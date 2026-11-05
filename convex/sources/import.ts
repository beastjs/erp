import { v } from "convex/values";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { action, internalMutation, mutation, query, type MutationCtx } from "../_generated/server";
import { asOrg, withOrg } from "../_shared/org";
import { bumpRun, loadRun, settleRun } from "../runs/mutations";
import { checkContractVersion, validateCandidate } from "./contract";
import { parseCsv } from "./csv";
import { INGEST_BATCH, ingestCandidate } from "./ingest";
import { missingColumns, rowToCandidate, validateMapping, type ColumnPair } from "./mapping";
import { insertCandidate } from "./mutations";

/**
 * Rows per mutation. A mutation may write 16k documents and read 32k; an inserted candidate costs a
 * handful, so 500 leaves headroom for the dedupe lookups and the run counter. Larger inputs are driven
 * link by link by the import chain driven from `importCsv`.
 */
export const CHUNK_SIZE = 500;
type RowError = { row: number; errors: string[] };

export const saveMapping = mutation({
  args: { name: v.string(), columns: v.record(v.string(), v.string()) },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    const name = args.name.trim();
    if (name === "") throw new Error("name must not be empty");
    const columns: ColumnPair[] = Object.entries(args.columns).map(([column, target]) => ({ column, target }));
    const errors = validateMapping(columns);
    if (errors.length > 0) throw new Error(`invalid mapping: ${errors.join("; ")}`);
    const existing = await ctx.db
      .query("columnMappings")
      .withIndex("by_org_and_name", (q) => q.eq("orgId", orgId).eq("name", name))
      .first();
    if (existing) throw new Error(`a mapping named "${name}" already exists`);
    return await ctx.db.insert("columnMappings", { orgId, name, columns });
  },
});

export const getMapping = query({
  args: { mappingId: v.id("columnMappings") },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    const mapping = await ctx.db.get(args.mappingId);
    if (!mapping || mapping.orgId !== orgId) throw new Error("mapping not found");
    return mapping;
  },
});

/**
 * Maps and inserts ONE chunk (at most CHUNK_SIZE rows) as pending candidates. A malformed row is data,
 * not an exception: it lands in `rejected` and the rest of the chunk goes ahead. What does throw is a
 * problem with the whole input (bad mapping, a mapped column absent from every row, a finished run),
 * and it throws before anything is written.
 *
 * Candidates are inserted, not ingested: ingest writes ~30 documents per candidate, so the caller
 * passes `candidateIds` to `ingestCandidates` in batches. `rowOffset` is the index of rows[0] in the
 * original file, so rejected row numbers point at the source.
 */
/** Maps and inserts one chunk of rows as pending candidates. Shared by the public mutation and the scheduled chain. */
async function importChunk(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
  run: Doc<"discoveryRuns">,
  mapping: Doc<"columnMappings">,
  rows: Array<Record<string, string>>,
  offset: number,
) {
  if (rows.length > CHUNK_SIZE) {
    throw new Error(`chunk_too_large: at most ${CHUNK_SIZE} rows per call (got ${rows.length}); use importCsv or send chunks`);
  }
  // Re-checked here: saveMapping is not the only way a row reaches the table.
  const mappingErrors = validateMapping(mapping.columns);
  if (mappingErrors.length > 0) throw new Error(`invalid mapping: ${mappingErrors.join("; ")}`);
  const missing = missingColumns(rows, mapping.columns);
  if (missing.length > 0) throw new Error(`missing_columns: ${missing.join(", ")}`);

  const rejected: RowError[] = [];
  const candidateIds: Id<"candidates">[] = [];
  let duplicates = 0;
  for (const [i, row] of rows.entries()) {
    const mapped = rowToCandidate(row, mapping.columns, run.startedAt);
    if (!mapped.ok) {
      rejected.push({ row: offset + i, errors: mapped.errors });
      continue;
    }
    const id = await insertCandidate(ctx, { candidate: mapped.candidate, sourceId: run.sourceId, runId: run._id });
    if (id) candidateIds.push(id);
    else duplicates++;
  }
  await bumpRun(ctx, run, {
    rowsProcessed: rows.length,
    candidatesInserted: candidateIds.length,
    duplicates,
    rowsRejected: rejected.length,
  });
  return { inserted: candidateIds.length, duplicates, rejected, candidateIds };
}

/**
 * Maps and inserts ONE chunk (at most CHUNK_SIZE rows) as pending candidates. A malformed row is data,
 * not an exception: it lands in `rejected` and the rest of the chunk goes ahead. What does throw is a
 * problem with the whole input (bad mapping, a mapped column absent from every row, a finished run),
 * and it throws before anything is written.
 *
 * Candidates are inserted, not ingested: ingest writes ~30 documents per candidate, so the caller
 * passes `candidateIds` to `ingestCandidates` in batches. `rowOffset` is the index of rows[0] in the
 * original file, so rejected row numbers point at the source. Whole files go through `importCsv`.
 */
export const importRows = mutation({
  args: {
    runId: v.id("discoveryRuns"),
    rows: v.array(v.record(v.string(), v.string())),
    mappingId: v.id("columnMappings"),
    rowOffset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    if (args.rows.length > CHUNK_SIZE) {
      throw new Error(`chunk_too_large: at most ${CHUNK_SIZE} rows per call (got ${args.rows.length}); use importCsv or send chunks`);
    }
    const run = await loadRun(ctx, orgId, args.runId, { active: true });
    const mapping = await ctx.db.get(args.mappingId);
    if (!mapping || mapping.orgId !== orgId) throw new Error("mapping not found");
    return await importChunk(ctx, orgId, run, mapping, args.rows, args.rowOffset ?? 0);
  },
});

// ------------------------------------------------------------ self-scheduling import chain
//
// importCsv (an action: file IO and parsing) stages the parsed file as chunk rows and starts the chain.
// Each link is an internalMutation that imports one chunk, schedules its ingest batches and the next
// link, and finishes. The org is derived ONCE, from the caller's identity, in the public entry point
// and travels down as an explicit argument, because scheduled functions run with no identity. Every
// link is its own transaction, so a 100k-row file has no single-action ceiling, and the chain's state
// (staged chunks left, run counters) is stored, so a stalled chain resumes with `resumeImport`.

/** Stages one parsed slice. Cells are aligned with `columns` (the mapped headers only). */
export const stageImportChunk = mutation({
  args: {
    runId: v.id("discoveryRuns"),
    mappingId: v.id("columnMappings"),
    seq: v.number(),
    columns: v.array(v.string()),
    rows: v.array(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    if (args.rows.length > CHUNK_SIZE) throw new Error(`chunk_too_large: at most ${CHUNK_SIZE} rows per staged chunk`);
    const run = await loadRun(ctx, orgId, args.runId, { active: true });
    if (run.rowsExpected !== undefined) throw new Error("import_already_started: this run already has an import");
    const mapping = await ctx.db.get(args.mappingId);
    if (!mapping || mapping.orgId !== orgId) throw new Error("mapping not found");
    // Idempotent for an action retried after a partial stage: the same slice replaces itself.
    const stale = await ctx.db.query("importChunks").withIndex("by_run_and_seq", (q) => q.eq("runId", run._id).eq("seq", args.seq)).first();
    if (stale) await ctx.db.delete(stale._id);
    await ctx.db.insert("importChunks", { orgId, ...args });
    return null;
  },
});

/** Declares the staged total and starts the chain. A zero-row file completes immediately. */
export const startStagedImport = mutation({
  args: { runId: v.id("discoveryRuns"), totalRows: v.number() },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    const run = await loadRun(ctx, orgId, args.runId, { active: true });
    if (run.rowsExpected !== undefined) throw new Error("import_already_started: this run already has an import");
    await ctx.db.patch(run._id, { rowsExpected: args.totalRows });
    if (args.totalRows === 0) await settleRun(ctx, run._id);
    else await ctx.scheduler.runAfter(0, internal.sources.import.processStagedChunk, { orgId, runId: run._id, seq: 0 });
    return null;
  },
});

/** Re-arms a stalled chain: ingest for candidates still pending, and the first chunk still staged. Safe to call on a healthy chain: a chunk is imported at most once. */
export const resumeImport = mutation({
  args: { runId: v.id("discoveryRuns") },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    const run = await loadRun(ctx, orgId, args.runId, { active: true });
    // Ingest batches can be lost too, so re-arm candidates still pending (a bounded slice per call;
    // call again for more). Ingest skips anything already consumed, so over-arming is harmless.
    const pending = await ctx.db
      .query("candidates")
      .withIndex("by_org_and_run_and_status", (q) => q.eq("orgId", orgId).eq("runId", run._id).eq("status", "pending"))
      .take(CHUNK_SIZE);
    for (let i = 0; i < pending.length; i += INGEST_BATCH) {
      await ctx.scheduler.runAfter(0, internal.sources.ingest.ingestStep, {
        orgId,
        candidateIds: pending.slice(i, i + INGEST_BATCH).map((c) => c._id),
      });
    }
    const next = await ctx.db.query("importChunks").withIndex("by_run_and_seq", (q) => q.eq("runId", run._id)).first();
    if (next) await ctx.scheduler.runAfter(0, internal.sources.import.processStagedChunk, { orgId, runId: run._id, seq: next.seq });
    return { resumedAt: next?.seq ?? null, rearmedCandidates: pending.length };
  },
});

/** One link of the chain. Imports chunk `seq`, deletes it, and schedules its ingest batches and the next link. */
export const processStagedChunk = internalMutation({
  args: { orgId: v.id("orgs"), runId: v.id("discoveryRuns"), seq: v.number() },
  handler: async (rawCtx, args): Promise<null> => {
    const ctx = asOrg(rawCtx, args.orgId);
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== args.orgId || run.status !== "running") return null;
    const chunk = await ctx.db.query("importChunks").withIndex("by_run_and_seq", (q) => q.eq("runId", args.runId).eq("seq", args.seq)).first();
    const mapping = chunk && (await ctx.db.get(chunk.mappingId));
    if (chunk && mapping) {
      const rows = chunk.rows.map((cells) => Object.fromEntries(chunk.columns.map((c, i) => [c, cells[i] ?? ""])));
      const res = await importChunk(ctx, args.orgId, run, mapping, rows, args.seq * CHUNK_SIZE);
      for (const r of res.rejected) await ctx.db.insert("importRejections", { orgId: args.orgId, runId: args.runId, ...r });
      await ctx.db.delete(chunk._id);
      for (let i = 0; i < res.candidateIds.length; i += INGEST_BATCH) {
        await ctx.scheduler.runAfter(0, internal.sources.ingest.ingestStep, {
          orgId: args.orgId,
          candidateIds: res.candidateIds.slice(i, i + INGEST_BATCH),
        });
      }
    }
    if ((args.seq + 1) * CHUNK_SIZE < (run.rowsExpected ?? 0)) {
      await ctx.scheduler.runAfter(0, internal.sources.import.processStagedChunk, { orgId: args.orgId, runId: args.runId, seq: args.seq + 1 });
    }
    return null;
  },
});

/**
 * Reads an uploaded CSV from storage, validates it against the mapping, stages it as chunks and starts
 * the self-scheduling chain (see above). It returns as soon as the file is staged; the import itself
 * proceeds in the background and is observable on the run (`rowsProcessed` of `rowsExpected`, then
 * `status: "completed"`). Rejected rows are kept in `importRejections` (`rejectionsForRun`).
 *
 * The whole file's headers are checked against the mapping BEFORE anything is staged, so a wrong file
 * fails with a named error instead of leaving a half-imported dataset. Only mapped columns are staged:
 * smaller documents, and unmapped headers (blank, or starting with "_") never meet a validator.
 */
export const importCsv = action({
  args: { runId: v.id("discoveryRuns"), mappingId: v.id("columnMappings"), storageId: v.id("_storage") },
  handler: async (ctx, args): Promise<{ rows: number; chunks: number }> => {
    const blob = await ctx.storage.get(args.storageId);
    if (!blob) throw new Error("file_not_found: nothing is stored under that id");
    const { headers, rows } = parseCsv(await blob.text());
    const mapping = await ctx.runQuery(api.sources.import.getMapping, { mappingId: args.mappingId });
    const errors = validateMapping(mapping.columns);
    if (errors.length > 0) throw new Error(`invalid mapping: ${errors.join("; ")}`);
    const absent = mapping.columns.filter((c) => !headers.includes(c.column)).map((c) => c.column);
    if (absent.length > 0) throw new Error(`missing_columns: ${absent.join(", ")}`);

    const columns = mapping.columns.map((c) => c.column);
    const at = columns.map((c) => headers.indexOf(c));
    let chunks = 0;
    for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
      await ctx.runMutation(api.sources.import.stageImportChunk, {
        runId: args.runId,
        mappingId: args.mappingId,
        seq: chunks++,
        columns,
        rows: rows.slice(offset, offset + CHUNK_SIZE).map((cells) => at.map((i) => cells[i] ?? "")),
      });
    }
    await ctx.runMutation(api.sources.import.startStagedImport, { runId: args.runId, totalRows: rows.length });
    return { rows: rows.length, chunks };
  },
});

/**
 * One lead typed in by an operator. Its source is that operator (`manual:<identity>`, trust 1, created
 * on first use), so their claims are attributable to a person rather than to a shared bucket.
 * Inserted and ingested in the same transaction: a single lead is well inside the write budget.
 * The lawful basis defaults to legitimate interest; an org that relies on another should register the
 * operator's source itself first.
 */
export const addManualLead = mutation({
  args: { candidate: v.any() },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("no identity");
    const key = `manual:${identity.tokenIdentifier}`;
    const existing = await ctx.db
      .query("sources")
      .withIndex("by_org_and_key", (q) => q.eq("orgId", orgId).eq("key", key))
      .first();
    const sourceId =
      existing?._id ??
      (await ctx.db.insert("sources", { orgId, key, kind: "manual", trustWeight: 1, lawfulBasis: "legitimate_interest" }));
    const id = await insertCandidate(ctx, { candidate: args.candidate, sourceId });
    if (!id) throw new Error("duplicate_candidate: an identical lead is already waiting to be processed");
    const result = await ingestCandidate(ctx, id);
    if (result.outcome !== "consumed") throw new Error(result.reason ?? "lead could not be ingested");
    return id;
  },
});

/**
 * The seam an external producer (the Firecrawl Collector Worker) posts through. The producer DECLARES
 * the contract version it was built against; a MAJOR mismatch, a producer ahead of Core, or anything
 * unparseable is refused for the whole call rather than guessed at (see checkContractVersion). The
 * declared version is what gets stored. Per-item problems are data, as in importRows. Candidates are
 * inserted pending; the caller then passes `candidateIds` to `ingestCandidates`.
 */
export const submitCandidates = mutation({
  args: {
    sourceId: v.id("sources"),
    contractVersion: v.string(),
    candidates: v.array(v.any()),
    runId: v.optional(v.id("discoveryRuns")),
  },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    const version = checkContractVersion(args.contractVersion);
    if (!version.ok) throw new Error(version.error);
    if (args.candidates.length > CHUNK_SIZE) {
      throw new Error(`chunk_too_large: at most ${CHUNK_SIZE} candidates per call (got ${args.candidates.length})`);
    }
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.orgId !== orgId) throw new Error("source not found");
    const run = args.runId ? await loadRun(ctx, orgId, args.runId, { active: true }) : null;

    const rejected: RowError[] = [];
    const candidateIds: Id<"candidates">[] = [];
    let duplicates = 0;
    for (const [i, candidate] of args.candidates.entries()) {
      const checked = validateCandidate(candidate);
      if (!checked.ok) {
        rejected.push({ row: i, errors: checked.errors });
        continue;
      }
      const id = await insertCandidate(ctx, {
        candidate: checked.value,
        sourceId: args.sourceId,
        runId: args.runId,
        contractVersion: args.contractVersion,
      });
      if (id) candidateIds.push(id);
      else duplicates++;
    }
    if (run) {
      await bumpRun(ctx, run, {
        rowsProcessed: args.candidates.length,
        candidatesInserted: candidateIds.length,
        duplicates,
        rowsRejected: rejected.length,
      });
    }
    return { inserted: candidateIds.length, duplicates, rejected, candidateIds };
  },
});

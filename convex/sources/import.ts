import { v } from "convex/values";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, mutation, query } from "../_generated/server";
import { withOrg } from "../_shared/org";
import { bumpRun, loadRun } from "../runs/mutations";
import { checkContractVersion, validateCandidate } from "./contract";
import { parseCsv } from "./csv";
import { INGEST_BATCH, ingestCandidate } from "./ingest";
import { missingColumns, rowToCandidate, validateMapping, type ColumnPair } from "./mapping";
import { insertCandidate } from "./mutations";

/**
 * Rows per mutation. A mutation may write 16k documents and read 32k; an inserted candidate costs a
 * handful, so 500 leaves headroom for the dedupe lookups and the run counter. Larger inputs are driven
 * chunk by chunk by `importCsv` (an action), because actions can loop and mutations cannot.
 */
export const CHUNK_SIZE = 500;
/** Rejected rows `importCsv` hands back; the true count is always returned alongside. */
const REJECTED_SAMPLE = 1000;

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
    // Re-checked here: saveMapping is not the only way a row reaches the table.
    const mappingErrors = validateMapping(mapping.columns);
    if (mappingErrors.length > 0) throw new Error(`invalid mapping: ${mappingErrors.join("; ")}`);
    const missing = missingColumns(args.rows, mapping.columns);
    if (missing.length > 0) throw new Error(`missing_columns: ${missing.join(", ")}`);

    const offset = args.rowOffset ?? 0;
    const rejected: RowError[] = [];
    const candidateIds: Id<"candidates">[] = [];
    let duplicates = 0;
    for (const [i, row] of args.rows.entries()) {
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
      rowsProcessed: args.rows.length,
      candidatesInserted: candidateIds.length,
      duplicates,
      rowsRejected: rejected.length,
    });
    return { inserted: candidateIds.length, duplicates, rejected, candidateIds };
  },
});

export type ImportCsvResult = {
  /** One entry per chunk, in order: progress a caller (or a log) can follow. */
  chunks: Array<{ offset: number; processed: number; inserted: number }>;
  inserted: number;
  duplicates: number;
  rejectedCount: number;
  /** The first REJECTED_SAMPLE rejected rows; `rejectedCount` is the true total. */
  rejected: RowError[];
  consumed: number;
};

/**
 * Reads an uploaded CSV from storage and drives the import: parse (IO, so an action), then for each
 * chunk of CHUNK_SIZE rows an `importRows` mutation followed by `ingestCandidates` batches. It is a
 * loop in an action rather than self-scheduling mutations because scheduled functions run without the
 * caller's auth identity, and every org-scoped write here derives its org from that identity.
 *
 * The whole file's headers are checked against the mapping BEFORE the first row is written, so a
 * wrong file fails with a named error instead of leaving a half-imported dataset. Progress is also
 * visible live on the run (`rowsProcessed`, ...), and the run is finished at the end. If the action
 * dies mid-way the run stays `running` with its counters showing exactly how far it got.
 */
export const importCsv = action({
  args: { runId: v.id("discoveryRuns"), mappingId: v.id("columnMappings"), storageId: v.id("_storage") },
  handler: async (ctx, args): Promise<ImportCsvResult> => {
    const blob = await ctx.storage.get(args.storageId);
    if (!blob) throw new Error("file_not_found: nothing is stored under that id");
    const { headers, rows } = parseCsv(await blob.text());
    const mapping = await ctx.runQuery(api.sources.import.getMapping, { mappingId: args.mappingId });
    const errors = validateMapping(mapping.columns);
    if (errors.length > 0) throw new Error(`invalid mapping: ${errors.join("; ")}`);
    const absent = mapping.columns.filter((c) => !headers.includes(c.column)).map((c) => c.column);
    if (absent.length > 0) throw new Error(`missing_columns: ${absent.join(", ")}`);

    // Only mapped columns travel to the mutation: smaller payloads, and unmapped headers (which may
    // be blank or start with "_", neither of which a record key allows) never reach a validator.
    const index = new Map(mapping.columns.map((c) => [c.column, headers.indexOf(c.column)]));
    const toRecord = (cells: string[]) => {
      const rec: Record<string, string> = {};
      for (const [column, i] of index) rec[column] = cells[i] ?? "";
      return rec;
    };

    const out: ImportCsvResult = { chunks: [], inserted: 0, duplicates: 0, rejectedCount: 0, rejected: [], consumed: 0 };
    for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
      const slice = rows.slice(offset, offset + CHUNK_SIZE).map(toRecord);
      const res = await ctx.runMutation(api.sources.import.importRows, {
        runId: args.runId,
        mappingId: args.mappingId,
        rows: slice,
        rowOffset: offset,
      });
      for (let i = 0; i < res.candidateIds.length; i += INGEST_BATCH) {
        const ingested = await ctx.runMutation(api.sources.ingest.ingestCandidates, {
          candidateIds: res.candidateIds.slice(i, i + INGEST_BATCH),
        });
        out.consumed += ingested.consumed;
      }
      out.chunks.push({ offset, processed: slice.length, inserted: res.inserted });
      out.inserted += res.inserted;
      out.duplicates += res.duplicates;
      out.rejectedCount += res.rejected.length;
      for (const r of res.rejected) if (out.rejected.length < REJECTED_SAMPLE) out.rejected.push(r);
    }
    await ctx.runMutation(api.runs.mutations.finishRun, { runId: args.runId });
    return out;
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

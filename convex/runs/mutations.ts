import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { action, internalMutation, mutation, type MutationCtx } from "../_generated/server";
import { MAX_CREDIT_BUDGET } from "../_shared/limits";
import { requireRole } from "../_shared/authz";
import { writeAudit } from "../audit/log";
import { recordRefusals } from "../observability/refusals";


export type RunCounter =
  | "rowsProcessed"
  | "candidatesInserted"
  | "duplicates"
  | "rowsRejected"
  | "candidatesConsumed"
  | "candidatesRejected"
  | "chunksProcessed";

/**
 * Staged chunks removed per transaction. A chunk is at most ~512 KB and a transaction may read 16 MiB, so this bounds
 * the read; a run with more is finished by a scheduled continuation, never abandoned.
 */
export const PURGE_CHUNKS_PER_TXN = 16;

/**
 * Deletes a TERMINAL run's staged import rows. A chunk is the raw grid of the file (names, emails, phones, verbatim),
 * deleted as the chain consumes it; what is left when a run ends any other way (failed, closed by hand) would sit
 * there for good and erasure cannot find it (no index from an identifier to a chunk). So the end of a run is the
 * moment they go. Refuses a run that is still running. Returns true when none are left; the caller schedules
 * `purgeStagedChunks` for the rest otherwise.
 */
export async function purgeStagedChunks(ctx: MutationCtx, run: Doc<"discoveryRuns">): Promise<boolean> {
  if (run.status === "running") throw new Error("a running run's staged rows are still to be imported");
  const chunks = await ctx.db.query("importChunks").withIndex("by_run_and_seq", (q) => q.eq("runId", run._id)).take(PURGE_CHUNKS_PER_TXN + 1);
  for (const chunk of chunks.slice(0, PURGE_CHUNKS_PER_TXN)) {
    if (chunk.orgId === run.orgId) await ctx.db.delete(chunk._id);
  }
  const done = chunks.length <= PURGE_CHUNKS_PER_TXN;
  // Liveness marker for observability (Task 16): set while raw rows remain, cleared by the purge that removes the last.
  // Written here, in the transaction that commits the deletes, so it is always the state of the last purge that COMMITTED.
  // A continuation that throws is not retried, and the marker then stays set and ages: pipelineHealth lists it.
  if (!done && run.purgePendingSince === undefined) await ctx.db.patch(run._id, { purgePendingSince: Date.now() });
  if (done && run.purgePendingSince !== undefined) await ctx.db.patch(run._id, { purgePendingSince: undefined });
  return done;
}

/** Runs once, in the transaction that ends a run: purge the staged rows, and schedule the rest if they do not fit. */
async function onRunTerminal(ctx: MutationCtx, runId: Id<"discoveryRuns">): Promise<void> {
  const run = await ctx.db.get(runId);
  if (!run || run.status === "running") return;
  if (!(await purgeStagedChunks(ctx, run))) {
    await ctx.scheduler.runAfter(0, internal.sources.import.purgeStagedChunks, { orgId: run.orgId, runId });
  }
}

/** Loads a run in the caller's org. Pass `active: true` to also refuse a finished run. */
export async function loadRun(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
  runId: Id<"discoveryRuns">,
  opts: { active?: boolean } = {},
): Promise<Doc<"discoveryRuns">> {
  const run = await ctx.db.get(runId);
  if (!run || run.orgId !== orgId) throw new Error("run not found");
  if (opts.active && run.status !== "running") throw new Error("run_not_active");
  return run;
}

/**
 * Increments counters on a run. Read-modify-write inside one transaction, so concurrent chunks
 * serialize through OCC rather than losing updates.
 */
export async function bumpRun(
  ctx: MutationCtx,
  run: Doc<"discoveryRuns">,
  delta: Partial<Record<RunCounter, number>>,
): Promise<void> {
  const fresh = (await ctx.db.get(run._id)) ?? run;
  const patch: Partial<Record<RunCounter, number>> = {};
  for (const [key, n] of Object.entries(delta) as Array<[RunCounter, number]>) {
    if (n) patch[key] = (fresh[key] ?? 0) + n;
  }
  if (Object.keys(patch).length > 0) await ctx.db.patch(run._id, { ...patch, progressAt: Date.now() });
  await settleRun(ctx, run._id);
}

/**
 * Completes a staged import once everything it promised has happened: all staged chunks processed
 * and every inserted candidate consumed or rejected. Called after every counter change, so no
 * separate "finisher" step can be forgotten or lost.
 */
export async function settleRun(ctx: MutationCtx, runId: Id<"discoveryRuns">): Promise<void> {
  const run = await ctx.db.get(runId);
  if (!run || run.status !== "running" || run.chunksExpected === undefined) return;
  if (
    (run.chunksProcessed ?? 0) >= run.chunksExpected &&
    run.candidatesConsumed + run.candidatesRejected >= run.candidatesInserted
  ) {
    await ctx.db.patch(runId, { status: "completed", finishedAt: Date.now() });
    await onRunTerminal(ctx, runId);
  }
}

/**
 * Terminal failure: the run announces that it is dead and why, instead of staying `running` forever.
 * Idempotent (a finished run keeps its outcome), and it stops the run from accepting more work because
 * every writer loads it with `active: true`. Counters of work already in flight may still land.
 */
export async function failRun(ctx: MutationCtx, runId: Id<"discoveryRuns">, reason: string): Promise<void> {
  const run = await ctx.db.get(runId);
  if (!run || run.status !== "running") return;
  await ctx.db.patch(runId, { status: "failed", failureReason: reason, finishedAt: Date.now() });
  await onRunTerminal(ctx, runId);
}

/**
 * Spends credits from a run's budget, refusing (not clamping) past it. Shared by `consumeCredits` and the
 * pipeline's enqueue gate so there is exactly one place where "the budget is the backpressure" is decided.
 */
export async function spendCredits(ctx: MutationCtx, orgId: Id<"orgs">, runId: Id<"discoveryRuns">, credits: number): Promise<{ remaining: number }> {
  if (!(Number.isFinite(credits) && credits >= 0)) throw new Error("credits must be a finite number >= 0");
  const run = await loadRun(ctx, orgId, runId, { active: true });
  const remaining = run.creditBudget - run.creditsUsed;
  if (credits > remaining) throw new Error("budget_exhausted");
  await ctx.db.patch(run._id, { creditsUsed: run.creditsUsed + credits });
  return { remaining: remaining - credits };
}

/**
 * `spendCredits` for a caller that can act on a refusal. An exhausted budget marks the run `failed` /
 * `budget_exhausted` (spec 9) and returns null instead of throwing: a throw would roll the mark back with the rest
 * of the transaction. Nothing is spent when it refuses. The caller MUST return normally for the mark to persist.
 */
export async function trySpendCredits(ctx: MutationCtx, orgId: Id<"orgs">, runId: Id<"discoveryRuns">, credits: number): Promise<{ remaining: number } | null> {
  if (!(Number.isFinite(credits) && credits >= 0)) throw new Error("credits must be a finite number >= 0");
  const run = await loadRun(ctx, orgId, runId, { active: true });
  const remaining = run.creditBudget - run.creditsUsed;
  if (credits > remaining) {
    await failRun(ctx, run._id, "budget_exhausted");
    return null;
  }
  await ctx.db.patch(run._id, { creditsUsed: run.creditsUsed + credits });
  return { remaining: remaining - credits };
}

/**
 * Starts a discovery run with a credit budget. Role: `admin`. A public ACTION so that an authorization refusal can be
 * recorded (observability/refusals.ts); the work and the role check run in `startRunTxn` with the caller's identity.
 */
export const startRun = action({
  args: { sourceId: v.id("sources"), icpVersionId: v.optional(v.id("icpDefinitions")), creditBudget: v.number() },
  handler: async (ctx, args): Promise<Id<"discoveryRuns">> => await recordRefusals(ctx, "startRun", () => ctx.runMutation(internal.runs.mutations.startRunTxn, args)),
});

/** The work of `startRun`, in one transaction. Internal: reachable only through the action above. */
export const startRunTxn = internalMutation({
  args: { sourceId: v.id("sources"), icpVersionId: v.optional(v.id("icpDefinitions")), creditBudget: v.number() },
  handler: async (ctx, args): Promise<Id<"discoveryRuns">> => {
    const { orgId, actor } = await requireRole(ctx, "admin");
    // Negated conjunction: NaN fails every comparison, so it fails closed. An infinite budget is no budget. The upper
    // bound is a REFUSAL, not a clamp: the budget lands in two stores erasure cannot redact (see MAX_CREDIT_BUDGET).
    if (!(Number.isFinite(args.creditBudget) && args.creditBudget >= 0 && args.creditBudget <= MAX_CREDIT_BUDGET)) {
      throw new Error(`creditBudget must be a finite number between 0 and ${MAX_CREDIT_BUDGET}`);
    }
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.orgId !== orgId) throw new Error("source not found");
    if (args.icpVersionId) {
      const icp = await ctx.db.get(args.icpVersionId);
      if (!icp || icp.orgId !== orgId) throw new Error("icp version not found");
    }
    const runId = await ctx.db.insert("discoveryRuns", {
      orgId,
      sourceId: args.sourceId,
      icpVersionId: args.icpVersionId,
      status: "running",
      creditBudget: args.creditBudget,
      creditsUsed: 0,
      startedAt: Date.now(),
      rowsProcessed: 0,
      candidatesInserted: 0,
      duplicates: 0,
      rowsRejected: 0,
      candidatesConsumed: 0,
      candidatesRejected: 0,
    });
    await writeAudit(ctx, { actor, action: "run.started", targetTable: "discoveryRuns", targetId: runId, after: { creditBudget: args.creditBudget } });
    return runId;
  },
});

/**
 * The pipeline's backpressure. Throws `budget_exhausted` when the spend would pass the budget: it
 * never clamps and never goes negative, so a runaway crawl or enrichment fails closed. The throw
 * rolls the mutation back, so a refused call spends nothing.
 */
export const consumeCredits = mutation({
  args: { runId: v.id("discoveryRuns"), credits: v.number() },
  handler: async (ctx, args) => {
    const { orgId } = await requireRole(ctx, "operator");
    return await spendCredits(ctx, orgId, args.runId, args.credits);
  },
});

/** Closes a run. Idempotent: a second call keeps the original finish time. */
export const finishRun = mutation({
  args: { runId: v.id("discoveryRuns") },
  handler: async (ctx, args) => {
    const { orgId } = await requireRole(ctx, "operator");
    const run = await loadRun(ctx, orgId, args.runId);
    // A failed run stays failed: completing it would erase the only signal that it died.
    if (run.status !== "running") return null;
    await ctx.db.patch(run._id, { status: "completed", finishedAt: Date.now() });
    await onRunTerminal(ctx, run._id);
    return null;
  },
});

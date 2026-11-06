import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import { withOrg } from "../_shared/org";

export type RunCounter =
  | "rowsProcessed"
  | "candidatesInserted"
  | "duplicates"
  | "rowsRejected"
  | "candidatesConsumed"
  | "candidatesRejected"
  | "chunksProcessed";

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
  if (Object.keys(patch).length > 0) await ctx.db.patch(run._id, patch);
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

export const startRun = mutation({
  args: { sourceId: v.id("sources"), icpVersionId: v.optional(v.id("icpDefinitions")), creditBudget: v.number() },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    // Negated conjunction: NaN fails every comparison, so it fails closed. An infinite budget is no budget.
    if (!(Number.isFinite(args.creditBudget) && args.creditBudget >= 0)) {
      throw new Error("creditBudget must be a finite number >= 0");
    }
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.orgId !== orgId) throw new Error("source not found");
    if (args.icpVersionId) {
      const icp = await ctx.db.get(args.icpVersionId);
      if (!icp || icp.orgId !== orgId) throw new Error("icp version not found");
    }
    return await ctx.db.insert("discoveryRuns", {
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
    const { orgId } = await withOrg(ctx, args);
    return await spendCredits(ctx, orgId, args.runId, args.credits);
  },
});

/** Closes a run. Idempotent: a second call keeps the original finish time. */
export const finishRun = mutation({
  args: { runId: v.id("discoveryRuns") },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    const run = await loadRun(ctx, orgId, args.runId);
    // A failed run stays failed: completing it would erase the only signal that it died.
    if (run.status !== "running") return null;
    await ctx.db.patch(run._id, { status: "completed", finishedAt: Date.now() });
    return null;
  },
});

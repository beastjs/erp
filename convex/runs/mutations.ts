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
  | "candidatesRejected";

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
    if (n) patch[key] = fresh[key] + n;
  }
  if (Object.keys(patch).length > 0) await ctx.db.patch(run._id, patch);
  await settleRun(ctx, run._id);
}

/**
 * Completes a staged import once everything it promised has happened: all expected rows processed
 * and every inserted candidate consumed or rejected. Called after every counter change, so no
 * separate "finisher" step can be forgotten or lost.
 */
export async function settleRun(ctx: MutationCtx, runId: Id<"discoveryRuns">): Promise<void> {
  const run = await ctx.db.get(runId);
  if (!run || run.status !== "running" || run.rowsExpected === undefined) return;
  if (
    run.rowsProcessed >= run.rowsExpected &&
    run.candidatesConsumed + run.candidatesRejected >= run.candidatesInserted
  ) {
    await ctx.db.patch(runId, { status: "completed", finishedAt: Date.now() });
  }
}

export const startRun = mutation({
  args: { sourceId: v.id("sources"), icpVersionId: v.optional(v.string()), creditBudget: v.number() },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    // Negated conjunction: NaN fails every comparison, so it fails closed. An infinite budget is no budget.
    if (!(Number.isFinite(args.creditBudget) && args.creditBudget >= 0)) {
      throw new Error("creditBudget must be a finite number >= 0");
    }
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.orgId !== orgId) throw new Error("source not found");
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
    if (!(Number.isFinite(args.credits) && args.credits >= 0)) {
      throw new Error("credits must be a finite number >= 0");
    }
    const run = await loadRun(ctx, orgId, args.runId, { active: true });
    const remaining = run.creditBudget - run.creditsUsed;
    if (args.credits > remaining) throw new Error("budget_exhausted");
    await ctx.db.patch(run._id, { creditsUsed: run.creditsUsed + args.credits });
    return { remaining: remaining - args.credits };
  },
});

/** Closes a run. Idempotent: a second call keeps the original finish time. */
export const finishRun = mutation({
  args: { runId: v.id("discoveryRuns") },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    const run = await loadRun(ctx, orgId, args.runId);
    if (run.status === "completed") return null;
    await ctx.db.patch(run._id, { status: "completed", finishedAt: Date.now() });
    return null;
  },
});

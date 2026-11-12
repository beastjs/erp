import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireRole } from "../_shared/authz";
import { resolveOrg } from "../_shared/org";
import { STAGES, type Stage } from "../pipeline/schema";
import { RUN_SCAN_CAP, ratio, tally, type Count, type ObsCtx } from "./definitions";

/*
 * Run metrics (spec 10, 4.7). Two sources, kept apart because they differ in how far they can be trusted:
 *   - the run's own counters on `discoveryRuns`, maintained in the same transactions as the work, so EXACT;
 *   - the run's pipeline rows, which have no counter and are read through the `by_org_and_run` index, at most
 *     RUN_SCAN_CAP of them, so a count from them is a `Count` that says `at_least` when the cap was hit.
 * Every field of every result is a key of METRIC_DEFINITIONS (`runSummary.*`, `costPerQualifiedLead.*`).
 */

const PIPELINE_STATUSES = ["active", "done", "deadlettered"] as const;
type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

async function loadRun(ctx: ObsCtx, runId: Id<"discoveryRuns">): Promise<Doc<"discoveryRuns">> {
  const { orgId } = await resolveOrg(ctx);
  const run = await ctx.db.get(runId);
  if (!run || run.orgId !== orgId) throw new Error("run not found");
  return run;
}

/** The run's pipeline rows, at most RUN_SCAN_CAP, and whether there were more. */
async function runStates(ctx: ObsCtx, run: Doc<"discoveryRuns">): Promise<{ states: Doc<"pipelineState">[]; truncated: boolean }> {
  const rows = await ctx.db
    .query("pipelineState")
    .withIndex("by_org_and_run", (q) => q.eq("orgId", run.orgId).eq("runId", run._id))
    .take(RUN_SCAN_CAP + 1);
  return { states: rows.slice(0, RUN_SCAN_CAP), truncated: rows.length > RUN_SCAN_CAP };
}

export type RunSummary = {
  runId: Id<"discoveryRuns">;
  status: Doc<"discoveryRuns">["status"];
  countsByStage: Record<Stage, Count>;
  countsByStatus: Record<PipelineStatus, Count>;
  countsByOutcome: {
    rowsProcessed: number;
    candidatesInserted: number;
    duplicates: number;
    rowsRejected: number;
    candidatesConsumed: number;
    candidatesRejected: number;
  };
  creditsConsumed: number;
  durationMs: number | null;
};

export async function runSummaryOf(ctx: ObsCtx, args: { runId: Id<"discoveryRuns"> }): Promise<RunSummary> {
  const run = await loadRun(ctx, args.runId);
  const { states, truncated } = await runStates(ctx, run);
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  const byStatus = Object.fromEntries(PIPELINE_STATUSES.map((s) => [s, 0])) as Record<PipelineStatus, number>;
  for (const s of states) {
    byStage[s.stage]++;
    byStatus[s.status]++;
  }
  const duration = run.finishedAt === undefined ? null : run.finishedAt - run.startedAt;
  return {
    runId: run._id,
    status: run.status,
    countsByStage: Object.fromEntries(STAGES.map((s) => [s, tally(byStage[s], truncated)])) as Record<Stage, Count>,
    countsByStatus: Object.fromEntries(PIPELINE_STATUSES.map((s) => [s, tally(byStatus[s], truncated)])) as Record<PipelineStatus, Count>,
    countsByOutcome: {
      rowsProcessed: run.rowsProcessed,
      candidatesInserted: run.candidatesInserted,
      duplicates: run.duplicates,
      rowsRejected: run.rowsRejected,
      candidatesConsumed: run.candidatesConsumed,
      candidatesRejected: run.candidatesRejected,
    },
    creditsConsumed: run.creditsUsed,
    durationMs: duration !== null && Number.isFinite(duration) ? duration : null,
  };
}

export type CostPerQualifiedLead = {
  runId: Id<"discoveryRuns">;
  credits: number;
  qualified: Count;
  costPerLead: number | null;
  costBound: "exact" | "at_most";
};

export async function costPerQualifiedLeadOf(ctx: ObsCtx, args: { runId: Id<"discoveryRuns"> }): Promise<CostPerQualifiedLead> {
  const run = await loadRun(ctx, args.runId);
  const { states, truncated } = await runStates(ctx, run);
  // `leadId` is set only by the package stage, which a Reject tier never reaches, and a subject has one pipeline row:
  // so this counts each subject that ever qualified once, however many times it was rescored and repackaged.
  const qualified = tally(states.filter((s) => s.leadId !== undefined).length, truncated);
  return {
    runId: run._id,
    credits: run.creditsUsed,
    qualified,
    costPerLead: ratio(run.creditsUsed, qualified.value),
    costBound: qualified.bound === "exact" ? "exact" : "at_most",
  };
}

/** Operator: the same people who run discovery and can already read the run (`getRun`) and its leads (spec 7.1). */
export const runSummary = query({
  args: { runId: v.id("discoveryRuns") },
  handler: async (ctx, args): Promise<RunSummary> => {
    await requireRole(ctx, "operator");
    return await runSummaryOf(ctx, args);
  },
});

/** Operator, as `runSummary`: credits used are already on `getRun` for this role, and this adds only a count. */
export const costPerQualifiedLead = query({
  args: { runId: v.id("discoveryRuns") },
  handler: async (ctx, args): Promise<CostPerQualifiedLead> => {
    await requireRole(ctx, "operator");
    return await costPerQualifiedLeadOf(ctx, args);
  },
});

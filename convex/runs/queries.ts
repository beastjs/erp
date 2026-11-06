import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireRole } from "../_shared/authz";


export const getRun = query({
  args: { runId: v.id("discoveryRuns") },
  handler: async (ctx, args) => {
    const { orgId } = await requireRole(ctx, "operator");
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== orgId) throw new Error("run not found");
    return run;
  },
});

/**
 * Rows a chunked import rejected, in file order, one page at a time. Paginated rather than capped: a run with more
 * rejections than any fixed bound must not look, to a caller, like a run with fewer. `rowsRejected` on the run is the
 * true total; keep calling with `continueCursor` until `isDone`.
 */
export const rejectionsForRun = query({
  args: { runId: v.id("discoveryRuns"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<PaginationResult<Doc<"importRejections">>> => {
    const { orgId } = await requireRole(ctx, "operator");
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== orgId) throw new Error("run not found");
    return await ctx.db.query("importRejections").withIndex("by_run", (q) => q.eq("runId", args.runId)).paginate(args.paginationOpts);
  },
});

import { v } from "convex/values";
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

/** Rows a chunked import rejected, in file order. Bounded; `rowsRejected` on the run is the true total. */
export const rejectionsForRun = query({
  args: { runId: v.id("discoveryRuns") },
  handler: async (ctx, args) => {
    const { orgId } = await requireRole(ctx, "operator");
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== orgId) throw new Error("run not found");
    return await ctx.db.query("importRejections").withIndex("by_run", (q) => q.eq("runId", args.runId)).take(1000);
  },
});

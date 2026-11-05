import { v } from "convex/values";
import { query } from "../_generated/server";
import { withOrg } from "../_shared/org";

export const getRun = query({
  args: { runId: v.id("discoveryRuns") },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== orgId) throw new Error("run not found");
    return run;
  },
});

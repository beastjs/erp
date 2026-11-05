import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { withOrg } from "../_shared/org";
import { claimMethod, subjectType, type ClaimMethod } from "./schema";

/** Highest confidence a claim of each method may carry. Task 9 moves this to scoring-model config. */
export const METHOD_CEILINGS: Record<ClaimMethod, number> = {
  observed: 1.0,
  extracted: 0.7,
  inferred: 0.5,
};

export const appendClaim = mutation({
  args: {
    subjectType,
    subjectId: v.string(),
    field: v.string(),
    value: v.any(),
    sourceId: v.id("sources"),
    method: claimMethod,
    confidence: v.number(),
    observedAt: v.number(),
    snapshotRef: v.optional(v.string()),
    runId: v.optional(v.id("discoveryRuns")),
  },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    if (!(args.confidence >= 0 && args.confidence <= 1)) {
      throw new Error("confidence must be between 0 and 1");
    }
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.orgId !== orgId) throw new Error("source not found");
    if (args.runId) {
      const run = await ctx.db.get(args.runId);
      if (!run || run.orgId !== orgId) throw new Error("run not found");
    }
    return await ctx.db.insert("claims", {
      ...args,
      orgId,
      confidence: Math.min(args.confidence, METHOD_CEILINGS[args.method]),
    });
  },
});

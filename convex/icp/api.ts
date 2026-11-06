import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation } from "../_generated/server";
import { requireRole } from "../_shared/authz";
import { createIcpVersion, createScoringModel } from "./mutations";
import { icpCriteria, scoringConfig } from "./schema";

/**
 * Spec 7.1: `analyst` edits ICP definitions and scoring models. Each call appends a NEW version (nothing is edited
 * in place), attributed to the verified caller, with an audit entry written by the same helper in the same
 * transaction. `admin` outranks `analyst`, so an admin may do this too; an `operator` may not.
 */
export const createIcp = mutation({
  args: { name: v.string(), criteria: icpCriteria, supersedesId: v.optional(v.id("icpDefinitions")) },
  handler: async (ctx, args): Promise<Id<"icpDefinitions">> => {
    const { actor } = await requireRole(ctx, "analyst");
    return await createIcpVersion(ctx, args, actor);
  },
});

export const createModel = mutation({
  args: { ...scoringConfig, supersedesId: v.optional(v.id("scoringModels")) },
  handler: async (ctx, args): Promise<Id<"scoringModels">> => {
    const { actor } = await requireRole(ctx, "analyst");
    return await createScoringModel(ctx, args, actor);
  },
});

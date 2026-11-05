import { v } from "convex/values";
import { query } from "../_generated/server";
import { withOrg } from "../_shared/org";
import { subjectType } from "./schema";

const MAX_CLAIMS = 1000;

export const claimsForSubject = query({
  args: { subjectType, subjectId: v.string() },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    return await ctx.db
      .query("claims")
      .withIndex("by_subject", (q) =>
        q.eq("orgId", orgId).eq("subjectType", args.subjectType).eq("subjectId", args.subjectId),
      )
      .take(MAX_CLAIMS);
  },
});

export const claimsForField = query({
  args: { subjectType, subjectId: v.string(), field: v.string() },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    return await ctx.db
      .query("claims")
      .withIndex("by_subject_field", (q) =>
        q
          .eq("orgId", orgId)
          .eq("subjectType", args.subjectType)
          .eq("subjectId", args.subjectId)
          .eq("field", args.field),
      )
      .take(MAX_CLAIMS);
  },
});

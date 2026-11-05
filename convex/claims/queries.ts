import { v } from "convex/values";
import { query } from "../_generated/server";
import { withOrg } from "../_shared/org";
import { subjectType } from "./schema";

/**
 * Most claims a single subject (or subject+field) may hold for a read. Exceeding
 * it throws rather than truncating: index order is oldest-first, so a silent
 * cut would drop the newest claims and yield a stale, wrong projection.
 */
export const MAX_CLAIMS = 1000;

function withinLimit<T>(rows: T[], what: string): T[] {
  if (rows.length > MAX_CLAIMS) {
    throw new Error(`${what} has more than ${MAX_CLAIMS} claims (limit ${MAX_CLAIMS}); refusing a partial read`);
  }
  return rows;
}

export const claimsForSubject = query({
  args: { subjectType, subjectId: v.string() },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    const rows = await ctx.db
      .query("claims")
      .withIndex("by_subject", (q) =>
        q.eq("orgId", orgId).eq("subjectType", args.subjectType).eq("subjectId", args.subjectId),
      )
      .take(MAX_CLAIMS + 1);
    return withinLimit(rows, `subject ${args.subjectType}:${args.subjectId}`);
  },
});

export const claimsForField = query({
  args: { subjectType, subjectId: v.string(), field: v.string() },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    const rows = await ctx.db
      .query("claims")
      .withIndex("by_subject_field", (q) =>
        q
          .eq("orgId", orgId)
          .eq("subjectType", args.subjectType)
          .eq("subjectId", args.subjectId)
          .eq("field", args.field),
      )
      .take(MAX_CLAIMS + 1);
    return withinLimit(rows, `subject ${args.subjectType}:${args.subjectId} field ${args.field}`);
  },
});

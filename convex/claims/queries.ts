import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { withOrg } from "../_shared/org";
import { subjectType, type SubjectType } from "./schema";

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

/** Plain helpers so projection rebuilds read claims in-transaction, without a nested query (which would lose the auth identity in internal contexts). */
export async function loadClaimsForSubject(ctx: QueryCtx, orgId: Id<"orgs">, a: { subjectType: SubjectType; subjectId: string }) {
  const rows = await ctx.db
    .query("claims")
    .withIndex("by_subject", (q) => q.eq("orgId", orgId).eq("subjectType", a.subjectType).eq("subjectId", a.subjectId))
    .take(MAX_CLAIMS + 1);
  return withinLimit(rows, `subject ${a.subjectType}:${a.subjectId}`);
}

export async function loadClaimsForField(
  ctx: QueryCtx,
  orgId: Id<"orgs">,
  a: { subjectType: SubjectType; subjectId: string; field: string },
) {
  const rows = await ctx.db
    .query("claims")
    .withIndex("by_subject_field", (q) =>
      q.eq("orgId", orgId).eq("subjectType", a.subjectType).eq("subjectId", a.subjectId).eq("field", a.field),
    )
    .take(MAX_CLAIMS + 1);
  return withinLimit(rows, `subject ${a.subjectType}:${a.subjectId} field ${a.field}`);
}

export const claimsForSubject = query({
  args: { subjectType, subjectId: v.string() },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    return await loadClaimsForSubject(ctx, orgId, args);
  },
});

export const claimsForField = query({
  args: { subjectType, subjectId: v.string(), field: v.string() },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
    return await loadClaimsForField(ctx, orgId, args);
  },
});

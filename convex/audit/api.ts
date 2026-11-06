import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireRole } from "../_shared/authz";

/**
 * Reading the log is `admin` (spec 7.2: it names who did what, including people, so it is not for every operator).
 * Both reads are PAGINATED: an audit log only grows, so a bounded read that silently stopped at N rows would hide the
 * oldest entries, which are the ones an investigation most needs.
 */
export const recentAudit = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<PaginationResult<Doc<"auditLog">>> => {
    const { orgId } = await requireRole(ctx, "admin");
    return await ctx.db
      .query("auditLog")
      .withIndex("by_org_and_created", (q) => q.eq("orgId", orgId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

/** Every entry about one record, newest first. `targetTable` is a name, `targetId` the record's id string. */
export const auditForTarget = query({
  args: { targetTable: v.string(), targetId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<PaginationResult<Doc<"auditLog">>> => {
    const { orgId } = await requireRole(ctx, "admin");
    return await ctx.db
      .query("auditLog")
      .withIndex("by_org_and_target", (q) => q.eq("orgId", orgId).eq("targetTable", args.targetTable).eq("targetId", args.targetId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

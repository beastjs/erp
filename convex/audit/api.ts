import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { action, internalQuery } from "../_generated/server";
import { requireRole } from "../_shared/authz";
import { recordRefusals } from "../observability/refusals";

/**
 * Reading the log is `admin` (spec 7.2: it names who did what, including people, so it is not for every operator).
 * Both reads are PAGINATED: an audit log only grows, so a bounded read that silently stopped at N rows would hide the
 * oldest entries, which are the ones an investigation most needs.
 *
 * Both are public ACTIONS so that an authorization refusal can be recorded (observability/refusals.ts); each reads in an
 * internal query that checks the role first, with the caller's identity. As actions they are NOT reactive: a client
 * calls them with `useAction` and fetches again to see new entries.
 */
export const recentAudit = action({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<PaginationResult<Doc<"auditLog">>> =>
    await recordRefusals(ctx, "recentAudit", () => ctx.runQuery(internal.audit.api.recentAuditTxn, args)),
});

/** The read behind `recentAudit`. Internal: reachable only through the action above. */
export const recentAuditTxn = internalQuery({
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
export const auditForTarget = action({
  args: { targetTable: v.string(), targetId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<PaginationResult<Doc<"auditLog">>> =>
    await recordRefusals(ctx, "auditForTarget", () => ctx.runQuery(internal.audit.api.auditForTargetTxn, args)),
});

/** The read behind `auditForTarget`. Internal: reachable only through the action above. */
export const auditForTargetTxn = internalQuery({
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

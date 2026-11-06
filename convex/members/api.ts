import { v } from "convex/values";
import { internalMutation, mutation, query } from "../_generated/server";
import { role as roleValidator } from "../_shared/actor";
import { requireRole, systemActor } from "../_shared/authz";
import { withTrustedOrgForInternalOnly } from "../_shared/org";
import { writeAudit } from "../audit/log";

/**
 * Sets (grants, or changes) a user's role in the caller's org. Role: `admin` (spec 7.1: admin manages users). The
 * target is named by the identity's `tokenIdentifier`, never by org: the org is the caller's. An admin may not change
 * their OWN role, so the last admin cannot demote themselves and leave the org with nobody who can manage users.
 * (Demoting a different admin is allowed; `bootstrapMember` is the way back from any lockout.)
 */
export const setMemberRole = mutation({
  args: { userId: v.string(), role: roleValidator },
  handler: async (ctx, args): Promise<null> => {
    const { orgId, actor, userId } = await requireRole(ctx, "admin");
    if (args.userId === "") throw new Error("userId must not be empty");
    if (args.userId === userId) throw new Error("an admin cannot change their own role");
    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_org_and_user", (q) => q.eq("orgId", orgId).eq("userId", args.userId))
      .unique();
    const now = Date.now();
    let id;
    if (existing) {
      id = existing._id;
      await ctx.db.patch(existing._id, { role: args.role, updatedAt: now, grantedBy: actor });
    } else {
      id = await ctx.db.insert("memberships", { orgId, userId: args.userId, role: args.role, createdAt: now, updatedAt: now, grantedBy: actor });
    }
    await writeAudit(ctx, {
      actor,
      action: "member.role_set",
      targetTable: "memberships",
      targetId: id,
      before: existing ? { role: existing.role } : undefined,
      after: { role: args.role },
    });
    return null;
  },
});

/** The caller's own role, for the UI to hide what it cannot do (it hides for comfort; every function still enforces). */
export const myRole = query({
  args: {},
  handler: async (ctx): Promise<string> => (await requireRole(ctx, "operator")).role,
});

/**
 * Creates an org's first admin (or recovers one after a lockout). INTERNAL, run by an operator of the DEPLOYMENT from
 * the dashboard or CLI: that is the trust root, since nobody inside an org can be an admin before one exists. It
 * takes `orgId` because it has no caller identity, and it records itself as the `membership_bootstrap` system process.
 */
export const bootstrapMember = internalMutation({
  args: { orgId: v.id("orgs"), userId: v.string(), role: roleValidator },
  handler: async (ctx, args): Promise<null> => {
    if (args.userId === "") throw new Error("userId must not be empty");
    if (!(await ctx.db.get(args.orgId))) throw new Error("org not found");
    const actor = systemActor("membership_bootstrap");
    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_org_and_user", (q) => q.eq("orgId", args.orgId).eq("userId", args.userId))
      .unique();
    const now = Date.now();
    let id;
    if (existing) {
      id = existing._id;
      await ctx.db.patch(existing._id, { role: args.role, updatedAt: now, grantedBy: actor });
    } else {
      id = await ctx.db.insert("memberships", { orgId: args.orgId, userId: args.userId, role: args.role, createdAt: now, updatedAt: now, grantedBy: actor });
    }
    await writeAudit(withTrustedOrgForInternalOnly(ctx, args.orgId), {
      actor,
      action: "member.role_set",
      targetTable: "memberships",
      targetId: id,
      before: existing ? { role: existing.role } : undefined,
      after: { role: args.role },
    });
    return null;
  },
});

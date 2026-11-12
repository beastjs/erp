import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalMutation, query } from "../_generated/server";
import { role as roleValidator } from "../_shared/actor";
import { requireRole, systemActor } from "../_shared/authz";
import { withTrustedOrgForInternalOnly } from "../_shared/org";
import { writeAudit } from "../audit/log";
import { recordRefusals } from "../observability/refusals";

/**
 * Sets (grants, or changes) a user's role in the caller's org. Role: `admin` (spec 7.1: admin manages users). The
 * target is named by the identity's `tokenIdentifier`, never by org: the org is the caller's. An admin may not change
 * their OWN role.
 *
 * What that guarantees: an org that has an admin keeps one through this endpoint. Every successful call is made by an
 * admin about SOMEONE ELSE, so the caller is still an admin afterwards, and a concurrent demotion of the caller commits
 * first or second but never both (the second then fails `requireRole`). Demoting a different admin is allowed.
 * What it does NOT guarantee: that the org keeps the admin it has. `bootstrapMember` (internal, run by an operator of
 * the DEPLOYMENT) can set any role, including demoting the last admin, and it is also the way back from any lockout.
 * (Pinned by the walk in authz.test.ts.)
 *
 * A public ACTION so that an authorization refusal can be recorded (observability/refusals.ts); the work, and the role
 * check, run in `setMemberRoleTxn` with the caller's identity. Call it with `useAction`.
 */
export const setMemberRole = action({
  args: { userId: v.string(), role: roleValidator },
  handler: async (ctx, args): Promise<null> => await recordRefusals(ctx, "setMemberRole", () => ctx.runMutation(internal.members.api.setMemberRoleTxn, args)),
});

/** The work of `setMemberRole`, in one transaction. Internal: reachable only through the action above. */
export const setMemberRoleTxn = internalMutation({
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

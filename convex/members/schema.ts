import { defineTable } from "convex/server";
import { v } from "convex/values";
import { actor, role } from "../_shared/actor";

/**
 * Who may do what in an org (spec 7.1). The role lives HERE, not in the identity token: a token claim cannot be
 * revoked until it expires, and "admin manages users" needs a record to manage. `userId` is the identity's
 * `tokenIdentifier`. One row per (org, user). A user with no row has no role and can do nothing, whatever the token says.
 * `role` is validated again on every read (`requireRole`): a row written around the validators fails closed.
 */
export const memberships = defineTable({
  orgId: v.id("orgs"),
  userId: v.string(),
  role,
  createdAt: v.number(),
  updatedAt: v.number(),
  /** Who granted the current role. `system` only for the bootstrap of an org's first admin. */
  grantedBy: actor,
}).index("by_org_and_user", ["orgId", "userId"]);

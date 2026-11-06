import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { ROLES, SYSTEM_PROCESSES, type Actor, type Role, type SystemProcess } from "./actor";
import { withOrg } from "./org";

export { ROLES, type Actor, type Role, type SystemProcess } from "./actor";

const RANK: Record<Role, number> = { operator: 1, analyst: 2, admin: 3 };

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Whether `have` may do what `need` may. Fails closed: an unknown role on either side is never enough. */
export function roleSatisfies(have: unknown, need: unknown): boolean {
  return isRole(have) && isRole(need) && RANK[have] >= RANK[need];
}

export type Authorized = { orgId: Id<"orgs">; userId: string; role: Role; actor: Actor };

/**
 * Authorization for PUBLIC functions (spec 7.1: enforced inside Convex, the UI hides things for comfort only).
 * `min` is the LEAST role allowed; roles are ordered operator < analyst < admin.
 *
 * The org comes from the identity (`withOrg`), the user from the identity's `tokenIdentifier`, and the role from the
 * `memberships` row for that pair. FAILS CLOSED on every doubt, and never defaults a role in either direction:
 *   no identity / no org            -> throws (withOrg)
 *   no membership in this org       -> throws; a valid token alone grants nothing
 *   two membership rows             -> throws (`.unique()`): ambiguity is not resolved by picking one
 *   a stored role that is not one of the three -> throws; it is neither the weakest nor the strongest
 *   `min` that is not one of the three         -> throws; a typo at a call site must not mean "anyone"
 * Deliberately has no trusted-org path: a scheduled function has no user and must not be able to pass this check.
 * The returned `actor` is the ONLY way to obtain a `user` actor, so every audit entry and `createdBy` naming a person
 * names one whose role was just verified.
 */
export async function requireRole(ctx: Pick<QueryCtx, "auth" | "db">, min: Role): Promise<Authorized> {
  if (!isRole(min)) throw new Error("forbidden: unknown required role");
  const { orgId } = await withOrg(ctx, {});
  const identity = await ctx.auth.getUserIdentity();
  const userId = identity?.tokenIdentifier;
  if (typeof userId !== "string" || userId === "") throw new Error("forbidden: no identity");
  const member = await ctx.db
    .query("memberships")
    .withIndex("by_org_and_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
    .unique();
  if (!member) throw new Error("forbidden: not a member of this org");
  // Defence in depth: the schema's role validator makes a malformed role unreachable through normal writes, and
  // `roleSatisfies` would refuse it anyway. Its test pins the MESSAGE, so removing this reads as a message regression
  // (the refusal would still happen, worded differently), not as a security one.
  if (!isRole(member.role)) throw new Error("forbidden: malformed membership");
  if (!roleSatisfies(member.role, min)) throw new Error(`forbidden: requires the ${min} role`);
  return { orgId, userId, role: member.role, actor: { kind: "user", userId, role: member.role } };
}

/**
 * The actor for work done by the system on its own: no person is behind it, and it says so by TYPE. Takes a process
 * from a closed set, so it cannot name a person and cannot be given a free-form label. `authz.guard.test.ts` pins
 * every file that calls it: a public handler must never present its caller's action as the system's.
 */
export function systemActor(process: SystemProcess): Actor {
  if (!(SYSTEM_PROCESSES as readonly string[]).includes(process)) throw new Error("unknown system process");
  return { kind: "system", process };
}

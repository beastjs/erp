import { ConvexError } from "convex/values";
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

/**
 * WHY `requireRole` refused, as a closed set. These are the only refusals that are AUTHORIZATION decisions, and the only
 * ones observability records (convex/observability/refusals.ts). Everything else a function throws (a business rule, a
 * missing record, a budget, an org claim naming no org) is not one of these and is never recorded as a refusal.
 */
export const REFUSAL_REASONS = ["no_identity", "not_member", "malformed_membership", "insufficient_role"] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];
export type RefusalData = { code: "forbidden"; reason: RefusalReason };

/**
 * An authorization refusal, typed. A `ConvexError` because its `data` is the one part of an error that survives a call
 * from an action into a mutation or query unchanged: Convex rethrows a plain `Error` crossing that boundary as a NEW
 * `Error(message)` (class lost, message rewritten by the runtime), and a `ConvexError` as a new `ConvexError` with the
 * same `data` (convex/src/server/impl/syscall.ts). So the refusal is classified by `data`, never by class or wording.
 * The message keeps the wording it always had, for people and for tests that read it.
 */
export class AuthorizationRefusal extends ConvexError<RefusalData> {
  constructor(reason: RefusalReason, message: string) {
    super({ code: "forbidden", reason });
    this.message = message;
  }
}

/** The reason of an authorization refusal thrown by `requireRole`, read from the error's DATA; null for any other error. */
export function refusalReasonOf(error: unknown): RefusalReason | null {
  if (typeof error !== "object" || error === null || !(Symbol.for("ConvexError") in error)) return null;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const { code, reason } = data as { code?: unknown; reason?: unknown };
  if (code !== "forbidden" || typeof reason !== "string") return null;
  return (REFUSAL_REASONS as readonly string[]).includes(reason) ? (reason as RefusalReason) : null;
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
 *   two membership rows             -> throws (malformed_membership): ambiguity is not resolved by picking one
 *   a stored role that is not one of the three -> throws; it is neither the weakest nor the strongest
 *   `min` that is not one of the three         -> throws; a typo at a call site must not mean "anyone"
 * Every refusal from a membership decision is an `AuthorizationRefusal` carrying one of REFUSAL_REASONS. "No org" stays
 * a plain error from `withOrg`: such a caller names no org a refusal could be counted against.
 * Deliberately has no trusted-org path: a scheduled function has no user and must not be able to pass this check.
 * The returned `actor` is the ONLY way to obtain a `user` actor, so every audit entry and `createdBy` naming a person
 * names one whose role was just verified.
 */
export async function requireRole(ctx: Pick<QueryCtx, "auth" | "db">, min: Role): Promise<Authorized> {
  if (!isRole(min)) throw new Error("forbidden: unknown required role");
  const { orgId } = await withOrg(ctx, {});
  const identity = await ctx.auth.getUserIdentity();
  const userId = identity?.tokenIdentifier;
  if (typeof userId !== "string" || userId === "") throw new AuthorizationRefusal("no_identity", "forbidden: no identity");
  // take(2), not unique(): two rows for one (org, user) is ambiguous and refused, and refused AS a malformed membership
  // (typed), not as whatever error `.unique()` happens to throw.
  const rows = await ctx.db
    .query("memberships")
    .withIndex("by_org_and_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
    .take(2);
  if (rows.length === 0) throw new AuthorizationRefusal("not_member", "forbidden: not a member of this org");
  if (rows.length > 1) throw new AuthorizationRefusal("malformed_membership", "forbidden: malformed membership (more than one row)");
  const member = rows[0]!;
  // Defence in depth: the schema's role validator makes a malformed role unreachable through normal writes, and
  // `roleSatisfies` would refuse it anyway. Its test pins the MESSAGE, so removing this reads as a message regression
  // (the refusal would still happen, worded differently), not as a security one.
  if (!isRole(member.role)) throw new AuthorizationRefusal("malformed_membership", "forbidden: malformed membership");
  if (!roleSatisfies(member.role, min)) throw new AuthorizationRefusal("insufficient_role", `forbidden: requires the ${min} role`);
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

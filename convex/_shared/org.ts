import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * Org guard for PUBLIC entry points. The org is derived server-side from the caller's identity (`orgId` claim),
 * never from client-supplied args. It deliberately ignores any trusted org carried on the ctx (see `resolveOrg`):
 * a public function must always be authenticated.
 */
export async function withOrg<T>(
  ctx: Pick<QueryCtx, "auth" | "db">,
  args: T,
): Promise<{ orgId: Id<"orgs"> }> {
  void args;
  const identity = await ctx.auth.getUserIdentity();
  const claim = identity?.orgId;
  const orgId =
    typeof claim === "string" ? ctx.db.normalizeId("orgs", claim) : null;
  if (!orgId) throw new Error("no org context");
  return { orgId };
}

/** The ctx field that carries an org an internal function was handed. Written ONLY by `withTrustedOrgForInternalOnly`; org.guard.test.ts forbids any other file naming it. */
type TrustedOrgCtx = { readonly trustedOrgId?: Id<"orgs"> };

/**
 * The org for SHARED helpers (plain functions that run both under a public entry and under scheduled work).
 * A ctx wrapped by `withTrustedOrgForInternalOnly` answers with that org; any other ctx answers exactly as
 * `withOrg` does, from the authenticated identity. Neither path reads args.
 */
export async function resolveOrg(
  ctx: Pick<QueryCtx, "auth" | "db"> & TrustedOrgCtx,
): Promise<{ orgId: Id<"orgs"> }> {
  const trusted = ctx.trustedOrgId;
  if (trusted !== undefined) {
    const orgId = ctx.db.normalizeId("orgs", trusted);
    if (!orgId) throw new Error("no org context");
    return { orgId };
  }
  return await withOrg(ctx, {});
}

/**
 * Runs trusted INTERNAL work as an org that an authenticated entry point already established.
 *
 * Scheduled functions carry no auth identity. A continuation receives `orgId` as an explicit argument of an
 * `internalMutation` and wraps its ctx with this so the shared helpers (which call `resolveOrg`) keep working.
 * It attaches ONLY the org, in `trustedOrgId`, and does NOT touch `auth`: `ctx.auth.getUserIdentity()` still
 * returns what Convex really gave this function (null when scheduled), so code that needs an ACTOR gets null and
 * must handle it, rather than silently receiving a counterfeit one that would be recorded as who did the work.
 *
 * Internal functions are unreachable by clients, so the org cannot be forged; NEVER call this with a value that
 * came from a public function's args or from stored data a client controls. The org was derived from `withOrg`
 * by whichever public function scheduled the work.
 */
export function withTrustedOrgForInternalOnly<C extends object>(ctx: C, orgId: Id<"orgs">): C & { readonly trustedOrgId: Id<"orgs"> } {
  return Object.create(ctx, { trustedOrgId: { value: orgId } }) as C & { readonly trustedOrgId: Id<"orgs"> };
}

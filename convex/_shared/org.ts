import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * Org guard used by every module. The org is derived server-side from the
 * caller's identity (`orgId` claim), never from client-supplied args.
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

/**
 * Runs trusted INTERNAL work as an org that an authenticated entry point already established.
 *
 * Scheduled functions carry no auth identity, so a continuation (an import chunk, an ingest batch)
 * receives `orgId` as an explicit argument of an `internalMutation` and wraps its ctx with this, which
 * lets the shared helpers (all of which call `withOrg`) keep working unchanged. Internal functions are
 * unreachable by clients, so the org cannot be forged; NEVER call this with a value that came from a
 * public function's args or from stored data a client controls. The org was derived from `withOrg` by
 * whichever public function scheduled the work.
 */
export function unsafeCtxAsOrgForInternalOnly<C extends Pick<QueryCtx, "auth">>(ctx: C, orgId: Id<"orgs">): C {
  const auth = {
    getUserIdentity: async () => ({ orgId, subject: "internal", issuer: "internal", tokenIdentifier: `internal|${orgId}` }),
  } as unknown as C["auth"];
  return Object.create(ctx, { auth: { value: auth } }) as C;
}

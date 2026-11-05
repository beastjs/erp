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

import type { convexTest } from "convex-test";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { createIcpVersion as realCreateIcpVersion, createScoringModel as realCreateScoringModel } from "../icp/mutations";
import type { Actor, Role } from "./actor";

/**
 * Test support only (nothing in the product imports this). convex-test's default identity issuer, so the
 * `tokenIdentifier` a test caller presents is predictable and a `memberships` row can be written for it.
 */
export const tokenOf = (subject: string): string => `https://convex.test|${subject}`;

/** The actor the version-creating helpers are given in tests that are not about authorization. A verified-looking user: tests of `requireRole` itself go through the public API. */
export const TEST_ACTOR: Actor = { kind: "user", userId: tokenOf("u1"), role: "analyst" };

type T = ReturnType<typeof convexTest>;

/** Writes a membership row directly (bypassing the admin endpoint on purpose: tests set the world up, they do not test it). */
export async function grant(raw: T, orgId: Id<"orgs">, subject: string, role: Role = "admin"): Promise<void> {
  await raw.run((ctx) =>
    ctx.db.insert("memberships", {
      orgId,
      userId: tokenOf(subject),
      role,
      createdAt: 0,
      updatedAt: 0,
      grantedBy: { kind: "system", process: "membership_bootstrap" },
    }),
  );
}

/** A caller of `orgId`, who holds `role` there. */
export async function asMember(raw: T, subject: string, orgId: Id<"orgs">, role: Role = "admin") {
  await grant(raw, orgId, subject, role);
  return raw.withIdentity({ subject, orgId });
}

export const createIcpVersion = (ctx: MutationCtx, args: Parameters<typeof realCreateIcpVersion>[1]) => realCreateIcpVersion(ctx, args, TEST_ACTOR);
export const createScoringModel = (ctx: MutationCtx, args: Parameters<typeof realCreateScoringModel>[1]) => realCreateScoringModel(ctx, args, TEST_ACTOR);

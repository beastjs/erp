import { defineTable } from "convex/server";
import { v } from "convex/values";
import { REFUSAL_REASONS } from "../_shared/authz";
import type { Domain } from "../audit/log";

/**
 * The admin-tier public functions whose authorization refusals are recorded (Task 16, "Option W"). Each is a public
 * ACTION that runs its work as an internal function and records a refusal in a separate transaction, because the
 * function that refuses cannot record anything: its throw rolls its own writes back, and a query cannot write.
 * Adding one is a decision: authz.guard.test.ts compares this list with the wrapped registrations, whole.
 */
export const REFUSABLE_FUNCTIONS = ["setMemberRole", "requestErasure", "suppressIdentifier", "startRun", "registerSource", "recentAudit", "auditForTarget"] as const;
export type RefusableFunction = (typeof REFUSABLE_FUNCTIONS)[number];
export const refusableFunction = v.union(
  v.literal("setMemberRole"),
  v.literal("requestErasure"),
  v.literal("suppressIdentifier"),
  v.literal("startRun"),
  v.literal("registerSource"),
  v.literal("recentAudit"),
  v.literal("auditForTarget"),
);

export { REFUSAL_REASONS };
export const refusalReason = v.union(v.literal("no_identity"), v.literal("not_member"), v.literal("malformed_membership"), v.literal("insufficient_role"));

/** WHO was refused, as a class. A member is named only by its `membershipId`; anyone else is only `non_member`. */
export const CALLER_CLASSES = ["member", "non_member"] as const;
export type CallerClass = (typeof CALLER_CLASSES)[number];
export const callerClass = v.union(v.literal("member"), v.literal("non_member"));

/**
 * Each stored field's domain, declared the way convex/audit/log.ts declares audit fields: a closed set of strings or a
 * bounded integer, and nothing else. `recordRefusal` checks every field against these before it writes (and the schema
 * validators above enforce the same sets; a test pins that they agree). `orgId` and `membershipId` are ids the recorder
 * looked up itself (the caller's org, the caller's own membership in it, or null), never values it was handed.
 */
export const REFUSAL_DOMAINS = {
  hour: { int: [0, 8_640_000_000_000_000] },
  fn: { enum: REFUSABLE_FUNCTIONS },
  reason: { enum: REFUSAL_REASONS },
  callerClass: { enum: CALLER_CLASSES },
  count: { int: [1, Number.MAX_SAFE_INTEGER] },
} as const satisfies Record<string, Domain>;

/**
 * Refusal counters: one row per (org, hour, function, reason, caller class, membership or none), whose `count` is
 * incremented in place. Holds NO identifier of a non-member (no `tokenIdentifier`, no hash of one: a hash of an
 * identifier is still that identity), no `userId`, no free text, no error message. Written by exactly one function,
 * which only inserts `count: 1` or increments (pinned by authz.guard.test.ts, net R).
 */
export const refusalCounts = defineTable({
  orgId: v.id("orgs"),
  /** Start of the hour, epoch ms, from the RECORDER's clock (never the caller's). */
  hour: v.number(),
  fn: refusableFunction,
  reason: refusalReason,
  callerClass,
  /** The refused member's membership; null for `non_member`. */
  membershipId: v.union(v.id("memberships"), v.null()),
  count: v.number(),
}).index("by_org_and_bucket", ["orgId", "hour", "fn", "reason", "callerClass", "membershipId"]);

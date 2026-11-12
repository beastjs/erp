import { defineTable } from "convex/server";
import { v } from "convex/values";
import { subjectType } from "../claims/schema";

export const VERIFICATION_KINDS = ["email", "phone"] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];
export const verificationKind = v.union(v.literal("email"), v.literal("phone"));

export const OUTCOMES = ["pass", "fail", "unknown"] as const;
export const verificationOutcome = v.union(v.literal("pass"), v.literal("fail"), v.literal("unknown"));

/** WHY, as a closed set. A reason never carries any part of the value it is about. */
export const REASONS = ["ok", "empty", "not_text", "too_long", "syntax", "domain_shape", "non_ascii", "disposable", "role", "bad_length", "ambiguous_length"] as const;
export type VerificationReason = (typeof REASONS)[number];
export const verificationReason = v.union(
  v.literal("ok"),
  v.literal("empty"),
  v.literal("not_text"),
  v.literal("too_long"),
  v.literal("syntax"),
  v.literal("domain_shape"),
  v.literal("non_ascii"),
  v.literal("disposable"),
  v.literal("role"),
  v.literal("bad_length"),
  v.literal("ambiguous_length"),
);

/** Who judged. v1 is `structural` only; a provider-backed verifier adds its literal here. */
export const verificationProvider = v.literal("structural");

/*
 * CONTENT-FREE BY CONSTRUCTION (Task 15). A verification is the third table in this plan that could have become an
 * un-erasable store of personal data (after `leads.snapshot` and `importChunks.rows`), so this row holds NO value:
 * not the email, not the phone, not the domain, not the local part. It names the claim that was judged (`claimId`,
 * an opaque id whose value erasure redacts in place) and records only the verdict, from closed sets:
 *
 *   ids         orgId, subjectId, claimId
 *   literals    subjectType, kind, outcome, reason, provider
 *   numbers     logic (a 32-bit fingerprint of the rules that judged it), checkedAt (a timestamp)
 *
 * There is NO string, object, array or `v.any()` column, and a test walks this definition and fails if one appears,
 * so that the safety does not depend on every current call site happening to pass something harmless (Task 14 M1).
 * That is why erasure has nothing to redact here and the all-tables sweep over it is a real check, not a hope.
 *
 * Append-only (guarded by verify/verify.guard.test.ts): history is the point. A list change re-runs the stage and
 * ADDS a row under the new `logic`; the old row stays, saying what the rules said then. The scorer reads the latest
 * row for the claim that currently wins the field, so a verdict on a superseded email never counts.
 */
export const verifications = defineTable({
  orgId: v.id("orgs"),
  subjectType,
  subjectId: v.union(v.id("accounts"), v.id("contacts")),
  claimId: v.id("claims"),
  kind: verificationKind,
  outcome: verificationOutcome,
  reason: verificationReason,
  provider: verificationProvider,
  logic: v.number(),
  checkedAt: v.number(),
})
  // The latest verdict on one claim is an exact-key read, newest first.
  .index("by_org_and_claim", ["orgId", "claimId"]);

/*
 * One row per org: how far the re-judge sweep (verify/sweep.ts) has walked under the CURRENT rules. This is what makes
 * the sweep cheap when nothing is stale: once `done` is set for today's `logic`, a tick reads this one row per org and
 * schedules nothing. A rules change (a list edit or a revision bump) changes `logic`, which reads as "not done" and
 * restarts the walk from the first subject.
 *
 * Content-free like `verifications`: ids, a number and a boolean. `after` is the last pipelineState `subjectId` the
 * walk finished (an opaque contact id), so the walk resumes by an exact index range, not by a stored cursor string.
 * `leaseUntil` is written ONLY by a slice that committed: a slice that throws leaves the previous one's lease, which
 * expires, and the next tick resumes from the last committed `after`. Nothing records a failure (Task 13's rule).
 */
export const verificationSweeps = defineTable({
  orgId: v.id("orgs"),
  logic: v.number(),
  after: v.optional(v.id("contacts")),
  done: v.boolean(),
  leaseUntil: v.number(),
}).index("by_org", ["orgId"]);

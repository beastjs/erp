import { defineTable } from "convex/server";
import { v } from "convex/values";
import { actor } from "../_shared/actor";
import { subjectType } from "../claims/schema";

export const SUPPRESSION_REASONS = ["erasure", "opt_out", "complaint", "manual"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];
export const suppressionReason = v.union(v.literal("erasure"), v.literal("opt_out"), v.literal("complaint"), v.literal("manual"));

/**
 * Spec 7.3: identifiers that must not re-enter. Stores a KEYED hash, never the identifier: a leaked table must not be a
 * list of the people who asked to be forgotten. `hash` is HMAC-SHA256 under the deployment's secret over
 * `kind:normalized` (see suppress.ts). `saltId` is a fingerprint of the key that produced it, so a changed key is
 * DETECTED (every lookup would otherwise silently miss) instead of quietly emptying the list.
 * Per-org: an erasure request is made to one controller. Append-only; no code path deletes a row.
 */
export const suppressions = defineTable({
  orgId: v.id("orgs"),
  hash: v.string(),
  kind: v.union(v.literal("email"), v.literal("domain"), v.literal("phone"), v.literal("profile")),
  reason: suppressionReason,
  saltId: v.string(),
  createdAt: v.number(),
}).index("by_org_and_hash", ["orgId", "hash"]);

/**
 * ACCOUNTABILITY for an erasure: who asked, why, and on what legal basis. All closed vocabularies plus an opaque case
 * reference, never free text: this row is permanent (it is the proof the erasure happened), so a "reason" field that
 * accepted prose would be where someone types the data subject's name and re-creates what was just erased.
 */
export const LEGAL_BASES = ["gdpr_art17_erasure", "ccpa_deletion", "consent_withdrawn", "legal_obligation", "controller_decision"] as const;
export type LegalBasis = (typeof LEGAL_BASES)[number];
export const legalBasis = v.union(
  v.literal("gdpr_art17_erasure"),
  v.literal("ccpa_deletion"),
  v.literal("consent_withdrawn"),
  v.literal("legal_obligation"),
  v.literal("controller_decision"),
);
export const ERASURE_REASONS = ["data_subject_request", "opt_out", "complaint", "regulator_order", "data_quality"] as const;
export type ErasureReason = (typeof ERASURE_REASONS)[number];
export const erasureReason = v.union(
  v.literal("data_subject_request"),
  v.literal("opt_out"),
  v.literal("complaint"),
  v.literal("regulator_order"),
  v.literal("data_quality"),
);
/** An opaque case or ticket id (letters, digits, `._:-`, at least one digit, so a bare name does not pass). Heuristic: it keeps prose out, it cannot prove an id is not a name. */
export const REFERENCE_PATTERN = /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;

/**
 * The fact that a subject was erased, and how far the erasure has got. Contains NO personal data: ids, counts and
 * times. Its existence is what makes an erased subject inert (no new claims or signals, no pipeline, empty projection)
 * and it survives as the proof that the erasure happened. One row per subject. `completedAt` absent = still in
 * progress (a subject with more rows than one transaction handles is erased across several calls).
 * Who requested it, why, and on what basis IS recorded here (`requestedBy`, `reasonCode`, `legalBasis`, `reference`):
 * it is the record that matters if the erasure is ever challenged, so it lives on the row that proves the erasure.
 *
 * LIVENESS. An in-progress erasure is carried by a self-scheduled chain, and a scheduled mutation that throws is NOT
 * retried by the platform, so the chain can die with the person half-erased. `resumeAt` is therefore the time before
 * which nobody need look: every successful call pushes it forward, and the sweeper (privacy/sweep.ts, driven by a
 * cron) re-runs any row that is incomplete and past it. A transaction that throws rolls its own writes back, so
 * `resumeAt` is by construction the time of the last call that COMMITTED, plus the grace period. `attempts`,
 * `lastError` and `failedAt` are written only by the caller that caught a failure; a successful call clears them.
 */
export const erasures = defineTable({
  orgId: v.id("orgs"),
  subjectType,
  subjectId: v.string(),
  requestedAt: v.number(),
  requestedBy: actor,
  reasonCode: erasureReason,
  legalBasis,
  reference: v.string(),
  completedAt: v.optional(v.number()),
  resumeAt: v.optional(v.number()),
  attempts: v.optional(v.number()),
  lastError: v.optional(v.string()),
  failedAt: v.optional(v.number()),
  claimsRedacted: v.number(),
  contactKeysDeleted: v.number(),
  candidatesRedacted: v.number(),
  signalsRedacted: v.number(),
  leadsRedacted: v.number(),
  suppressionsAdded: v.number(),
})
  .index("by_subject", ["orgId", "subjectType", "subjectId"])
  .index("by_org_and_completed_and_resume", ["orgId", "completedAt", "resumeAt"]);

/**
 * Raw crawl snapshots (R2) that the redacted claims pointed at. They live OUTSIDE this database and hold the same
 * personal data as the claim values erasure just overwrote, so the references are recorded here, durably and in the
 * same transaction as the redaction, for whatever deletes the objects. A child table, not an array on `erasures`: a
 * subject can have thousands. `deletedAt` is for that deleter to stamp; nothing in Core sets it.
 * The reference itself is an opaque storage key and must not carry personal data.
 */
export const erasureSnapshotRefs = defineTable({
  orgId: v.id("orgs"),
  erasureId: v.id("erasures"),
  ref: v.string(),
  recordedAt: v.number(),
  deletedAt: v.optional(v.number()),
})
  .index("by_org_and_erasure_and_ref", ["orgId", "erasureId", "ref"])
  .index("by_org_and_deleted", ["orgId", "deletedAt"]);

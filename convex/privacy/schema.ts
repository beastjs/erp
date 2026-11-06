import { defineTable } from "convex/server";
import { v } from "convex/values";
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
 * The fact that a subject was erased, and how far the erasure has got. Contains NO personal data: ids, counts and
 * times. Its existence is what makes an erased subject inert (no new claims or signals, no pipeline, empty projection)
 * and it survives as the proof that the erasure happened. One row per subject. `completedAt` absent = still in
 * progress (a subject with more rows than one transaction handles is erased across several calls).
 * Who requested it is NOT recorded here: that belongs to Task 14's audit log.
 */
export const erasures = defineTable({
  orgId: v.id("orgs"),
  subjectType,
  subjectId: v.string(),
  requestedAt: v.number(),
  completedAt: v.optional(v.number()),
  claimsRedacted: v.number(),
  contactKeysDeleted: v.number(),
  candidatesRedacted: v.number(),
  signalsRedacted: v.number(),
  leadsRedacted: v.number(),
  suppressionsAdded: v.number(),
}).index("by_subject", ["orgId", "subjectType", "subjectId"]);

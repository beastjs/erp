import { defineTable } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";

export const claimMethod = v.union(
  v.literal("observed"),
  v.literal("extracted"),
  v.literal("inferred"),
);
export const subjectType = v.union(v.literal("account"), v.literal("contact"));

export type ClaimMethod = "observed" | "extracted" | "inferred";
export type SubjectType = "account" | "contact";
export type Claim = Doc<"claims">;

/**
 * Append-only: one row is one field assertion. Rows are never patched,
 * replaced or deleted; a newer claim supersedes an older one at read time.
 * THE ONE EXCEPTION is erasure (spec 7.3, privacy/redact.ts): it overwrites `value` with null and stamps `redactedAt`.
 * Everything else about the claim (source, method, confidence, observedAt, field) survives. A redacted claim is
 * excluded from projections by the PRESENCE of `redactedAt`; its time is never read. A guard test pins redact.ts as
 * the only writer.
 */
export const claims = defineTable({
  orgId: v.id("orgs"),
  subjectType,
  // Account/contact tables do not exist yet (Task 4), so the subject is a string key.
  subjectId: v.string(),
  field: v.string(),
  value: v.any(),
  sourceId: v.id("sources"),
  method: claimMethod,
  confidence: v.number(),
  observedAt: v.number(),
  snapshotRef: v.optional(v.string()),
  runId: v.optional(v.id("discoveryRuns")),
  /** Set by erasure alone. When present, `value` is null and the claim contributes to no projection. */
  redactedAt: v.optional(v.number()),
})
  .index("by_subject", ["orgId", "subjectType", "subjectId"])
  .index("by_subject_field", ["orgId", "subjectType", "subjectId", "field"])
  // Erasure finds what is still unredacted with an exact-key read, so it is resumable with no cursor.
  .index("by_subject_redacted", ["orgId", "subjectType", "subjectId", "redactedAt"])
  // Observability (Task 16): the org's newest claims, by creation, for the declared data-quality sample.
  .index("by_org", ["orgId"]);

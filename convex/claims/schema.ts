import { defineTable } from "convex/server";
import { v } from "convex/values";

export const claimMethod = v.union(
  v.literal("observed"),
  v.literal("extracted"),
  v.literal("inferred"),
);
export const subjectType = v.union(v.literal("account"), v.literal("contact"));

export type ClaimMethod = "observed" | "extracted" | "inferred";
export type SubjectType = "account" | "contact";

/**
 * Append-only: one row is one field assertion. Rows are never patched,
 * replaced or deleted; a newer claim supersedes an older one at read time.
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
})
  .index("by_subject", ["orgId", "subjectType", "subjectId"])
  .index("by_subject_field", ["orgId", "subjectType", "subjectId", "field"]);

import { defineTable } from "convex/server";
import { v } from "convex/values";

export const sourceKind = v.union(
  v.literal("csv"),
  v.literal("manual"),
  v.literal("crm"),
  v.literal("crawler"),
);
export type SourceKind = "csv" | "manual" | "crm" | "crawler";

/** Spec §7.4: a documented lawful basis per source (GDPR Art. 6(1) bases). */
export const lawfulBasis = v.union(
  v.literal("consent"),
  v.literal("contract"),
  v.literal("legal_obligation"),
  v.literal("vital_interests"),
  v.literal("public_task"),
  v.literal("legitimate_interest"),
);
export type LawfulBasis =
  | "consent"
  | "contract"
  | "legal_obligation"
  | "vital_interests"
  | "public_task"
  | "legitimate_interest";

export const sources = defineTable({
  orgId: v.id("orgs"),
  key: v.string(),
  kind: sourceKind,
  /** In [0, 1]. Missing/foreign sources resolve as 0 in claim comparison. */
  trustWeight: v.number(),
  lawfulBasis,
}).index("by_org_and_key", ["orgId", "key"]);

/** Normalized pending input. Never read by projections; consumed by the ingest stage. */
export const candidates = defineTable({
  orgId: v.id("orgs"),
  sourceId: v.id("sources"),
  runId: v.optional(v.id("discoveryRuns")),
  dedupeHash: v.string(),
  /** Dedupe applies to pending rows only: a re-observation after consumption must insert fresh. Ingest (Task 7) owns the transitions. */
  status: v.union(v.literal("pending"), v.literal("consumed"), v.literal("rejected")),
  contractVersion: v.string(),
  candidate: v.any(), // validated by validateCandidate at the write boundary
}).index("by_org_and_dedupe_hash_and_status", ["orgId", "dedupeHash", "status"]);

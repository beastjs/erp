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
  /** Why ingest turned the candidate away; set only with status "rejected". */
  rejectionReason: v.optional(v.string()),
  /** The version the PRODUCER declared (Core's own for in-process sources), not the consumer's. */
  contractVersion: v.string(),
  candidate: v.any(), // validated by validateCandidate at the write boundary
})
  .index("by_org_and_dedupe_hash_and_status", ["orgId", "dedupeHash", "status"])
  .index("by_org_and_run_and_status", ["orgId", "runId", "status"]);

/**
 * Header -> target field, saved per org. Stored as pairs, not a record: spreadsheet headers are
 * free-form and Convex record keys may not start with `$` or `_`.
 */
export const columnMappings = defineTable({
  orgId: v.id("orgs"),
  name: v.string(),
  columns: v.array(v.object({ column: v.string(), target: v.string() })),
}).index("by_org_and_name", ["orgId", "name"]);

/**
 * A parsed CSV slice waiting for its turn in the self-scheduling import chain. Cells are positional
 * (aligned with `columns`) because headers are free-form and cannot all be record keys. Deleted in
 * the same transaction that imports it, so what remains for a run is exactly what is still to do.
 */
export const importChunks = defineTable({
  orgId: v.id("orgs"),
  runId: v.id("discoveryRuns"),
  mappingId: v.id("columnMappings"),
  seq: v.number(),
  /** Index of rows[0] in the original file (chunks are byte-bounded, so seq*500 would be wrong). */
  rowOffset: v.number(),
  columns: v.array(v.string()),
  rows: v.array(v.array(v.string())),
}).index("by_run_and_seq", ["runId", "seq"]);

/** Rows a chunked import turned away, kept because the chain has no caller to return them to. */
export const importRejections = defineTable({
  orgId: v.id("orgs"),
  runId: v.id("discoveryRuns"),
  row: v.number(),
  errors: v.array(v.string()),
}).index("by_run", ["runId", "row"]);

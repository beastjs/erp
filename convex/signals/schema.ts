import { defineTable } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { subjectType } from "../claims/schema";

export const signalStrength = v.union(v.literal("high"), v.literal("medium"), v.literal("low"));
export type SignalStrength = "high" | "medium" | "low";
export type Signal = Doc<"signals">;

/**
 * Append-only: one row is one dated event at a subject (funding, hire, expansion...).
 * Rows are never patched or deleted; staleness is expressed at read time by decay and expiresAt.
 */
export const signals = defineTable({
  orgId: v.id("orgs"),
  subjectType,
  // Canonical id of an accounts/contacts row, stored as a string like claims.subjectId.
  subjectId: v.string(),
  kind: v.string(),
  strength: signalStrength,
  confidence: v.number(),
  observedAt: v.number(),
  expiresAt: v.optional(v.number()),
  // Which source reported the event; part of the exact-duplicate key in appendSignal.
  sourceId: v.optional(v.id("sources")),
  /**
   * The reporter's own identity for the event (an id from the provider, a webhook delivery key). When present
   * it IS the event's identity: a retry of the same event is a no-op however its observedAt was reported, and two
   * genuinely distinct events on one day are told apart. Absent, identity falls back to the exact
   * (subject, kind, observedAt, sourceId) tuple.
   */
  externalId: v.optional(v.string()),
})
  .index("by_subject_observed", ["orgId", "subjectType", "subjectId", "observedAt"])
  // Idempotency lookups. Both end in an exact key, so `.first()` decides existence with no bound to truncate at.
  .index("by_subject_external", ["orgId", "subjectType", "subjectId", "kind", "sourceId", "externalId"])
  .index("by_subject_event", ["orgId", "subjectType", "subjectId", "kind", "observedAt", "sourceId", "externalId"])
  // Recorded-at order (the implicit _creationTime), so staleness can ask "any signal since the score?" in one read.
  .index("by_subject_created", ["orgId", "subjectType", "subjectId"]);

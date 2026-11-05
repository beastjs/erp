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
}).index("by_subject_observed", ["orgId", "subjectType", "subjectId", "observedAt"]);

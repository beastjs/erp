import { defineTable } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";

export type IcpDefinition = Doc<"icpDefinitions">;
export type ScoringModel = Doc<"scoringModels">;

export const tier = v.union(v.literal("S"), v.literal("A"), v.literal("B"), v.literal("C"), v.literal("Reject"));
export type Tier = "S" | "A" | "B" | "C" | "Reject";
/** Highest tier first. The order is part of the contract: floors must not rise as the tier falls. */
export const TIERS: readonly Tier[] = ["S", "A", "B", "C", "Reject"];

const perStrength = v.object({ high: v.number(), medium: v.number(), low: v.number() });
const perTier = v.object({ S: v.number(), A: v.number(), B: v.number(), C: v.number(), Reject: v.number() });

/** What an ICP asks for, by the five playbook dimensions that the scoring engine can read today. */
export const icpCriteria = v.object({
  industries: v.array(v.string()),
  geographies: v.array(v.string()),
  technologies: v.array(v.string()),
  decisionMakerRoles: v.array(v.string()),
  employeeMin: v.optional(v.number()),
  employeeMax: v.optional(v.number()),
});
export type IcpCriteria = {
  industries: string[];
  geographies: string[];
  technologies: string[];
  decisionMakerRoles: string[];
  employeeMin?: number;
  employeeMax?: number;
};

/** The tunable numbers, without row bookkeeping. This is the shape that pure scoring code receives. */
export const scoringConfig = {
  /** Points out of 100 for each score component. Sums to exactly 100. */
  weights: v.object({ companyFit: v.number(), contactFit: v.number(), intent: v.number() }),
  /** Half-open score ranges [min, max), covering 0..100 with no gap or overlap; the top band includes 100. */
  tierBands: v.array(v.object({ tier, min: v.number(), max: v.number() })),
  /** Minimum confidence (0..1) a score needs to hold each tier. */
  confidenceFloors: perTier,
  /** Highest confidence a claim of each method may carry. */
  methodCeilings: v.object({ observed: v.number(), extracted: v.number(), inferred: v.number() }),
  /** Base weight of a fresh signal of each strength. */
  strengthWeights: perStrength,
  /** Milliseconds for a signal's weight to halve. */
  decayHalfLives: perStrength,
  /** Milliseconds for a claim's weight in confidence to fall halfway to its floor (0.5). */
  claimHalfLifeMs: v.number(),
  /** Multiplier on confidence for each verification kind whose latest result failed. In (0, 1]. */
  failedVerificationFactor: v.number(),
  /** Lowest freshness multiplier an arbitrarily old claim reaches, in [0, 1]. */
  claimFreshnessFloor: v.number(),
  /** Company-size credit in [0, 1] when the company's range overlaps the ICP range without fitting inside it. */
  sizeOverlapCredit: v.number(),
};

export type ScoringConfig = {
  weights: { companyFit: number; contactFit: number; intent: number };
  tierBands: Array<{ tier: Tier; min: number; max: number }>;
  confidenceFloors: Record<Tier, number>;
  methodCeilings: { observed: number; extracted: number; inferred: number };
  strengthWeights: { high: number; medium: number; low: number };
  decayHalfLives: { high: number; medium: number; low: number };
  claimHalfLifeMs: number;
  failedVerificationFactor: number;
  claimFreshnessFloor: number;
  sizeOverlapCredit: number;
};

/**
 * APPEND-ONLY. A new version is a new row; no code path patches or deletes one, because every
 * scoreRun cites a row by id and would silently change meaning if the row changed.
 * `version` counts up per org from 1; `supersedesId` links to the previous version (absent on v1).
 */
export const icpDefinitions = defineTable({
  orgId: v.id("orgs"),
  version: v.number(),
  name: v.string(),
  criteria: icpCriteria,
  supersedesId: v.optional(v.id("icpDefinitions")),
  createdBy: v.string(),
  activeFrom: v.number(),
}).index("by_org_and_version", ["orgId", "version"]);

/** APPEND-ONLY, same rules as icpDefinitions. */
export const scoringModels = defineTable({
  orgId: v.id("orgs"),
  version: v.number(),
  ...scoringConfig,
  supersedesId: v.optional(v.id("scoringModels")),
  createdBy: v.string(),
  activeFrom: v.number(),
}).index("by_org_and_version", ["orgId", "version"]);

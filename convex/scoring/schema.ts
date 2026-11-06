import { defineTable } from "convex/server";
import { v } from "convex/values";
import { subjectType } from "../claims/schema";
import { tier } from "../icp/schema";

export const contribution = v.object({
  factor: v.string(),
  input: v.number(),
  weight: v.number(),
  contributed: v.number(),
});

/**
 * APPEND-ONLY, like claims, signals and leads. A rescore is a new row; no code path patches or
 * deletes one. The row stores the per-factor contributions so the UI explains a score by reading it,
 * never by recomputing it, and cites the exact immutable icp version and scoring model it ran under.
 */
export const scoreRuns = defineTable({
  orgId: v.id("orgs"),
  subjectType,
  subjectId: v.string(),
  icpVersionId: v.id("icpDefinitions"),
  scoringModelId: v.id("scoringModels"),
  fit: v.number(),
  intent: v.number(),
  score: v.number(),
  confidence: v.number(),
  priority: v.number(),
  tier,
  contributions: v.array(contribution),
  /**
   * True when a scored subject has an active inbound identityLink. `activeSignals` does not follow
   * links, so the merged-away subject's signals were not counted and `intent` (and the tier built on it)
   * may be understated. Recorded rather than silently baked in; link traversal itself is unowned.
   */
  intentMayBeStranded: v.boolean(),
  scoredAt: v.number(),
}).index("by_subject", ["orgId", "subjectType", "subjectId", "scoredAt"]);

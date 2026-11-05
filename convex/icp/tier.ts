import { TIERS, type ScoringConfig, type Tier } from "./schema";

/**
 * Tier for a score, gated by confidence. Bands are half-open [min, max), so exactly 90 is S and 89.99
 * is A; the top band also owns 100. A score that lands in a band whose confidence floor it does not
 * meet drops to the next tier down whose floor it does meet (a 92 below the S floor is not S).
 * Fail closed: a non-finite or out-of-range score or confidence is "Reject".
 */
export function tierFor(score: number, confidence: number, config: Pick<ScoringConfig, "tierBands" | "confidenceFloors">): Tier {
  if (!(Number.isFinite(score) && score >= 0 && score <= 100)) return "Reject";
  if (!(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1)) return "Reject";
  const band = config.tierBands.find((b) => (score >= b.min && score < b.max) || (b.max === 100 && score === 100));
  if (!band) return "Reject";
  for (let i = TIERS.indexOf(band.tier); i < TIERS.length; i++) {
    if (confidence >= config.confidenceFloors[TIERS[i]]) return TIERS[i];
  }
  return "Reject";
}

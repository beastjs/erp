import type { ScoringConfig } from "./schema";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * v1 tuning (spec 5.2-5.4). Used as the fallback when an org has not created a model yet, and as the
 * seed for its first. Bands are half-open: "A 80-89" is [80, 90), so a fractional 89.5 is an A, not a gap.
 * Confidence floors are a tuning choice of this task (the spec fixes the mechanism, not the numbers).
 */
export const DEFAULT_SCORING_MODEL: ScoringConfig = {
  weights: { companyFit: 35, contactFit: 20, intent: 45 },
  tierBands: [
    { tier: "Reject", min: 0, max: 60 },
    { tier: "C", min: 60, max: 70 },
    { tier: "B", min: 70, max: 80 },
    { tier: "A", min: 80, max: 90 },
    { tier: "S", min: 90, max: 100 },
  ],
  confidenceFloors: { S: 0.8, A: 0.7, B: 0.6, C: 0.5, Reject: 0 },
  methodCeilings: { observed: 1.0, extracted: 0.7, inferred: 0.5 },
  strengthWeights: { high: 1, medium: 0.6, low: 0.25 },
  decayHalfLives: { high: 90 * DAY_MS, medium: 45 * DAY_MS, low: 14 * DAY_MS },
  claimHalfLifeMs: 365 * DAY_MS,
  failedVerificationFactor: 0.5,
};

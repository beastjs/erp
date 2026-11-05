import type { Signal, SignalStrength } from "./schema";

export type { Signal, SignalStrength } from "./schema";

/**
 * The slice of a scoring model that decay needs. Callers pass a `scoringModels` row (or
 * DEFAULT_SCORING_MODEL) directly; this stays a plain structural type so the functions below remain
 * pure and database-free, and a second caller (scoring) reuses the same shape.
 */
export type DecayParams = {
  strengthWeights: Record<SignalStrength, number>;
  decayHalfLives: Record<SignalStrength, number>;
};

/** Strength defaults per spec section 5.3, keyed by signal kind. */
export const DEFAULT_STRENGTH_BY_KIND: Record<string, SignalStrength> = {
  funding_announcement: "high",
  executive_hired: "high",
  major_expansion: "high",
  relevant_hiring: "medium",
  technology_detected: "medium",
  website_activity: "low",
};

/**
 * Decayed weight of a signal at `now`: STRENGTH_WEIGHTS * 0.5^(age / halfLife).
 * An expired signal (now >= expiresAt) is 0 regardless of how much of its half-life remains; an
 * unexpired one decays normally. Age is clamped at 0, so a future-dated signal is full weight.
 * Total: always a finite number in [0, strengthWeights[strength]]; unusable input yields 0.
 * Confidence is deliberately not applied here; the caller combines it.
 */
export function decayedWeight(
  signal: Pick<Signal, "strength" | "observedAt" | "expiresAt">,
  now: number,
  params: DecayParams,
): number {
  const base = params.strengthWeights[signal.strength];
  const halfLife = params.decayHalfLives[signal.strength];
  // Fail closed on unusable config as well as unusable input: no weight, never NaN.
  if (!(Number.isFinite(base) && base > 0 && Number.isFinite(halfLife) && halfLife > 0)) return 0;
  if ( !Number.isFinite(now) || !Number.isFinite(signal.observedAt)) return 0;
  if (signal.expiresAt !== undefined && !(now < signal.expiresAt)) return 0;
  const age = Math.max(0, now - signal.observedAt);
  const w = base * Math.pow(0.5, age / halfLife);
  return Number.isFinite(w) && w > 0 ? w : 0;
}

/**
 * What a signal contributes to intent: decayedWeight x confidence. INTENT SCORING MUST USE THIS,
 * NOT decayedWeight, or an unverified rumour counts as much as a confirmed announcement.
 * Same guarantees as decayedWeight: finite, never negative, never above the strength's base weight.
 */
export function signalContribution(
  signal: Pick<Signal, "strength" | "observedAt" | "expiresAt" | "confidence">,
  now: number,
  params: DecayParams,
): number {
  const c = signal.confidence;
  // Fail closed: out-of-range confidence (including +Infinity, and finite values above 1) is 0, never clamped.
  if (!Number.isFinite(c) || c <= 0 || c > 1) return 0;
  const w = decayedWeight(signal, now, params) * c;
  return Number.isFinite(w) && w > 0 ? w : 0;
}

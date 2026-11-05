import type { Signal, SignalStrength } from "./schema";

export type { Signal, SignalStrength } from "./schema";

/** Base weight of a fresh signal. Task 9 moves this to scoring-model config. */
export const STRENGTH_WEIGHTS: Record<SignalStrength, number> = {
  high: 1,
  medium: 0.6,
  low: 0.25,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Half-life per strength. A funding round or exec hire stays a meaningful buying trigger for a
 * quarter; relevant hiring and tech detection are sustained but fade in about six weeks; generic
 * website activity is noise within two weeks. Task 9 moves this to scoring-model config.
 */
export const HALF_LIFE_MS: Record<SignalStrength, number> = {
  high: 90 * DAY_MS,
  medium: 45 * DAY_MS,
  low: 14 * DAY_MS,
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
 * Total: always a finite number in [0, STRENGTH_WEIGHTS[strength]]; unusable input yields 0.
 * Confidence is deliberately not applied here; the caller combines it.
 */
export function decayedWeight(
  signal: Pick<Signal, "strength" | "observedAt" | "expiresAt">,
  now: number,
): number {
  const base = STRENGTH_WEIGHTS[signal.strength];
  const halfLife = HALF_LIFE_MS[signal.strength];
  if (base === undefined || !Number.isFinite(now) || !Number.isFinite(signal.observedAt)) return 0;
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
): number {
  const c = signal.confidence;
  // Fail closed: out-of-range confidence (including +Infinity, and finite values above 1) is 0, never clamped.
  if (!Number.isFinite(c) || c <= 0 || c > 1) return 0;
  const w = decayedWeight(signal, now) * c;
  return Number.isFinite(w) && w > 0 ? w : 0;
}

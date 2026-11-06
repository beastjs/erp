import { TIERS, type IcpCriteria, type ScoringConfig } from "./schema";

const METHODS = ["observed", "extracted", "inferred"] as const;
const STRENGTHS = ["high", "medium", "low"] as const;

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
/** Negated comparisons throughout: NaN fails every one of them, so it is rejected, never waved through. */
const unit = (n: unknown): n is number => finite(n) && n >= 0 && n <= 1;

/**
 * Fails closed on any scoring config that could put a NaN, an unreachable tier or a silently
 * re-weighted score into arithmetic. Throws on the first problem; returns nothing.
 */
export function validateScoringConfig(c: ScoringConfig): void {
  const w = c.weights;
  for (const k of ["companyFit", "contactFit", "intent"] as const) {
    if (!(finite(w?.[k]) && w[k] >= 0 && w[k] <= 100)) throw new Error(`weights.${k} must be a finite number in [0, 100]`);
  }
  if (w.companyFit + w.contactFit + w.intent !== 100) throw new Error("weights must sum to exactly 100");

  for (const m of METHODS) {
    if (!(finite(c.methodCeilings?.[m]) && c.methodCeilings[m] > 0 && c.methodCeilings[m] <= 1)) {
      throw new Error(`methodCeilings.${m} must be a finite number in (0, 1]`);
    }
  }
  for (const s of STRENGTHS) {
    if (!(finite(c.strengthWeights?.[s]) && c.strengthWeights[s] > 0 && c.strengthWeights[s] <= 1)) {
      throw new Error(`strengthWeights.${s} must be a finite number in (0, 1]`);
    }
    if (!(finite(c.decayHalfLives?.[s]) && c.decayHalfLives[s] > 0)) {
      throw new Error(`decayHalfLives.${s} must be a finite number > 0`);
    }
  }

  if (!(finite(c.claimHalfLifeMs) && c.claimHalfLifeMs > 0)) throw new Error("claimHalfLifeMs must be a finite number > 0");
  if (!(finite(c.failedVerificationFactor) && c.failedVerificationFactor > 0 && c.failedVerificationFactor <= 1)) {
    throw new Error("failedVerificationFactor must be a finite number in (0, 1]");
  }
  for (const k of ["claimFreshnessFloor", "sizeOverlapCredit"] as const) {
    if (!unit(c[k])) throw new Error(`${k} must be a finite number in [0, 1]`);
  }

  let previousFloor = Infinity;
  for (const t of TIERS) {
    const f = c.confidenceFloors?.[t];
    if (!unit(f)) throw new Error(`confidenceFloors.${t} must be a finite number in [0, 1]`);
    if (f > previousFloor) throw new Error(`confidenceFloors.${t} must not exceed the floor of the tier above it`);
    previousFloor = f;
  }

  const bands = c.tierBands;
  if (!Array.isArray(bands) || bands.length !== TIERS.length) throw new Error(`tierBands must contain exactly ${TIERS.length} bands`);
  const seen = new Set<string>();
  for (const b of bands) {
    if (!(finite(b?.min) && finite(b?.max) && b.min < b.max)) throw new Error("each tier band needs finite min < max");
    if (!TIERS.includes(b.tier) || seen.has(b.tier)) throw new Error("tierBands must name each tier exactly once");
    seen.add(b.tier);
  }
  const sorted = [...bands].sort((a, b) => a.min - b.min);
  if (sorted[0].min !== 0) throw new Error("tierBands must start at 0");
  if (sorted[sorted.length - 1].max !== 100) throw new Error("tierBands must end at 100");
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].min < sorted[i - 1].max) throw new Error("tierBands must not overlap");
    if (sorted[i].min > sorted[i - 1].max) throw new Error("tierBands must not leave gaps");
  }
  // A higher tier must sit higher in the score range, or "S" could be easier to reach than "A".
  const order = sorted.map((b) => b.tier);
  if (order.join() !== [...TIERS].reverse().join()) throw new Error("tierBands must rise from Reject to S");
}

export function validateIcpCriteria(c: IcpCriteria): void {
  for (const k of ["industries", "geographies", "technologies", "decisionMakerRoles"] as const) {
    if (!Array.isArray(c?.[k]) || c[k].some((x) => typeof x !== "string")) throw new Error(`criteria.${k} must be an array of strings`);
  }
  for (const k of ["employeeMin", "employeeMax"] as const) {
    if (c[k] !== undefined && !(finite(c[k]) && c[k]! >= 0)) throw new Error(`criteria.${k} must be a finite number >= 0`);
  }
  if (c.employeeMin !== undefined && c.employeeMax !== undefined && c.employeeMin > c.employeeMax) {
    throw new Error("criteria.employeeMin must not exceed employeeMax");
  }
}

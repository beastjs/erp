import type { Doc, Id } from "../_generated/dataModel";
import type { ClaimMethod } from "../claims/schema";

export type Claim = Doc<"claims">;
export type SourceTrust = Map<Id<"sources">, { trustWeight: number }>;

const METHOD_RANK: Record<ClaimMethod, number> = {
  observed: 2,
  extracted: 1,
  inferred: 0,
};

/**
 * Effective observation time: a missing value is 0 (oldest) and a value in the
 * future is clamped to `now`, so a source cannot win by reporting tomorrow.
 */
function effectiveObservedAt(claim: Claim, now: number): number {
  const at = claim.observedAt ?? 0;
  return Math.min(Number.isFinite(at) ? at : 0, now);
}

/**
 * Order: method precedence, source trust, recency, confidence, claim id.
 * Returns < 0 when `a` outranks `b`. The id comparison makes it a total order,
 * so the result is independent of input order.
 */
function compareClaims(a: Claim, b: Claim, sources: SourceTrust, now: number): number {
  const byMethod = METHOD_RANK[b.method] - METHOD_RANK[a.method];
  if (byMethod !== 0) return byMethod;

  const trustA = sources.get(a.sourceId)?.trustWeight ?? 0;
  const trustB = sources.get(b.sourceId)?.trustWeight ?? 0;
  if (trustA !== trustB) return trustB - trustA;

  const atA = effectiveObservedAt(a, now);
  const atB = effectiveObservedAt(b, now);
  if (atA !== atB) return atB - atA;

  if (a.confidence !== b.confidence) return b.confidence - a.confidence;

  return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
}

/**
 * Pure: picks the winning claim for one (subject, field). `contenders` is every
 * input claim ranked best-first (the winner is `contenders[0]`). Sources missing
 * from the map count as trust 0. Returns null when there are no claims.
 */
export function resolveField(
  claims: Claim[],
  sources: SourceTrust,
  now: number,
): { winner: Claim; contenders: Claim[] } | null {
  if (claims.length === 0) return null;
  const contenders = [...claims].sort((a, b) => compareClaims(a, b, sources, now));
  return { winner: contenders[0], contenders };
}

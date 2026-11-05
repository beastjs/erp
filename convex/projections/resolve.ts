import type { Id } from "../_generated/dataModel";
import type { Claim, ClaimMethod } from "../claims/schema";

export type { Claim };
export type SourceTrust = Map<Id<"sources">, { trustWeight: number }>;

const METHOD_RANK: Record<ClaimMethod, number> = {
  observed: 2,
  extracted: 1,
  inferred: 0,
};

/**
 * Effective observation time: a missing value is 0 (oldest) and a value later
 * than the moment we recorded the claim is clamped to its own `_creationTime`,
 * so a source cannot win by reporting tomorrow. Both inputs live on the claim
 * row, so the result never depends on when it is computed.
 */
function effectiveObservedAt(claim: Claim): number {
  const at = claim.observedAt ?? 0;
  return Math.min(Number.isFinite(at) ? at : 0, claim._creationTime);
}

/**
 * Order: method precedence, source trust, recency, confidence, claim id.
 * Returns < 0 when `a` outranks `b`. The id comparison makes it a total order,
 * so the result is independent of input order.
 */
function compareClaims(a: Claim, b: Claim, sources: SourceTrust): number {
  const byMethod = METHOD_RANK[b.method] - METHOD_RANK[a.method];
  if (byMethod !== 0) return byMethod;

  // A source absent from the map is deliberately trust 0: it ranks last within
  // its method tier rather than outranking a trusted source.
  const trustA = sources.get(a.sourceId)?.trustWeight ?? 0;
  const trustB = sources.get(b.sourceId)?.trustWeight ?? 0;
  if (trustA !== trustB) return trustB - trustA;

  const atA = effectiveObservedAt(a);
  const atB = effectiveObservedAt(b);
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
): { winner: Claim; contenders: Claim[] } | null {
  if (claims.length === 0) return null;
  const contenders = [...claims].sort((a, b) => compareClaims(a, b, sources));
  return { winner: contenders[0], contenders };
}

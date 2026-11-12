import { getDocumentSize, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { MAX_CLAIM_DOC_BYTES } from "../_shared/limits";
import { requireRole } from "../_shared/authz";
import { resolveOrg } from "../_shared/org";
import type { ClaimMethod } from "../claims/schema";
import { latestVerificationForClaim } from "../verify/mutations";
import { VERIFICATION_KINDS } from "../verify/schema";
import { DAY_MS, QUALITY_CLAIM_READ_BUDGET, QUALITY_SAMPLE, asOf as checkAsOf, median, ratio, type ObsCtx } from "./definitions";

/*
 * Data quality (spec 10): method mix, verification pass rate, median claim age.
 *
 * NOT computed over the whole ledger. `claims` is append-only and grows without bound, and a query has read limits, so
 * a whole-ledger scan would either fail or (with a cap) silently undercount: the defect this plan has paid for seven
 * times. These are computed over a DECLARED SAMPLE, the org's newest claims by creation (`by_org` index, descending),
 * at most QUALITY_SAMPLE and at most what QUALITY_CLAIM_READ_BUDGET bytes are sure to hold (`newestClaims`), and the
 * result says which: `sample.scope` is `whole_ledger` when the read reached the org's oldest claim (then the numbers
 * are exact) and `newest_sample` otherwise (then they estimate the ledger, hence `basis: "modelled"` in
 * METRIC_DEFINITIONS). Redacted claims are excluded: they contribute to no projection.
 * The pass rate reads one verdict per sampled email/phone claim, by exact key, so the read stays bounded by the sample.
 * Content-free: counts, a rate and a median; no value of any claim leaves this function.
 */

const METHODS: readonly ClaimMethod[] = ["observed", "extracted", "inferred"];
const VERIFIABLE: ReadonlySet<string> = new Set(VERIFICATION_KINDS);

export type DataQuality = {
  asOf: number;
  sample: { scope: "whole_ledger" | "newest_sample"; claimsRead: number; claimsCounted: number };
  methodMix: Record<ClaimMethod, number>;
  verificationPassRate: number | null;
  verificationsJudged: number;
  medianClaimAgeDays: number;
};

/**
 * The org's newest claims, newest first: up to QUALITY_SAMPLE + 1 (the one extra says whether there are more), read a
 * page at a time so the bytes read never pass QUALITY_CLAIM_READ_BUDGET. A page holds no more claims than the budget
 * left could hold if every one were as large as a claim may be (MAX_CLAIM_DOC_BYTES); after it, the budget is charged
 * with what was really read. When not even one more claim is sure to fit, the read stops: a smaller sample, and it
 * says so (`reachedOldest` false). Pages continue strictly below the last `_creationTime` read, so none is read twice.
 * Should two claims ever share a `_creationTime` across a page boundary, the second is skipped: the sample misses one
 * claim (it is a declared sample), and no claim is ever counted twice.
 */
async function newestClaims(ctx: ObsCtx, orgId: Id<"orgs">): Promise<{ claims: Doc<"claims">[]; reachedOldest: boolean }> {
  const claims: Doc<"claims">[] = [];
  let budget = QUALITY_CLAIM_READ_BUDGET;
  let before: number | null = null;
  for (;;) {
    const want = Math.min(Math.floor(budget / MAX_CLAIM_DOC_BYTES), QUALITY_SAMPLE + 1 - claims.length);
    if (want <= 0) return { claims, reachedOldest: false };
    const cursor: number | null = before;
    const page: Doc<"claims">[] = await ctx.db
      .query("claims")
      .withIndex("by_org", (q) => (cursor === null ? q.eq("orgId", orgId) : q.eq("orgId", orgId).lt("_creationTime", cursor)))
      .order("desc")
      .take(want);
    for (const c of page) {
      claims.push(c);
      budget -= getDocumentSize(c);
    }
    if (page.length < want) return { claims, reachedOldest: true };
    before = page[page.length - 1]!._creationTime;
  }
}

export async function dataQualityOf(ctx: ObsCtx, args: { asOf: number }): Promise<DataQuality> {
  const now = checkAsOf(args.asOf);
  const { orgId } = await resolveOrg(ctx);
  const { claims: read, reachedOldest } = await newestClaims(ctx, orgId);
  const sampled = read.slice(0, QUALITY_SAMPLE);
  const live = sampled.filter((c) => c.redactedAt === undefined);

  const methodMix = Object.fromEntries(METHODS.map((m) => [m, 0])) as Record<ClaimMethod, number>;
  for (const c of live) methodMix[c.method]++;

  let judged = 0;
  let passed = 0;
  for (const c of live) {
    if (c.subjectType !== "contact" || !VERIFIABLE.has(c.field)) continue;
    const verdict = await latestVerificationForClaim(ctx, orgId, c._id);
    if (!verdict) continue;
    judged++;
    if (verdict.outcome === "pass") passed++;
  }

  return {
    asOf: now,
    sample: { scope: reachedOldest && read.length <= QUALITY_SAMPLE ? "whole_ledger" : "newest_sample", claimsRead: sampled.length, claimsCounted: live.length },
    methodMix,
    verificationPassRate: ratio(passed, judged),
    verificationsJudged: judged,
    medianClaimAgeDays: median(live.map((c) => (now - c.observedAt) / DAY_MS)),
  };
}

/**
 * Operator (spec 7.1: operators review leads, and data quality is what they review them against). Returns no content.
 * `asOf` is the instant ages are measured from: a query must not read the clock, so the caller states it.
 */
export const dataQuality = query({
  args: { asOf: v.number() },
  handler: async (ctx, args): Promise<DataQuality> => {
    await requireRole(ctx, "operator");
    return await dataQualityOf(ctx, args);
  },
});

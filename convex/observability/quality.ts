import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireRole } from "../_shared/authz";
import { resolveOrg } from "../_shared/org";
import type { ClaimMethod } from "../claims/schema";
import { latestVerificationForClaim } from "../verify/mutations";
import { VERIFICATION_KINDS } from "../verify/schema";
import { DAY_MS, QUALITY_SAMPLE, asOf as checkAsOf, median, ratio, type ObsCtx } from "./definitions";

/*
 * Data quality (spec 10): method mix, verification pass rate, median claim age.
 *
 * NOT computed over the whole ledger. `claims` is append-only and grows without bound, and a query has read limits, so
 * a whole-ledger scan would either fail or (with a cap) silently undercount: the defect this plan has paid for seven
 * times. These are computed over a DECLARED SAMPLE, the org's newest QUALITY_SAMPLE claims by creation (`by_org`
 * index, descending), and the result says which: `sample.scope` is `whole_ledger` when the org has no more claims
 * than that (then the numbers are exact) and `newest_sample` otherwise (then they estimate the ledger, hence
 * `basis: "modelled"` in METRIC_DEFINITIONS). Redacted claims are excluded: they contribute to no projection.
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

export async function dataQualityOf(ctx: ObsCtx, args: { asOf: number }): Promise<DataQuality> {
  const now = checkAsOf(args.asOf);
  const { orgId } = await resolveOrg(ctx);
  const read = await ctx.db.query("claims").withIndex("by_org", (q) => q.eq("orgId", orgId)).order("desc").take(QUALITY_SAMPLE + 1);
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
    sample: { scope: read.length > QUALITY_SAMPLE ? "newest_sample" : "whole_ledger", claimsRead: sampled.length, claimsCounted: live.length },
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

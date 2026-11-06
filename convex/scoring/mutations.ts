import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { withOrg } from "../_shared/org";
import type { SubjectType } from "../claims/schema";
import { ensureActiveScoringModel } from "../icp/mutations";
import { getIcpVersion, getScoringModel } from "../icp/queries";
import { TIERS } from "../icp/schema";
import { tierFor } from "../icp/tier";
import type { ScoreResult } from "./score";

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Tolerance for float drift between the stored total and the sum of its parts. */
const SUM_EPSILON = 1e-6;

/** Fails closed on any result that could not have come from computeScore under this model. */
function validateResult(r: ScoreResult, model: Parameters<typeof tierFor>[2]): void {
  for (const k of ["fit", "intent", "score", "priority"] as const) {
    if (!(finite(r[k]) && r[k] >= 0 && r[k] <= 100)) throw new Error(`result.${k} must be a finite number in [0, 100]`);
  }
  if (!(finite(r.confidence) && r.confidence >= 0 && r.confidence <= 1)) throw new Error("result.confidence must be a finite number in [0, 1]");
  if (!TIERS.includes(r.tier)) throw new Error("result.tier is not a tier");
  if (!Array.isArray(r.contributions) || r.contributions.length === 0) throw new Error("result.contributions must be a non-empty array");
  let total = 0;
  for (const c of r.contributions) {
    if (typeof c.factor !== "string" || c.factor === "") throw new Error("contribution.factor is required");
    if (/data.?quality/i.test(c.factor)) throw new Error("data quality is not a scoring factor");
    if (!(finite(c.input) && c.input >= 0 && c.input <= 1)) throw new Error(`contribution ${c.factor}: input must be in [0, 1]`);
    if (!(finite(c.weight) && c.weight >= 0)) throw new Error(`contribution ${c.factor}: weight must be finite and >= 0`);
    if (!(finite(c.contributed) && c.contributed >= 0)) throw new Error(`contribution ${c.factor}: contributed must be finite and >= 0`);
    total += c.contributed;
  }
  if (Math.abs(total - r.score) > SUM_EPSILON) throw new Error("result.score must equal the sum of its contributions");
  if (tierFor(r.score, r.confidence, model) !== r.tier) throw new Error("result.tier does not match score and confidence under the cited model");
}

/**
 * Append-only: a rescore is a new row. A plain helper, not a public function, and it takes no org: the
 * org comes from the auth identity. The score cites a real immutable scoring model row, never the
 * built-in defaults: with no `scoringModelId` it uses `ensureActiveScoringModel`, which seeds v1 if needed.
 */
export async function recordScoreRun(
  ctx: MutationCtx,
  args: {
    subjectType: SubjectType;
    subjectId: string;
    icpVersionId: Id<"icpDefinitions">;
    scoringModelId?: Id<"scoringModels">;
    result: ScoreResult;
  },
): Promise<Id<"scoreRuns">> {
  const { orgId } = await withOrg(ctx, args);
  const subjectId = ctx.db.normalizeId(args.subjectType === "account" ? "accounts" : "contacts", args.subjectId);
  if (!subjectId) throw new Error("invalid subject id");
  const subject = await ctx.db.get(subjectId);
  if (!subject || subject.orgId !== orgId) throw new Error("subject not found");
  const icp = await getIcpVersion(ctx, { id: args.icpVersionId });
  const model = args.scoringModelId ? await getScoringModel(ctx, { id: args.scoringModelId }) : await ensureActiveScoringModel(ctx);
  validateResult(args.result, model);
  const r = args.result;
  return await ctx.db.insert("scoreRuns", {
    orgId,
    subjectType: args.subjectType,
    subjectId,
    icpVersionId: icp._id,
    scoringModelId: model._id,
    fit: r.fit,
    intent: r.intent,
    score: r.score,
    confidence: r.confidence,
    priority: r.priority,
    tier: r.tier,
    contributions: r.contributions.map((c) => ({ factor: c.factor, input: c.input, weight: c.weight, contributed: c.contributed })),
    scoredAt: Date.now(),
  });
}

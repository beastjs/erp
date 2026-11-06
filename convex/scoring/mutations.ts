import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { withOrg } from "../_shared/org";
import type { SubjectType } from "../claims/schema";
import { hasActiveInboundLink } from "../projections/identity";
import { ensureActiveScoringModel } from "../icp/mutations";
import { getIcpVersion, getScoringModel } from "../icp/queries";
import { TIERS } from "../icp/schema";
import { tierFor } from "../icp/tier";
import type { ScoreResult } from "./score";

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Float tolerance for recomputed relationships (the result is snapped at 1e-9; sums accumulate a little more). */
const EPS = 1e-6;
const near = (a: number, b: number) => Math.abs(a - b) <= EPS;

/**
 * Fails closed on any result that computeScore could not have produced under this model: ranges, tier,
 * and every relationship between the parts (weights match the model, contributed = input x weight,
 * score = sum, fit and intent follow from the contributions, priority = fit x intent / 100).
 */
function validateResult(r: ScoreResult, model: Parameters<typeof tierFor>[2] & { weights: { companyFit: number; contactFit: number; intent: number } }): void {
  for (const k of ["fit", "intent", "score", "priority"] as const) {
    if (!(finite(r[k]) && r[k] >= 0 && r[k] <= 100)) throw new Error(`result.${k} must be a finite number in [0, 100]`);
  }
  if (!(finite(r.confidence) && r.confidence >= 0 && r.confidence <= 1)) throw new Error("result.confidence must be a finite number in [0, 1]");
  if (!TIERS.includes(r.tier)) throw new Error("result.tier is not a tier");
  if (!Array.isArray(r.contributions) || r.contributions.length === 0) throw new Error("result.contributions must be a non-empty array");
  let total = 0;
  let companyWeight = 0;
  let contactWeight = 0;
  let intentWeight = 0;
  let intentInput = 0;
  let intents = 0;
  let fitPoints = 0;
  let fitWeight = 0;
  for (const c of r.contributions) {
    if (typeof c.factor !== "string" || c.factor === "") throw new Error("contribution.factor is required");
    if (/data.?quality/i.test(c.factor)) throw new Error("data quality is not a scoring factor");
    if (!(finite(c.input) && c.input >= 0 && c.input <= 1)) throw new Error(`contribution ${c.factor}: input must be in [0, 1]`);
    if (!(finite(c.weight) && c.weight >= 0)) throw new Error(`contribution ${c.factor}: weight must be finite and >= 0`);
    if (!(finite(c.contributed) && c.contributed >= 0)) throw new Error(`contribution ${c.factor}: contributed must be finite and >= 0`);
    if (!near(c.contributed, c.input * c.weight)) throw new Error(`contribution ${c.factor}: contributed must equal input x weight`);
    total += c.contributed;
    if (c.factor === "intent") {
      intents++;
      intentWeight += c.weight;
      intentInput = c.input;
    } else {
      fitPoints += c.contributed;
      fitWeight += c.weight;
      if (c.factor.startsWith("company.")) companyWeight += c.weight;
      else if (c.factor === "contact.role") contactWeight += c.weight;
      else throw new Error(`unknown scoring factor ${c.factor}`);
    }
  }
  if (intents !== 1) throw new Error("result.contributions must contain exactly one intent factor");
  // Weights must be the model's, normalised only when the contact factor was omitted (as computeScore does).
  const w = model.weights;
  const hasContact = r.contributions.some((c) => c.factor === "contact.role");
  const scale = hasContact || w.companyFit + w.intent <= 0 ? 1 : 100 / (w.companyFit + w.intent);
  if (!near(companyWeight, w.companyFit * scale) || !near(intentWeight, w.intent * scale) || !near(contactWeight, hasContact ? w.contactFit : 0)) {
    throw new Error("contribution weights do not match the cited scoring model");
  }
  if (!near(total, r.score)) throw new Error("result.score must equal the sum of its contributions");
  if (!near(r.intent, intentInput * 100)) throw new Error("result.intent must equal the intent factor input x 100");
  if (!near(r.fit, fitWeight > 0 ? (fitPoints / fitWeight) * 100 : 0)) throw new Error("result.fit does not follow from the contributions");
  if (!near(r.priority, (r.fit * r.intent) / 100)) throw new Error("result.priority must equal fit x intent / 100");
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
    /**
     * Other subjects whose signals fed this score (a lead scores a contact but reads its account's signals
     * too). Each is checked for an active inbound identityLink along with the scored subject.
     */
    alsoSignalSubjects?: Array<{ subjectType: SubjectType; subjectId: string }>;
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
  const linked: Array<Id<"accounts"> | Id<"contacts">> = [subjectId];
  for (const s of args.alsoSignalSubjects ?? []) {
    const id = ctx.db.normalizeId(s.subjectType === "account" ? "accounts" : "contacts", s.subjectId);
    const row = id && (await ctx.db.get(id));
    if (!id || !row || row.orgId !== orgId) throw new Error("signal subject not found");
    linked.push(id);
  }
  let intentMayBeStranded = false;
  for (const id of linked) {
    if (await hasActiveInboundLink(ctx, { orgId, subjectId: id })) {
      intentMayBeStranded = true;
      break;
    }
  }
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
    intentMayBeStranded,
    contributions: r.contributions.map((c) => ({ factor: c.factor, input: c.input, weight: c.weight, contributed: c.contributed })),
    scoredAt: Date.now(),
  });
}

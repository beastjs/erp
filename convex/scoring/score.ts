import type { Doc } from "../_generated/dataModel";
import type { ClaimMethod } from "../claims/schema";
import { tierFor } from "../icp/tier";
import type { IcpDefinition, ScoringModel, Tier } from "../icp/schema";
import { signalContribution, type Signal } from "../signals/decay";

export type { Tier } from "../icp/schema";

export type VerificationResult = { kind: "email" | "phone"; outcome: "pass" | "fail" | "unknown"; checkedAt: number };
/** One weighted factor: `input` in [0, 1] times `weight` points is what it `contributed` to the score. */
export type Contribution = { factor: string; input: number; weight: number; contributed: number };
export type ScoreResult = {
  /** 0..100: company + contact points, normalised by the points available to them. */
  fit: number;
  /** 0..100 */
  intent: number;
  /** 0..100: the sum of `contributions`. */
  score: number;
  /** 0..1: evidence quality. Never part of `score`. */
  confidence: number;
  /** 0..100: fit x intent. A product, deliberately: a sum would hide a lead that is strong on one axis and dead on the other. */
  priority: number;
  tier: Tier;
  contributions: Contribution[];
};

type Fielded = { fields: Doc<"accounts">["fields"] };
export type ScoreInput = {
  account: Fielded;
  contact: Fielded;
  /** Extra annotations from `activeSignals` are tolerated and ignored: intent is recomputed here from the model. */
  signals: Signal[];
  /** Defaults to none until structural verification exists; an empty list must score exactly as before it did. */
  verifications?: VerificationResult[];
  icp: Pick<IcpDefinition, "criteria">;
  model: Pick<
    ScoringModel,
    "weights" | "tierBands" | "confidenceFloors" | "methodCeilings" | "strengthWeights" | "decayHalfLives" | "claimHalfLifeMs" | "failedVerificationFactor" | "claimFreshnessFloor" | "sizeOverlapCredit"
  >;
  /**
   * claimId -> the claim's `_creationTime`. A source cannot have observed something after we recorded it, so a
   * claim's age runs from min(observedAt, recordedAt), the same clamp Task 4 applies to claim resolution.
   * A claim with no entry whose observedAt is in the future (after `now`) gets no freshness credit at all.
   */
  claimRecordedAt?: Record<string, number>;
  /** Epoch ms. Explicit so the function stays pure: decay and claim age are measured against it. */
  now: number;
};

/*
 * CONFIDENCE (a proposal of this task; the spec fixes the inputs, not the formula).
 *   evidence  = mean over the fields the scored factors READ (not every field that exists: more evidence must
 *               never make a lead look worse) of  min(claim.confidence, methodCeiling) x freshness
 *   freshness = floor + (1 - floor) x 0.5^(age / model.claimHalfLifeMs), floor = model.claimFreshnessFloor.
 *   verified  = evidence x model.failedVerificationFactor per failed verification kind (latest result per kind); pass/unknown are neutral.
 * Two consequences that surprise: a lead with one present field out of five read fields keeps HIGH confidence
 * (it is confidence in the evidence that exists; the missing fields already cost points in the score), and once
 * the contact criterion is omitted a zero-scoring company factor costs 43.75 points (35 normalised over 35 + 45).
 * No verifications means no factor, so populating the list later only ever lowers confidence for subjects
 * that actually fail a check. No fields at all is confidence 0.
 */

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
/** Total clamp into [lo, hi]: anything unusable (NaN, Infinity) becomes lo. */
const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
/** Round away float drift at 1e-9 so a value that is mathematically on a boundary compares as on it. */
const snap = (n: number) => Math.round(n * 1e9) / 1e9;
const norm = (s: string) => s.trim().toLowerCase();
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function fieldValue(p: Fielded, name: string): unknown {
  return p.fields.find((f) => f.field === name)?.value;
}
const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : undefined);

/**
 * Employee count range from free text. Accepts ONLY a whole-string single number ("250"), a range ("51-200",
 * "201 - 1,000") or an open range ("1,000+"), each number optionally with a k suffix ("5k-10k"). Anything else
 * ("51-200 (2023)", "up to 50", "Founded 2015, 51-200") is null and scores 0: a wrong match is
 * indistinguishable from a real one downstream, so an unreadable size must not be guessed at.
 */
const NUM = String.raw`(\d+(?:,\d{3})*(?:\.\d+)?)(k?)`;
const SINGLE = new RegExp(`^${NUM}(\\+?)$`);
const RANGE = new RegExp(`^${NUM}\\s*[-\u2013]\\s*${NUM}$`);
const toCount = (digits: string, k: string) => Number(digits.replace(/,/g, "")) * (k === "k" ? 1000 : 1);
export function parseSize(text: string): { lo: number; hi: number } | null {
  const t = text.trim().toLowerCase();
  const range = RANGE.exec(t);
  if (range) {
    const lo = toCount(range[1], range[2]);
    const hi = toCount(range[3], range[4]);
    return Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi ? { lo, hi } : null;
  }
  const one = SINGLE.exec(t);
  if (one) {
    const n = toCount(one[1], one[2]);
    if (!Number.isFinite(n)) return null;
    return { lo: n, hi: one[3] === "+" ? Infinity : n };
  }
  return null;
}

function sizeMatch(text: string | undefined, min: number | undefined, max: number | undefined, overlapCredit: number): number {
  if (text === undefined) return 0;
  const r = parseSize(text);
  if (!r) return 0;
  const floor = min ?? 0;
  const ceil = max ?? Infinity;
  if (r.lo >= floor && r.hi <= ceil) return 1;
  if (r.lo <= ceil && r.hi >= floor) return clamp(overlapCredit, 0, 1); // unusable credit fails closed to 0
  return 0;
}

function listMatch(wanted: string[], got: string[]): number {
  if (wanted.length === 0) return 0;
  const have = new Set(got.map(norm));
  return wanted.filter((w) => have.has(norm(w))).length / wanted.length;
}

function roleMatch(title: string | undefined, roles: string[]): number {
  if (title === undefined) return 0;
  // Whole-word sequence match: "CTO" must not match "Director".
  const padded = ` ${tokens(title).join(" ")} `;
  return roles.some((r) => {
    const t = tokens(r);
    return t.length > 0 && padded.includes(` ${t.join(" ")} `);
  })
    ? 1
    : 0;
}

/** The projected fields a scored factor reads, per the ICP. Confidence is confidence in THIS evidence. */
function evidenceFields(input: ScoreInput): Doc<"accounts">["fields"] {
  const c = input.icp.criteria;
  const account = new Set<string>();
  if (c.industries.length > 0) account.add("industry");
  if (c.geographies.length > 0) ["country", "location"].forEach((f) => account.add(f));
  if (c.technologies.length > 0) account.add("techStack");
  if (c.employeeMin !== undefined || c.employeeMax !== undefined) account.add("size");
  const contact = new Set<string>(c.decisionMakerRoles.length > 0 ? ["title"] : []);
  return [...input.account.fields.filter((f) => account.has(f.field)), ...input.contact.fields.filter((f) => contact.has(f.field))];
}

function evidenceConfidence(input: ScoreInput): number {
  const fields = evidenceFields(input);
  if (fields.length === 0) return 0;
  const ceilings = input.model.methodCeilings;
  const halfLife = input.model.claimHalfLifeMs;
  // Fail closed on an unusable half-life: treat every claim as fully aged rather than dividing by it.
  const rawFloor = input.model.claimFreshnessFloor;
  // Unusable floor fails closed to 0: an old claim counts for nothing rather than for an invented amount.
  const floorUsable = Number.isFinite(rawFloor);
  const freshFloor = floorUsable ? clamp(rawFloor, 0, 1) : 0;
  const usable = Number.isFinite(halfLife) && halfLife > 0;
  let sum = 0;
  for (const f of fields) {
    const ceiling = clamp(ceilings[f.method as ClaimMethod], 0, 1);
    const claimed = finite(f.confidence) && f.confidence > 0 && f.confidence <= 1 ? f.confidence : 0;
    const recorded = input.claimRecordedAt?.[f.claimId];
    const observed = finite(f.observedAt) ? (finite(recorded) ? Math.min(f.observedAt, recorded) : f.observedAt) : NaN;
    // Future-dated with no record of when we saw it: no freshness credit (Infinity age = the floor).
    const age = finite(observed) && observed <= input.now ? input.now - observed : Infinity;
    const freshness = floorUsable && usable && Number.isFinite(age) ? freshFloor + (1 - freshFloor) * Math.pow(0.5, age / halfLife) : freshFloor;
    sum += Math.min(claimed, ceiling) * freshness;
  }
  // Snap: a mean that is mathematically exactly a tier floor (ceilings equal floors by default) must not land
  // one ULP under it and silently demote the lead.
  return snap(clamp(sum / fields.length, 0, 1));
}

function verificationFactor(verifications: VerificationResult[], failed: number): number {
  const penalty = Number.isFinite(failed) && failed > 0 && failed <= 1 ? failed : 0;
  const latest = new Map<string, VerificationResult>();
  for (const v of verifications) {
    const prev = latest.get(v.kind);
    if (!prev || v.checkedAt >= prev.checkedAt) latest.set(v.kind, v);
  }
  let factor = 1;
  for (const v of latest.values()) if (v.outcome === "fail") factor *= penalty;
  return factor;
}

/** Pure. No ctx, no database, never NaN, never negative, never above its range. */
export function computeScore(input: ScoreInput): ScoreResult {
  const { model, icp } = input;
  const c = icp.criteria;
  const w = model.weights;
  const wCompany = clamp(w.companyFit, 0, 100);
  const wContact = clamp(w.contactFit, 0, 100);
  const wIntent = clamp(w.intent, 0, 100);

  const factors: Array<{ factor: string; input: number; weight: number }> = [];
  const add = (factor: string, rawInput: number, weight: number) => {
    factors.push({ factor, input: clamp(rawInput, 0, 1), weight });
  };

  // Company fit: each dimension the ICP actually specifies shares the company weight equally.
  const a = input.account;
  const dims: Array<[string, number]> = [];
  if (c.industries.length > 0) {
    const industry = str(fieldValue(a, "industry"));
    dims.push(["company.industry", industry !== undefined && c.industries.some((i) => norm(i) === norm(industry)) ? 1 : 0]);
  }
  if (c.geographies.length > 0) {
    const places = [str(fieldValue(a, "country")), ...(str(fieldValue(a, "location")) ?? "").split(",")]
      .filter((p): p is string => p !== undefined && p.trim() !== "")
      .map(norm);
    dims.push(["company.geography", c.geographies.some((g) => places.includes(norm(g))) ? 1 : 0]);
  }
  if (c.technologies.length > 0) {
    const stack = fieldValue(a, "techStack");
    const got = Array.isArray(stack) ? stack.filter((s): s is string => typeof s === "string") : [];
    dims.push(["company.technologies", listMatch(c.technologies, got)]);
  }
  if (c.employeeMin !== undefined || c.employeeMax !== undefined) {
    dims.push(["company.size", sizeMatch(str(fieldValue(a, "size")), c.employeeMin, c.employeeMax, model.sizeOverlapCredit)]);
  }
  // An ICP that asks for nothing matches nothing: fail closed with one explicit zero factor.
  if (dims.length === 0) add("company.criteria", 0, wCompany);
  else for (const [factor, value] of dims) add(factor, value, wCompany / dims.length);

  // Same rule as the company side: a criterion the ICP does not specify is omitted and the weights are normalised
  // (below), not scored as a miss that caps the ICP at 80.
  const contactSpecified = c.decisionMakerRoles.length > 0;
  if (contactSpecified) add("contact.role", roleMatch(str(fieldValue(input.contact, "title")), c.decisionMakerRoles), wContact);

  // Intent: noisy-or, 1 - prod(1 - c_i): parameter-free (nothing to version), but a modelling decision: many weak
  // signals approach 1 (ten at 0.2 give ~0.89), i.e. "lots of activity is high intent".
  // Inputs are signal contributions (decayed weight x confidence). Many weak signals add up,
  // none can push past 1, and zero signals is exactly 0 with no division anywhere.
  let miss = 1;
  for (const s of input.signals) miss *= 1 - clamp(signalContribution(s, input.now, model), 0, 1);
  const intentInput = clamp(1 - miss, 0, 1);
  add("intent", intentInput, wIntent);

  // Normalise when the contact factor is omitted so the weights still total 100. Untouched otherwise.
  const available = wCompany + wIntent;
  const scale = !contactSpecified && available > 0 ? 100 / available : 1;
  const contributions: Contribution[] = factors.map((f) => {
    const weight = f.weight * scale;
    return { factor: f.factor, input: f.input, weight, contributed: f.input * weight };
  });

  const evidence = evidenceConfidence(input);
  // Snapped like its factors: the product can sit one ULP under a tier floor too (dormant until verifications exist).
  const confidence = snap(clamp(evidence * verificationFactor(input.verifications ?? [], model.failedVerificationFactor), 0, 1));

  // No claims at all means nothing is known, whatever signals say: score 0, confidence 0, Reject.
  if (input.account.fields.length + input.contact.fields.length === 0) {
    return {
      fit: 0,
      intent: 0,
      score: 0,
      confidence: 0,
      priority: 0,
      tier: "Reject",
      contributions: contributions.map((x) => ({ ...x, input: 0, contributed: 0 })),
    };
  }

  const fitPoints = contributions.filter((x) => x.factor !== "intent").reduce((s, x) => s + x.contributed, 0);
  const fitDen = contributions.filter((x) => x.factor !== "intent").reduce((s, x) => s + x.weight, 0);
  const fit = fitDen > 0 ? clamp((fitPoints / fitDen) * 100, 0, 100) : 0;
  const intent = intentInput * 100;
  const score = snap(clamp(contributions.reduce((s, x) => s + x.contributed, 0), 0, 100));
  const priority = clamp((fit * intent) / 100, 0, 100);
  return { fit, intent, score, confidence, priority, tier: tierFor(score, confidence, model), contributions };
}

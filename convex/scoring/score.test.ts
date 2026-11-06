/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { DEFAULT_SCORING_MODEL } from "../icp/defaults";
import { createIcpVersion } from "../icp/mutations";
import type { IcpCriteria } from "../icp/schema";
import type { ClaimMethod } from "../claims/schema";
import schema from "../schema";
import { recordScoreRun } from "./mutations";
import { computeScore, parseSize, type ScoreInput, type ScoreResult, type VerificationResult } from "./score";

const modules = import.meta.glob("/convex/**/*.ts");
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY;

const criteria: IcpCriteria = {
  industries: ["software"],
  geographies: ["US"],
  technologies: ["convex"],
  decisionMakerRoles: ["CTO"],
  employeeMin: 50,
  employeeMax: 500,
};
const icp = { criteria };
const model = DEFAULT_SCORING_MODEL;

let n = 0;
const id = (): Id<"claims"> => `claim${n++}` as Id<"claims">;
function fields(entries: Record<string, unknown>, method: ClaimMethod = "observed", confidence = 1, observedAt = NOW) {
  return Object.entries(entries)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([field, value]) => ({ field, value, claimId: id(), method, confidence, observedAt }));
}
const perfectAccount = { industry: "Software", country: "US", techStack: ["Convex", "React"], size: "51-200" };
const perfectContact = { title: "CTO" };
const signal = (over: Partial<ScoreInput["signals"][number]> = {}): ScoreInput["signals"][number] => ({
  _id: `s${n++}` as Id<"signals">,
  _creationTime: 0,
  orgId: "o" as Id<"orgs">,
  subjectType: "account",
  subjectId: "a",
  kind: "funding_announcement",
  strength: "high",
  confidence: 1,
  observedAt: NOW,
  ...over,
});
const input = (over: Partial<ScoreInput> = {}): ScoreInput => ({
  account: { fields: fields(perfectAccount) },
  contact: { fields: fields(perfectContact) },
  signals: [signal()],
  icp,
  model,
  now: NOW,
  ...over,
});

test("a perfect-fit, high-intent, fully-observed subject scores 100 and tiers S", () => {
  const r = computeScore(input());
  expect(r.fit).toBe(100);
  expect(r.intent).toBe(100);
  expect(r.score).toBe(100);
  expect(r.confidence).toBe(1);
  expect(r.priority).toBe(100);
  expect(r.tier).toBe("S");
});

test("inferred-only claims cap confidence at 0.5", () => {
  const r = computeScore(
    input({ account: { fields: fields(perfectAccount, "inferred", 0.99) }, contact: { fields: fields(perfectContact, "inferred", 0.99) } }),
  );
  expect(r.confidence).toBe(0.5);
  const extracted = computeScore(input({ account: { fields: fields(perfectAccount, "extracted", 0.99) }, contact: { fields: fields(perfectContact, "extracted", 0.99) } }));
  expect(extracted.confidence).toBe(0.7);
});

test("a score in the S band below the S confidence floor does not tier S", () => {
  // Score 100 sits in the S band; confidence 0.7 is under the S floor (0.8) and meets A's (0.7).
  const r = computeScore(input({ account: { fields: fields(perfectAccount, "observed", 0.7) }, contact: { fields: fields(perfectContact, "observed", 0.7) } }));
  expect(r.score).toBe(100);
  expect(r.confidence).toBe(0.7);
  expect(r.tier).toBe("A");
  // And a score of 91 (intent 0.8 -> 100 - 45*0.2) at confidence 0.5.
  const low = computeScore(
    input({
      signals: [signal({ confidence: 0.8 })],
      account: { fields: fields(perfectAccount, "observed", 0.5) },
      contact: { fields: fields(perfectContact, "observed", 0.5) },
    }),
  );
  expect(low.score).toBeCloseTo(91, 9);
  expect(low.tier).toBe("C"); // confidence 0.5 meets only C's floor
});

test("excellent fit with zero intent does not reach tier S", () => {
  const r = computeScore(input({ signals: [] }));
  expect(r.fit).toBe(100);
  expect(r.intent).toBe(0);
  expect(r.score).toBe(55);
  expect(r.tier).toBe("Reject");
});

test("priority is fit × intent, not a sum", () => {
  const half = computeScore(input({ signals: [signal({ confidence: 0.5 })] }));
  expect(half.fit).toBe(100);
  expect(half.intent).toBe(50);
  expect(half.priority).toBe(50); // a sum or mean would be 150 / 75
  const poorFit = computeScore(input({ account: { fields: fields({ industry: "mining" }) }, contact: { fields: fields({ title: "Intern" }) } }));
  expect(poorFit.fit).toBe(0);
  expect(poorFit.intent).toBe(100);
  expect(poorFit.priority).toBe(0); // high intent cannot rescue a poor fit
  const noIntent = computeScore(input({ signals: [] }));
  expect(noIntent.priority).toBe(0);
});

test("zero signals yields intent 0, not NaN", () => {
  const r = computeScore(input({ signals: [] }));
  expect(r.intent).toBe(0);
  expect(Object.is(r.intent, 0)).toBe(true);
  expect(r.contributions.find((c) => c.factor === "intent")).toEqual({ factor: "intent", input: 0, weight: 45, contributed: 0 });
});

test("a subject with no claims yields score 0, confidence 0, tier Reject", () => {
  // A signal is present on purpose: nothing is known about the subject, so it must not score.
  const r = computeScore(input({ account: { fields: [] }, contact: { fields: [] } }));
  expect(r.score).toBe(0);
  expect(r.confidence).toBe(0);
  expect(r.fit).toBe(0);
  expect(r.intent).toBe(0);
  expect(r.priority).toBe(0);
  expect(r.tier).toBe("Reject");
  expect(r.contributions.every((c) => c.input === 0 && c.contributed === 0)).toBe(true);
});

test("contributions list every weighted factor and its input value", () => {
  const r = computeScore(input({ account: { fields: fields({ ...perfectAccount, techStack: ["Convex", "Go"] }) } }));
  expect(r.contributions.map((c) => c.factor)).toEqual([
    "company.industry",
    "company.geography",
    "company.technologies",
    "company.size",
    "contact.role",
    "intent",
  ]);
  expect(r.contributions.map((c) => c.input)).toEqual([1, 1, 1, 1, 1, 1]);
  expect(r.contributions.map((c) => c.weight)).toEqual([8.75, 8.75, 8.75, 8.75, 20, 45]);
  expect(r.contributions.reduce((s, c) => s + c.weight, 0)).toBe(100);
  expect(r.contributions.reduce((s, c) => s + c.contributed, 0)).toBe(r.score);
  // Partial technology coverage shows up as a fractional input, not a hidden adjustment.
  const partial = computeScore(input({ icp: { criteria: { ...criteria, technologies: ["convex", "rust"] } } }));
  expect(partial.contributions.find((c) => c.factor === "company.technologies")?.input).toBe(0.5);
});

test("each factor carries its own input (distinguishable values, two scenarios)", () => {
  const rich = { ...criteria, technologies: ["convex", "rust", "go"] };
  const byFactor = (r: ScoreResult) => Object.fromEntries(r.contributions.map((c) => [c.factor, c.input]));
  const a = computeScore(
    input({
      icp: { criteria: rich },
      model: { ...model, sizeOverlapCredit: 0.25 },
      account: { fields: fields({ industry: "software", country: "DE", techStack: ["Convex"], size: "201-1,000" }) },
      contact: { fields: fields({ title: "Cook" }) },
      signals: [signal({ confidence: 0.75 })],
    }),
  );
  expect(byFactor(a)).toEqual({ "company.industry": 1, "company.geography": 0, "company.technologies": 1 / 3, "company.size": 0.25, "contact.role": 0, intent: 0.75 });
  const b = computeScore(input({ icp: { criteria: rich }, account: { fields: fields({ industry: "mining", country: "US", techStack: [], size: "10" }) }, signals: [] }));
  expect(byFactor(b)).toEqual({ "company.industry": 0, "company.geography": 1, "company.technologies": 0, "company.size": 0, "contact.role": 1, intent: 0 });
});

test("confidence drift: three fields at the extracted ceiling sit exactly on A's floor and tier A", () => {
  // 0.7 + 0.7 + 0.7 = 2.0999999999999996; / 3 = 0.6999999999999998, one ULP under A's 0.7 floor, unless snapped.
  const small = { ...criteria, technologies: [], employeeMin: undefined, employeeMax: undefined };
  const r = computeScore(
    input({ icp: { criteria: small }, account: { fields: fields({ industry: "software", country: "US" }, "extracted", 0.99) }, contact: { fields: fields(perfectContact, "extracted", 0.99) } }),
  );
  expect(r.score).toBe(100);
  expect(r.confidence).toBe(0.7);
  expect(r.tier).toBe("A");
});

test("more evidence never makes a lead look worse: fields no criterion reads do not move confidence or tier", () => {
  const base = computeScore(input());
  const extra = computeScore(
    input({
      account: { fields: fields({ ...perfectAccount }) .concat(fields({ description: "x", revenueRange: "y" }, "inferred", 0.05)) },
      contact: { fields: fields(perfectContact).concat(fields({ phone: "+1", notes: "n" }, "inferred", 0.05)) },
    }),
  );
  expect(extra.confidence).toBe(base.confidence);
  expect(extra.tier).toBe(base.tier);
  expect(extra.score).toBe(base.score);
  // No relevant evidence at all (fields exist, none read): nothing backs the score.
  const none = computeScore(input({ account: { fields: fields({ description: "x" }) }, contact: { fields: fields({ phone: "+1" }) } }));
  expect(none.confidence).toBe(0);
  expect(none.tier).toBe("Reject");
});

test("confidence counts a specified criterion whose field is present but scored 0, and does not count an absent field", () => {
  // Present and mismatched: industry is read, scores 0, and its 1.0-confidence claim is still evidence.
  const mismatch = computeScore(input({ account: { fields: fields({ ...perfectAccount, industry: "mining" }, "observed", 1).map((f) => (f.field === "industry" ? { ...f, confidence: 0.5 } : f)) } }));
  expect(mismatch.contributions.find((c) => c.factor === "company.industry")?.input).toBe(0);
  // 5 read fields: four at 1.0 and the mismatched industry at 0.5 -> mean 0.9.
  expect(mismatch.confidence).toBe(0.9);
  // Absent: only the title is present; the four missing account fields are not counted as zeros.
  const sparse = computeScore(input({ account: { fields: [] }, contact: { fields: fields(perfectContact) } }));
  expect(sparse.confidence).toBe(1);
  expect(sparse.score).toBeLessThan(100); // the absence costs score, not confidence
});

test("an ICP without decision-maker roles omits the contact factor and normalises: it can reach 100 and tier S", () => {
  const r = computeScore(input({ icp: { criteria: { ...criteria, decisionMakerRoles: [] } }, contact: { fields: [] } }));
  expect(r.contributions.some((c) => c.factor === "contact.role")).toBe(false);
  expect(r.contributions.reduce((sum, c) => sum + c.weight, 0)).toBeCloseTo(100, 9);
  expect(r.contributions.map((c) => c.weight)).toEqual([35 / 4 * (100 / 80), 35 / 4 * (100 / 80), 35 / 4 * (100 / 80), 35 / 4 * (100 / 80), 45 * (100 / 80)]);
  expect(r.score).toBe(100);
  expect(r.fit).toBe(100);
  expect(r.tier).toBe("S");
  // Confidence reads company fields only; and a contact title does not matter.
  expect(r.confidence).toBe(1);
});

test("parseSize accepts only whole-string number, range or open range, and reads k suffixes", () => {
  expect(parseSize("250")).toEqual({ lo: 250, hi: 250 });
  expect(parseSize("51-200")).toEqual({ lo: 51, hi: 200 });
  expect(parseSize(" 201 - 1,000 ")).toEqual({ lo: 201, hi: 1000 });
  expect(parseSize("1,000+")).toEqual({ lo: 1000, hi: Infinity });
  expect(parseSize("5k-10k")).toEqual({ lo: 5000, hi: 10000 });
  expect(parseSize("10k+")).toEqual({ lo: 10000, hi: Infinity });
  for (const bad of ["51-200 (2023)", "Founded 2015, 51-200", "up to 50", "under 10", "200-51", "many", "", "1-2-3", "about 100"]) {
    expect(parseSize(bad), bad).toBeNull();
  }
  // And a null parse scores exactly 0 rather than a confident wrong match.
  const size = (t: string) => computeScore(input({ account: { fields: fields({ ...perfectAccount, size: t }) } })).contributions.find((c) => c.factor === "company.size")?.input;
  expect(size("51-200 (2023)")).toBe(0);
  expect(size("up to 50")).toBe(0);
  expect(size("Founded 2015, 51-200")).toBe(0);
  expect(size("5k-10k")).toBe(0); // 5000-10000 employees is outside 50-500, not "5-10"
});

test("a future-dated claim cannot boost freshness: age runs from min(observedAt, recordedAt)", () => {
  const future = NOW + 30 * DAY;
  const old = NOW - 365 * DAY;
  const conf = (observedAt: number, recorded?: number) => {
    const af = fields(perfectAccount, "observed", 1, observedAt);
    const cf = fields(perfectContact, "observed", 1, observedAt);
    const rec = recorded === undefined ? undefined : Object.fromEntries([...af, ...cf].map((f) => [f.claimId, recorded]));
    return computeScore(input({ account: { fields: af }, contact: { fields: cf }, claimRecordedAt: rec })).confidence;
  };
  expect(conf(future)).toBe(0.5); // no record: no credit
  expect(conf(future, old)).toBe(0.75); // claim says the future, we recorded it a year ago: a year old
  expect(conf(old, NOW)).toBe(0.75); // recorded later than observed: observedAt stands
});

test("data quality is absent from contributions", () => {
  const r = computeScore(input());
  expect(r.contributions.some((c) => /data.?quality|confidence/i.test(c.factor))).toBe(false);
  expect(Object.keys(model.weights).sort()).toEqual(["companyFit", "contactFit", "intent"]);
  // Confidence moves the tier, never the score.
  const weak = computeScore(input({ account: { fields: fields(perfectAccount, "inferred", 0.1) }, contact: { fields: fields(perfectContact, "inferred", 0.1) } }));
  expect(weak.score).toBe(r.score);
  expect(weak.confidence).toBeCloseTo(0.1, 12);
});

test("a failed email verification lowers confidence", () => {
  const base = computeScore(input()).confidence;
  const failed = computeScore(input({ verifications: [{ kind: "email", outcome: "fail", checkedAt: NOW }] }));
  expect(base).toBe(1);
  expect(failed.confidence).toBe(0.5);
  expect(failed.tier).toBe("C"); // 100 points, confidence 0.5
  const both = computeScore(input({ verifications: [{ kind: "email", outcome: "fail", checkedAt: NOW }, { kind: "phone", outcome: "fail", checkedAt: NOW }] }));
  expect(both.confidence).toBe(0.25);
  // Only the latest result per kind counts: a later pass supersedes an earlier fail.
  const recovered = computeScore(input({ verifications: [{ kind: "email", outcome: "fail", checkedAt: 1 }, { kind: "email", outcome: "pass", checkedAt: 2 }] }));
  expect(recovered.confidence).toBe(1);
});

test("an empty verifications array scores the same as before Task 15", () => {
  const without = computeScore(input());
  expect(computeScore(input({ verifications: [] }))).toEqual(without);
  const neutral: VerificationResult[] = [{ kind: "email", outcome: "pass", checkedAt: NOW }, { kind: "phone", outcome: "unknown", checkedAt: NOW }];
  expect(computeScore(input({ verifications: neutral }))).toEqual(without);
});

test("two model versions with different freshness half-lives give different confidence for the same claim", () => {
  const old = (m: typeof model) => computeScore(input({ model: m, account: { fields: fields(perfectAccount, "observed", 1, NOW - 365 * DAY) }, contact: { fields: fields(perfectContact, "observed", 1, NOW - 365 * DAY) } })).confidence;
  expect(old(model)).toBe(0.75);
  expect(old({ ...model, claimHalfLifeMs: 730 * DAY })).toBeCloseTo(0.5 + 0.5 * Math.SQRT1_2, 8);
  expect(old({ ...model, claimHalfLifeMs: 30 * DAY })).toBeCloseTo(0.5 + 0.5 * Math.pow(0.5, 365 / 30), 8);
  // An unusable half-life fails closed to fully aged instead of dividing by it.
  expect(old({ ...model, claimHalfLifeMs: 0 })).toBe(0.5);
  expect(old({ ...model, claimHalfLifeMs: NaN })).toBe(0.5);
});

test("two models with different size-overlap credits give different company-fit contributions for the same range", () => {
  const overlapping = { account: { fields: fields({ ...perfectAccount, size: "201-1,000" }) } }; // overlaps 50-500, not inside
  const size = (m: typeof model) => computeScore(input({ ...overlapping, model: m })).contributions.find((c) => c.factor === "company.size");
  expect(size(model)).toEqual({ factor: "company.size", input: 0.5, weight: 8.75, contributed: 4.375 });
  expect(size({ ...model, sizeOverlapCredit: 0.2 })?.input).toBe(0.2);
  expect(size({ ...model, sizeOverlapCredit: 1 })?.input).toBe(1);
  expect(size({ ...model, sizeOverlapCredit: NaN })?.input).toBe(0);
  // Fully inside / fully outside are unaffected by the credit.
  const inside = computeScore(input({ model: { ...model, sizeOverlapCredit: 0 } })).contributions.find((c) => c.factor === "company.size");
  expect(inside?.input).toBe(1);
});

test("two models with different freshness floors give different confidence for a very old claim", () => {
  const ancient = (m: typeof model) => computeScore(input({ model: m, account: { fields: fields(perfectAccount, "observed", 1, NOW - 100000 * DAY) }, contact: { fields: fields(perfectContact, "observed", 1, NOW - 100000 * DAY) } })).confidence;
  expect(ancient(model)).toBeCloseTo(0.5, 12);
  expect(ancient({ ...model, claimFreshnessFloor: 0.9 })).toBeCloseTo(0.9, 12);
  expect(ancient({ ...model, claimFreshnessFloor: 0 })).toBeCloseTo(0, 12);
  expect(ancient({ ...model, claimFreshnessFloor: NaN })).toBe(0);
});

test("the failed-verification factor comes from the model", () => {
  const failed: VerificationResult[] = [{ kind: "email", outcome: "fail", checkedAt: NOW }];
  expect(computeScore(input({ verifications: failed, model: { ...model, failedVerificationFactor: 0.2 } })).confidence).toBe(0.2);
  expect(computeScore(input({ verifications: failed, model: { ...model, failedVerificationFactor: NaN } })).confidence).toBe(0);
});

test("ten weak signals approach 1 under noisy-or (documented modelling choice)", () => {
  const r = computeScore(input({ signals: Array.from({ length: 10 }, () => signal({ confidence: 0.2 })) }));
  expect(r.intent).toBeCloseTo(100 * (1 - Math.pow(0.8, 10)), 9);
});

test("claim age lowers confidence by at most half", () => {
  const year = 365 * DAY;
  const aged = (age: number) => computeScore(input({ account: { fields: fields(perfectAccount, "observed", 1, NOW - age) }, contact: { fields: fields(perfectContact, "observed", 1, NOW - age) } })).confidence;
  expect(aged(0)).toBe(1);
  expect(aged(year)).toBe(0.75);
  expect(aged(1000 * year)).toBeCloseTo(0.5, 12);
  // Future-dated with no record of when we saw it earns no freshness credit: the floor, not a free boost.
  expect(aged(-5 * DAY)).toBe(0.5);
});

test("intent uses confidence-weighted contribution: an unverified rumour counts for less", () => {
  const confirmed = computeScore(input({ signals: [signal({ confidence: 1 })] })).intent;
  const rumour = computeScore(input({ signals: [signal({ confidence: 0.2 })] })).intent;
  expect(confirmed).toBe(100);
  expect(rumour).toBeCloseTo(20, 9);
  // Decay and expiry still apply.
  const old = computeScore(input({ signals: [signal({ observedAt: NOW - 90 * DAY })] })).intent;
  expect(old).toBeCloseTo(50, 9);
  expect(computeScore(input({ signals: [signal({ expiresAt: NOW })] })).intent).toBe(0);
  // Several signals accumulate but cannot exceed 100.
  const many = computeScore(input({ signals: [signal({ confidence: 0.5 }), signal({ confidence: 0.5 }), signal({ strength: "medium", confidence: 0.5 })] }));
  expect(many.intent).toBeCloseTo(100 * (1 - 0.5 * 0.5 * 0.7), 9);
});

test("float drift in the sum of contributions cannot push a perfect score past 100 and into Reject", () => {
  // These weights sum to exactly 100, yet 12.13/3 three times + 24.91 + 62.96000000000001 is 100.00000000000001.
  const weights = { companyFit: 12.13, contactFit: 24.91, intent: 62.96000000000001 };
  expect(weights.companyFit + weights.contactFit + weights.intent).toBe(100);
  const r = computeScore(input({ model: { ...model, weights }, icp: { criteria: { ...criteria, technologies: [] } } }));
  expect(r.score).toBe(100);
  expect(r.tier).toBe("S");
});

test("fail-closed on hostile numbers: never NaN, negative or Infinity", () => {
  const bad = (confidence: number) => ({ field: "industry", value: "software", claimId: id(), method: "observed" as const, confidence, observedAt: NOW });
  for (const c of [NaN, Infinity, -1, 2]) {
    const r = computeScore(input({ account: { fields: [bad(c)] }, contact: { fields: [] } }));
    expect(r.confidence).toBe(0);
    expect(r.tier).toBe("Reject");
    for (const k of ["fit", "intent", "score", "priority"] as const) expect(Number.isFinite(r[k]) && r[k] >= 0 && r[k] <= 100).toBe(true);
  }
  const nanAge = computeScore(input({ account: { fields: fields(perfectAccount, "observed", 1, NaN) }, contact: { fields: fields(perfectContact, "observed", 1, NaN) } }));
  expect(nanAge.confidence).toBe(0.5);
  // A zero-weight model must not divide by zero.
  const zero = computeScore(input({ model: { ...model, weights: { companyFit: 0, contactFit: 0, intent: 100 } } }));
  expect(zero.fit).toBe(0);
  expect(zero.score).toBe(100);
  // An ICP that asks for nothing matches nothing.
  const empty = computeScore(input({ icp: { criteria: { industries: [], geographies: [], technologies: [], decisionMakerRoles: [] } } }));
  expect(empty.fit).toBe(0);
  expect(empty.contributions[0]).toEqual({ factor: "company.criteria", input: 0, weight: 43.75, contributed: 0 }); // contact omitted, so 35 is normalised over 35 + 45
});

test("fit matching: role is whole-word, size handles ranges, geography reads country or location", () => {
  const role = (title: string) => computeScore(input({ contact: { fields: fields({ title }) } })).contributions.find((c) => c.factor === "contact.role")?.input;
  expect(role("Chief Technology Officer, CTO")).toBe(1);
  expect(role("Director of Sales")).toBe(0); // "cto" hides inside "dire-cto-r"
  const size = (s: string) => computeScore(input({ account: { fields: fields({ ...perfectAccount, size: s }) } })).contributions.find((c) => c.factor === "company.size")?.input;
  expect(size("100")).toBe(1);
  expect(size("201-1,000")).toBe(0.5);
  expect(size("10000+")).toBe(0);
  expect(size("many")).toBe(0);
  const geo = (f: Record<string, unknown>) => computeScore(input({ account: { fields: fields({ ...perfectAccount, country: undefined, ...f }) } })).contributions.find((c) => c.factor === "company.geography")?.input;
  expect(geo({ country: "us" })).toBe(1);
  expect(geo({ country: undefined, location: "Austin, TX, US" })).toBe(1);
  expect(geo({ country: "DE" })).toBe(0);
  expect(parseSize("1,000+")).toEqual({ lo: 1000, hi: Infinity });
});

// ---- recordScoreRun -------------------------------------------------------------------------

let raw: ReturnType<typeof convexTest>;
let t: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
let orgId: Id<"orgs">;
beforeEach(async () => {
  raw = convexTest(schema, modules);
  orgId = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 }));
  t = raw.withIdentity({ subject: "u1", orgId });
});

async function seed() {
  return await t.run(async (ctx) => {
    const accountId = await ctx.db.insert("accounts", { orgId, fields: [], display: {} });
    const icpId = await createIcpVersion(ctx, { name: "ICP", criteria });
    return { accountId, icpId };
  });
}
const goodResult = (): ScoreResult => computeScore(input());

test("recordScoreRun appends a row citing a real scoring model, seeding v1 when none exists", async () => {
  const { accountId, icpId } = await seed();
  expect(await raw.run((ctx) => ctx.db.query("scoringModels").collect())).toEqual([]);
  const result = goodResult();
  const runId = await t.run((ctx) => recordScoreRun(ctx, { subjectType: "account", subjectId: accountId, icpVersionId: icpId, result }));
  const models = await raw.run((ctx) => ctx.db.query("scoringModels").collect());
  expect(models).toHaveLength(1);
  const row = await raw.run((ctx) => ctx.db.get(runId));
  expect(row).toMatchObject({ orgId, subjectId: accountId, icpVersionId: icpId, scoringModelId: models[0]._id, score: 100, tier: "S", confidence: 1 });
  expect(row?.contributions).toEqual(result.contributions);
  // A rescore is a new row, not a patch.
  await t.run((ctx) => recordScoreRun(ctx, { subjectType: "account", subjectId: accountId, icpVersionId: icpId, result }));
  expect(await raw.run((ctx) => ctx.db.query("scoreRuns").collect())).toHaveLength(2);
  expect(await raw.run((ctx) => ctx.db.query("scoringModels").collect())).toHaveLength(1);
});

test("recordScoreRun refuses results that could not have come from computeScore, and foreign rows", async () => {
  const { accountId, icpId } = await seed();
  const call = (result: ScoreResult, over: Partial<Parameters<typeof recordScoreRun>[1]> = {}) =>
    t.run((ctx) => recordScoreRun(ctx, { subjectType: "account", subjectId: accountId, icpVersionId: icpId, result, ...over }));
  const good = goodResult();
  await expect(call({ ...good, score: NaN })).rejects.toThrow(/result\.score/);
  await expect(call({ ...good, confidence: 1.5 })).rejects.toThrow(/result\.confidence/);
  await expect(call({ ...good, tier: "Bogus" as never })).rejects.toThrow(/tier/);
  await expect(call({ ...good, tier: "A" })).rejects.toThrow(/does not match score and confidence/);
  await expect(call({ ...good, score: 99 })).rejects.toThrow(/sum of its contributions/);
  await expect(call({ ...good, contributions: [...good.contributions, { factor: "dataQuality", input: 0, weight: 0, contributed: 0 }] })).rejects.toThrow(/data quality/);
  await expect(call({ ...good, contributions: [] })).rejects.toThrow(/contributions/);
  // Every relationship, not just the ranges: a tampered or other-model result must not persist.
  await expect(call({ ...good, priority: 10 })).rejects.toThrow(/result\.priority must equal/);
  await expect(call({ ...good, fit: 50, priority: 50 })).rejects.toThrow(/fit does not follow/); // priority kept consistent so only fit is wrong
  await expect(call({ ...good, intent: 50, priority: 50 })).rejects.toThrow(/result\.intent must equal/);
  const bump = (i: number, patch: object) => good.contributions.map((c, k) => (k === i ? { ...c, ...patch } : c));
  await expect(call({ ...good, contributions: bump(0, { contributed: 1 }) })).rejects.toThrow(/input x weight/);
  // Computed under a different model (35/20/45 -> 30/25/45) yet internally consistent and tiering the same.
  const otherModel = computeScore(input({ model: { ...model, weights: { companyFit: 30, contactFit: 25, intent: 45 } } }));
  expect(otherModel.tier).toBe(good.tier);
  await expect(call(otherModel)).rejects.toThrow(/do not match the cited scoring model/);
  await expect(call({ ...good, contributions: [...good.contributions, { factor: "mystery", input: 0, weight: 0, contributed: 0 }] })).rejects.toThrow(/unknown scoring factor/);
  await expect(call(good, { subjectId: "nope" })).rejects.toThrow(/invalid subject id/);
  const other = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
  const foreign = await raw.run((ctx) => ctx.db.insert("accounts", { orgId: other, fields: [], display: {} }));
  await expect(call(good, { subjectId: foreign })).rejects.toThrow(/subject not found/);
  expect(await raw.run((ctx) => ctx.db.query("scoreRuns").collect())).toEqual([]);
  // A normalised result (contact omitted) is accepted under the same model.
  const noContact = computeScore(input({ icp: { criteria: { ...criteria, decisionMakerRoles: [] } } }));
  await expect(call(noContact)).resolves.toBeDefined();
});

test("scoring code never patches or deletes a score run, and no function declares an orgId argument", async () => {
  const sources = import.meta.glob("./*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  for (const [file, text] of Object.entries(sources)) {
    if (file.endsWith(".test.ts") || file.endsWith("schema.ts")) continue; // schema.ts declares the stored column, not an argument
    expect(text, file).not.toMatch(/db\.(patch|replace|delete)\(/);
    expect(text, file).not.toMatch(/orgId:\s*v\./);
  }
});

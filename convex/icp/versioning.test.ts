/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { decayedWeight } from "../signals/decay";
import { asMember } from "../_shared/testkit.support";
import schema from "../schema";
import { DEFAULT_SCORING_MODEL } from "./defaults";
import { ensureActiveScoringModel } from "./mutations";
import { createIcpVersion, createScoringModel } from "../_shared/testkit.support";
import { tierFor } from "./tier";
import { activeIcp, scoringConfigForRead, getIcpVersion, getScoringModel } from "./queries";
import type { IcpCriteria, ScoringConfig } from "./schema";
import { validateScoringConfig } from "./validate";

const modules = import.meta.glob("/convex/**/*.ts");
const criteria: IcpCriteria = { industries: ["software"], geographies: ["US"], technologies: [], decisionMakerRoles: ["CTO"], employeeMin: 50, employeeMax: 500 };
const DAY = 24 * 60 * 60 * 1000;

let raw: ReturnType<typeof convexTest>;
let t: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
let orgId: Id<"orgs">;

beforeEach(async () => {
  raw = convexTest(schema, modules);
  orgId = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 }));
  t = await asMember(raw, "u1", orgId);
});

const model = (over: Partial<ScoringConfig> = {}): ScoringConfig => ({ ...structuredClone(DEFAULT_SCORING_MODEL), ...over });
const run = <T>(fn: (ctx: MutationCtx) => Promise<T>) => t.run(fn);

test("DEFAULT_SCORING_MODEL matches the spec: 35/20/45, ceilings 1.0/0.7/0.5", () => {
  const d = DEFAULT_SCORING_MODEL;
  expect(d.weights).toEqual({ companyFit: 35, contactFit: 20, intent: 45 });
  expect(d.weights.companyFit + d.weights.contactFit + d.weights.intent).toBe(100);
  expect(d.methodCeilings).toEqual({ observed: 1.0, extracted: 0.7, inferred: 0.5 });
  expect(d.strengthWeights).toEqual({ high: 1, medium: 0.6, low: 0.25 });
  expect(d.decayHalfLives).toEqual({ high: 90 * DAY, medium: 45 * DAY, low: 14 * DAY });
  expect(d.claimHalfLifeMs).toBe(365 * DAY);
  expect(d.failedVerificationFactor).toBe(0.5);
  expect(d.claimFreshnessFloor).toBe(0.5);
  expect(d.sizeOverlapCredit).toBe(0.5);
  const band = (tier: string) => d.tierBands.find((b) => b.tier === tier);
  expect([band("S"), band("A"), band("B"), band("C"), band("Reject")]).toEqual([
    { tier: "S", min: 90, max: 100 },
    { tier: "A", min: 80, max: 90 },
    { tier: "B", min: 70, max: 80 },
    { tier: "C", min: 60, max: 70 },
    { tier: "Reject", min: 0, max: 60 },
  ]);
  expect(() => validateScoringConfig(d)).not.toThrow();
});

test("createScoringModel rejects weights that do not sum to 100", async () => {
  for (const weights of [
    { companyFit: 35, contactFit: 20, intent: 44 },
    { companyFit: 35, contactFit: 20, intent: 46 },
    { companyFit: 33.3, contactFit: 33.3, intent: 33.3 },
    { companyFit: NaN, contactFit: 20, intent: 45 },
    { companyFit: Infinity, contactFit: -Infinity, intent: 100 },
    { companyFit: 150, contactFit: -30, intent: -20 },
  ]) {
    await expect(run((ctx) => createScoringModel(ctx, model({ weights })))).rejects.toThrow(/weights/);
  }
  expect(await raw.run((ctx) => ctx.db.query("scoringModels").collect())).toEqual([]);
});

test("createScoringModel rejects non-finite or out-of-range ceilings, floors, strengths and half-lives", async () => {
  const bad: Array<[RegExp, Partial<ScoringConfig>]> = [
    [/methodCeilings\.observed/, { methodCeilings: { observed: 1.1, extracted: 0.7, inferred: 0.5 } }],
    [/methodCeilings\.extracted/, { methodCeilings: { observed: 1, extracted: NaN, inferred: 0.5 } }],
    [/methodCeilings\.inferred/, { methodCeilings: { observed: 1, extracted: 0.7, inferred: 0 } }],
    [/strengthWeights\.low/, { strengthWeights: { high: 1, medium: 0.6, low: -0.1 } }],
    [/claimFreshnessFloor/, { claimFreshnessFloor: -0.1 }],
    [/claimFreshnessFloor/, { claimFreshnessFloor: NaN }],
    [/sizeOverlapCredit/, { sizeOverlapCredit: 1.1 }],
    [/sizeOverlapCredit/, { sizeOverlapCredit: Infinity }],
    [/claimHalfLifeMs/, { claimHalfLifeMs: 0 }],
    [/claimHalfLifeMs/, { claimHalfLifeMs: Infinity }],
    [/failedVerificationFactor/, { failedVerificationFactor: 0 }],
    [/failedVerificationFactor/, { failedVerificationFactor: 1.5 }],
    [/failedVerificationFactor/, { failedVerificationFactor: NaN }],
    [/decayHalfLives\.high/, { decayHalfLives: { ...DEFAULT_SCORING_MODEL.decayHalfLives, high: 0 } }],
    [/decayHalfLives\.medium/, { decayHalfLives: { ...DEFAULT_SCORING_MODEL.decayHalfLives, medium: Infinity } }],
    [/decayHalfLives\.low/, { decayHalfLives: { ...DEFAULT_SCORING_MODEL.decayHalfLives, low: NaN } }],
    [/confidenceFloors\.S/, { confidenceFloors: { ...DEFAULT_SCORING_MODEL.confidenceFloors, S: 1.2 } }],
    [/confidenceFloors\.C/, { confidenceFloors: { ...DEFAULT_SCORING_MODEL.confidenceFloors, C: NaN } }],
    [/above it/, { confidenceFloors: { S: 0.5, A: 0.7, B: 0.6, C: 0.5, Reject: 0 } }],
  ];
  for (const [msg, over] of bad) {
    await expect(run((ctx) => createScoringModel(ctx, model(over)))).rejects.toThrow(msg);
  }
});

test("createScoringModel rejects tier bands that overlap, leave gaps, or do not cover 0..100", async () => {
  const bands = DEFAULT_SCORING_MODEL.tierBands;
  const withBand = (tier: string, patch: { min?: number; max?: number }) =>
    bands.map((b) => (b.tier === tier ? { ...b, ...patch } : b));
  const cases: Array<[RegExp, ScoringConfig["tierBands"]]> = [
    [/overlap/, withBand("A", { min: 79 })],
    [/gaps/, withBand("A", { min: 81 })],
    [/gaps/, withBand("S", { min: 91 })],
    [/end at 100/, withBand("S", { max: 99 })],
    [/start at 0/, withBand("Reject", { min: 1 })],
    [/min < max/, withBand("B", { min: 80 })],
    [/finite/, withBand("B", { max: NaN })],
    [/exactly 5/, bands.slice(1)],
    [/exactly once/, bands.map((b) => (b.tier === "C" ? { ...b, tier: "B" as const } : b))],
    [/rise from Reject to S/, bands.map((b) => (b.tier === "S" ? { ...b, tier: "A" as const } : b.tier === "A" ? { ...b, tier: "S" as const } : b))],
  ];
  for (const [msg, tierBands] of cases) {
    await expect(run((ctx) => createScoringModel(ctx, model({ tierBands })))).rejects.toThrow(msg);
  }
});

test("editing a model creates a new version and leaves the old row byte-identical", async () => {
  const v1 = await run((ctx) => createScoringModel(ctx, model()));
  const before = await raw.run((ctx) => ctx.db.get(v1));
  const v2 = await run((ctx) =>
    createScoringModel(ctx, { ...model({ weights: { companyFit: 30, contactFit: 20, intent: 50 } }), supersedesId: v1 }),
  );
  expect(v2).not.toBe(v1);
  const after = await raw.run((ctx) => ctx.db.get(v1));
  expect(after).toStrictEqual(before);
  const second = await raw.run((ctx) => ctx.db.get(v2));
  expect(second).toMatchObject({ version: 2, supersedesId: v1, orgId, weights: { intent: 50 } });
  expect(before).toMatchObject({ version: 1, orgId });
  expect(before!.supersedesId).toBeUndefined();
  expect(before!.createdBy).toMatchObject({ kind: "user" });
  expect(before!.activeFrom).toBeGreaterThan(0);
});

test("an existing scoreRun still resolves its original model version after a new one is created", async () => {
  const v1 = await run((ctx) => createScoringModel(ctx, model()));
  // Stand-in for a scoreRun (Task 10): a score is explained by the model id it recorded.
  const recorded = { scoringModelId: v1 };
  await run((ctx) =>
    createScoringModel(ctx, {
      ...model({ strengthWeights: { high: 0.5, medium: 0.3, low: 0.1 }, decayHalfLives: { high: DAY, medium: DAY, low: DAY } }),
      supersedesId: v1,
    }),
  );
  const resolved = await run((ctx) => getScoringModel(ctx, { id: recorded.scoringModelId }));
  expect(resolved.version).toBe(1);
  expect(resolved.strengthWeights).toEqual(DEFAULT_SCORING_MODEL.strengthWeights);
  // While "active" has moved on, and the same signal decays differently under each.
  const active = await run((ctx) => scoringConfigForRead(ctx, {}));
  expect(active.strengthWeights.high).toBe(0.5);
  const signal = { strength: "high" as const, observedAt: 0 };
  expect(decayedWeight(signal, 90 * DAY, resolved)).toBe(0.5);
  expect(decayedWeight(signal, 90 * DAY, active)).toBe(0.5 * Math.pow(0.5, 90));
});

test("with no model, the active config is the built-in default", async () => {
  expect(await run((ctx) => scoringConfigForRead(ctx, {}))).toStrictEqual(DEFAULT_SCORING_MODEL);
});

test("versions form one chain: forks, stale bases and bogus supersedesId are refused", async () => {
  const v1 = await run((ctx) => createScoringModel(ctx, model()));
  await expect(run((ctx) => createScoringModel(ctx, model()))).rejects.toThrow("supersedesId must be the current latest");
  const v2 = await run((ctx) => createScoringModel(ctx, { ...model(), supersedesId: v1 }));
  await expect(run((ctx) => createScoringModel(ctx, { ...model(), supersedesId: v1 }))).rejects.toThrow("current latest");
  await run((ctx) => createScoringModel(ctx, { ...model(), supersedesId: v2 }));
  const fresh = convexTest(schema, modules);
  const o = await fresh.run((ctx) => ctx.db.insert("orgs", { name: "O", createdAt: 0 }));
  await expect(
    fresh.withIdentity({ subject: "u", orgId: o }).run((ctx) => createScoringModel(ctx, { ...model(), supersedesId: v1 })),
  ).rejects.toThrow("no earlier version");
});

test("versions are per org: another org's history and rows are invisible", async () => {
  const mine = await run((ctx) => createScoringModel(ctx, model()));
  const other = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
  const theirs = await asMember(raw, "u2", other);
  const theirId = await theirs.run((ctx) => createScoringModel(ctx, model()));
  expect((await raw.run((ctx) => ctx.db.get(theirId)))!.version).toBe(1);
  await expect(theirs.run((ctx) => getScoringModel(ctx, { id: mine }))).rejects.toThrow("scoring model not found");
  await expect(run((ctx) => getScoringModel(ctx, { id: theirId }))).rejects.toThrow("scoring model not found");
});

test("createIcpVersion records supersedesId and createdBy", async () => {
  const v1 = await run((ctx) => createIcpVersion(ctx, { name: "Mid-market SaaS", criteria }));
  const v2 = await run((ctx) => createIcpVersion(ctx, { name: "Mid-market SaaS", criteria: { ...criteria, employeeMax: 1000 }, supersedesId: v1 }));
  const r1 = await run((ctx) => getIcpVersion(ctx, { id: v1 }));
  const r2 = await run((ctx) => getIcpVersion(ctx, { id: v2 }));
  expect(r1).toMatchObject({ version: 1, name: "Mid-market SaaS", orgId, criteria });
  expect(r1.supersedesId).toBeUndefined();
  expect(r2).toMatchObject({ version: 2, supersedesId: v1, createdBy: r1.createdBy });
  expect(r1.createdBy).toMatchObject({ kind: "user", userId: expect.stringContaining("u1") });
  expect(r2.criteria.employeeMax).toBe(1000);
  expect(r1.criteria.employeeMax).toBe(500);
  expect((await run((ctx) => activeIcp(ctx, {})))._id).toBe(v2);
});

test("activeIcp throws a named error when none exists, and ICP input is validated", async () => {
  await expect(run((ctx) => activeIcp(ctx, {}))).rejects.toThrow("no active icp");
  await expect(run((ctx) => createIcpVersion(ctx, { name: "  ", criteria }))).rejects.toThrow("name");
  await expect(run((ctx) => createIcpVersion(ctx, { name: "x", criteria: { ...criteria, employeeMin: 10, employeeMax: 5 } }))).rejects.toThrow("employeeMin");
  await expect(run((ctx) => createIcpVersion(ctx, { name: "x", criteria: { ...criteria, employeeMin: NaN } }))).rejects.toThrow("employeeMin");
  await expect(run((ctx) => createIcpVersion(ctx, { name: "x", criteria: { ...criteria, industries: [1 as never] } }))).rejects.toThrow("industries");
});

test("no public function can write or delete these tables, and no orgId argument exists", async () => {
  const sources = import.meta.glob("/convex/icp/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  for (const [path, src] of Object.entries(sources)) {
    if (path.endsWith(".test.ts")) continue;
    expect(src, path).not.toMatch(/db\.(patch|replace|delete)\(/);
    // The analyst-gated endpoints live in api.ts and nowhere else in this folder (authz.guard.test.ts checks every
    // registration for a role check; here the point is that no OTHER file in icp/ can grow a public door).
    if (path.endsWith("/icp/api.ts")) {
      const registrations = src.match(/\b(mutation|query|action)\(\{/g) ?? [];
      expect(registrations).toHaveLength(2);
      expect(src.match(/requireRole\(ctx, "analyst"\)/g)).toHaveLength(2);
      continue;
    }
    expect(src, path).not.toMatch(/\b(mutation|query|action)\(\{/);
  }
});

const D = DEFAULT_SCORING_MODEL;

test("tierFor honours half-open band boundaries (confidence 1 so floors never interfere)", () => {
  const at = (s: number) => tierFor(s, 1, D);
  expect(at(100)).toBe("S");
  expect(at(90)).toBe("S");
  expect(at(89.99)).toBe("A");
  expect(at(89)).toBe("A");
  expect(at(80)).toBe("A");
  expect(at(79.99)).toBe("B");
  expect(at(70)).toBe("B");
  expect(at(69.99)).toBe("C");
  expect(at(60)).toBe("C");
  expect(at(59.99)).toBe("Reject");
  expect(at(0)).toBe("Reject");
});

test("tierFor drops a score that fails its band's confidence floor to the next tier it qualifies for", () => {
  expect(tierFor(92, 0.8, D)).toBe("S"); // exactly at floor passes
  expect(tierFor(92, 0.79, D)).toBe("A");
  expect(tierFor(92, 0.65, D)).toBe("B"); // fails S (.8) and A (.7), meets B (.6)
  expect(tierFor(92, 0.4, D)).toBe("Reject");
  expect(tierFor(92, 0, D)).toBe("Reject");
  expect(tierFor(65, 0.49, D)).toBe("Reject");
  expect(tierFor(65, 0.5, D)).toBe("C");
});

test("tierFor fails closed on unusable input with exactly Reject", () => {
  for (const [s, c] of [[NaN, 1], [90, NaN], [Infinity, 1], [-1, 1], [101, 1], [90, 1.01], [90, -0.1], [90, Infinity]] as const) {
    expect(tierFor(s, c, D)).toBe("Reject");
  }
});

test("ensureActiveScoringModel seeds v1 exactly once and then returns the existing row", async () => {
  const first = await run((ctx) => ensureActiveScoringModel(ctx));
  const second = await run((ctx) => ensureActiveScoringModel(ctx));
  expect(first.version).toBe(1);
  expect(first.supersedesId).toBeUndefined();
  expect(second._id).toBe(first._id);
  expect(first.weights).toEqual(D.weights);
  expect(await raw.run((ctx) => ctx.db.query("scoringModels").collect())).toHaveLength(1);
});

test("ensureActiveScoringModel returns the newest existing row rather than creating a version", async () => {
  const v1 = await run((ctx) => createScoringModel(ctx, model()));
  const v2 = await run((ctx) => createScoringModel(ctx, { ...model({ weights: { companyFit: 30, contactFit: 20, intent: 50 } }), supersedesId: v1 }));
  const got = await run((ctx) => ensureActiveScoringModel(ctx));
  expect(got._id).toBe(v2);
  expect(got.weights.intent).toBe(50);
  expect(await raw.run((ctx) => ctx.db.query("scoringModels").collect())).toHaveLength(2);
});

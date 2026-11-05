/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { DEFAULT_SCORING_MODEL } from "../icp/defaults";
import { DEFAULT_STRENGTH_BY_KIND, decayedWeight, signalContribution, type Signal } from "./decay";
import { MAX_FUTURE_SKEW_MS, MAX_SIGNALS, activeSignals, appendSignal } from "./mutations";

const modules = import.meta.glob("/convex/**/*.ts");
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const P = DEFAULT_SCORING_MODEL;
const STRENGTH_WEIGHTS = P.strengthWeights;
const HALF_LIFE_MS = P.decayHalfLives;

const sig = (over: Partial<Signal> = {}) =>
  ({ strength: "high", observedAt: NOW, ...over }) as Pick<Signal, "strength" | "observedAt" | "expiresAt">;

test("a signal observed today keeps its full strength weight", () => {
  for (const s of ["high", "medium", "low"] as const) {
    expect(decayedWeight(sig({ strength: s }), NOW, P)).toBe(STRENGTH_WEIGHTS[s]);
  }
});

test("weight halves after exactly one half-life", () => {
  const w = decayedWeight(sig({ observedAt: NOW - HALF_LIFE_MS.high }), NOW, P);
  expect(w).toBeCloseTo(STRENGTH_WEIGHTS.high / 2, 10);
});

test("a six-month-old high signal decays below a fresh medium signal", () => {
  const old = decayedWeight(sig({ strength: "high", observedAt: NOW - 180 * DAY }), NOW, P);
  expect(old).toBeLessThan(decayedWeight(sig({ strength: "medium" }), NOW, P));
});

test("an expired signal has weight 0 even inside its half-life", () => {
  const s = sig({ observedAt: NOW - DAY, expiresAt: NOW - 1 });
  expect(decayedWeight(s, NOW, P)).toBe(0);
  expect(decayedWeight(sig({ observedAt: NOW - DAY, expiresAt: NOW + DAY }), NOW, P)).toBeGreaterThan(0);
});

test("decayedWeight never returns NaN, a negative number or Infinity", () => {
  const nows = [NOW, NaN, Infinity, -Infinity, -1, 0, Number.MAX_VALUE];
  const observed = [NOW, NaN, Infinity, -Infinity, NOW + 10 * DAY, -1e300, 0];
  for (const strength of ["high", "medium", "low"] as const)
    for (const now of nows)
      for (const observedAt of observed)
        for (const expiresAt of [undefined, NaN, Infinity, NOW - 1, NOW + DAY]) {
          const w = decayedWeight({ strength, observedAt, expiresAt }, now, P);
          expect(Number.isFinite(w)).toBe(true);
          expect(w).toBeGreaterThanOrEqual(0);
          expect(w).toBeLessThanOrEqual(STRENGTH_WEIGHTS[strength]);
        }
  // an unknown strength that slipped past validation must not leak NaN either
  expect(decayedWeight({ strength: "bogus" as never, observedAt: NOW }, NOW, P)).toBe(0);
});

test("strength weights order high > medium > low, and so do half-lives", () => {
  expect(STRENGTH_WEIGHTS.high).toBeGreaterThan(STRENGTH_WEIGHTS.medium);
  expect(STRENGTH_WEIGHTS.medium).toBeGreaterThan(STRENGTH_WEIGHTS.low);
  expect(HALF_LIFE_MS.high).toBeGreaterThan(HALF_LIFE_MS.medium);
  expect(HALF_LIFE_MS.medium).toBeGreaterThan(HALF_LIFE_MS.low);
});

test("default strengths follow the spec", () => {
  expect(DEFAULT_STRENGTH_BY_KIND).toMatchObject({
    funding_announcement: "high",
    executive_hired: "high",
    major_expansion: "high",
    relevant_hiring: "medium",
    technology_detected: "medium",
    website_activity: "low",
  });
});

let raw: ReturnType<typeof convexTest>;
let t: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
let accountId: Id<"accounts">;
let otherOrgAccount: Id<"accounts">;
let otherT: typeof t;

afterEach(() => vi.useRealTimers());

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  raw = convexTest(schema, modules);
  const s = await raw.run(async (ctx) => {
    const org = await ctx.db.insert("orgs", { name: "A", createdAt: 0 });
    const other = await ctx.db.insert("orgs", { name: "B", createdAt: 0 });
    return {
      org,
      other,
      account: await ctx.db.insert("accounts", { orgId: org, fields: [], display: {} }),
      otherAccount: await ctx.db.insert("accounts", { orgId: other, fields: [], display: {} }),
    };
  });
  accountId = s.account;
  otherOrgAccount = s.otherAccount;
  t = raw.withIdentity({ subject: "u1", orgId: s.org });
  otherT = raw.withIdentity({ subject: "u2", orgId: s.other });
});

const base = () => ({
  subjectType: "account" as const,
  subjectId: accountId as string,
  kind: "funding_announcement",
  strength: "high" as const,
  confidence: 0.9,
  observedAt: NOW - DAY,
});

test("appendSignal stores a signal and activeSignals returns it annotated with weight", async () => {
  await t.run((ctx) => appendSignal(ctx, base()));
  const out = await t.run((ctx) => activeSignals(ctx, { subjectType: "account", subjectId: accountId, now: NOW }));
  expect(out).toHaveLength(1);
  expect(out[0].weight).toBe(decayedWeight(out[0], NOW, P));
  expect(out[0].kind).toBe("funding_announcement");
});

test("activeSignals decays under the active model by default and under a named historical model on request", async () => {
  const org = (await raw.run((ctx) => ctx.db.get(accountId)))!.orgId;
  const v1 = await raw.run((ctx) => ctx.db.insert("scoringModels", { ...P, orgId: org, version: 1, createdBy: "u1", activeFrom: 0 }));
  await raw.run((ctx) =>
    ctx.db.insert("scoringModels", { ...P, strengthWeights: { high: 0.5, medium: 0.3, low: 0.1 }, orgId: org, version: 2, supersedesId: v1, createdBy: "u1", activeFrom: 1 }),
  );
  await t.run((ctx) => appendSignal(ctx, { ...base(), observedAt: NOW, confidence: 1 }));
  const args = { subjectType: "account" as const, subjectId: accountId as string, now: NOW };
  const active = await t.run((ctx) => activeSignals(ctx, args));
  expect(active.map((x) => [x.weight, x.contribution])).toEqual([[0.5, 0.5]]);
  const historical = await t.run((ctx) => activeSignals(ctx, { ...args, scoringModelId: v1 }));
  expect(historical.map((x) => [x.weight, x.contribution])).toEqual([[1, 1]]);
});

test("decay fails closed on unusable params: exactly 0, never NaN", () => {
  const sig2 = { strength: "high" as const, observedAt: NOW };
  const hl = P.decayHalfLives;
  const sw = P.strengthWeights;
  for (const bad of [0, -1, NaN, Infinity, undefined as never]) {
    expect(decayedWeight(sig2, NOW, { strengthWeights: sw, decayHalfLives: { ...hl, high: bad } })).toBe(0);
    expect(decayedWeight(sig2, NOW, { strengthWeights: { ...sw, high: bad }, decayHalfLives: hl })).toBe(0);
  }
  expect(signalContribution({ ...sig2, confidence: 1 }, NOW, { strengthWeights: sw, decayHalfLives: { ...hl, high: 0 } })).toBe(0);
});

test("activeSignals drops expired signals and orders newest first", async () => {
  await t.run(async (ctx) => {
    await appendSignal(ctx, { ...base(), kind: "old", observedAt: NOW - 10 * DAY });
    await appendSignal(ctx, { ...base(), kind: "gone", observedAt: NOW - 5 * DAY, expiresAt: NOW - DAY });
    await appendSignal(ctx, { ...base(), kind: "new", observedAt: NOW - DAY });
  });
  const out = await t.run((ctx) => activeSignals(ctx, { subjectType: "account", subjectId: accountId, now: NOW }));
  expect(out.map((s) => s.kind)).toEqual(["new", "old"]);
});

test("activeSignals never shows another org's signals", async () => {
  await t.run((ctx) => appendSignal(ctx, base()));
  const out = await otherT.run((ctx) => activeSignals(ctx, { subjectType: "account", subjectId: accountId, now: NOW }));
  expect(out).toEqual([]);
});

test("appendSignal rejects bad confidence, bad times and foreign or missing subjects", async () => {
  const bad: Array<Partial<ReturnType<typeof base>> & { expiresAt?: number }> = [
    { confidence: NaN },
    { confidence: 1.1 },
    { confidence: -0.1 },
    { confidence: Infinity },
    { observedAt: NaN },
    { observedAt: Infinity },
    { expiresAt: NaN },
    { expiresAt: Infinity },
    { expiresAt: NOW - 2 * DAY },
    { subjectId: otherOrgAccount as string },
    { subjectId: "nonsense" },
    { subjectType: "contact" as never },
  ];
  for (const over of bad) {
    await expect(t.run((ctx) => appendSignal(ctx, { ...base(), ...over }))).rejects.toThrow();
  }
  expect(await raw.run((ctx) => ctx.db.query("signals").collect())).toEqual([]);
});

test("appendSignal without an org identity fails closed", async () => {
  await expect(raw.run((ctx) => appendSignal(ctx, base()))).rejects.toThrow("no org context");
});

test("a half-confidence signal contributes half as much as an identical full-confidence one", () => {
  const full = signalContribution({ ...sig({ observedAt: NOW - 10 * DAY }), confidence: 1 }, NOW, P);
  const half = signalContribution({ ...sig({ observedAt: NOW - 10 * DAY }), confidence: 0.5 }, NOW, P);
  expect(full).toBeGreaterThan(0);
  expect(half).toBeCloseTo(full / 2, 12);
});

test("signalContribution is never NaN, negative or Infinity", () => {
  for (const confidence of [NaN, Infinity, -Infinity, -1, 0, 0.3, 1, 5])
    for (const now of [NOW, NaN, Infinity])
      for (const observedAt of [NOW, NaN, -Infinity, NOW + DAY]) {
        const c = signalContribution({ strength: "high", observedAt, confidence }, now, P);
        expect(Number.isFinite(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(STRENGTH_WEIGHTS.high);
      }
});

test("activeSignals annotates contribution = weight x confidence", async () => {
  await t.run((ctx) => appendSignal(ctx, { ...base(), confidence: 0.5 }));
  const [s] = await t.run((ctx) => activeSignals(ctx, { subjectType: "account", subjectId: accountId, now: NOW }));
  expect(s.contribution).toBeCloseTo(s.weight * 0.5, 12);
});

test("appendSignal rejects an exact duplicate event but allows distinct ones", async () => {
  const sourceId = await raw.run(async (ctx) => {
    const org = (await ctx.db.query("orgs").first())!._id;
    return ctx.db.insert("sources", { orgId: org, key: "web", kind: "crawler", trustWeight: 1, lawfulBasis: "legitimate_interest" });
  });
  const ev = { ...base(), sourceId };
  await t.run((ctx) => appendSignal(ctx, ev));
  await expect(t.run((ctx) => appendSignal(ctx, { ...ev, confidence: 0.2 }))).rejects.toThrow("duplicate signal");
  // different observedAt, kind, or source are different events
  await t.run((ctx) => appendSignal(ctx, { ...ev, observedAt: ev.observedAt - 1 }));
  await t.run((ctx) => appendSignal(ctx, { ...ev, kind: "executive_hired" }));
  await t.run((ctx) => appendSignal(ctx, { ...ev, sourceId: undefined }));
  expect(await raw.run((ctx) => ctx.db.query("signals").collect())).toHaveLength(4);
});

test("appendSignal rejects a source from another org", async () => {
  const foreign = await raw.run(async (ctx) => {
    const other = (await ctx.db.query("orgs").collect())[1]._id;
    return ctx.db.insert("sources", { orgId: other, key: "x", kind: "crawler", trustWeight: 1, lawfulBasis: "legitimate_interest" });
  });
  await expect(t.run((ctx) => appendSignal(ctx, { ...base(), sourceId: foreign }))).rejects.toThrow("source not found");
});

test("fail-closed inputs are exactly 0, not merely in range", () => {
  expect(decayedWeight({ strength: "high", observedAt: Infinity }, NOW, P)).toBe(0);
  expect(decayedWeight({ strength: "high", observedAt: NaN }, NOW, P)).toBe(0);
  expect(decayedWeight({ strength: "high", observedAt: NOW }, Infinity, P)).toBe(0);
  for (const confidence of [Infinity, -Infinity, NaN, 5, 1.0000001, -0.1, 0]) {
    expect(signalContribution({ strength: "high", observedAt: NOW, confidence }, NOW, P)).toBe(0);
  }
  expect(signalContribution({ strength: "high", observedAt: NOW, confidence: 1 }, NOW, P)).toBe(STRENGTH_WEIGHTS.high);
});

test("appendSignal rejects a future-dated observedAt beyond the skew but allows within it", async () => {
  await expect(
    t.run((ctx) => appendSignal(ctx, { ...base(), observedAt: Date.parse("2062-01-01") })),
  ).rejects.toThrow("observedAt is in the future");
  await expect(t.run((ctx) => appendSignal(ctx, { ...base(), observedAt: NOW + MAX_FUTURE_SKEW_MS + 1 }))).rejects.toThrow(
    "observedAt is in the future",
  );
  await t.run((ctx) => appendSignal(ctx, { ...base(), observedAt: NOW + MAX_FUTURE_SKEW_MS }));
});

test("activeSignals refuses a partial read instead of dropping live signals behind expired ones", async () => {
  await raw.run(async (ctx) => {
    const orgId = (await ctx.db.query("orgs").first())!._id;
    // one live old signal, then MAX_SIGNALS newer expired ones that would push it out of a naive window
    await ctx.db.insert("signals", { orgId, subjectType: "account", subjectId: accountId, kind: "live", strength: "high", confidence: 1, observedAt: NOW - 100 * DAY });
    for (let i = 0; i < MAX_SIGNALS; i++) {
      await ctx.db.insert("signals", { orgId, subjectType: "account", subjectId: accountId, kind: `e${i}`, strength: "high", confidence: 1, observedAt: NOW - DAY - i, expiresAt: NOW - 1 });
    }
  });
  await expect(
    t.run((ctx) => activeSignals(ctx, { subjectType: "account", subjectId: accountId, now: NOW })),
  ).rejects.toThrow(/more than 200 signals \(limit 200\)/);
});

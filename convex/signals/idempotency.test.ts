/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { MAX_SIGNAL_BATCH, MAX_SIGNALS, appendSignal } from "./mutations";

const modules = import.meta.glob("/convex/**/*.ts");
const DAY = 24 * 60 * 60 * 1000;

let raw: ReturnType<typeof convexTest>;
let t: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
let orgId: Id<"orgs">;
let accountId: Id<"accounts">;
let sourceId: Id<"sources">;
const at = Date.now() - 2 * DAY;

beforeEach(async () => {
  raw = convexTest(schema, modules);
  ({ orgId, accountId, sourceId } = await raw.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 });
    return {
      orgId,
      accountId: await ctx.db.insert("accounts", { orgId, fields: [], display: {} }),
      sourceId: await ctx.db.insert("sources", { orgId, key: "feed", kind: "crawler", trustWeight: 1, lawfulBasis: "legitimate_interest" }),
    };
  }));
  t = raw.withIdentity({ subject: "u1", orgId });
});

const ev = (over: Record<string, unknown> = {}) =>
  ({ subjectType: "account" as const, subjectId: accountId, kind: "hire", strength: "medium" as const, confidence: 0.8, observedAt: at, ...over });
const count = () => raw.run(async (ctx) => (await ctx.db.query("signals").collect()).length);

test("two genuinely distinct events on one day are both recorded when the reporter identifies them", async () => {
  const a = await t.run((ctx) => appendSignal(ctx, ev({ sourceId, externalId: "hire-1" })));
  const b = await t.run((ctx) => appendSignal(ctx, ev({ sourceId, externalId: "hire-2" })));
  expect(a.created && b.created).toBe(true);
  expect(a.id).not.toBe(b.id);
  expect(await count()).toBe(2);
});

test("a retried event is a no-op returning the original row, even when its observedAt or strength differs", async () => {
  const first = await t.run((ctx) => appendSignal(ctx, ev({ sourceId, externalId: "hire-1" })));
  const retry = await t.run((ctx) => appendSignal(ctx, ev({ sourceId, externalId: "hire-1", observedAt: at + 1000, strength: "high", confidence: 1 })));
  expect(retry).toEqual({ id: first.id, created: false });
  expect(await count()).toBe(1);
  // The original row is untouched: append-only means a retry cannot rewrite it.
  expect(await raw.run((ctx) => ctx.db.get(first.id))).toMatchObject({ strength: "medium", confidence: 0.8, observedAt: at });
});

test("an externalId is scoped to its subject, kind and source", async () => {
  await t.run((ctx) => appendSignal(ctx, ev({ sourceId, externalId: "x" })));
  const otherSource = await raw.run((ctx) => ctx.db.insert("sources", { orgId, key: "other", kind: "crawler", trustWeight: 1, lawfulBasis: "consent" }));
  const otherAccount = await raw.run((ctx) => ctx.db.insert("accounts", { orgId, fields: [], display: {} }));
  for (const over of [{ sourceId: otherSource }, { kind: "funding" }, { subjectId: otherAccount }, { sourceId: undefined }]) {
    expect((await t.run((ctx) => appendSignal(ctx, ev({ sourceId, externalId: "x", ...over })))).created).toBe(true);
  }
  expect(await count()).toBe(5);
});

test("without an externalId the exact (subject, kind, observedAt, source) tuple is the identity, and a no-op", async () => {
  const first = await t.run((ctx) => appendSignal(ctx, ev({ sourceId })));
  expect(await t.run((ctx) => appendSignal(ctx, ev({ sourceId, confidence: 0.1 })))).toEqual({ id: first.id, created: false });
  for (const over of [{ observedAt: at - 1 }, { kind: "funding" }, { sourceId: undefined }]) {
    expect((await t.run((ctx) => appendSignal(ctx, ev({ sourceId, ...over })))).created).toBe(true);
  }
  // An event with an identity is not the same event as an anonymous one at the same instant.
  expect((await t.run((ctx) => appendSignal(ctx, ev({ sourceId, externalId: "e" })))).created).toBe(true);
  expect(await count()).toBe(5);
});

test("a duplicate is found however many other signals share its instant (no bounded read to hide behind)", async () => {
  // MAX_SIGNALS + 5 rows at one instant, the one that matters inserted LAST: a take(MAX_SIGNALS) would never see it.
  const lastId = await raw.run(async (ctx) => {
    const row = (kind: string) => ({ orgId, subjectType: "account" as const, subjectId: accountId, kind, strength: "low" as const, confidence: 1, observedAt: at, sourceId });
    for (let i = 0; i < MAX_SIGNALS + 4; i++) await ctx.db.insert("signals", row(`filler-${i}`));
    return await ctx.db.insert("signals", row("the-one"));
  });
  expect(await t.run((ctx) => appendSignal(ctx, ev({ sourceId, kind: "the-one" })))).toEqual({ id: lastId, created: false });
  expect(await count()).toBe(MAX_SIGNALS + 5);
});

test("an externalId is validated at the write boundary", async () => {
  for (const externalId of ["", "   ", "x".repeat(201)]) {
    await expect(t.run((ctx) => appendSignal(ctx, ev({ sourceId, externalId })))).rejects.toThrow("externalId must be");
  }
  expect(await count()).toBe(0);
});

test("recordSignals: a retried batch is a no-op and reports what was new", async () => {
  const batch = [ev({ sourceId, externalId: "a" }), ev({ sourceId, externalId: "b" }), ev({ sourceId, kind: "funding" })];
  expect(await t.mutation(api.signals.mutations.recordSignals, { signals: batch })).toEqual({ created: 3, duplicates: 0 });
  expect(await t.mutation(api.signals.mutations.recordSignals, { signals: batch })).toEqual({ created: 0, duplicates: 3 });
  expect(await t.mutation(api.signals.mutations.recordSignals, { signals: [...batch, ev({ sourceId, externalId: "c" })] })).toEqual({ created: 1, duplicates: 3 });
  expect(await count()).toBe(4);
});

test("recordSignals is all-or-nothing and refuses an oversized batch or a foreign subject", async () => {
  await expect(t.mutation(api.signals.mutations.recordSignals, { signals: [ev({ externalId: "ok" }), ev({ confidence: 7 })] })).rejects.toThrow("confidence must be between 0 and 1");
  expect(await count()).toBe(0);
  const many = Array.from({ length: MAX_SIGNAL_BATCH + 1 }, (_, i) => ev({ externalId: `e${i}` }));
  await expect(t.mutation(api.signals.mutations.recordSignals, { signals: many })).rejects.toThrow("batch_too_large");
  const foreign = raw.withIdentity({ subject: "u2", orgId: await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 })) });
  await expect(foreign.mutation(api.signals.mutations.recordSignals, { signals: [ev()] })).rejects.toThrow("subject not found");
  expect(await count()).toBe(0);
});

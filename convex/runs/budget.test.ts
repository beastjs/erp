/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asMember } from "../_shared/testkit";
import schema from "../schema";

const modules = import.meta.glob("/convex/**/*.ts");

let raw: ReturnType<typeof convexTest>;
let t: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
let orgId: Id<"orgs">;
let sourceId: Id<"sources">;
let icpVersionId: Id<"icpDefinitions">;
const criteria = { industries: [], geographies: [], technologies: [], decisionMakerRoles: [] };

beforeEach(async () => {
  raw = convexTest(schema, modules);
  const seeded = await raw.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 });
    const sourceId = await ctx.db.insert("sources", { orgId, key: "csv", kind: "csv", trustWeight: 0.8, lawfulBasis: "consent" });
    const icpVersionId = await ctx.db.insert("icpDefinitions", { orgId, version: 1, name: "v1", criteria, createdBy: { kind: "user", userId: "u1", role: "analyst" }, activeFrom: 0 });
    return { orgId, sourceId, icpVersionId };
  });
  orgId = seeded.orgId;
  sourceId = seeded.sourceId;
  icpVersionId = seeded.icpVersionId;
  t = await asMember(raw, "u1", orgId);
});

const start = (creditBudget = 10) => t.mutation(api.runs.mutations.startRun, { sourceId, icpVersionId, creditBudget });

test("startRun opens a running run with zeroed accounting", async () => {
  const run = await t.query(api.runs.queries.getRun, { runId: await start(10) });
  expect(run).toMatchObject({
    orgId, sourceId, status: "running", creditBudget: 10, creditsUsed: 0, icpVersionId,
    rowsProcessed: 0, candidatesInserted: 0, duplicates: 0, rowsRejected: 0, candidatesConsumed: 0, candidatesRejected: 0,
  });
  expect(run.startedAt).toBeGreaterThan(0);
  expect(run.finishedAt).toBeUndefined();
});

test("startRun refuses an ICP version from another org", async () => {
  const foreign = await raw.run(async (ctx) => {
    const other = await ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 });
    return await ctx.db.insert("icpDefinitions", { orgId: other, version: 1, name: "theirs", criteria, createdBy: { kind: "user", userId: "x", role: "analyst" }, activeFrom: 0 });
  });
  await expect(t.mutation(api.runs.mutations.startRun, { sourceId, icpVersionId: foreign, creditBudget: 5 })).rejects.toThrow("icp version not found");
});

test("startRun refuses a bad budget and a source from another org", async () => {
  for (const creditBudget of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(t.mutation(api.runs.mutations.startRun, { sourceId, creditBudget })).rejects.toThrow("creditBudget");
  }
  const foreign = await raw.run(async (ctx) => {
    const other = await ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 });
    return ctx.db.insert("sources", { orgId: other, key: "x", kind: "csv", trustWeight: 1, lawfulBasis: "consent" });
  });
  await expect(t.mutation(api.runs.mutations.startRun, { sourceId: foreign, creditBudget: 5 })).rejects.toThrow("source not found");
});

test("consumeCredits decrements the budget and records the spend", async () => {
  const runId = await start(10);
  expect(await t.mutation(api.runs.mutations.consumeCredits, { runId, credits: 4 })).toEqual({ remaining: 6 });
  expect(await t.mutation(api.runs.mutations.consumeCredits, { runId, credits: 6 })).toEqual({ remaining: 0 });
  expect((await t.query(api.runs.queries.getRun, { runId })).creditsUsed).toBe(10);
});

test("consumeCredits throws budget_exhausted rather than going negative", async () => {
  const runId = await start(10);
  await t.mutation(api.runs.mutations.consumeCredits, { runId, credits: 8 });
  await expect(t.mutation(api.runs.mutations.consumeCredits, { runId, credits: 3 })).rejects.toThrow("budget_exhausted");
  // Fail closed means nothing was spent by the refused call, and nothing was clamped either.
  expect((await t.query(api.runs.queries.getRun, { runId })).creditsUsed).toBe(8);
  expect(await t.mutation(api.runs.mutations.consumeCredits, { runId, credits: 2 })).toEqual({ remaining: 0 });
});

test("a zero-budget run refuses any spend", async () => {
  const runId = await start(0);
  await expect(t.mutation(api.runs.mutations.consumeCredits, { runId, credits: 1 })).rejects.toThrow("budget_exhausted");
});

test("consumeCredits refuses negative, NaN and infinite amounts (a negative would refund)", async () => {
  const runId = await start(10);
  for (const credits of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(t.mutation(api.runs.mutations.consumeCredits, { runId, credits })).rejects.toThrow("credits");
  }
  expect((await t.query(api.runs.queries.getRun, { runId })).creditsUsed).toBe(0);
});

test("consumeCredits refuses a finished run and a run from another org", async () => {
  const runId = await start(10);
  await t.mutation(api.runs.mutations.finishRun, { runId });
  await expect(t.mutation(api.runs.mutations.consumeCredits, { runId, credits: 1 })).rejects.toThrow("run_not_active");
  const other = await asMember(raw, "u2", await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 })));
  await expect(other.mutation(api.runs.mutations.consumeCredits, { runId, credits: 1 })).rejects.toThrow("run not found");
});

test("finishRun stamps finishedAt and is idempotent", async () => {
  const runId = await start(10);
  await t.mutation(api.runs.mutations.finishRun, { runId });
  const first = await t.query(api.runs.queries.getRun, { runId });
  expect(first.status).toBe("completed");
  expect(first.finishedAt).toBeGreaterThanOrEqual(first.startedAt);
  await t.mutation(api.runs.mutations.finishRun, { runId });
  expect((await t.query(api.runs.queries.getRun, { runId })).finishedAt).toBe(first.finishedAt);
});

/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { asMember, createIcpVersion } from "../_shared/testkit.support";
import { BACKOFF_CAP_MS, MAX_ATTEMPTS, REASON_CODES, STAGES, backoffMs } from "../pipeline/schema";
import schema from "../schema";
import { structuralLogic } from "../verify/structural";
import { getConvexSize, getDocumentSize } from "convex/values";
import { CONVEX_READ_LIMIT_BYTES, MAX_CLAIM_DOC_BYTES, MAX_CLAIM_TEXT_CHARS, MAX_CLAIM_VALUE_BYTES } from "../_shared/limits";
import { MAX_STRING } from "../sources/contract";
import { planClaims } from "../sources/ingest";
import { COUNT_CAP, DAY_MS, METRIC_DEFINITIONS, QUALITY_CLAIM_READ_BUDGET, QUALITY_SAMPLE, QUALITY_VERDICT_RESERVE, RUN_SCAN_CAP, median, ratio } from "./definitions";
import { ERASURE_OVERDUE_MS, IMPORT_STALLED_MS, LONGEST_RETRY_WAIT_MS, PURGE_STALLED_MS, STALE_ACTIVE_MS, SWEEP_LAPSED_MS } from "./health";

const modules = import.meta.glob("/convex/**/*.ts");

type Raw = ReturnType<typeof convexTest>;
let raw: Raw;
let t: ReturnType<Raw["withIdentity"]>;
let orgId: Id<"orgs">;
let sourceId: Id<"sources">;
const NOW = 100 * DAY_MS;

beforeEach(async () => {
  raw = convexTest(schema, modules);
  ({ orgId, sourceId } = await newOrg("Org 1"));
  t = await asMember(raw, "op", orgId, "operator");
});

// ------------------------------------------------------------------------------------------- direct-write fixtures
// These tests are about what the metrics READ, so the world is written straight into the tables.

async function newOrg(name: string) {
  const id = await raw.run((ctx) => ctx.db.insert("orgs", { name, createdAt: 0 }));
  const src = await raw.run((ctx) => ctx.db.insert("sources", { orgId: id, key: "crm", kind: "crm", trustWeight: 0.5, lawfulBasis: "consent" }));
  return { orgId: id, sourceId: src };
}
const run = (over: Partial<Doc<"discoveryRuns">> = {}, org = orgId, src = sourceId) =>
  raw.run((ctx) =>
    ctx.db.insert("discoveryRuns", {
      orgId: org,
      sourceId: src,
      status: "running",
      creditBudget: 1000,
      creditsUsed: 0,
      startedAt: 1_000,
      rowsProcessed: 0,
      candidatesInserted: 0,
      duplicates: 0,
      rowsRejected: 0,
      candidatesConsumed: 0,
      candidatesRejected: 0,
      ...over,
    }),
  );
let n = 0;
const state = (over: Partial<Doc<"pipelineState">> = {}, org = orgId) =>
  raw.run((ctx) =>
    ctx.db.insert("pipelineState", {
      orgId: org,
      subjectType: "contact",
      subjectId: `subject-${n++}`,
      stage: "ingest",
      status: "active",
      attempt: 0,
      rewinds: 0,
      inputHashes: {},
      updatedAt: NOW,
      ...over,
    }),
  );
const states = async (count: number, over: Partial<Doc<"pipelineState">> = {}) => {
  for (let i = 0; i < count; i++) await state(over);
};
const claim = (over: Partial<Doc<"claims">> = {}, org = orgId, src = sourceId) =>
  raw.run((ctx) =>
    ctx.db.insert("claims", { orgId: org, subjectType: "contact", subjectId: `subject-${n++}`, field: "title", value: "CTO", sourceId: src, method: "observed", confidence: 1, observedAt: NOW - DAY_MS, ...over }),
  );
const health = (asOf = NOW) => t.query(api.observability.health.pipelineHealth, { asOf });

const drain = () => raw.finishAllScheduledFunctions(vi.runAllTimers);
afterEach(() => vi.useRealTimers());

/**
 * One real lead, made by the real pipeline under a run: a manual contact at confidence 1.0 with an intent signal,
 * scored against an ICP and packaged. Returns the run, the subject and the lead.
 */
async function realQualifiedLead() {
  vi.useFakeTimers();
  const admin = await asMember(raw, "ad", orgId, "admin");
  await t.mutation(api.sources.import.addManualLead, {
    candidate: {
      person: { fullName: "Pat Doe", email: "pat@acme.com", jobTitle: "CTO" },
      company: { name: "Acme", domain: "acme.com", industry: "Software" },
      acquisition: { acquiredAt: Date.now() },
    },
  });
  await drain();
  await raw.run(async (ctx) => {
    for (const c of await ctx.db.query("claims").collect()) if (c.confidence !== 1) await ctx.db.patch(c._id, { confidence: 1 });
  });
  const contacts = (await raw.run((ctx) => ctx.db.query("contacts").collect())) as Doc<"contacts">[];
  const contact = contacts.find((c) => c.display.email === "pat@acme.com")!;
  const accountId = contact.fields.find((f) => f.field === "accountId")!.value as Id<"accounts">;
  await t.run((ctx) => createIcpVersion(ctx, { name: "ICP", criteria: { industries: ["software"], geographies: [], technologies: [], decisionMakerRoles: [] } }));
  const claimSource = (await raw.run((ctx) => ctx.db.query("claims").first()))!.sourceId;
  await t.mutation(api.signals.mutations.recordSignals, {
    signals: [{ subjectType: "account", subjectId: accountId, kind: "funding", strength: "high", confidence: 1, observedAt: Date.now() - DAY_MS, sourceId: claimSource, externalId: "round-1" }],
  });
  const runId = await admin.action(api.runs.mutations.startRun, { sourceId: claimSource, creditBudget: 10 });
  await t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: contact._id, runId });
  await drain();
  const st = (await raw.run((ctx) => ctx.db.query("pipelineState").collect())).find((s) => s.subjectId === contact._id)!;
  expect(st.leadId).toBeDefined();
  return { runId, contactId: contact._id, leadId: st.leadId! };
}

// =============================================================================================== runSummary

describe("runSummary", () => {
  test("counts the run's subjects by stage and by status, and its own counters by outcome", async () => {
    const runId = await run({ creditsUsed: 7, rowsProcessed: 10, candidatesInserted: 8, duplicates: 1, rowsRejected: 1, candidatesConsumed: 6, candidatesRejected: 2 });
    const other = await run();
    await state({ runId, stage: "ingest" });
    await state({ runId, stage: "score", status: "active", attempt: 2 });
    await state({ runId, stage: "package", status: "done" });
    await state({ runId, stage: "verify", status: "deadlettered", deadReasonCode: "timeout" });
    await state({ runId: other, stage: "score" }); // another run's subject is not this run's
    await state({ stage: "score" }); // nor is one with no run

    const s = await t.query(api.observability.runs.runSummary, { runId });
    const exact = (value: number) => ({ value, bound: "exact" });
    expect(s.countsByStage).toEqual({
      ingest: exact(1), resolve: exact(0), enrich: exact(0), verify: exact(1), signals: exact(0), score: exact(1), qualify: exact(0), package: exact(1),
    });
    expect(Object.keys(s.countsByStage).sort()).toEqual([...STAGES].sort());
    expect(s.countsByStatus).toEqual({ active: exact(2), done: exact(1), deadlettered: exact(1) });
    expect(s.countsByOutcome).toEqual({ rowsProcessed: 10, candidatesInserted: 8, duplicates: 1, rowsRejected: 1, candidatesConsumed: 6, candidatesRejected: 2 });
    expect(s.creditsConsumed).toBe(7);
    expect(s.status).toBe("running");
  });

  test("duration is finishedAt - startedAt, and null (not NaN) while the run is still running", async () => {
    const running = await run({ startedAt: 5_000 });
    expect((await t.query(api.observability.runs.runSummary, { runId: running })).durationMs).toBeNull();
    const finished = await run({ status: "completed", startedAt: 5_000, finishedAt: 65_000 });
    expect((await t.query(api.observability.runs.runSummary, { runId: finished })).durationMs).toBe(60_000);
  });

  test(`a run with more than ${RUN_SCAN_CAP} subjects says at_least instead of undercounting silently`, async () => {
    const runId = await run();
    await raw.run(async (ctx) => {
      for (let i = 0; i < RUN_SCAN_CAP + 1; i++) {
        await ctx.db.insert("pipelineState", { orgId, subjectType: "contact", subjectId: `bulk-${i}`, stage: "score", status: "active", attempt: 0, rewinds: 0, inputHashes: {}, runId, updatedAt: NOW });
      }
    });
    const s = await t.query(api.observability.runs.runSummary, { runId });
    expect(s.countsByStage.score).toEqual({ value: RUN_SCAN_CAP, bound: "at_least" });
    expect(s.countsByStage.ingest).toEqual({ value: 0, bound: "at_least" }); // a zero from a truncated read is not a known zero
    expect(s.countsByStatus.active.bound).toBe("at_least");
  });

  test("another org's run is not found, and an outsider is refused", async () => {
    const theirs = await newOrg("Org 2");
    const runId = await run({}, theirs.orgId, theirs.sourceId);
    await expect(t.query(api.observability.runs.runSummary, { runId })).rejects.toThrow("run not found");
    const outsider = raw.withIdentity({ subject: "nobody", orgId });
    await expect(outsider.query(api.observability.runs.runSummary, { runId: await run() })).rejects.toThrow("forbidden");
  });
});

// ===================================================================================== costPerQualifiedLead

describe("costPerQualifiedLead", () => {
  test("returns null, not Infinity, when zero leads qualified", async () => {
    const runId = await run({ creditsUsed: 12 });
    await state({ runId, status: "done", finishedReason: "rejected_tier" });
    const c = await t.query(api.observability.runs.costPerQualifiedLead, { runId });
    expect(c).toEqual({ runId, credits: 12, qualified: { value: 0, bound: "exact" }, costPerLead: null, costBound: "exact" });
  });

  test("a real run: credits over the subjects the pipeline packaged a lead for", async () => {
    const { runId } = await realQualifiedLead();
    const c = await t.query(api.observability.runs.costPerQualifiedLead, { runId });
    expect(c.qualified).toEqual({ value: 1, bound: "exact" });
    expect(c.credits).toBeGreaterThan(0);
    expect(c.costPerLead).toBe(c.credits);
  });

  test("counts each subject once, and past the read cap reports an upper-bound cost rather than a wrong exact one", async () => {
    const { runId, leadId } = await realQualifiedLead();
    await raw.run(async (ctx) => {
      const r = (await ctx.db.get(runId))!;
      await ctx.db.patch(runId, { creditsUsed: r.creditsUsed + 1000 });
      for (let i = 0; i < RUN_SCAN_CAP; i++) {
        await ctx.db.insert("pipelineState", { orgId, subjectType: "contact", subjectId: `bulk-${i}`, stage: "package", status: "done", attempt: 0, rewinds: 0, inputHashes: {}, runId, leadId, updatedAt: NOW });
      }
    });
    const c = await t.query(api.observability.runs.costPerQualifiedLead, { runId });
    expect(c.qualified).toEqual({ value: RUN_SCAN_CAP, bound: "at_least" });
    expect(c.costBound).toBe("at_most");
    expect(Number.isFinite(c.costPerLead)).toBe(true);
    expect(METRIC_DEFINITIONS["costPerQualifiedLead.costPerLead"].coverage).toBe("upper_bound"); // L2: never called a lower bound
  });

  test("an outsider is refused", async () => {
    const runId = await run();
    await expect(raw.withIdentity({ subject: "nobody", orgId }).query(api.observability.runs.costPerQualifiedLead, { runId })).rejects.toThrow("forbidden");
    await expect(raw.query(api.observability.runs.costPerQualifiedLead, { runId })).rejects.toThrow();
  });
});

// ============================================================================================= dataQuality

describe("dataQuality", () => {
  const dq = (asOf = NOW) => t.query(api.observability.quality.dataQuality, { asOf });

  test("methodMix sums to the claim count, and redacted claims are not counted", async () => {
    await claim({ method: "observed" });
    await claim({ method: "observed" });
    await claim({ method: "extracted" });
    await claim({ method: "inferred" });
    await claim({ method: "observed", value: null, redactedAt: 1 });
    await claim({ method: "inferred" }, (await newOrg("Org 2")).orgId); // another org's claim
    const q = await dq();
    expect(q.methodMix).toEqual({ observed: 2, extracted: 1, inferred: 1 });
    expect(q.sample).toEqual({ scope: "whole_ledger", claimsRead: 5, claimsCounted: 4 });
    expect(Object.values(q.methodMix).reduce((a, b) => a + b, 0)).toBe(q.sample.claimsCounted);
  });

  test("medianClaimAgeDays on an empty ledger returns 0, not NaN, and the pass rate is null, not NaN", async () => {
    const q = await dq();
    expect(q.medianClaimAgeDays).toBe(0);
    expect(q.verificationPassRate).toBeNull();
    expect(q.verificationsJudged).toBe(0);
    expect(q.methodMix).toEqual({ observed: 0, extracted: 0, inferred: 0 });
  });

  test("median claim age is measured from the stated asOf, in days", async () => {
    for (const days of [1, 2, 10]) await claim({ observedAt: NOW - days * DAY_MS });
    expect((await dq()).medianClaimAgeDays).toBe(2);
    expect((await dq(NOW + DAY_MS)).medianClaimAgeDays).toBe(3); // reproducible: no clock is read
    await claim({ observedAt: NOW - 20 * DAY_MS });
    expect((await dq()).medianClaimAgeDays).toBe(6); // even count: mean of the middle two (2, 10)
  });

  test(`past ${QUALITY_SAMPLE} claims it is a declared sample of the newest, not a silent prefix of the ledger`, async () => {
    await raw.run(async (ctx) => {
      // the oldest claim is inferred; everything newer is observed
      await ctx.db.insert("claims", { orgId, subjectType: "contact", subjectId: "old", field: "title", value: "x", sourceId, method: "inferred", confidence: 1, observedAt: 0 });
      for (let i = 0; i < QUALITY_SAMPLE; i++) {
        await ctx.db.insert("claims", { orgId, subjectType: "contact", subjectId: `s${i}`, field: "title", value: "x", sourceId, method: "observed", confidence: 1, observedAt: NOW });
      }
    });
    const q = await dq();
    expect(q.sample.scope).toBe("newest_sample");
    expect(q.methodMix).toEqual({ observed: QUALITY_SAMPLE, extracted: 0, inferred: 0 });
    expect(METRIC_DEFINITIONS["dataQuality.methodMix"].basis).toBe("modelled");
  });

  test("the pass rate reads the latest verdict of each sampled email/phone claim", async () => {
    const contactId = await raw.run((ctx) => ctx.db.insert("contacts", { orgId, fields: [], display: {} }));
    const verdict = async (claimId: Id<"claims">, kind: "email" | "phone", outcome: "pass" | "fail" | "unknown", checkedAt: number) =>
      raw.run((ctx) => ctx.db.insert("verifications", { orgId, subjectType: "contact", subjectId: contactId, claimId, kind, outcome, reason: "ok", provider: "structural", logic: 1, checkedAt }));
    const e1 = await claim({ field: "email", subjectId: contactId });
    const e2 = await claim({ field: "email", subjectId: contactId });
    const p1 = await claim({ field: "phone", subjectId: contactId });
    await claim({ field: "phone", subjectId: contactId }); // never judged: not in the denominator
    await verdict(e1, "email", "fail", 1);
    await verdict(e1, "email", "pass", 2); // the latest verdict wins
    await verdict(e2, "email", "unknown", 1);
    await verdict(p1, "phone", "pass", 1);
    const q = await dq();
    expect(q.verificationsJudged).toBe(3);
    expect(q.verificationPassRate).toBeCloseTo(2 / 3, 12);
  });

  test("asOf must be a finite, non-negative time: NaN, Infinity and a negative instant are refused, not clamped", async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) await expect(dq(bad), String(bad)).rejects.toThrow("asOf");
    await expect(dq(0)).resolves.toMatchObject({ asOf: 0 }); // the boundary itself is a valid instant
  });

  test("an outsider is refused", async () => {
    await expect(raw.withIdentity({ subject: "nobody", orgId }).query(api.observability.quality.dataQuality, { asOf: NOW })).rejects.toThrow("forbidden");
    await expect(raw.query(api.observability.quality.dataQuality, { asOf: NOW })).rejects.toThrow();
  });

  test("the claim count and the median agree: every counted claim has a finite age, and a non-finite one is refused at append", async () => {
    for (const days of [1, 3]) await claim({ observedAt: NOW - days * DAY_MS });
    const q = await dq();
    expect(q.sample.claimsCounted).toBe(2);
    expect(q.medianClaimAgeDays).toBe(2);
    // median does not silently drop what the count includes: a non-finite age fails closed
    expect(() => median([Number.NaN, 3])).toThrow("finite");
    expect(() => median([Number.POSITIVE_INFINITY])).toThrow("finite");
  });

  // ----------------------------------------------------------------------------------------- M2: the read budget
  test("the arithmetic: a claim document is bounded, and the sample's byte budget leaves room for the verdict reads", () => {
    // The largest claim document the bounds admit, measured with Convex's own size function.
    const id = "k".repeat(32);
    const biggest = {
      _id: id, _creationTime: 1, orgId: id, subjectType: "contact", subjectId: id, field: "\u20ac".repeat(MAX_CLAIM_TEXT_CHARS),
      value: "x".repeat(MAX_CLAIM_VALUE_BYTES - 2), sourceId: id, method: "extracted", confidence: 1, observedAt: 1,
      snapshotRef: "\u20ac".repeat(MAX_CLAIM_TEXT_CHARS), runId: id, redactedAt: 1,
    };
    expect(getConvexSize(biggest.value)).toBe(MAX_CLAIM_VALUE_BYTES);
    expect(getDocumentSize(biggest)).toBeLessThanOrEqual(MAX_CLAIM_DOC_BYTES);
    expect(MAX_CLAIM_VALUE_BYTES).toBe(655_360);
    expect(MAX_CLAIM_DOC_BYTES).toBe(655_360 + 2 * (2 + 3 * 2048) + 1024);
    expect(CONVEX_READ_LIMIT_BYTES).toBe(16 * 1024 * 1024);
    // the budget for claims plus the reserve for one verdict per sampled claim fits the read limit
    expect(QUALITY_CLAIM_READ_BUDGET + QUALITY_VERDICT_RESERVE).toBeLessThanOrEqual(CONVEX_READ_LIMIT_BYTES);
    // one verdict per sampled claim fits the reserve: every field of a verification row is an id, a closed label or a number
    const id32 = "k".repeat(32);
    const label = "l".repeat(64); // longer than any label in the closed sets
    const verdict = { _id: id32, _creationTime: 1, orgId: id32, subjectType: "contact", subjectId: id32, claimId: id32, kind: label, outcome: label, reason: label, provider: label, logic: 1, checkedAt: 1 };
    expect((QUALITY_SAMPLE + 1) * getDocumentSize(verdict)).toBeLessThanOrEqual(QUALITY_VERDICT_RESERVE);
    // a whole budget of maximum-size claims is still a sample of more than a handful
    expect(Math.floor(QUALITY_CLAIM_READ_BUDGET / MAX_CLAIM_DOC_BYTES)).toBe(21);
  });

  test("the largest claim legitimate ingest can produce fits the bound (a full techStack of 3-byte characters)", async () => {
    const techStack = Array.from({ length: 100 }, () => "\u20ac".repeat(MAX_STRING));
    const plan = planClaims({ company: { name: "Acme", domain: "acme.com", techStack }, acquisition: { acquiredAt: NOW } } as never);
    const value = plan.account.find(([f]) => f === "techStack")![1] as string[];
    expect(getConvexSize(value)).toBe(2 + 100 * (2 + 3 * MAX_STRING)); // 614,602 bytes
    expect(getConvexSize(value)).toBeLessThanOrEqual(MAX_CLAIM_VALUE_BYTES);
    // and the real ingest path stores it
    await t.mutation(api.sources.import.addManualLead, { candidate: { company: { name: "Acme", domain: "acme.com", techStack }, acquisition: { acquiredAt: NOW } } });
    const stored = (await raw.run((ctx) => ctx.db.query("claims").collect())).find((c) => c.field === "techStack")!;
    expect(getConvexSize(stored.value)).toBe(614_602);
  });

  test("a claim value, field or snapshotRef past its bound is refused at the write boundary, never truncated", async () => {
    const contactId = await raw.run((ctx) => ctx.db.insert("contacts", { orgId, fields: [], display: {} }));
    const base = { subjectType: "contact" as const, subjectId: contactId, field: "notes", value: "ok", sourceId, method: "observed" as const, confidence: 1, observedAt: NOW };
    const append = (over: Partial<Omit<typeof base, "value">> & { value?: unknown; snapshotRef?: string }) => t.mutation(api.claims.mutations.appendClaim, { ...base, ...over });
    await expect(append({ value: "x".repeat(MAX_CLAIM_VALUE_BYTES - 2) })).resolves.toBeDefined(); // exactly at the bound
    await expect(append({ value: "x".repeat(MAX_CLAIM_VALUE_BYTES - 1) })).rejects.toThrow("claim value is");
    await expect(append({ value: ["\u20ac".repeat(300_000)] })).rejects.toThrow("claim value is"); // bytes, not characters
    await expect(append({ field: "f".repeat(MAX_CLAIM_TEXT_CHARS + 1) })).rejects.toThrow("field");
    await expect(append({ snapshotRef: "r".repeat(MAX_CLAIM_TEXT_CHARS + 1) })).rejects.toThrow("snapshotRef");
    const values = (await raw.run((ctx) => ctx.db.query("claims").collect())).map((c) => getConvexSize(c.value));
    expect(values).toEqual([MAX_CLAIM_VALUE_BYTES]); // only the one at the bound was stored, whole
  });

  test("observedAt must be finite at append: refused, not clamped", async () => {
    const contactId = await raw.run((ctx) => ctx.db.insert("contacts", { orgId, fields: [], display: {} }));
    for (const observedAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(
        t.mutation(api.claims.mutations.appendClaim, { subjectType: "contact", subjectId: contactId, field: "title", value: "CTO", sourceId, method: "observed", confidence: 1, observedAt }),
        String(observedAt),
      ).rejects.toThrow("observedAt");
    }
    expect(await raw.run((ctx) => ctx.db.query("claims").collect())).toHaveLength(0);
  });

  test("maximum-size claims: the sample stops inside its byte budget and says it is a sample", async () => {
    const big = "x".repeat(MAX_CLAIM_VALUE_BYTES - 2);
    await raw.run(async (ctx) => {
      for (let i = 0; i < 25; i++) {
        await ctx.db.insert("claims", { orgId, subjectType: "account", subjectId: `a${i}`, field: "techStack", value: big, sourceId, method: "observed", confidence: 1, observedAt: NOW });
      }
    });
    const q = await dq();
    // at least what the budget guarantees at the worst-case size, fewer than all 25, and never past the budget in bytes
    expect(q.sample.claimsRead).toBeGreaterThanOrEqual(Math.floor(QUALITY_CLAIM_READ_BUDGET / MAX_CLAIM_DOC_BYTES));
    expect(q.sample.claimsRead).toBeLessThan(25);
    expect(q.sample.scope).toBe("newest_sample");
    const one = getDocumentSize((await raw.run((ctx) => ctx.db.query("claims").first()))!);
    expect(q.sample.claimsRead * one).toBeLessThanOrEqual(QUALITY_CLAIM_READ_BUDGET);
  });
});

// ========================================================================================== pipelineHealth

describe("pipelineHealth", () => {
  test("groups dead letters by reason code, and derives retrying from attempt > 0", async () => {
    await state({ status: "deadlettered", deadReasonCode: "timeout", attempt: 5 });
    await state({ status: "deadlettered", deadReasonCode: "timeout", attempt: 5 });
    await state({ status: "deadlettered", deadReasonCode: "invalid_domain", attempt: 1 });
    await state({ status: "active", attempt: 0 });
    await state({ status: "active", attempt: 2 });
    await state({ status: "done", attempt: 3 }); // a finished subject's stale attempt is not a retry
    const h = await health();
    expect(Object.keys(h.deadLettered).sort()).toEqual([...REASON_CODES].sort());
    expect(h.deadLettered.timeout).toEqual({ value: 2, bound: "exact" });
    expect(h.deadLettered.invalid_domain).toEqual({ value: 1, bound: "exact" });
    expect(h.deadLettered.rate_limited).toEqual({ value: 0, bound: "exact" });
    expect(h.inFlight).toEqual({ value: 2, bound: "exact" });
    expect(h.retrying).toEqual({ value: 1, bound: "exact" });
  });

  test(`past ${COUNT_CAP} active subjects, inFlight and retrying say at_least`, async () => {
    await raw.run(async (ctx) => {
      for (let i = 0; i < COUNT_CAP + 1; i++) {
        await ctx.db.insert("pipelineState", { orgId, subjectType: "contact", subjectId: `bulk-${i}`, stage: "score", status: "active", attempt: 1, rewinds: 0, inputHashes: {}, updatedAt: NOW });
      }
    });
    const h = await health();
    expect(h.inFlight).toEqual({ value: COUNT_CAP, bound: "at_least" });
    expect(h.retrying).toEqual({ value: COUNT_CAP, bound: "at_least" });
  });

  test("a stale active subject is listed; a fresh one, a retry within its backoff and a finished one are not", async () => {
    const stale = await state({ status: "active", stage: "verify", updatedAt: NOW - STALE_ACTIVE_MS - 1 });
    await state({ status: "active", updatedAt: NOW - 1000 });
    await state({ status: "active", attempt: MAX_ATTEMPTS - 1, updatedAt: NOW - LONGEST_RETRY_WAIT_MS }); // waiting on its longest backoff
    await state({ status: "done", updatedAt: 0 });
    await state({ status: "deadlettered", deadReasonCode: "timeout", updatedAt: 0 });
    const h = await health();
    expect(h.staleActive.count).toEqual({ value: 1, bound: "exact" });
    expect(h.staleActive.items.map((i) => i.stateId)).toEqual([stale]);
    expect(h.staleActive.items[0]).toMatchObject({ stage: "verify", attempt: 0 });
    expect(h.staleActive.more).toBe(false);
  });

  test("the staleness threshold is longer than any scheduled retry wait", () => {
    expect(LONGEST_RETRY_WAIT_MS).toBe(Math.min(backoffMs(MAX_ATTEMPTS - 1), BACKOFF_CAP_MS));
    expect(STALE_ACTIVE_MS).toBeGreaterThan(LONGEST_RETRY_WAIT_MS);
  });

  test("a finished run whose staged-row purge stopped is listed; one still within the grace period is not", async () => {
    const stuck = await run({ status: "failed", finishedAt: 0, purgePendingSince: NOW - PURGE_STALLED_MS - 1 });
    await run({ status: "completed", finishedAt: 0, purgePendingSince: NOW - 1000 });
    await run({ status: "completed", finishedAt: 0 });
    const h = await health();
    expect(h.stalledPurges.items).toEqual([{ runId: stuck, status: "failed", pendingSince: NOW - PURGE_STALLED_MS - 1 }]);
  });

  test("a staged import whose counters stopped moving is listed with the phase that stopped; a moving one and a non-import run are not", async () => {
    const stuck = await run({ chunksExpected: 4, chunksProcessed: 1, progressAt: NOW - IMPORT_STALLED_MS - 1 });
    await run({ chunksExpected: 4, chunksProcessed: 1, progressAt: NOW - 1000 });
    // all chunks done but ingest has not consumed every candidate: the INGEST phase stopped (M1). Listed.
    const ingest = await run({ chunksExpected: 4, chunksProcessed: 4, candidatesInserted: 3, candidatesConsumed: 1, candidatesRejected: 1, progressAt: 0 });
    // the same, still moving: not listed
    await run({ chunksExpected: 4, chunksProcessed: 4, candidatesInserted: 3, candidatesConsumed: 1, progressAt: NOW - 1000 });
    await run({ startedAt: 0 }); // a crawl run with no staged chunks may idle legitimately
    await run({ startedAt: 0, progressAt: 0, rowsProcessed: 5 }); // nor does a crawl run that once moved count as a staged import
    const h = await health();
    expect(h.stalledImports.items).toEqual([
      { runId: stuck, phase: "chunks", chunksExpected: 4, chunksProcessed: 1, lastProgressAt: NOW - IMPORT_STALLED_MS - 1 },
      { runId: ingest, phase: "ingest", chunksExpected: 4, chunksProcessed: 4, lastProgressAt: 0 },
    ]);
    expect(h.stalledImports.count).toEqual({ value: 2, bound: "exact" });
  });

  test("a finished run's purge filter is not by status: whatever holds raw rows past the threshold is listed", async () => {
    // L7c: the old status filter could not be reached through any code path and is gone; the index range alone decides.
    const odd = await run({ status: "running", purgePendingSince: NOW - PURGE_STALLED_MS - 1 });
    expect((await health()).stalledPurges.items.map((r) => r.runId)).toEqual([odd]);
  });

  test("the verification sweep: not started, walking, lapsed, done", async () => {
    const logic = structuralLogic().short;
    // the org was created at 0 and NOW is long after: a sweep that never reached it has LAPSED (L7b) ...
    expect((await health()).verificationSweep.state).toBe("lapsed");
    // ... but not yet within the grace period after the org was created
    expect((await health(SWEEP_LAPSED_MS - 1)).verificationSweep.state).toBe("not_started");
    const row = await raw.run((ctx) => ctx.db.insert("verificationSweeps", { orgId, logic, done: false, leaseUntil: NOW + 1000 }));
    expect((await health()).verificationSweep.state).toBe("walking");
    await raw.run((ctx) => ctx.db.patch(row, { leaseUntil: NOW - SWEEP_LAPSED_MS - 1 }));
    expect((await health()).verificationSweep.state).toBe("lapsed");
    await raw.run((ctx) => ctx.db.patch(row, { done: true, leaseUntil: 0 }));
    expect((await health()).verificationSweep.state).toBe("done");
    await raw.run((ctx) => ctx.db.patch(row, { logic: logic + 1 }));
    // a walk under OTHER rules, and no verdict yet under today's: nothing says how long today's rules have been live
    expect((await health()).verificationSweep).toEqual({ state: "not_started", passedOver: 0, lastPassedOver: null });
  });

  test("a sweep the cron never restarted under today's rules lapses, measured from the first verdict under them (L7b)", async () => {
    const logic = structuralLogic().short;
    await raw.run((ctx) => ctx.db.insert("verificationSweeps", { orgId, logic: logic + 1, done: true, leaseUntil: 0 }));
    const contactId = await raw.run((ctx) => ctx.db.insert("contacts", { orgId, fields: [], display: {} }));
    const claimId = await claim({ field: "email", subjectId: contactId });
    const firstToday = NOW - 5 * DAY_MS;
    await raw.run((ctx) => ctx.db.insert("verifications", { orgId, subjectType: "contact", subjectId: contactId, claimId, kind: "email", outcome: "pass", reason: "ok", provider: "structural", logic, checkedAt: firstToday }));
    // another org's verdict under today's rules, and an older verdict under old rules, say nothing about this org's walk
    const theirs = await newOrg("Org 2");
    const theirContact = await raw.run((ctx) => ctx.db.insert("contacts", { orgId: theirs.orgId, fields: [], display: {} }));
    const theirClaim = await claim({ field: "email", subjectId: theirContact }, theirs.orgId, theirs.sourceId);
    await raw.run((ctx) => ctx.db.insert("verifications", { orgId: theirs.orgId, subjectType: "contact", subjectId: theirContact, claimId: theirClaim, kind: "email", outcome: "pass", reason: "ok", provider: "structural", logic, checkedAt: 0 }));
    await raw.run((ctx) => ctx.db.insert("verifications", { orgId, subjectType: "contact", subjectId: contactId, claimId, kind: "email", outcome: "pass", reason: "ok", provider: "structural", logic: logic + 1, checkedAt: 0 }));
    expect((await health(firstToday + SWEEP_LAPSED_MS - 1)).verificationSweep.state).toBe("not_started");
    expect((await health(firstToday + SWEEP_LAPSED_MS + 1)).verificationSweep.state).toBe("lapsed");
  });

  test("lastPassedOver never names a contact that has since been erased (L4)", async () => {
    const logic = structuralLogic().short;
    const contactId = await raw.run((ctx) => ctx.db.insert("contacts", { orgId, fields: [], display: {} }));
    await raw.run((ctx) => ctx.db.insert("verificationSweeps", { orgId, logic, done: true, leaseUntil: 0, passedOver: 1, lastPassedOver: contactId }));
    expect((await health()).verificationSweep).toEqual({ state: "done", passedOver: 1, lastPassedOver: contactId });
    await raw.run((ctx) => ctx.db.insert("erasures", { ...erasureRow(contactId), resumeAt: NOW + 60_000 }));
    expect((await health()).verificationSweep).toEqual({ state: "done", passedOver: 1, lastPassedOver: null });
  });

  test("asOf must be a finite, non-negative time (L1)", async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) await expect(health(bad), String(bad)).rejects.toThrow("asOf");
    await expect(health(0)).resolves.toMatchObject({ asOf: 0 });
  });

  test("pipelineHealth returns no erasure data: that is the admin's stalledErasures (M3)", async () => {
    const contactId = await raw.run((ctx) => ctx.db.insert("contacts", { orgId, fields: [], display: {} }));
    const id = await raw.run((ctx) => ctx.db.insert("erasures", { ...erasureRow(contactId), attempts: 3, failedAt: NOW - 5, resumeAt: NOW + 60_000 }));
    const h = await health();
    expect(JSON.stringify(h)).not.toContain(id);
    expect(JSON.stringify(Object.keys(h)) + JSON.stringify(Object.keys(h.thresholds))).not.toMatch(/rasure/);
  });

  test("an outsider is refused", async () => {
    await expect(raw.withIdentity({ subject: "nobody", orgId }).query(api.observability.health.pipelineHealth, { asOf: NOW })).rejects.toThrow("forbidden");
    await expect(raw.query(api.observability.health.pipelineHealth, { asOf: NOW })).rejects.toThrow();
  });
});

// ======================================================================================= stalledErasures (admin)

const erasureRow = (contactId: Id<"contacts">) => ({
  orgId, subjectType: "contact" as const, subjectId: contactId, requestedAt: 0, requestedBy: { kind: "system" as const, process: "erasure" as const },
  reasonCode: "opt_out" as const, legalBasis: "consent_withdrawn" as const, reference: "CASE-1",
  claimsRedacted: 0, contactKeysDeleted: 0, candidatesRedacted: 0, signalsRedacted: 0, leadsRedacted: 0, suppressionsAdded: 0,
});

describe("stalledErasures", () => {
  let admin: Awaited<ReturnType<typeof asMember>>;
  beforeEach(async () => {
    admin = await asMember(raw, "ad", orgId, "admin");
  });
  const stalled = (asOf = NOW) => admin.query(api.observability.health.stalledErasures, { asOf });

  test("an operator is refused, and so is an outsider: erasure is admin-only (M3)", async () => {
    await expect(t.query(api.observability.health.stalledErasures, { asOf: NOW })).rejects.toThrow("forbidden");
    await expect(raw.withIdentity({ subject: "nobody", orgId }).query(api.observability.health.stalledErasures, { asOf: NOW })).rejects.toThrow("forbidden");
    await expect(stalled()).resolves.toMatchObject({ asOf: NOW });
  });

  test("a failing erasure is listed with its attempt count, and never its error text or subject", async () => {
    const contactId = await raw.run((ctx) => ctx.db.insert("contacts", { orgId, fields: [], display: {} }));
    const failing = await raw.run((ctx) => ctx.db.insert("erasures", { ...erasureRow(contactId), attempts: 3, lastError: "Pat Doe <pat@acme.com> broke it", failedAt: NOW - 5, resumeAt: NOW + 60_000, progressAt: NOW - 1000 }));
    await raw.run((ctx) => ctx.db.insert("erasures", { ...erasureRow(contactId), resumeAt: NOW + 60_000, progressAt: NOW - 1000 })); // in progress, healthy
    await raw.run((ctx) => ctx.db.insert("erasures", { ...erasureRow(contactId), attempts: 2, completedAt: NOW })); // finished: not stalled
    const s = await stalled();
    expect(s.stalled.count).toEqual({ value: 1, bound: "exact" });
    expect(s.stalled.items).toEqual([{ erasureId: failing, subjectType: "contact", attempts: 3, failedAt: NOW - 5, lastProgressAt: NOW - 1000, overdue: false }]);
    expect(JSON.stringify(s)).not.toContain("pat@acme.com");
    expect(JSON.stringify(s)).not.toContain(contactId);
  });

  test("an erasure with no committed step for too long is overdue even while the sweeper keeps pushing resumeAt forward (L6)", async () => {
    // The failure-catching code itself failed, so nothing recorded a failure, and every sweep claims the row anew:
    // resumeAt is always in the future. Only the last COMMITTED step's progress stamp says it has stopped.
    const contactId = await raw.run((ctx) => ctx.db.insert("contacts", { orgId, fields: [], display: {} }));
    const id = await raw.run((ctx) => ctx.db.insert("erasures", { ...erasureRow(contactId), resumeAt: NOW + 5 * 60_000, progressAt: NOW - ERASURE_OVERDUE_MS - 1 }));
    expect((await stalled()).stalled.items).toEqual([{ erasureId: id, subjectType: "contact", attempts: 0, failedAt: null, lastProgressAt: NOW - ERASURE_OVERDUE_MS - 1, overdue: true }]);
    expect((await stalled(NOW - 2)).stalled.items).toEqual([]); // within the threshold it is not
  });

  test("a committed erasure step stamps its progress; the stamp is what overdue is judged from", async () => {
    vi.useFakeTimers();
    const contactId = await raw.run((ctx) => ctx.db.insert("contacts", { orgId, fields: [], display: {} }));
    await admin.action(api.privacy.api.requestErasure, { subjectType: "contact", subjectId: contactId, reasonCode: "opt_out", legalBasis: "consent_withdrawn", reference: "CASE-9" });
    const row = (await raw.run((ctx) => ctx.db.query("erasures").first()))!;
    expect(row.progressAt).toBeGreaterThan(0);
    expect(row.completedAt).toBeDefined();
  });

  test("a later committed step replaces an old progress stamp, and the erasure stops being overdue", async () => {
    vi.useFakeTimers();
    const contactId = await raw.run((ctx) => ctx.db.insert("contacts", { orgId, fields: [], display: {} }));
    // an accepted erasure whose last committed step is long ago
    const id = await raw.run((ctx) => ctx.db.insert("erasures", { ...erasureRow(contactId), resumeAt: 0, progressAt: 0 }));
    const now = Date.now();
    expect((await stalled(now)).stalled.items.map((e) => e.erasureId)).toEqual([id]);
    await raw.mutation(internal.privacy.redact.erasureStep, { orgId, subjectType: "contact", subjectId: contactId });
    const row = (await raw.run((ctx) => ctx.db.get(id)))!;
    expect(row.progressAt).toBeGreaterThanOrEqual(now);
    expect((await stalled(row.progressAt!)).stalled.items).toEqual([]);
  });

  test("asOf must be a finite, non-negative time (L1)", async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) await expect(stalled(bad), String(bad)).rejects.toThrow("asOf");
    await expect(stalled(0)).resolves.toMatchObject({ asOf: 0 });
  });
});

// ======================================================================== wedged work found by the real code paths

describe("wedged work, written by the real chains", () => {
  test("a subject the verification sweep passes over is counted and named, once per subject", async () => {
    vi.useFakeTimers();
    const claimId = await claim({ field: "email" });
    const contactId = await raw.run((ctx) =>
      ctx.db.insert("contacts", { orgId, fields: [{ field: "email", value: "x@acme.com", claimId, method: "observed", confidence: 1, observedAt: 0 }], display: {} }),
    );
    await raw.run((ctx) => ctx.db.insert("verifications", { orgId, subjectType: "contact", subjectId: contactId, claimId, kind: "email", outcome: "pass", reason: "ok", provider: "structural", logic: structuralLogic().short + 1, checkedAt: 0 }));
    // Two pipeline rows for one subject: findState refuses the ambiguity, so this subject's rewind throws.
    await state({ subjectId: contactId, status: "done" });
    await state({ subjectId: contactId, status: "done" });
    const result = await raw.mutation(internal.verify.sweep.rejudgeSlice, { orgId });
    expect(result.failed).toBeGreaterThan(0);
    expect((await health()).verificationSweep).toEqual({ state: "done", passedOver: 1, lastPassedOver: contactId });
  });

  test("a purge that does not fit the terminal transaction marks the run, and the continuation that finishes clears it", async () => {
    vi.useFakeTimers();
    const runId = await run({ chunksExpected: 100 });
    const { PURGE_CHUNKS_PER_TXN } = await import("../runs/mutations");
    const mappingId = await raw.run((ctx) => ctx.db.insert("columnMappings", { orgId, name: "m", columns: [] }));
    await raw.run(async (ctx) => {
      for (let seq = 0; seq < PURGE_CHUNKS_PER_TXN + 1; seq++) {
        await ctx.db.insert("importChunks", { orgId, runId, mappingId, seq, rowOffset: seq, columns: ["a"], rows: [["x"]] });
      }
    });
    const op = await asMember(raw, "op2", orgId, "operator");
    await op.mutation(api.runs.mutations.finishRun, { runId });
    const marked = await raw.run((ctx) => ctx.db.get(runId));
    expect(marked!.status).not.toBe("running");
    expect(marked!.purgePendingSince).toBeDefined();
    // the chain dies here: nothing runs the scheduled continuation. Later, it is listed.
    expect((await health(marked!.purgePendingSince! + PURGE_STALLED_MS + 1)).stalledPurges.items.map((r) => r.runId)).toEqual([runId]);
    await drain();
    expect((await raw.run((ctx) => ctx.db.get(runId)))!.purgePendingSince).toBeUndefined();
    expect(await raw.run((ctx) => ctx.db.query("importChunks").collect())).toHaveLength(0);
  });

  test("resumePurge restarts a stalled purge of a finished run, is safe to call twice, and refuses a running run", async () => {
    vi.useFakeTimers();
    const { PURGE_CHUNKS_PER_TXN } = await import("../runs/mutations");
    const runId = await run({ chunksExpected: 100 });
    const mappingId = await raw.run((ctx) => ctx.db.insert("columnMappings", { orgId, name: "m", columns: [] }));
    const stage = (id: Id<"discoveryRuns">, count: number) =>
      raw.run(async (ctx) => {
        for (let seq = 0; seq < count; seq++) await ctx.db.insert("importChunks", { orgId, runId: id, mappingId, seq, rowOffset: seq, columns: ["a"], rows: [["x"]] });
      });
    await stage(runId, 3 * PURGE_CHUNKS_PER_TXN + 1);
    // a running run's rows are still to be imported
    await expect(t.mutation(api.sources.import.resumePurge, { runId })).rejects.toThrow("run_still_running");
    await t.mutation(api.runs.mutations.finishRun, { runId });
    await cancelPending(); // the purge chain dies after its first link
    expect((await raw.run((ctx) => ctx.db.get(runId)))!.purgePendingSince).toBeDefined();
    // twice, before anything runs: two chains over the same rows are harmless
    await t.mutation(api.sources.import.resumePurge, { runId });
    await t.mutation(api.sources.import.resumePurge, { runId });
    await drain();
    expect(await raw.run((ctx) => ctx.db.query("importChunks").collect())).toHaveLength(0);
    expect((await raw.run((ctx) => ctx.db.get(runId)))!.purgePendingSince).toBeUndefined();
    // and again on a clean run: a no-op
    await expect(t.mutation(api.sources.import.resumePurge, { runId })).resolves.toEqual({ remaining: false });
    // another org's run is not found; an outsider is refused
    const theirs = await newOrg("Org 2");
    const other = await run({ status: "completed", finishedAt: 0 }, theirs.orgId, theirs.sourceId);
    await stage(other, 1);
    await expect(t.mutation(api.sources.import.resumePurge, { runId: other })).rejects.toThrow("run not found");
    await expect(raw.withIdentity({ subject: "nobody", orgId }).mutation(api.sources.import.resumePurge, { runId })).rejects.toThrow("forbidden");
    expect(await raw.run((ctx) => ctx.db.query("importChunks").collect())).toHaveLength(1); // the other org's row is untouched
  });

  /** A staged import of `rows` rows into a fresh run, staged by the real internal functions `importCsv` calls. */
  async function stagedImport(rows: number, opts: { start: boolean } = { start: true }) {
    vi.useFakeTimers();
    const admin = await asMember(raw, "ad", orgId, "admin");
    const runId = await admin.action(api.runs.mutations.startRun, { sourceId, creditBudget: 100 });
    const mappingId = await t.mutation(api.sources.import.saveMapping, { name: `m-${n++}`, columns: { Email: "person.email", Name: "person.fullName", Company: "company.name" } });
    const grid = Array.from({ length: rows }, (_, i) => [`p${i}@acme.com`, `Person ${i}`, "Acme"]);
    await raw.mutation(internal.sources.import.stageImportChunk, { orgId, runId, mappingId, seq: 0, rowOffset: 0, columns: ["Email", "Name", "Company"], rows: grid });
    if (opts.start) await raw.mutation(internal.sources.import.startStagedImport, { orgId, runId, totalRows: rows, totalChunks: 1 });
    return runId;
  }
  const cancelPending = () =>
    raw.run(async (ctx) => {
      for (const s of await ctx.db.system.query("_scheduled_functions").collect()) if (s.state.kind === "pending") await ctx.scheduler.cancel(s._id);
    });

  test("M1: an import whose INGEST phase stopped is listed, and resumeImport re-arms it to completion", async () => {
    const runId = await stagedImport(3);
    // the chunk chain runs; the ingest batches it schedules are lost (a scheduled mutation that throws is not retried)
    await raw.mutation(internal.sources.import.processStagedChunk, { orgId, runId, seq: 0 });
    await cancelPending();
    const r = (await raw.run((ctx) => ctx.db.get(runId)))!;
    expect(r).toMatchObject({ status: "running", chunksExpected: 1, chunksProcessed: 1, candidatesInserted: 3, candidatesConsumed: 0 });
    expect((await health(r.progressAt! + IMPORT_STALLED_MS + 1)).stalledImports.items).toEqual([
      { runId, phase: "ingest", chunksExpected: 1, chunksProcessed: 1, lastProgressAt: r.progressAt! },
    ]);
    const resumed = await t.mutation(api.sources.import.resumeImport, { runId });
    expect(resumed).toEqual({ resumedAt: null, rearmedCandidates: 3 });
    await drain();
    expect(await raw.run((ctx) => ctx.db.get(runId))).toMatchObject({ status: "completed", candidatesConsumed: 3 });
    expect((await health(r.progressAt! + IMPORT_STALLED_MS + 1)).stalledImports.items).toEqual([]);
  });

  test("L5: an import whose action died after staging, before startStagedImport, is listed as stopped in staging", async () => {
    const runId = await stagedImport(2, { start: false });
    const r = (await raw.run((ctx) => ctx.db.get(runId)))!;
    expect(r.chunksExpected).toBeUndefined();
    expect(r.progressAt).toBeDefined(); // staging stamps progress
    expect((await health(r.progressAt! + IMPORT_STALLED_MS - 1)).stalledImports.items).toEqual([]);
    expect((await health(r.progressAt! + IMPORT_STALLED_MS + 1)).stalledImports.items).toEqual([
      { runId, phase: "staging", chunksExpected: null, chunksProcessed: 0, lastProgressAt: r.progressAt! },
    ]);
    // resumeImport cannot finish a half-staged file (its size was never declared) and must not import a part of it
    await t.mutation(api.sources.import.resumeImport, { runId });
    await drain();
    expect(await raw.run((ctx) => ctx.db.get(runId))).toMatchObject({ status: "running", rowsProcessed: 0 });
    // the remedy is to close the run, which purges its raw rows
    await t.mutation(api.runs.mutations.finishRun, { runId });
    await drain();
    expect(await raw.run((ctx) => ctx.db.query("importChunks").collect())).toHaveLength(0);
  });

  test("bumpRun stamps progress, which is what tells a stopped import from a slow one", async () => {
    const runId = await run({ chunksExpected: 4, chunksProcessed: 0, startedAt: 0 });
    const { bumpRun } = await import("../runs/mutations");
    await raw.run(async (ctx) => bumpRun(ctx, (await ctx.db.get(runId))!, { chunksProcessed: 1 }));
    const at = (await raw.run((ctx) => ctx.db.get(runId)))!.progressAt!;
    expect(at).toBeGreaterThan(0);
    // judged from the last progress, not from the start (which is long past)
    expect((await health(at + IMPORT_STALLED_MS - 1)).stalledImports.items).toEqual([]);
    expect((await health(at + IMPORT_STALLED_MS + 1)).stalledImports.items.map((r) => r.runId)).toEqual([runId]);
  });
});

// ============================================================================================= definitions

describe("METRIC_DEFINITIONS", () => {
  const keysOf = (query: string, result: object) => Object.keys(result).map((k) => `${query}.${k}`);

  test("every metric returned has an entry in METRIC_DEFINITIONS, and every entry is returned by some query", async () => {
    const runId = await run();
    const returned = [
      ...keysOf("runSummary", await t.query(api.observability.runs.runSummary, { runId })),
      ...keysOf("costPerQualifiedLead", await t.query(api.observability.runs.costPerQualifiedLead, { runId })),
      ...keysOf("dataQuality", await t.query(api.observability.quality.dataQuality, { asOf: NOW })),
      ...keysOf("pipelineHealth", await health()),
      ...keysOf("refusalCounts", await (await asMember(raw, "ad", orgId, "admin")).query(api.observability.refusals.refusalCounts, { fromHour: 0, toHour: 0 })),
      ...keysOf("stalledErasures", await (await asMember(raw, "ad2", orgId, "admin")).query(api.observability.health.stalledErasures, { asOf: NOW })),
    ];
    expect(returned.length).toBeGreaterThan(20); // the walk is over real results, not nothing
    for (const key of returned) expect(METRIC_DEFINITIONS, key).toHaveProperty([key]);
    expect(Object.keys(METRIC_DEFINITIONS).sort()).toEqual([...returned].sort());
  });

  test("each definition declares observed or modelled basis, a coverage, and a non-empty definition", () => {
    for (const [key, d] of Object.entries(METRIC_DEFINITIONS)) {
      expect(["observed", "modelled"], key).toContain(d.basis);
      expect(["exact", "lower_bound", "upper_bound", "sample", "listing"], key).toContain(d.coverage);
      expect(d.definition.length, key).toBeGreaterThan(10);
    }
    // a sample-based estimate is never presented as observed fact about the whole ledger
    for (const [key, d] of Object.entries(METRIC_DEFINITIONS)) if (d.basis === "modelled") expect(d.coverage, key).toBe("sample");
  });

  test("median and ratio never produce NaN or Infinity", () => {
    expect(median([])).toBe(0);
    expect(ratio(5, 0)).toBeNull();
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(Number.POSITIVE_INFINITY, 1)).toBeNull();
    expect(ratio(6, 3)).toBe(2);
  });
});

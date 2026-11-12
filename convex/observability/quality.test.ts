/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { asMember, createIcpVersion } from "../_shared/testkit.support";
import { BACKOFF_CAP_MS, MAX_ATTEMPTS, REASON_CODES, STAGES, backoffMs } from "../pipeline/schema";
import schema from "../schema";
import { structuralLogic } from "../verify/structural";
import { COUNT_CAP, DAY_MS, METRIC_DEFINITIONS, QUALITY_SAMPLE, RUN_SCAN_CAP, median, ratio } from "./definitions";
import { IMPORT_STALLED_MS, LONGEST_RETRY_WAIT_MS, PURGE_STALLED_MS, STALE_ACTIVE_MS, SWEEP_LAPSED_MS } from "./health";

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
  const runId = await admin.mutation(api.runs.mutations.startRun, { sourceId: claimSource, creditBudget: 10 });
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

  test("asOf must be a finite time", async () => {
    await expect(dq(Number.NaN)).rejects.toThrow("asOf");
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

  test("a failing erasure is listed with its attempt count, and never its error text or subject", async () => {
    const contactId = await raw.run((ctx) => ctx.db.insert("contacts", { orgId, fields: [], display: {} }));
    const base = {
      orgId, subjectType: "contact" as const, subjectId: contactId, requestedAt: 0, requestedBy: { kind: "system" as const, process: "erasure" as const },
      reasonCode: "opt_out" as const, legalBasis: "consent_withdrawn" as const, reference: "CASE-1",
      claimsRedacted: 0, contactKeysDeleted: 0, candidatesRedacted: 0, signalsRedacted: 0, leadsRedacted: 0, suppressionsAdded: 0,
    };
    const failing = await raw.run((ctx) => ctx.db.insert("erasures", { ...base, attempts: 3, lastError: "Pat Doe <pat@acme.com> broke it", failedAt: NOW - 5, resumeAt: NOW + 60_000 }));
    await raw.run((ctx) => ctx.db.insert("erasures", { ...base, resumeAt: NOW + 60_000 })); // in progress, healthy
    await raw.run((ctx) => ctx.db.insert("erasures", { ...base, attempts: 2, completedAt: NOW })); // finished: not stalled
    const h = await health();
    expect(h.stalledErasures.count).toEqual({ value: 1, bound: "exact" });
    expect(h.stalledErasures.items).toEqual([{ erasureId: failing, subjectType: "contact", attempts: 3, failedAt: NOW - 5, resumeAt: NOW + 60_000, overdue: false }]);
    expect(JSON.stringify(h)).not.toContain("pat@acme.com");
    expect(JSON.stringify(h)).not.toContain(contactId);
  });

  test("an erasure the sweeper itself has stopped reaching is listed as overdue, with no failure recorded", async () => {
    const contactId = await raw.run((ctx) => ctx.db.insert("contacts", { orgId, fields: [], display: {} }));
    const id = await raw.run((ctx) =>
      ctx.db.insert("erasures", {
        orgId, subjectType: "contact", subjectId: contactId, requestedAt: 0, requestedBy: { kind: "system", process: "erasure" }, reasonCode: "opt_out", legalBasis: "consent_withdrawn", reference: "CASE-2",
        claimsRedacted: 0, contactKeysDeleted: 0, candidatesRedacted: 0, signalsRedacted: 0, leadsRedacted: 0, suppressionsAdded: 0, resumeAt: NOW - DAY_MS,
      }),
    );
    expect((await health()).stalledErasures.items).toEqual([{ erasureId: id, subjectType: "contact", attempts: 0, failedAt: null, resumeAt: NOW - DAY_MS, overdue: true }]);
  });

  test("a finished run whose staged-row purge stopped is listed; one still within the grace period is not", async () => {
    const stuck = await run({ status: "failed", finishedAt: 0, purgePendingSince: NOW - PURGE_STALLED_MS - 1 });
    await run({ status: "completed", finishedAt: 0, purgePendingSince: NOW - 1000 });
    await run({ status: "completed", finishedAt: 0 });
    const h = await health();
    expect(h.stalledPurges.items).toEqual([{ runId: stuck, status: "failed", pendingSince: NOW - PURGE_STALLED_MS - 1 }]);
  });

  test("a staged import whose counters stopped moving is listed; a moving one and a non-import run are not", async () => {
    const stuck = await run({ chunksExpected: 4, chunksProcessed: 1, progressAt: NOW - IMPORT_STALLED_MS - 1 });
    await run({ chunksExpected: 4, chunksProcessed: 1, progressAt: NOW - 1000 });
    await run({ chunksExpected: 4, chunksProcessed: 4, progressAt: 0 }); // all chunks done: waiting on ingest, not the chunk chain
    await run({ startedAt: 0 }); // a crawl run with no staged chunks may idle legitimately
    const h = await health();
    expect(h.stalledImports.items).toEqual([{ runId: stuck, chunksExpected: 4, chunksProcessed: 1, lastProgressAt: NOW - IMPORT_STALLED_MS - 1 }]);
  });

  test("the verification sweep: not started, walking, lapsed, done", async () => {
    const logic = structuralLogic().short;
    expect((await health()).verificationSweep.state).toBe("not_started");
    const row = await raw.run((ctx) => ctx.db.insert("verificationSweeps", { orgId, logic, done: false, leaseUntil: NOW + 1000 }));
    expect((await health()).verificationSweep.state).toBe("walking");
    await raw.run((ctx) => ctx.db.patch(row, { leaseUntil: NOW - SWEEP_LAPSED_MS - 1 }));
    expect((await health()).verificationSweep.state).toBe("lapsed");
    await raw.run((ctx) => ctx.db.patch(row, { done: true, leaseUntil: 0 }));
    expect((await health()).verificationSweep.state).toBe("done");
    await raw.run((ctx) => ctx.db.patch(row, { logic: logic + 1 }));
    expect((await health()).verificationSweep).toEqual({ state: "not_started", passedOver: 0, lastPassedOver: null });
  });

  test("an outsider is refused", async () => {
    await expect(raw.withIdentity({ subject: "nobody", orgId }).query(api.observability.health.pipelineHealth, { asOf: NOW })).rejects.toThrow("forbidden");
    await expect(raw.query(api.observability.health.pipelineHealth, { asOf: NOW })).rejects.toThrow();
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
    ];
    expect(returned.length).toBeGreaterThan(20); // the walk is over real results, not nothing
    for (const key of returned) expect(METRIC_DEFINITIONS, key).toHaveProperty([key]);
    expect(Object.keys(METRIC_DEFINITIONS).sort()).toEqual([...returned].sort());
  });

  test("each definition declares observed or modelled basis, a coverage, and a non-empty definition", () => {
    for (const [key, d] of Object.entries(METRIC_DEFINITIONS)) {
      expect(["observed", "modelled"], key).toContain(d.basis);
      expect(["exact", "lower_bound", "sample", "listing"], key).toContain(d.coverage);
      expect(d.definition.length, key).toBeGreaterThan(10);
    }
    // a sample-based estimate is never presented as observed fact about the whole ledger
    for (const [key, d] of Object.entries(METRIC_DEFINITIONS)) if (d.basis === "modelled") expect(d.coverage, key).toBe("sample");
  });

  test("median and ratio never produce NaN or Infinity", () => {
    expect(median([])).toBe(0);
    expect(median([Number.NaN, 3])).toBe(3);
    expect(ratio(5, 0)).toBeNull();
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(Number.POSITIVE_INFINITY, 1)).toBeNull();
    expect(ratio(6, 3)).toBe(2);
  });
});

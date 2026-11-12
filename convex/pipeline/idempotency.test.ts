/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { appendClaimRecord } from "../claims/mutations";
import { createIcpVersion, asMember } from "../_shared/testkit.support";
import { latestIcp } from "../icp/queries";
import schema from "../schema";
import { deadLetterQueue } from "./deadletter";
import { stageInputHash } from "./hash";
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, MAX_ATTEMPTS, STAGES, backoffMs, type Stage } from "./schema";
import { STAGE_LOGIC_VERSION, runStage, stageFailure, stageHandlers, type StageHandler } from "./stages";

const modules = import.meta.glob("/convex/**/*.ts");
const DAY = 24 * 60 * 60 * 1000;

let raw: ReturnType<typeof convexTest>;
let t: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
let orgId: Id<"orgs">;
const originals = { ...stageHandlers };

beforeEach(async () => {
  // Scheduled steps must not run behind the test's back; they are inspected, or drained on purpose.
  vi.useFakeTimers();
  raw = convexTest(schema, modules);
  orgId = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 }));
  t = await asMember(raw, "u1", orgId);
});
afterEach(() => {
  Object.assign(stageHandlers, originals);
  vi.useRealTimers();
});

type Seed = { accountId: Id<"accounts">; contactId: Id<"contacts">; sourceId: Id<"sources"> };
async function seed(): Promise<Seed> {
  return await t.run(async (ctx) => {
    const sourceId = await ctx.db.insert("sources", { orgId, key: `s${Math.random()}`, kind: "crm", trustWeight: 1, lawfulBasis: "consent" });
    const accountId = await ctx.db.insert("accounts", { orgId, fields: [], display: {} });
    const contactId = await ctx.db.insert("contacts", { orgId, fields: [], display: {} });
    const claim = (subjectType: "account" | "contact", subjectId: string, field: string, value: unknown) =>
      appendClaimRecord(ctx, { subjectType, subjectId, field, value, sourceId, method: "observed", confidence: 1, observedAt: Date.now() - DAY });
    await claim("account", accountId, "name", "Acme");
    await claim("account", accountId, "industry", "Software");
    await claim("contact", contactId, "name", "Jo Doe");
    await claim("contact", contactId, "accountId", accountId);
    await claim("contact", contactId, "email", "jo@acme.com");
    if (!(await latestIcp(ctx, {}))) await createIcpVersion(ctx, { name: "ICP", criteria: { industries: ["software"], geographies: [], technologies: [], decisionMakerRoles: [] } });
    return { accountId, contactId, sourceId };
  });
}

const started = async (s: Seed) => {
  const out = await t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: s.contactId });
  if ("refused" in out) throw new Error(`refused: ${out.refused}`);
  return out;
};
const start = async (s: Seed) => (await started(s)).stateId;
const state = (id: Id<"pipelineState">) => raw.run((ctx) => ctx.db.get(id)) as Promise<Doc<"pipelineState">>;
const run = (s: Seed, stage: Stage) => t.run((ctx) => runStage(ctx, { subjectType: "contact", subjectId: s.contactId, stage }));
const scheduled = () => raw.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
const pendingSteps = async () => (await scheduled()).filter((f: { name: string; state: { kind: string } }) => f.state.kind === "pending" && f.name.endsWith(":step"));
/** Runs the stages before `stage` so the subject is positioned at it. */
async function reach(s: Seed, stage: Stage) {
  for (const earlier of STAGES.slice(0, STAGES.indexOf(stage))) expect((await run(s, earlier)).status).toBe("done");
}
/** The scheduler stores seconds as a float, so a delay can read 1ms off; backoffs are tens of seconds, so round to 10ms. */
const delay = (f: { scheduledTime: number }, from: number) => Math.round((f.scheduledTime - from) / 10) * 10;
const countClaims = () => raw.run(async (ctx) => (await ctx.db.query("claims").collect()).length);

/** Replaces a stage's body with one that counts its executions and (optionally) fails. */
function instrument(stage: Stage, body?: StageHandler) {
  const calls = { n: 0 };
  const original = stageHandlers[stage];
  stageHandlers[stage] = async (ctx, subject) => {
    calls.n++;
    return await (body ?? original)(ctx, subject);
  };
  return calls;
}
const failWith = (code: Parameters<typeof stageFailure>[0], providerRef?: string): StageHandler => async () => {
  throw stageFailure(code, providerRef);
};

describe("stageInputHash", () => {
  const ids = (...x: string[]) => x as Id<"claims">[];
  const base = { claimIds: ids("a", "b"), icpVersionId: "i1" as Id<"icpDefinitions">, scoringModelId: "m1" as Id<"scoringModels"> };

  test("is a function of the SET of inputs: order and repeats do not matter, any change does", () => {
    const h = stageInputHash(base);
    expect(stageInputHash({ ...base, claimIds: ids("b", "a") })).toBe(h);
    expect(stageInputHash({ ...base, claimIds: ids("a", "b", "b") })).toBe(h);
    expect(stageInputHash({ ...base, claimIds: ids("a", "b", "c") })).not.toBe(h);
    expect(stageInputHash({ ...base, claimIds: ids("a") })).not.toBe(h);
    expect(stageInputHash({ ...base, icpVersionId: "i2" as Id<"icpDefinitions"> })).not.toBe(h);
    expect(stageInputHash({ ...base, scoringModelId: "m2" as Id<"scoringModels"> })).not.toBe(h);
    expect(stageInputHash({ ...base, scoringModelId: null })).not.toBe(h);
    expect(stageInputHash({ ...base, extra: ["logic:2"] })).not.toBe(stageInputHash({ ...base, extra: ["logic:1"] }));
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });

  test("distinct inputs cannot collide by moving a boundary between parts", () => {
    const hash = (o: Partial<Parameters<typeof stageInputHash>[0]>) => stageInputHash({ ...base, claimIds: [], icpVersionId: null, scoringModelId: null, ...o });
    expect(hash({ claimIds: ids("ab", "c") })).not.toBe(hash({ claimIds: ids("a", "bc") }));
    expect(hash({ claimIds: ids("a") })).not.toBe(hash({ extra: ["a"] }));
    expect(hash({ icpVersionId: "x" as Id<"icpDefinitions"> })).not.toBe(hash({ scoringModelId: "x" as Id<"scoringModels"> }));
  });
});

describe("idempotency", () => {
  test("running a stage twice with the same inputHash produces one effect", async () => {
    const s = await seed();
    const id = await start(s);
    const calls = instrument("resolve");
    await reach(s, "resolve");
    expect(await run(s, "resolve")).toMatchObject({ status: "done" });
    expect(calls.n).toBe(1);
    const afterFirst = await state(id);
    expect(afterFirst.stage).toBe("enrich"); // the chain moved on

    const again = await run(s, "resolve");
    expect(again.status).toBe("skipped");
    expect(again.reasonCode).toBeUndefined(); // skipped because it is complete, not because it is out of turn
    expect(again.output?.accountId).toBe(s.accountId); // returns the prior result
    expect(calls.n).toBe(1);
    expect(await state(id)).toEqual(afterFirst); // and changes nothing
  });

  test("a changed claim set changes the inputHash and re-runs the stage", async () => {
    const s = await seed();
    const id = await start(s);
    const calls = instrument("resolve");
    await reach(s, "resolve");
    await run(s, "resolve");
    const hashBefore = (await state(id)).inputHashes.resolve;
    expect(hashBefore).toBeDefined();

    // New evidence about the contact: its hash changes, and the pipeline sends the subject back to resolve.
    await t.run((ctx) =>
      appendClaimRecord(ctx, { subjectType: "contact", subjectId: s.contactId, field: "title", value: "CTO", sourceId: s.sourceId, method: "observed", confidence: 1, observedAt: Date.now() }),
    );
    expect((await state(id)).stage).toBe("resolve");
    expect(await run(s, "resolve")).toMatchObject({ status: "done" });
    expect(calls.n).toBe(2);
    expect((await state(id)).inputHashes.resolve).not.toBe(hashBefore);
    // The new claim is in the projection: the re-run did real work.
    expect((await raw.run((ctx) => ctx.db.get(s.contactId)))!.fields.some((f: { field: string }) => f.field === "title")).toBe(true);
  });

  test("a stage's logic version is part of its hash, so a replay after a fix re-runs it", async () => {
    const s = await seed();
    const id = await start(s);
    const calls = instrument("ingest");
    await run(s, "ingest");
    try {
      STAGE_LOGIC_VERSION.ingest = 2; // the "fix"
      await raw.run((ctx) => ctx.db.patch(id, { stage: "ingest" })); // a replay puts the subject back at the stage
      expect(await run(s, "ingest")).toMatchObject({ status: "done" });
      expect(calls.n).toBe(2);
    } finally {
      STAGE_LOGIC_VERSION.ingest = 1;
    }
  });

  test("only the subject's current stage executes; stages out of turn are skipped with a reason", async () => {
    const s = await seed();
    await start(s);
    const calls = instrument("score");
    expect(await run(s, "score")).toMatchObject({ status: "skipped", reasonCode: "stage_not_reached" });
    await reach(s, "score");
    await run(s, "score");
    expect(await run(s, "resolve")).toMatchObject({ status: "skipped" }); // already complete
    expect(calls.n).toBe(1);
  });

  test("a stage's write and the move to the next stage are atomic: a failed stage leaves no partial claims", async () => {
    const s = await seed();
    const id = await start(s);
    await reach(s, "enrich");
    const before = await countClaims();
    const beforeState = await state(id);
    instrument("enrich", async (ctx) => {
      await appendClaimRecord(ctx, { subjectType: "contact", subjectId: s.contactId, field: "phone", value: "+15550100", sourceId: s.sourceId, method: "observed", confidence: 1, observedAt: Date.now() });
      throw stageFailure("provider_error", "enricher");
    });
    expect(await run(s, "enrich")).toMatchObject({ status: "retrying", reasonCode: "provider_error" });
    expect(await countClaims()).toBe(before); // the claim written before the throw was rolled back
    const after = await state(id);
    expect(after.stage).toBe("enrich");
    expect(after.inputHashes).toEqual(beforeState.inputHashes); // no completion was recorded
  });

  test("a stage that writes a claim and succeeds keeps the claim, records its hash, and the subject is sent back to re-resolve it", async () => {
    const s = await seed();
    const id = await start(s);
    await reach(s, "enrich");
    const before = await countClaims();
    instrument("enrich", async (ctx) => {
      await appendClaimRecord(ctx, { subjectType: "contact", subjectId: s.contactId, field: "phone", value: "+15550100", sourceId: s.sourceId, method: "observed", confidence: 1, observedAt: Date.now() });
      return { kind: "done" };
    });
    expect(await run(s, "enrich")).toMatchObject({ status: "done" });
    expect(await countClaims()).toBe(before + 1);
    const after = await state(id);
    // Output and state agree in one transaction: the new claim exists, the work is recorded, and because the
    // claim is new evidence the chain is at resolve rather than blindly continuing to verify.
    expect(after.inputHashes.enrich).toBeDefined();
    expect(after.stage).toBe("resolve");
  });
});

describe("failure handling", () => {
  test("a transient reason code schedules a retry with exponential backoff", async () => {
    const s = await seed();
    const id = await start(s);
    await reach(s, "enrich");
    instrument("enrich", failWith("timeout", "enricher-a"));
    const stepsBefore = (await pendingSteps()).length;

    const t0 = Date.now();
    expect(await run(s, "enrich")).toEqual({ status: "retrying", reasonCode: "timeout" });
    let st = await state(id);
    expect(st).toMatchObject({ status: "active", stage: "enrich", attempt: 1 });
    expect(st.lastError).toMatchObject({ stage: "enrich", reasonCode: "timeout", providerRef: "enricher-a", attempt: 1 });
    const steps = await pendingSteps();
    expect(steps.length).toBe(stepsBefore + 1);
    const newest = steps.sort((a, b) => b.scheduledTime - a.scheduledTime)[0]!;
    expect(delay(newest, t0)).toBe(BACKOFF_BASE_MS);
    expect(newest.args[0]).toMatchObject({ stage: "enrich", subjectId: s.contactId, orgId });

    // The next failure waits twice as long.
    const t1 = Date.now();
    await run(s, "enrich");
    st = await state(id);
    expect(st.attempt).toBe(2);
    const latest = (await pendingSteps()).sort((a, b) => b.scheduledTime - a.scheduledTime)[0]!;
    expect(delay(latest, t1)).toBe(2 * BACKOFF_BASE_MS);
  });

  test("backoff doubles and is capped", () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([BACKOFF_BASE_MS, 2 * BACKOFF_BASE_MS, 4 * BACKOFF_BASE_MS, 8 * BACKOFF_BASE_MS]);
    expect(backoffMs(50)).toBe(BACKOFF_CAP_MS);
    expect(backoffMs(0)).toBe(BACKOFF_BASE_MS);
  });

  test("attempts past the cap dead-letter the subject", async () => {
    const s = await seed();
    const id = await start(s);
    await reach(s, "enrich");
    instrument("enrich", failWith("rate_limited", "enricher-a"));
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      expect(await run(s, "enrich")).toEqual({ status: "retrying", reasonCode: "rate_limited" });
      expect((await state(id)).attempt).toBe(attempt);
    }
    const stepsBeforeLast = (await pendingSteps()).length;
    expect(await run(s, "enrich")).toEqual({ status: "deadlettered", reasonCode: "rate_limited" });
    const st = await state(id);
    expect(st.status).toBe("deadlettered");
    expect(st.attempt).toBe(MAX_ATTEMPTS);
    expect(st.deadReasonCode).toBe("rate_limited");
    expect(st.lastError).toMatchObject({ stage: "enrich", reasonCode: "rate_limited", providerRef: "enricher-a", attempt: MAX_ATTEMPTS });
    expect((await pendingSteps()).length).toBe(stepsBeforeLast); // no retry after the last
    // A dead-lettered subject does not run again, whoever asks.
    const calls = instrument("enrich");
    expect(await run(s, "enrich")).toEqual({ status: "deadlettered", reasonCode: "rate_limited" });
    expect(calls.n).toBe(0);
  });

  test("a terminal reason code dead-letters immediately, no retry", async () => {
    for (const code of ["invalid_domain", "no_such_record", "policy_refused"] as const) {
      const s = await seed();
      const id = await start(s);
      await reach(s, "enrich");
      instrument("enrich", failWith(code, "dns"));
      const stepsBefore = (await pendingSteps()).length;
      expect(await run(s, "enrich")).toEqual({ status: "deadlettered", reasonCode: code });
      const st = await state(id);
      expect(st).toMatchObject({ status: "deadlettered", attempt: 1, deadReasonCode: code });
      expect(st.lastError).toMatchObject({ stage: "enrich", reasonCode: code, providerRef: "dns", attempt: 1 });
      expect((await pendingSteps()).length).toBe(stepsBefore);
    }
  });

  test("budget_exhausted dead-letters without consuming an attempt", async () => {
    const s = await seed();
    const id = await start(s);
    await reach(s, "enrich");
    instrument("enrich", failWith("budget_exhausted", "run"));
    expect(await run(s, "enrich")).toEqual({ status: "deadlettered", reasonCode: "budget_exhausted" });
    const st = await state(id);
    expect(st.attempt).toBe(0);
    expect(st.lastError?.attempt).toBe(0);
    expect(st.deadReasonCode).toBe("budget_exhausted");
  });

  test("an unclassified throw fails closed as unexpected_error instead of being retried", async () => {
    const s = await seed();
    const id = await start(s);
    await reach(s, "enrich");
    instrument("enrich", async () => {
      throw new Error("boom: kaboom");
    });
    expect(await run(s, "enrich")).toEqual({ status: "deadlettered", reasonCode: "unexpected_error" });
    expect((await state(id)).lastError).toMatchObject({ reasonCode: "unexpected_error", message: "boom: kaboom" });
  });

  test("an unreadable input set is recorded as a failure, not a silent crash", async () => {
    const s = await seed();
    const id = await start(s);
    await reach(s, "signals");
    await t.run(async (ctx) => {
      const account = (await ctx.db.get(s.accountId))!;
      for (let i = 0; i < 201; i++) {
        await ctx.db.insert("signals", { orgId, subjectType: "account", subjectId: account._id, kind: `k${i}`, strength: "low", confidence: 1, observedAt: Date.now() - DAY });
      }
    });
    await raw.run((ctx) => ctx.db.patch(id, { accountId: s.accountId }));
    expect(await run(s, "signals")).toEqual({ status: "deadlettered", reasonCode: "unexpected_error" });
    expect((await state(id)).lastError?.message).toContain("more than 200 signals");
  });
});

describe("the dead-letter queue", () => {
  test("deadLetterQueue lists dead letters and filters by reason code", async () => {
    const dead: Record<string, Seed> = {};
    for (const code of ["invalid_domain", "policy_refused", "invalid_domain"] as const) {
      const s = await seed();
      await start(s);
      await reach(s, "enrich");
      instrument("enrich", failWith(code, `p-${code}`));
      await run(s, "enrich");
      dead[`${code}:${s.contactId}`] = s;
    }
    const healthy = await seed();
    await start(healthy);

    const all = await t.run((ctx) => deadLetterQueue(ctx));
    expect(all.map((r) => r.reasonCode).sort()).toEqual(["invalid_domain", "invalid_domain", "policy_refused"]);
    const invalid = await t.run((ctx) => deadLetterQueue(ctx, { reasonCode: "invalid_domain" }));
    expect(invalid).toHaveLength(2);
    expect(invalid.every((r) => r.reasonCode === "invalid_domain" && r.stage === "enrich" && r.providerRef === "p-invalid_domain" && r.attempt === 1)).toBe(true);
    expect(await t.run((ctx) => deadLetterQueue(ctx, { reasonCode: "policy_refused" }))).toHaveLength(1);
    expect(await t.run((ctx) => deadLetterQueue(ctx, { reasonCode: "timeout" }))).toEqual([]);
    expect(invalid.map((r) => r.subjectId).sort()).toEqual(
      Object.entries(dead).filter(([k]) => k.startsWith("invalid_domain")).map(([, s]) => s.contactId).sort(),
    );
    // Paginated variant agrees, and another org sees none of it.
    const page = await t.query(api.pipeline.deadletter.listDeadLetters, { reasonCode: "invalid_domain", paginationOpts: { numItems: 10, cursor: null } });
    expect(page.page).toHaveLength(2);
    const other = await asMember(raw, "u2", await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 })));
    expect(await other.run((ctx) => deadLetterQueue(ctx))).toEqual([]);
  });

  test("a dead-lettered subject is resumed explicitly: the failed stage runs again with a fresh attempt count", async () => {
    const s = await seed();
    const id = await start(s);
    await reach(s, "enrich");
    instrument("enrich", failWith("invalid_domain", "dns"));
    await run(s, "enrich");
    expect((await state(id)).status).toBe("deadlettered");
    await expect(t.mutation(api.pipeline.deadletter.resumeSubject, { subjectType: "contact", subjectId: "nope" })).rejects.toThrow("pipeline not started");

    stageHandlers.enrich = originals.enrich; // the cause was fixed
    const stepsBefore = (await pendingSteps()).length;
    await t.mutation(api.pipeline.deadletter.resumeSubject, { subjectType: "contact", subjectId: s.contactId });
    const st = await state(id);
    expect(st).toMatchObject({ status: "active", stage: "enrich", attempt: 0 });
    expect(st.lastError).toBeUndefined();
    expect(st.deadReasonCode).toBeUndefined();
    expect((await pendingSteps()).length).toBe(stepsBefore + 1);
    expect(await run(s, "enrich")).toMatchObject({ status: "done" });
    expect(await t.run((ctx) => deadLetterQueue(ctx))).toEqual([]);
    // Resuming an active subject is allowed (it re-schedules the current stage) and changes nothing else; see chain.test.ts.
    const hashes = (await state(id)).inputHashes;
    await t.mutation(api.pipeline.deadletter.resumeSubject, { subjectType: "contact", subjectId: s.contactId });
    expect((await state(id)).inputHashes).toEqual(hashes);
  });

  test("resuming from an earlier stage forgets that stage's recorded work and everything after it", async () => {
    const s = await seed();
    const id = await start(s);
    await reach(s, "verify");
    instrument("verify", failWith("policy_refused"));
    await run(s, "verify");
    await t.mutation(api.pipeline.deadletter.resumeSubject, { subjectType: "contact", subjectId: s.contactId, fromStage: "resolve" });
    const st = await state(id);
    expect(st.stage).toBe("resolve");
    expect(Object.keys(st.inputHashes)).toEqual(["ingest"]);
    const calls = instrument("resolve");
    expect(await run(s, "resolve")).toMatchObject({ status: "done" }); // re-executed even though its inputs are unchanged
    expect(calls.n).toBe(1);
  });
});

describe("enqueue", () => {
  test("is idempotent: a second enqueue (a webhook retry) adds nothing", async () => {
    const s = await seed();
    const first = await started(s);
    const steps = (await pendingSteps()).length;
    const second = await started(s);
    expect(first.created).toBe(true);
    expect(second).toEqual({ stateId: first.stateId, created: false });
    expect((await pendingSteps()).length).toBe(steps);
    expect(await raw.run((ctx) => ctx.db.query("pipelineState").collect())).toHaveLength(1);
  });

  test("refuses rather than queues when the run's budget is spent", async () => {
    const sourceId = (await seed()).sourceId;
    const runId = await t.action(api.runs.mutations.startRun, { sourceId, creditBudget: 2 });
    const subjects = [await seed(), await seed(), await seed()];
    await t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: subjects[0]!.contactId, runId });
    await t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: subjects[1]!.contactId, runId });
    const steps = (await pendingSteps()).length;
    expect(await t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: subjects[2]!.contactId, runId })).toEqual({ refused: "budget_exhausted" });
    // Nothing was queued and nothing was spent.
    expect((await pendingSteps()).length).toBe(steps);
    expect(await raw.run((ctx) => ctx.db.query("pipelineState").collect())).toHaveLength(2);
    expect((await t.query(api.runs.queries.getRun, { runId })).creditsUsed).toBe(2);
    // The run says why it stopped, instead of staying "running" forever.
    expect(await t.query(api.runs.queries.getRun, { runId })).toMatchObject({ status: "failed", failureReason: "budget_exhausted" });
  });

  test("refuses a subject that does not exist or belongs to another org", async () => {
    const s = await seed();
    const other = await asMember(raw, "u2", await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 })));
    await expect(other.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: s.contactId })).rejects.toThrow("subject not found");
    await expect(t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: s.accountId })).rejects.toThrow("subject not found");
    expect(await raw.run((ctx) => ctx.db.query("pipelineState").collect())).toHaveLength(0);
  });
});

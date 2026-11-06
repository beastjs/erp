/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { SYSTEM_ACTOR_DEFAULT_MODEL_SEED, createIcpVersion } from "../icp/mutations";
import { latestIcp } from "../icp/queries";
import { appendClaimRecord } from "../claims/mutations";
import { setInventoryState } from "../leads/mutations";
import schema from "../schema";
import { deadLetterQueue } from "./deadletter";
import { MAX_REWINDS, STAGES } from "./schema";
import { stageFailure, stageHandlers } from "./stages";

const modules = import.meta.glob("/convex/**/*.ts");
const DAY = 24 * 60 * 60 * 1000;

let raw: ReturnType<typeof convexTest>;
let t: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
let orgId: Id<"orgs">;
const originals = { ...stageHandlers };

beforeEach(async () => {
  vi.useFakeTimers();
  raw = convexTest(schema, modules);
  orgId = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 }));
  t = raw.withIdentity({ subject: "u1", orgId });
});
afterEach(() => {
  Object.assign(stageHandlers, originals);
  vi.useRealTimers();
});

const criteria = { industries: ["software"], geographies: [], technologies: [], decisionMakerRoles: [] };
const makeIcp = () => t.run(async (ctx) => (await latestIcp(ctx, {}))?._id ?? (await createIcpVersion(ctx, { name: "ICP", criteria })));
/** Everything scheduled runs, with NO auth identity, exactly as in production. */
const drain = () => raw.finishAllScheduledFunctions(vi.runAllTimers);
const all = <T extends "claims" | "signals" | "leads" | "scoreRuns" | "pipelineState" | "accounts" | "contacts">(table: T) => raw.run((ctx) => ctx.db.query(table).collect());
const state = async (contactId: Id<"contacts">) => (await t.query(api.pipeline.stages.pipelineStatus, { subjectType: "contact", subjectId: contactId }))!;

/** A real candidate through the real ingest path, so the subjects, claims, keys and source are what production produces. */
async function ingestLead(over: { industry?: string; email?: string; domain?: string } = {}) {
  const email = over.email ?? "jo@acme.com";
  await t.mutation(api.sources.import.addManualLead, {
    candidate: {
      person: { fullName: "Jo Doe", email, jobTitle: "CTO" },
      company: { name: "Acme", domain: over.domain ?? "acme.com", industry: over.industry ?? "Software" },
      acquisition: { acquiredAt: Date.now() - DAY },
    },
  });
  const contact = (await all("contacts")).find((c) => c.display.email === email)!;
  const accountId = contact.fields.find((f: { field: string }) => f.field === "accountId")!.value as Id<"accounts">;
  const sourceId = (await all("claims"))[0]!.sourceId;
  return { contactId: contact._id, accountId, sourceId };
}
const funding = (accountId: Id<"accounts">, sourceId: Id<"sources">, over: Record<string, unknown> = {}) =>
  t.mutation(api.signals.mutations.recordSignals, {
    signals: [{ subjectType: "account", subjectId: accountId, kind: "funding", strength: "high", confidence: 1, observedAt: Date.now() - DAY, sourceId, externalId: "round-a", ...over }],
  });
const start = (contactId: Id<"contacts">) => t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: contactId });
const lead = (id: Id<"leads">) => raw.run((ctx) => ctx.db.get(id)) as Promise<Doc<"leads">>;

describe("end to end", () => {
  test("ingest → package runs a candidate through to a packaged lead", async () => {
    const { contactId, accountId, sourceId } = await ingestLead();
    await makeIcp();
    await funding(accountId, sourceId);
    await start(contactId);
    await drain();

    const st = await state(contactId);
    expect(st).toMatchObject({ status: "done", stage: "package", attempt: 0, accountId });
    expect(st.lastError).toBeUndefined();
    expect(Object.keys(st.inputHashes).sort()).toEqual([...STAGES].sort()); // every stage completed, verify included
    const runs = await all("scoreRuns");
    expect(runs).toHaveLength(1);
    expect(st.scoreRunId).toBe(runs[0]!._id);
    const leads = await all("leads");
    expect(leads).toHaveLength(1);
    expect(st.leadId).toBe(leads[0]!._id);
    expect(leads[0]).toMatchObject({ orgId, accountId, contactId, scoreRunId: runs[0]!._id, inventoryState: "Available", disposition: "ReadyForDistribution" });
    expect(leads[0]!.distributability).toMatchObject({ ok: true, failed: [], suppressed: false });
    expect(leads[0]!.snapshot.contact.display.email).toBe("jo@acme.com");
  });

  test("verify (and enrich) are declared pass-throughs: the chain traverses them and nothing is written", async () => {
    const { contactId, accountId, sourceId } = await ingestLead();
    await makeIcp();
    await funding(accountId, sourceId);
    const seen: string[] = [];
    const trace = (stage: "enrich" | "verify") => {
      const body = stageHandlers[stage];
      stageHandlers[stage] = async (ctx, subject) => {
        const before = [(await ctx.db.query("claims").collect()).length, (await ctx.db.query("signals").collect()).length];
        const result = await body(ctx, subject);
        const after = [(await ctx.db.query("claims").collect()).length, (await ctx.db.query("signals").collect()).length];
        expect(after).toEqual(before);
        seen.push(stage);
        return result;
      };
    };
    trace("enrich");
    trace("verify");
    await start(contactId);
    await drain();
    expect(seen).toEqual(["enrich", "verify"]);
    const st = await state(contactId);
    expect(st.status).toBe("done");
    expect(st.inputHashes.verify).toBeDefined();
    expect(await all("leads")).toHaveLength(1);
  });

  test("a Reject-tier score finishes the pipeline without packaging", async () => {
    const { contactId, accountId, sourceId } = await ingestLead({ industry: "Mining" });
    await makeIcp();
    await funding(accountId, sourceId);
    await start(contactId);
    await drain();
    expect(await state(contactId)).toMatchObject({ status: "done", stage: "qualify", finishedReason: "rejected_tier" });
    expect((await all("scoreRuns"))[0]!.tier).toBe("Reject");
    expect(await all("leads")).toHaveLength(0);

    // Replaying a stopped subject stops it again: it is not skipped past the stage that stopped it into packaging.
    await start(contactId);
    await drain();
    expect(await state(contactId)).toMatchObject({ status: "done", stage: "qualify", finishedReason: "rejected_tier", attempt: 0 });
    expect(await all("leads")).toHaveLength(0);
    expect(await all("scoreRuns")).toHaveLength(1);
  });

  test("an account subject runs the shared stages and stops: only a contact is a lead", async () => {
    const { accountId } = await ingestLead();
    await makeIcp();
    await t.mutation(api.pipeline.stages.startPipeline, { subjectType: "account", subjectId: accountId });
    await drain();
    expect(await t.query(api.pipeline.stages.pipelineStatus, { subjectType: "account", subjectId: accountId })).toMatchObject({
      status: "done",
      stage: "score",
      finishedReason: "account_not_scorable",
    });
    expect(await all("scoreRuns")).toHaveLength(0);
  });

  test("scheduled steps carry the org as an argument, because they run with no identity", async () => {
    const { contactId, accountId, sourceId } = await ingestLead();
    await makeIcp();
    await funding(accountId, sourceId);
    await start(contactId);
    const pending = (await raw.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((f: { name: string }) => f.name.endsWith(":step"));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.args[0]).toEqual({ orgId, subjectType: "contact", subjectId: contactId, stage: "ingest" });
    // Run unauthenticated: if any stage needed an identity the chain would die here, not complete.
    await drain();
    expect(await state(contactId)).toMatchObject({ status: "done", stage: "package" });
    expect(await all("leads")).toHaveLength(1);
  });

  // Finding from the resolveOrg refactor: the score stage seeds the default scoring model from a scheduled function. That
  // used to record the fabricated identity "internal|<orgId>" as the row's author. No person made it, and no person is claimed.
  test("a scoring model seeded by a scheduled stage is attributed to the system label, not a fabricated actor", async () => {
    const { contactId, accountId, sourceId } = await ingestLead();
    await makeIcp();
    await funding(accountId, sourceId);
    await start(contactId);
    await drain();
    const models = await raw.run((ctx) => ctx.db.query("scoringModels").collect());
    expect(models).toHaveLength(1);
    expect(models[0]!.createdBy).toBe(SYSTEM_ACTOR_DEFAULT_MODEL_SEED);
    expect(models[0]!.createdBy).not.toContain("internal");
  });
});

describe("new evidence", () => {
  async function packaged() {
    const s = await ingestLead();
    await makeIcp();
    await funding(s.accountId, s.sourceId, { strength: "medium" });
    await start(s.contactId);
    await drain();
    const first = await state(s.contactId);
    expect(first.status).toBe("done");
    return { ...s, first };
  }

  test("a new claim marks an existing scoreRun stale and schedules a rescore", async () => {
    const s = await packaged();
    await t.mutation(api.claims.mutations.appendClaim, { subjectType: "contact", subjectId: s.contactId, field: "department", value: "Engineering", sourceId: s.sourceId, method: "observed", confidence: 1, observedAt: Date.now() });
    // Rewound in the same transaction as the claim, with the rescore already scheduled.
    const rewound = await state(s.contactId);
    expect(rewound).toMatchObject({ status: "active", stage: "resolve" });
    const pending = (await raw.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((f: { name: string; state: { kind: string } }) => f.state.kind === "pending" && f.name.endsWith(":step"));
    expect(pending.map((p) => p.args[0].stage)).toEqual(["resolve"]);

    await drain();
    const after = await state(s.contactId);
    expect(after).toMatchObject({ status: "done", stage: "package" });
    expect(after.scoreRunId).not.toBe(s.first.scoreRunId);
    expect(await all("scoreRuns")).toHaveLength(2);
    const projected = (await raw.run((ctx) => ctx.db.get(s.contactId)))!;
    expect(projected.fields.some((f: { field: string }) => f.field === "department")).toBe(true);
    // The superseded lead stops being offered; the new one is the shippable lead.
    expect((await lead(s.first.leadId!)).inventoryState).toBe("Replaced");
    expect(await lead(after.leadId!)).toMatchObject({ inventoryState: "Available", disposition: "ReadyForDistribution" });
  });

  test("a scheduled step for a stage that is no longer the subject's turn does nothing", async () => {
    const s = await packaged();
    await t.mutation(api.claims.mutations.appendClaim, { subjectType: "contact", subjectId: s.contactId, field: "department", value: "Engineering", sourceId: s.sourceId, method: "observed", confidence: 1, observedAt: Date.now() });
    const rewound = await state(s.contactId);
    expect(rewound).toMatchObject({ status: "active", stage: "resolve" });
    // The step that was already in flight for the OLD position (package) arrives after the rewind.
    await raw.mutation(internal.pipeline.stages.step, { orgId, subjectType: "contact", subjectId: s.contactId, stage: "package" });
    await raw.mutation(internal.pipeline.stages.step, { orgId, subjectType: "contact", subjectId: s.contactId, stage: "score" });
    expect(await state(s.contactId)).toEqual(rewound);
    expect(await all("scoreRuns")).toHaveLength(1);
    expect(await all("leads")).toHaveLength(1);
  });

  test("a rescore leaves a lead that is already reserved alone", async () => {
    const s = await packaged();
    await t.run((ctx) => setInventoryState(ctx, { leadId: s.first.leadId!, state: "Reserved" }));
    await t.mutation(api.claims.mutations.appendClaim, { subjectType: "contact", subjectId: s.contactId, field: "department", value: "Engineering", sourceId: s.sourceId, method: "observed", confidence: 1, observedAt: Date.now() });
    await drain();
    expect((await lead(s.first.leadId!)).inventoryState).toBe("Reserved");
    expect((await lead((await state(s.contactId)).leadId!)).inventoryState).toBe("Available");
  });

  test("a new signal on the ACCOUNT triggers a rescore of the contact's lead (intent is weighted 45 of 100)", async () => {
    const s = await packaged();
    const before = (await all("scoreRuns"))[0]!;
    await funding(s.accountId, s.sourceId, { kind: "expansion", externalId: "office-2", strength: "high" });
    // The account's contacts are rewound by a scheduled page, so nothing has moved yet.
    expect((await state(s.contactId)).status).toBe("done");
    await drain();
    const runs = await all("scoreRuns");
    expect(runs).toHaveLength(2);
    expect(runs[1]!.intent).toBeGreaterThan(before.intent);
    const after = await state(s.contactId);
    expect(after).toMatchObject({ status: "done", scoreRunId: runs[1]!._id });
    expect(await all("leads")).toHaveLength(2);
  });

  test("a new signal on the contact triggers a rescore too, and a retried signal triggers nothing", async () => {
    const s = await packaged();
    const signal = { subjectType: "contact" as const, subjectId: s.contactId, kind: "job_change", strength: "medium" as const, confidence: 1, observedAt: Date.now() - DAY, sourceId: s.sourceId, externalId: "jc-1" };
    await t.mutation(api.signals.mutations.recordSignals, { signals: [signal] });
    expect((await state(s.contactId)).status).toBe("active");
    await drain();
    expect(await all("scoreRuns")).toHaveLength(2);
    // The same delivery again is a no-op: no new row, so no rewind, no third score.
    await t.mutation(api.signals.mutations.recordSignals, { signals: [signal] });
    expect((await state(s.contactId)).status).toBe("done");
    await drain();
    expect(await all("scoreRuns")).toHaveLength(2);
  });

  test("re-enqueueing a finished subject re-runs only what its inputs invalidate: a new ICP version rescores", async () => {
    const s = await packaged();
    const hashes = s.first.inputHashes;
    const calls = { n: 0 };
    const ingest = stageHandlers.ingest;
    stageHandlers.ingest = async (c, x) => (calls.n++, ingest(c, x));
    await t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: s.contactId });
    await drain();
    expect(calls.n).toBe(0); // unchanged inputs: every stage skipped on its hash
    expect(await all("scoreRuns")).toHaveLength(1);

    await t.run(async (ctx) => createIcpVersion(ctx, { name: "ICP v2", criteria, supersedesId: (await latestIcp(ctx, {}))!._id }));
    await t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: s.contactId });
    await drain();
    const after = await state(s.contactId);
    expect(await all("scoreRuns")).toHaveLength(2);
    expect(after.inputHashes.score).not.toBe(hashes.score);
    expect(after.inputHashes.resolve).toBe(hashes.resolve); // not affected by the ICP
    expect(after).toMatchObject({ status: "done" });
    expect((await lead(s.first.leadId!)).inventoryState).toBe("Replaced");
  });

  test("a subject outside the pipeline is untouched by new evidence, and a dead-lettered one is not resurrected", async () => {
    const { contactId, sourceId } = await ingestLead();
    const claim = () =>
      t.mutation(api.claims.mutations.appendClaim, { subjectType: "contact", subjectId: contactId, field: "department", value: "Eng", sourceId, method: "observed", confidence: 1, observedAt: Date.now() });
    await claim();
    expect(await all("pipelineState")).toHaveLength(0);
    expect(await raw.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(0);

    // No ICP: the score stage dead-letters.
    await start(contactId);
    await drain();
    expect((await state(contactId)).status).toBe("deadlettered");
    await t.mutation(api.claims.mutations.appendClaim, { subjectType: "contact", subjectId: contactId, field: "seniority", value: "Senior", sourceId, method: "observed", confidence: 1, observedAt: Date.now() });
    expect((await state(contactId)).status).toBe("deadlettered");
  });
});

describe("failure and recovery through the real chain", () => {
  test("a missing ICP dead-letters at score, loudly, and resuming after it is created finishes the job", async () => {
    const { contactId, accountId, sourceId } = await ingestLead();
    await funding(accountId, sourceId);
    await start(contactId);
    await drain();
    const st = await state(contactId);
    expect(st).toMatchObject({ status: "deadlettered", stage: "score", attempt: 1, deadReasonCode: "no_such_record" });
    expect(st.lastError).toMatchObject({ stage: "score", reasonCode: "no_such_record", providerRef: "icp", attempt: 1 });
    expect(await t.run((ctx) => deadLetterQueue(ctx, { reasonCode: "no_such_record" }))).toHaveLength(1);
    expect(await all("scoreRuns")).toHaveLength(0);

    await makeIcp();
    await t.mutation(api.pipeline.deadletter.resumeSubject, { subjectType: "contact", subjectId: contactId });
    await drain();
    expect(await state(contactId)).toMatchObject({ status: "done", stage: "package" });
    expect(await all("leads")).toHaveLength(1);
    expect(await t.run((ctx) => deadLetterQueue(ctx))).toEqual([]);
  });

  test("a transient failure retries after its backoff and the chain completes", async () => {
    const { contactId, accountId, sourceId } = await ingestLead();
    await makeIcp();
    await funding(accountId, sourceId);
    let failures = 2;
    const enrich = stageHandlers.enrich;
    stageHandlers.enrich = async (ctx, subject) => {
      if (failures-- > 0) throw stageFailure("rate_limited", "enricher");
      return enrich(ctx, subject);
    };
    await start(contactId);
    await drain();
    const st = await state(contactId);
    expect(st).toMatchObject({ status: "done", stage: "package", attempt: 0 });
    expect(st.lastError).toBeUndefined(); // cleared when the stage completed
    expect(failures).toBe(-1);
  });

  test("one stale score is rescored, and a finished run through the chain gives the rewind budget back", async () => {
    const { contactId, accountId, sourceId } = await ingestLead();
    await makeIcp();
    await funding(accountId, sourceId);
    const qualify = stageHandlers.qualify;
    let first = true;
    stageHandlers.qualify = async (ctx, subject) => (first ? ((first = false), { kind: "rewind" as const, reason: "once" }) : qualify(ctx, subject));
    await start(contactId);
    await drain();
    expect(await state(contactId)).toMatchObject({ status: "done", stage: "package", rewinds: 0 });
    expect(await all("leads")).toHaveLength(1);
  });

  test("a stopped run also gives the rewind budget back", async () => {
    const { contactId, accountId, sourceId } = await ingestLead({ industry: "Mining" });
    await makeIcp();
    await funding(accountId, sourceId);
    const qualify = stageHandlers.qualify;
    let first = true;
    stageHandlers.qualify = async (ctx, subject) => (first ? ((first = false), { kind: "rewind" as const, reason: "once" }) : qualify(ctx, subject));
    await start(contactId);
    await drain();
    expect(await state(contactId)).toMatchObject({ status: "done", finishedReason: "rejected_tier", rewinds: 0 });
  });

  test("a score that keeps going stale is bounded: after MAX_REWINDS rescores the subject dead-letters", async () => {
    const { contactId, accountId, sourceId } = await ingestLead();
    await makeIcp();
    await funding(accountId, sourceId);
    stageHandlers.qualify = async () => ({ kind: "rewind", reason: "always stale" });
    await start(contactId);
    await drain();
    const st = await state(contactId);
    expect(st).toMatchObject({ status: "deadlettered", deadReasonCode: "unexpected_error", rewinds: MAX_REWINDS });
    expect(st.lastError?.message).toBe(`score still stale after ${MAX_REWINDS} rescores: always stale`);
    // Nothing changed between rewinds, so every stage skipped on its hash: the loop cost reads, not scores.
    expect(await all("scoreRuns")).toHaveLength(1);
  });
});

/** A subject the platform forgot: `active`, with no continuation scheduled. A scheduled mutation that throws is not retried. */
async function wedge(contactId: Id<"contacts">, stage: (typeof STAGES)[number]) {
  await raw.run(async (ctx) => {
    for (const f of await ctx.db.system.query("_scheduled_functions").collect()) if (f.state.kind === "pending") await ctx.scheduler.cancel(f._id);
    const row = (await ctx.db.query("pipelineState").collect()).find((r) => r.subjectId === contactId)!;
    await ctx.db.patch(row._id, { stage, status: "active", attempt: 0 });
  });
}
const pendingSteps = async () => (await raw.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((f: { name: string; state: { kind: string } }) => f.state.kind === "pending" && f.name.endsWith(":step"));

describe("an active subject with nothing scheduled", () => {
  test.each(["ingest", "resolve"] as const)("wedged at %s it is revived by resumeSubject and runs to the end", async (stage) => {
    const { contactId, accountId, sourceId } = await ingestLead();
    await makeIcp();
    await funding(accountId, sourceId);
    await start(contactId);
    await wedge(contactId, stage);
    await drain();
    expect(await state(contactId)).toMatchObject({ status: "active", stage }); // nothing moves it
    expect(await all("leads")).toHaveLength(0);

    await t.mutation(api.pipeline.deadletter.resumeSubject, { subjectType: "contact", subjectId: contactId });
    await drain();
    expect(await state(contactId)).toMatchObject({ status: "done", stage: "package" });
    expect(await all("leads")).toHaveLength(1);
  });

  test("resuming a subject that IS scheduled does not run a stage twice or score twice", async () => {
    const { contactId, accountId, sourceId } = await ingestLead();
    await makeIcp();
    await funding(accountId, sourceId);
    const calls: Record<string, number> = {};
    for (const stage of STAGES) {
      const body = stageHandlers[stage];
      stageHandlers[stage] = async (ctx, subject) => ((calls[stage] = (calls[stage] ?? 0) + 1), body(ctx, subject));
    }
    await start(contactId);
    await t.mutation(api.pipeline.deadletter.resumeSubject, { subjectType: "contact", subjectId: contactId });
    await t.mutation(api.pipeline.deadletter.resumeSubject, { subjectType: "contact", subjectId: contactId });
    expect(await pendingSteps()).toHaveLength(3); // the redundant continuations are real
    await drain();
    expect(await state(contactId)).toMatchObject({ status: "done", stage: "package" });
    expect(calls).toEqual(Object.fromEntries(STAGES.map((s) => [s, 1])));
    expect(await all("scoreRuns")).toHaveLength(1);
    expect(await all("leads")).toHaveLength(1);
  });

  test("resuming mid-chain keeps recorded work: it does not re-run completed stages", async () => {
    const { contactId, accountId, sourceId } = await ingestLead();
    await makeIcp();
    await funding(accountId, sourceId);
    await start(contactId);
    await drain();
    await t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: contactId }); // restarts at ingest
    await wedge(contactId, "score");
    const before = await all("scoreRuns");
    await t.mutation(api.pipeline.deadletter.resumeSubject, { subjectType: "contact", subjectId: contactId });
    await drain();
    expect(await all("scoreRuns")).toHaveLength(before.length); // score's hash matched, so it skipped
    expect(await state(contactId)).toMatchObject({ status: "done" });
  });
});

describe("budget exhaustion", () => {
  test("marks the run failed with budget_exhausted, and refuses the subject without queueing it", async () => {
    const { contactId, sourceId } = await ingestLead();
    const runId = await t.mutation(api.runs.mutations.startRun, { sourceId, creditBudget: 0 });
    const out = await t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: contactId, runId });
    expect(out).toEqual({ refused: "budget_exhausted" });
    expect(await t.query(api.runs.queries.getRun, { runId })).toMatchObject({ status: "failed", failureReason: "budget_exhausted", creditsUsed: 0 });
    expect(await all("pipelineState")).toHaveLength(0);
    expect(await pendingSteps()).toHaveLength(0);
  });
});

describe("score staleness from expiry", () => {
  const WEEK = 7 * DAY;
  async function expiring() {
    const s = await ingestLead();
    await makeIcp();
    await funding(s.accountId, s.sourceId, { expiresAt: Date.now() + 30 * DAY });
    await start(s.contactId);
    await drain();
    expect(await state(s.contactId)).toMatchObject({ status: "done" });
    return s;
  }

  test("re-enqueueing after a counted signal expired rescores, though no input row changed", async () => {
    const s = await expiring();
    const first = (await all("scoreRuns"))[0]!;
    const hash = (await state(s.contactId)).inputHashes.score;
    vi.setSystemTime(Date.now() + 5 * WEEK);
    await t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: s.contactId });
    await drain();
    const runs = await all("scoreRuns");
    expect(runs).toHaveLength(2);
    expect(runs[1]!.intent).toBeLessThan(first.intent);
    // The recorded hash is still a pure function of stored data: the clock was not folded into it.
    expect((await state(s.contactId)).inputHashes.score).toBe(hash);
    // Without the funding intent the lead is a Reject: the pipeline stops there instead of packaging a stale Tier S.
    expect(await state(s.contactId)).toMatchObject({ status: "done", finishedReason: "rejected_tier" });
  });

  test("before the expiry nothing is rescored", async () => {
    const s = await expiring();
    vi.setSystemTime(Date.now() + WEEK);
    await t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: s.contactId });
    await drain();
    expect(await all("scoreRuns")).toHaveLength(1);
  });

  test("qualify finding the expiry rescores instead of rewinding into a dead letter", async () => {
    const s = await expiring();
    vi.setSystemTime(Date.now() + 5 * WEEK);
    // A replay from qualify forgets qualify's and package's recorded work, so qualify really evaluates the old score.
    await t.mutation(api.pipeline.deadletter.resumeSubject, { subjectType: "contact", subjectId: s.contactId, fromStage: "qualify" });
    await drain();
    expect(await state(s.contactId)).toMatchObject({ status: "done", finishedReason: "rejected_tier", rewinds: 0 });
    expect(await all("scoreRuns")).toHaveLength(2);
  });
});

describe("account fan-out", () => {
  test("N account claims in one transaction schedule one fan-out chain, not N", async () => {
    const s = await ingestLead();
    await makeIcp();
    await start(s.contactId);
    await drain(); // the contact's pipeline now names the account
    const fanouts = async () => (await raw.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((f: { name: string; state: { kind: string } }) => f.state.kind === "pending" && f.name.endsWith(":markAccountStale"));
    expect(await fanouts()).toHaveLength(0);
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i++) await appendClaimRecord(ctx, { subjectType: "account", subjectId: s.accountId, field: `f${i}`, value: i, sourceId: s.sourceId, method: "observed", confidence: 1, observedAt: Date.now() });
    });
    expect(await fanouts()).toHaveLength(1);
    // A second transaction is a second chain: coalescing is per transaction, never across them.
    await t.run((ctx) => appendClaimRecord(ctx, { subjectType: "account", subjectId: s.accountId, field: "g", value: 1, sourceId: s.sourceId, method: "observed", confidence: 1, observedAt: Date.now() }));
    expect(await fanouts()).toHaveLength(2);
    await drain();
    expect(await state(s.contactId)).toMatchObject({ status: "done" });
  });
});

describe("pipelineState uniqueness", () => {
  test("two rows for one subject are a loud error, not a silently orphaned row", async () => {
    const { contactId } = await ingestLead();
    await start(contactId);
    await raw.run(async (ctx) => {
      const row = (await ctx.db.query("pipelineState").collect())[0]!;
      const { _id, _creationTime, ...rest } = row;
      await ctx.db.insert("pipelineState", rest);
    });
    await expect(t.query(api.pipeline.stages.pipelineStatus, { subjectType: "contact", subjectId: contactId })).rejects.toThrow();
    await expect(start(contactId)).rejects.toThrow();
  });
});

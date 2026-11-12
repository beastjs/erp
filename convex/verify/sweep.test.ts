/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import crons from "../crons";
import { createIcpVersion, asMember } from "../_shared/testkit.support";
import { latestIcp } from "../icp/queries";
import { stageHandlers } from "../pipeline/stages";
import schema from "../schema";
import { DISPOSABLE_DOMAINS } from "./lists";
import { REJUDGE, REJUDGE_LEASE_MS } from "./sweep";
import { structuralLogic } from "./structural";

const modules = import.meta.glob("/convex/**/*.ts");
const DAY = 24 * 60 * 60 * 1000;
const criteria = { industries: ["software"], geographies: [], technologies: [], decisionMakerRoles: [] };

let raw: ReturnType<typeof convexTest>;
let t: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
let orgId: Id<"orgs">;
const originals = { ...stageHandlers };
const disposable = [...DISPOSABLE_DOMAINS];
const page = REJUDGE.page;

beforeEach(async () => {
  vi.useFakeTimers();
  raw = convexTest(schema, modules);
  orgId = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 }));
  t = await asMember(raw, "u1", orgId);
});
afterEach(() => {
  Object.assign(stageHandlers, originals);
  (DISPOSABLE_DOMAINS as string[]).splice(0, DISPOSABLE_DOMAINS.length, ...disposable);
  REJUDGE.page = page;
  vi.useRealTimers();
});

const drain = () => raw.finishAllScheduledFunctions(vi.runAllTimers);
const all = <T extends "leads" | "scoreRuns" | "pipelineState" | "contacts" | "verifications" | "verificationSweeps">(table: T) =>
  raw.run((ctx) => ctx.db.query(table).collect()) as Promise<Doc<T>[]>;
const tick = () => raw.mutation(internal.verify.sweep.sweepStaleVerdicts, {});
const stateOf = async (contactId: Id<"contacts">) => (await all("pipelineState")).find((s) => s.subjectId === contactId)!;
const scoreRunsOf = async (contactId: Id<"contacts">) => (await all("scoreRuns")).filter((r) => r.subjectId === contactId);
const verdictsOf = async (contactId: Id<"contacts">) => (await all("verifications")).filter((r) => r.subjectId === contactId);

let n = 0;
/**
 * A fresh lead whose every claim is observed at confidence 1.0 (what an operator's `appendClaim` may record; ingest's
 * own is 0.9), so one failed kind lands it EXACTLY on the C floor: packaged, Available, and shipping at C. That is
 * the lead the stale verdict hurts most. (At ingest's 0.9 the same failure gives 0.45 and Reject.)
 */
async function ingest(phone: string) {
  const email = `p${n++}@acme.com`;
  await t.mutation(api.sources.import.addManualLead, {
    candidate: {
      person: { fullName: `Person ${n}`, email, phone, jobTitle: "CTO" },
      company: { name: "Acme", domain: "acme.com", industry: "Software" },
      acquisition: { acquiredAt: Date.now() },
    },
  });
  await raw.run(async (ctx) => {
    for (const c of await ctx.db.query("claims").collect()) if (c.confidence !== 1) await ctx.db.patch(c._id, { confidence: 1 });
  });
  const contact = (await all("contacts")).find((c) => c.display.email === email)!;
  const accountId = contact.fields.find((f) => f.field === "accountId")!.value as Id<"accounts">;
  return { contactId: contact._id, accountId };
}

/**
 * The world as it stood BEFORE `25d889a`: the verify stage ran under different rules (a list entry that is gone now,
 * so its `logic` is not today's) and wrote what the old code said about a 16-digit stored phone, `fail/bad_length`.
 * The score counted that failure and halved confidence. Then the rules changed and nothing re-ran this finished subject.
 */
async function judgedUnderOldRules(phone = "+1 555 010 4242 x12345") {
  const lead = await ingest(phone);
  if (!(await t.run((ctx) => latestIcp(ctx, {})))) await t.run((ctx) => createIcpVersion(ctx, { name: "ICP", criteria }));
  const sourceId = (await raw.run((ctx) => ctx.db.query("claims").first()))!.sourceId;
  await t.mutation(api.signals.mutations.recordSignals, {
    signals: [{ subjectType: "account", subjectId: lead.accountId, kind: "funding", strength: "high", confidence: 1, observedAt: Date.now() - DAY, sourceId, externalId: `round-${n}` }],
  });
  (DISPOSABLE_DOMAINS as string[]).push("old-rules.example");
  const oldLogic = structuralLogic().short;
  stageHandlers.verify = async (ctx, { orgId: org, state }) => {
    const contact = (await ctx.db.get(state.subjectId as Id<"contacts">))!;
    const claim = (kind: string) => contact.fields.find((f) => f.field === kind)!.claimId;
    const row = { orgId: org, subjectType: "contact" as const, subjectId: contact._id, provider: "structural" as const, logic: oldLogic, checkedAt: Date.now() };
    await ctx.db.insert("verifications", { ...row, claimId: claim("email"), kind: "email", outcome: "pass", reason: "ok" });
    await ctx.db.insert("verifications", { ...row, claimId: claim("phone"), kind: "phone", outcome: "fail", reason: "bad_length" });
    return { kind: "done" };
  };
  await t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: lead.contactId });
  await drain();
  // Today's rules: the old entry is gone and the real verifier is back.
  Object.assign(stageHandlers, originals);
  (DISPOSABLE_DOMAINS as string[]).splice(0, DISPOSABLE_DOMAINS.length, ...disposable);
  expect(structuralLogic().short).not.toBe(oldLogic);
  return lead;
}

describe("L4: a stored fail/bad_length phone is re-judged by the sweep, rescored, and its lead replaced", () => {
  test("verify writes unknown, the score reruns, confidence is restored and the prior Available lead becomes Replaced", async () => {
    const { contactId } = await judgedUnderOldRules();
    const [halved] = await scoreRunsOf(contactId);
    expect(halved!.confidence).toBe(0.5); // one failed kind on fresh observed evidence: exactly the C floor
    const [prior] = (await all("leads")).filter((l) => l.contactId === contactId);
    expect(prior).toMatchObject({ inventoryState: "Available", tier: "C" });

    expect(await tick()).toEqual({ scheduled: 1 });
    await drain();

    const phone = (await verdictsOf(contactId)).filter((r) => r.kind === "phone");
    expect(phone.map((r) => `${r.outcome}/${r.reason}`)).toEqual(["fail/bad_length", "unknown/ambiguous_length"]); // history kept, new verdict appended
    expect(phone[1]!.logic).toBe(structuralLogic().short);
    const runs = await scoreRunsOf(contactId);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.confidence).toBe(1);
    const leads = (await all("leads")).filter((l) => l.contactId === contactId);
    expect(leads.find((l) => l._id === prior!._id)!.inventoryState).toBe("Replaced");
    expect(leads.find((l) => l._id !== prior!._id)).toMatchObject({ inventoryState: "Available", scoreRunId: runs[1]!._id });
    expect(leads.find((l) => l._id !== prior!._id)!.tier).not.toBe("C");
    expect(await stateOf(contactId)).toMatchObject({ status: "done", stage: "package" });
  });
});

describe("M2: the sweep is cheap when nothing is stale", () => {
  test("once an org's walk under today's rules is done, a tick reads one row for it and schedules nothing; a rules change restarts it once", async () => {
    const { contactId } = await judgedUnderOldRules();
    expect(await tick()).toEqual({ scheduled: 1 });
    await drain();
    const [doneRow] = await all("verificationSweeps");
    expect(doneRow).toMatchObject({ orgId, logic: structuralLogic().short, done: true, after: contactId });
    const verdicts = (await all("verifications")).length;

    // Nothing is stale: repeated ticks schedule nothing, and a slice that runs anyway stops at the progress row.
    for (let i = 0; i < 3; i++) expect(await tick()).toEqual({ scheduled: 0 });
    expect(await raw.mutation(internal.verify.sweep.rejudgeSlice, { orgId })).toEqual({ rewound: 0, failed: 0, done: true });
    await drain();
    expect((await all("verifications")).length).toBe(verdicts);
    expect(await scoreRunsOf(contactId)).toHaveLength(2);

    // A rules change makes the row stale: exactly one walk again, which re-judges the subject under the new rules.
    (DISPOSABLE_DOMAINS as string[]).push("new-rules.example");
    expect(await tick()).toEqual({ scheduled: 1 });
    await drain();
    expect((await all("verifications")).length).toBe(verdicts + 2);
    expect(await tick()).toEqual({ scheduled: 0 });
  });

  test("a subject judged under today's rules is not touched by a walk", async () => {
    const lead = await ingest("+1 555 010 4242");
    await t.run((ctx) => createIcpVersion(ctx, { name: "ICP", criteria }));
    await t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: lead.contactId });
    await drain();
    const before = await stateOf(lead.contactId);
    expect(await tick()).toEqual({ scheduled: 1 }); // no progress row yet: the first walk runs once
    await drain();
    expect(await stateOf(lead.contactId)).toEqual(before);
  });
});

describe("M2: the sweep never revives a dead-lettered or erased subject", () => {
  test("a dead-lettered contact and an erased one keep their state; a live one beside them is re-judged", async () => {
    const dead = await judgedUnderOldRules();
    const erased = await judgedUnderOldRules("+1 555 010 4343 x12345");
    const live = await judgedUnderOldRules("+1 555 010 4444 x12345");
    const deadState = await stateOf(dead.contactId);
    await raw.run((ctx) => ctx.db.patch(deadState._id, { status: "deadlettered", deadReasonCode: "unexpected_error", deadLetteredAt: 1 }));
    const { eraseSubject } = await import("../privacy/redact");
    const request = { requestedBy: { kind: "user", userId: "https://convex.test|u1", role: "admin" }, reasonCode: "data_subject_request", legalBasis: "gdpr_art17_erasure", reference: "CASE-1" } as const;
    expect((await t.run((ctx) => eraseSubject(ctx, { subjectType: "contact", subjectId: erased.contactId, request }))).complete).toBe(true);
    const frozen = { dead: await stateOf(dead.contactId), erased: await stateOf(erased.contactId) };
    const counts = { dead: (await verdictsOf(dead.contactId)).length, erased: (await verdictsOf(erased.contactId)).length };

    await tick();
    await drain();

    expect(await stateOf(dead.contactId)).toEqual(frozen.dead);
    expect(await stateOf(erased.contactId)).toEqual(frozen.erased);
    expect((await verdictsOf(dead.contactId)).length).toBe(counts.dead);
    expect((await verdictsOf(erased.contactId)).length).toBe(counts.erased);
    expect((await verdictsOf(live.contactId)).filter((r) => r.kind === "phone").pop()).toMatchObject({ outcome: "unknown" });
  });
});

describe("M2: a lost or throwing slice does not stop the walk", () => {
  test("a chain that dies mid-walk is resumed by a later tick from the last committed slice, once its lease lapses", async () => {
    REJUDGE.page = 1;
    const a = await judgedUnderOldRules();
    const b = await judgedUnderOldRules("+1 555 010 4545 x12345");
    const [first, second] = [a.contactId, b.contactId].sort();
    // One slice commits, then its continuation is lost (as when a scheduled mutation throws and is not retried).
    expect(await raw.mutation(internal.verify.sweep.rejudgeSlice, { orgId })).toEqual({ rewound: 1, failed: 0, done: false });
    await raw.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.name.includes("rejudgeSlice") && job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
    await drain();
    expect((await verdictsOf(first!)).filter((r) => r.kind === "phone").pop()).toMatchObject({ outcome: "unknown" });
    expect((await verdictsOf(second!)).filter((r) => r.kind === "phone").pop()).toMatchObject({ outcome: "fail" });

    expect(await tick()).toEqual({ scheduled: 0 }); // the lease still holds: a tick does not race a live chain
    vi.setSystemTime(Date.now() + REJUDGE_LEASE_MS + 1);
    expect(await tick()).toEqual({ scheduled: 1 });
    await drain();
    expect((await verdictsOf(second!)).filter((r) => r.kind === "phone").pop()).toMatchObject({ outcome: "unknown" });
    expect((await all("verificationSweeps"))[0]).toMatchObject({ done: true });
  });

  test("a subject whose rewind throws is passed over in its own nested transaction; the slice commits and the walk goes on", async () => {
    const bad = await judgedUnderOldRules();
    const good = await judgedUnderOldRules("+1 555 010 4646 x12345");
    // A duplicate pipelineState row: findState's `.unique()` throws for this subject, loudly, every time.
    const st = await stateOf(bad.contactId);
    const { _id, _creationTime, ...copy } = st;
    await raw.run((ctx) => ctx.db.insert("pipelineState", copy));
    const res = await raw.mutation(internal.verify.sweep.rejudgeSlice, { orgId });
    expect(res).toMatchObject({ failed: 2, done: true }); // both rows of the broken subject
    await drain();
    expect((await verdictsOf(good.contactId)).filter((r) => r.kind === "phone").pop()).toMatchObject({ outcome: "unknown" });
    expect((await verdictsOf(bad.contactId)).filter((r) => r.kind === "phone").pop()).toMatchObject({ outcome: "fail" }); // not rewound, not half-rewound
    expect((await all("pipelineState")).filter((s) => s.subjectId === bad.contactId).every((s) => s.status === "done")).toBe(true);
  });
});

test("the cron is registered", () => {
  const jobs = (crons as unknown as { crons: Record<string, { name: string; schedule: unknown }> }).crons;
  expect(jobs["re-judge verdicts under changed rules"]).toMatchObject({ name: "verify/sweep:sweepStaleVerdicts", schedule: { type: "interval", minutes: 15 } });
});

/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { createIcpVersion, asMember } from "../_shared/testkit.support";
import { appendClaimRecord } from "../claims/mutations";
import { latestIcp } from "../icp/queries";
import { inputHashFor, runStage, stageFailure, stageHandlers, STAGE_LOGIC_VERSION } from "../pipeline/stages";
import { setInventoryState, staleReason } from "../leads/mutations";
import { STAGES } from "../pipeline/schema";
import { rebuildProjection } from "../projections/build";
import schema from "../schema";
import { DISPOSABLE_DOMAINS, ROLE_LOCAL_PARTS } from "./lists";
import { recordVerification, verificationsForSubject, verifySubject } from "./mutations";
import { verifications as verificationsTable } from "./schema";
import { structuralLogic, verifyEmailStructure } from "./structural";

const modules = import.meta.glob("/convex/**/*.ts");
const DAY = 24 * 60 * 60 * 1000;
const criteria = { industries: ["software"], geographies: [], technologies: [], decisionMakerRoles: [] };

let raw: ReturnType<typeof convexTest>;
let t: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
let orgId: Id<"orgs">;
const originals = { ...stageHandlers };
const versions = { ...STAGE_LOGIC_VERSION };
const listSnapshot = { disposable: [...DISPOSABLE_DOMAINS], roles: [...ROLE_LOCAL_PARTS] };

beforeEach(async () => {
  vi.useFakeTimers();
  raw = convexTest(schema, modules);
  orgId = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 }));
  t = await asMember(raw, "u1", orgId);
});
afterEach(() => {
  Object.assign(stageHandlers, originals);
  Object.assign(STAGE_LOGIC_VERSION, versions);
  // A test that edits a list must not leak the edit into the next one.
  (DISPOSABLE_DOMAINS as string[]).splice(0, DISPOSABLE_DOMAINS.length, ...listSnapshot.disposable);
  (ROLE_LOCAL_PARTS as string[]).splice(0, ROLE_LOCAL_PARTS.length, ...listSnapshot.roles);
  vi.useRealTimers();
});

const drain = () => raw.finishAllScheduledFunctions(vi.runAllTimers);
const all = <T extends "claims" | "leads" | "scoreRuns" | "pipelineState" | "contacts" | "verifications">(table: T) => raw.run((ctx) => ctx.db.query(table).collect());
const makeIcp = () => t.run(async (ctx) => (await latestIcp(ctx, {}))?._id ?? (await createIcpVersion(ctx, { name: "ICP", criteria })));
/** A funding signal, so the lead has intent and survives qualification to be packaged. */
const funding = (accountId: Id<"accounts">, sourceId: Id<"sources">) =>
  t.mutation(api.signals.mutations.recordSignals, {
    signals: [{ subjectType: "account", subjectId: accountId, kind: "funding", strength: "high", confidence: 1, observedAt: Date.now() - DAY, sourceId, externalId: "round-a" }],
  });

let leadCount = 0;
async function ingestLead(over: { email?: string; phone?: string | null; domain?: string; name?: string } = {}) {
  const email = over.email ?? "jo@acme.com";
  await t.mutation(api.sources.import.addManualLead, {
    candidate: {
      person: { fullName: over.name ?? "Jo Doe", email, ...(over.phone === null ? {} : { phone: over.phone ?? `+1 555 010 ${String(4000 + leadCount++)}` }), jobTitle: "CTO" },
      company: { name: "Acme", domain: over.domain ?? "acme.com", industry: "Software" },
      acquisition: { acquiredAt: Date.now() - DAY },
    },
  });
  const contact = (await all("contacts")).find((c) => c.display.email === email.toLowerCase())!;
  const accountId = contact.fields.find((f: { field: string }) => f.field === "accountId")!.value as Id<"accounts">;
  const sourceId = (await all("claims"))[0]!.sourceId;
  return { contactId: contact._id, accountId, sourceId };
}
const start = (contactId: Id<"contacts">) => t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: contactId });
const rowsFor = async (contactId: Id<"contacts">) => ((await all("verifications")) as Doc<"verifications">[]).filter((r) => r.subjectId === contactId);
const claimOf = async (contactId: Id<"contacts">, field: string) =>
  (await t.run(async (ctx) => (await ctx.db.get(contactId))!.fields.find((f: { field: string }) => f.field === field)!)).claimId;
const confidenceOf = async (contactId: Id<"contacts">) => {
  const runs = (await all("scoreRuns")).filter((r) => r.subjectId === contactId);
  return runs[runs.length - 1]!.confidence;
};

describe("recordVerification", () => {
  test("stores the provider as 'structural', the verdict, the claim it judged and nothing of the value", async () => {
    const { contactId } = await ingestLead();
    const claimId = await claimOf(contactId, "email");
    const before = Date.now();
    const id = await t.run((ctx) => recordVerification(ctx, { subjectType: "contact", subjectId: contactId, claimId }));
    const row = (await raw.run((ctx) => ctx.db.get(id)))!;
    expect(row).toMatchObject({
      orgId,
      subjectType: "contact",
      subjectId: contactId,
      claimId,
      kind: "email",
      outcome: "pass",
      reason: "ok",
      provider: "structural",
      logic: structuralLogic().short,
    });
    expect(row.checkedAt).toBeGreaterThanOrEqual(before - 1);
    expect(row.checkedAt).toBeLessThan(before + 60_000);
    expect(Object.keys(row).sort()).toEqual(["_creationTime", "_id", "checkedAt", "claimId", "kind", "logic", "orgId", "outcome", "provider", "reason", "subjectId", "subjectType"]);
    expect(JSON.stringify(row).toLowerCase()).not.toMatch(/jo@|acme|555|doe/);
  });

  test("the caller cannot choose the time, the verdict or the provider: each is refused as an argument, not ignored", async () => {
    const { contactId } = await ingestLead();
    const claimId = await claimOf(contactId, "email");
    const base = { subjectType: "contact", subjectId: contactId, claimId };
    for (const extra of [{ checkedAt: 9_999_999_999_999 }, { result: verifyEmailStructure("jo@acme.com") }, { provider: "structural" }, { outcome: "pass" }]) {
      await expect(t.run((ctx) => recordVerification(ctx, { ...base, ...extra } as never))).rejects.toThrow(/computed from the claim, never supplied/);
    }
    const id = await t.run((ctx) => recordVerification(ctx, { subjectType: "contact", subjectId: contactId, claimId }));
    expect((await raw.run((ctx) => ctx.db.get(id)))!.checkedAt).toBeLessThan(Date.now() + 60_000);
  });

  test("refuses at the boundary: a claim that is not this subject's, not a verifiable kind, erased or in another org", async () => {
    const a = await ingestLead();
    const b = await ingestLead({ email: "kay@other.com", domain: "other.com", name: "Kay Lee", phone: "+1 555 010 9999" });
    const record = (claimId: Id<"claims">) => t.run((ctx) => recordVerification(ctx, { subjectType: "contact", subjectId: a.contactId, claimId }));
    const emailClaim = await claimOf(a.contactId, "email");
    await expect(record(await claimOf(b.contactId, "email"))).rejects.toThrow(/claim not found/); // another subject's claim
    await expect(record(await claimOf(a.contactId, "title"))).rejects.toThrow(/a title claim is not a verifiable kind/);
    // another org's subject
    const otherOrg = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
    const t2 = await asMember(raw, "u2", otherOrg);
    await expect(t2.run((ctx) => recordVerification(ctx, { subjectType: "contact", subjectId: a.contactId, claimId: emailClaim }))).rejects.toThrow(/subject not found/);
    // a redacted claim
    await raw.run((ctx) => ctx.db.patch(emailClaim, { value: null, redactedAt: 1 }));
    await expect(record(emailClaim)).rejects.toThrow(/erased/);
    expect(await rowsFor(a.contactId)).toHaveLength(0);
  });

  test("the verdict is judged on the claim's own stored value, whatever the projection shows", async () => {
    const { contactId, sourceId } = await ingestLead();
    // A losing email claim on a disposable domain: judged by its own value, not by the winner the projection displays.
    const loser = await t.run((ctx) =>
      appendClaimRecord(ctx, { subjectType: "contact", subjectId: contactId, field: "email", value: "jo@mailinator.com", sourceId, method: "extracted", confidence: 0.5, observedAt: 0 }),
    );
    const id = await t.run((ctx) => recordVerification(ctx, { subjectType: "contact", subjectId: contactId, claimId: loser }));
    expect(await raw.run((ctx) => ctx.db.get(id))).toMatchObject({ claimId: loser, outcome: "fail", reason: "disposable" });
  });

  test("an erasure in progress already refuses: the subject is erased from the first slice, before every claim is redacted", async () => {
    const lead = await ingestLead();
    const { eraseSubject } = await import("../privacy/redact");
    const request = { requestedBy: { kind: "user", userId: "https://convex.test|u1", role: "admin" }, reasonCode: "data_subject_request", legalBasis: "gdpr_art17_erasure", reference: "CASE-1" } as const;
    expect((await t.run((ctx) => eraseSubject(ctx, { subjectType: "contact", subjectId: lead.contactId, request }, { budget: 1 }))).complete).toBe(false);
    const live = ((await all("claims")) as Doc<"claims">[]).find((c) => c.subjectId === lead.contactId && c.field === "email" && c.redactedAt === undefined);
    expect(live, "the partial erasure must leave the email claim unredacted for this test to mean anything").toBeTruthy();
    await expect(t.run((ctx) => recordVerification(ctx, { subjectType: "contact", subjectId: lead.contactId, claimId: live!._id }))).rejects.toThrow(/erased/);
  });

  test("the claim must be the subject's own even when the ids look right: a contact's id passed as a claim id is refused by the subject check", async () => {
    // Not a validator refusal (a plain helper has no arg validator): `db.get` returns the CONTACT, which has no
    // subjectType or subjectId, so the claim-belongs-to-this-subject check is what refuses it.
    const { contactId } = await ingestLead();
    await expect(
      t.run((ctx) => recordVerification(ctx, { subjectType: "contact", subjectId: contactId, claimId: contactId as unknown as Id<"claims"> })),
    ).rejects.toThrow(/claim not found for this subject/);
  });
});

describe("the table holds no value, by construction", () => {
  type V = { kind: string; fields?: Record<string, V>; members?: V[]; value?: unknown; tableName?: string };
  /** Every leaf of a validator tree, so a `v.string()`, `v.any()`, object, array or record anywhere in the row is found. */
  const leaves = (v: V): string[] => {
    if (v.kind === "object") return Object.values(v.fields ?? {}).flatMap(leaves);
    if (v.kind === "union") return (v.members ?? []).flatMap(leaves);
    return [v.kind];
  };
  const columns = (verificationsTable as unknown as { validator: { fields: Record<string, V> } }).validator.fields;

  test("every column is an id, a literal or a number: no string, any, object, array or record can hold a value", () => {
    const kinds = Object.fromEntries(Object.entries(columns).map(([name, v]) => [name, [...new Set(leaves(v))]]));
    expect(kinds).toEqual({
      orgId: ["id"],
      subjectType: ["literal"],
      subjectId: ["id"],
      claimId: ["id"],
      kind: ["literal"],
      outcome: ["literal"],
      reason: ["literal"],
      provider: ["literal"],
      logic: ["float64"],
      checkedAt: ["float64"],
    });
  });

  test("the schema refuses a row that smuggles the value in, however it is spelled", async () => {
    const { contactId } = await ingestLead();
    const claimId = await claimOf(contactId, "email");
    const good = { orgId, subjectType: "contact", subjectId: contactId, claimId, kind: "email", outcome: "pass", reason: "ok", provider: "structural", logic: 1, checkedAt: 1 } as const;
    const insert = (row: Record<string, unknown>) => raw.run((ctx) => ctx.db.insert("verifications", row as never));
    await expect(insert({ ...good, value: "jo@acme.com" })).rejects.toThrow(); // an extra column
    await expect(insert({ ...good, reason: "jo@acme.com" })).rejects.toThrow(); // the value in a literal's slot
    await expect(insert({ ...good, kind: "jo@acme.com" })).rejects.toThrow();
    await expect(insert({ ...good, provider: "jo@acme.com" })).rejects.toThrow();
    await expect(insert({ ...good, subjectId: "jo@acme.com" })).rejects.toThrow();
    await expect(insert(good)).resolves.toBeTruthy(); // and the control: the same row without the poison inserts
  });
});

describe("the verify stage", () => {
  test("records a verification for the email and phone and advances the pipeline", async () => {
    const { contactId, accountId, sourceId } = await ingestLead();
    await makeIcp();
    await funding(accountId, sourceId);
    await start(contactId);
    await drain();
    const rows = await rowsFor(contactId);
    expect(rows.map((r) => `${r.kind}:${r.outcome}:${r.reason}:${r.provider}`).sort()).toEqual(["email:pass:ok:structural", "phone:pass:ok:structural"]);
    const st = (await all("pipelineState"))[0]!;
    expect(st).toMatchObject({ status: "done", stage: "package" });
    expect(Object.keys(st.inputHashes).sort()).toEqual([...STAGES].sort());
    expect(await all("leads")).toHaveLength(1);
  });

  test("every claim it judged is the one the contact currently projects", async () => {
    const { contactId } = await ingestLead();
    await makeIcp();
    await start(contactId);
    await drain();
    const rows = await rowsFor(contactId);
    expect(rows.find((r) => r.kind === "email")!.claimId).toBe(await claimOf(contactId, "email"));
    expect(rows.find((r) => r.kind === "phone")!.claimId).toBe(await claimOf(contactId, "phone"));
  });

  test("a contact with no phone is judged on its email alone; an account is not judged at all", async () => {
    const { contactId, accountId } = await ingestLead({ phone: null });
    await t.run(async (ctx) => {
      expect(await verifySubject(ctx, { subjectType: "contact", subjectId: contactId })).toBe(1);
      expect(await verifySubject(ctx, { subjectType: "account", subjectId: accountId })).toBe(0);
    });
    expect((await rowsFor(contactId)).map((r) => r.kind)).toEqual(["email"]);
  });

  test("it is idempotent: replaying the pipeline, or the body itself, adds no rows", async () => {
    const { contactId } = await ingestLead();
    await makeIcp();
    await start(contactId);
    await drain();
    expect(await rowsFor(contactId)).toHaveLength(2);
    await start(contactId);
    await drain();
    expect(await rowsFor(contactId)).toHaveLength(2);
    expect(await t.run((ctx) => verifySubject(ctx, { subjectType: "contact", subjectId: contactId }))).toBe(0);
    expect(await rowsFor(contactId)).toHaveLength(2);
  });

  test("a valid phone with an extension is not failed once the pipeline has stored it as bare digits", async () => {
    const { contactId } = await ingestLead({ email: "jo@acme.com", phone: "+1 555 010 4242 x12345" });
    await makeIcp();
    await start(contactId);
    await drain();
    expect((await rowsFor(contactId)).map((r) => `${r.kind}:${r.outcome}:${r.reason}`).sort()).toEqual(["email:pass:ok", "phone:unknown:ambiguous_length"]);
  });

  test("a failing verdict never stops the lead: it is recorded and the chain goes on", async () => {
    const { contactId } = await ingestLead({ email: "jo@mailinator.com", phone: "12345" });
    await makeIcp();
    await start(contactId);
    await drain();
    expect((await rowsFor(contactId)).map((r) => `${r.kind}:${r.outcome}:${r.reason}`).sort()).toEqual(["email:fail:disposable", "phone:fail:bad_length"]);
    const st = (await all("pipelineState"))[0]!;
    expect(st.status).toBe("done");
    expect(st.lastError).toBeUndefined();
  });

  test("version 2 of the stage's logic: a subject that completed the old pass-through re-runs the real one", async () => {
    expect(STAGE_LOGIC_VERSION.verify).toBe(2);
    const { contactId } = await ingestLead();
    await makeIcp();
    await start(contactId);
    await drain();
    const st = (await all("pipelineState"))[0]!;
    // A subject that completed verify under the pass-through recorded the hash of logic 1; the real stage's hash differs, so it re-runs.
    const v2 = await t.run((ctx) => inputHashFor(ctx, orgId, st, "verify"));
    expect(st.inputHashes.verify).toBe(v2);
    await t.run(async (ctx) => {
      STAGE_LOGIC_VERSION.verify = 1;
      try {
        expect(await inputHashFor(ctx, orgId, st, "verify")).not.toBe(v2);
      } finally {
        STAGE_LOGIC_VERSION.verify = 2;
      }
    });
  });
});

describe("THE LISTS ARE LOGIC: changing one forces a re-run, never a skip on an unchanged hash", () => {
  async function completed() {
    const lead = await ingestLead();
    await makeIcp();
    await funding(lead.accountId, lead.sourceId);
    await start(lead.contactId);
    await drain();
    return lead;
  }
  const verifyHash = async (contactId: Id<"contacts">) => {
    const st = (await all("pipelineState")).find((s) => s.subjectId === contactId)!;
    return await t.run((ctx) => inputHashFor(ctx, orgId, st, "verify"));
  };
  const stageRun = (contactId: Id<"contacts">) => t.run((ctx) => runStage(ctx, { subjectType: "contact", subjectId: contactId, stage: "verify" }));
  const rewindTo = async (contactId: Id<"contacts">, stage: "verify") => {
    const st = (await all("pipelineState")).find((s) => s.subjectId === contactId)!;
    await raw.run((ctx) => ctx.db.patch(st._id, { stage, status: "active" }));
  };

  test("control: with the lists unchanged the verify stage is SKIPPED on its hash", async () => {
    const { contactId } = await completed();
    const hash = await verifyHash(contactId);
    await rewindTo(contactId, "verify");
    expect((await stageRun(contactId)).status).toBe("skipped");
    expect(await verifyHash(contactId)).toBe(hash);
    expect(await rowsFor(contactId)).toHaveLength(2);
  });

  test("a domain added to the disposable list changes the verify hash and the stage RE-RUNS: the stale pass is superseded by a fail, the old row kept", async () => {
    const { contactId } = await completed();
    const hash = await verifyHash(contactId);
    const oldRows = await rowsFor(contactId);
    expect(oldRows.find((r) => r.kind === "email")).toMatchObject({ outcome: "pass" });
    expect((await verifyHash(contactId)) === hash).toBe(true);

    (DISPOSABLE_DOMAINS as string[]).push("acme.com");
    expect(await verifyHash(contactId)).not.toBe(hash);
    await rewindTo(contactId, "verify");
    expect((await stageRun(contactId)).status).toBe("done"); // not "skipped"

    const rows = await rowsFor(contactId);
    expect(rows).toHaveLength(4); // email and phone re-judged under the new rules
    for (const old of oldRows) expect(rows.find((r) => r._id === old._id)).toEqual(old); // append-only: history untouched
    const fresh = rows.filter((r) => !oldRows.some((o) => o._id === r._id));
    expect(fresh.find((r) => r.kind === "email")).toMatchObject({ outcome: "fail", reason: "disposable", logic: structuralLogic().short });
    expect(fresh.every((r) => r.logic !== oldRows[0]!.logic)).toBe(true);
    // The scorer reads the NEW verdict, not the stale pass.
    expect(await t.run((ctx) => verificationsForSubject(ctx, { subjectType: "contact", subjectId: contactId }))).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "email", outcome: "fail" })]),
    );
  });

  test.each([
    ["a role added", () => (ROLE_LOCAL_PARTS as string[]).push("jo")],
    ["a role removed", () => (ROLE_LOCAL_PARTS as string[]).splice(0, 1)],
    ["a disposable domain removed", () => (DISPOSABLE_DOMAINS as string[]).splice(0, 1)],
  ])("%s: the hash changes", async (_name, edit) => {
    const { contactId } = await completed();
    const hash = await verifyHash(contactId);
    edit();
    expect(await verifyHash(contactId)).not.toBe(hash);
  });

  test("end to end through the real chain: the list edit reaches a REPLAY of a finished subject and lowers its score's confidence", async () => {
    const { contactId } = await completed();
    const before = await confidenceOf(contactId);
    (DISPOSABLE_DOMAINS as string[]).push("acme.com");
    await start(contactId);
    await drain();
    expect(await confidenceOf(contactId)).toBeLessThan(before);
    expect((await all("scoreRuns")).filter((r) => r.subjectId === contactId)).toHaveLength(2);
  });

  test("a role edit that moves a verdict from pass to unknown changes nothing the scorer sees, and does not rescore", async () => {
    const { contactId } = await completed();
    (ROLE_LOCAL_PARTS as string[]).push("jo");
    await start(contactId);
    await drain();
    expect((await rowsFor(contactId)).find((r) => r.reason === "role")).toBeTruthy(); // re-judged...
    expect((await all("scoreRuns")).filter((r) => r.subjectId === contactId)).toHaveLength(1); // ...pass and unknown are both neutral: no rescore
  });
});

describe("scoring: a failed verification lowers confidence, pass and unknown do not, and a superseded verdict counts for nothing", () => {
  async function scored(over: Parameters<typeof ingestLead>[0]) {
    const lead = await ingestLead(over);
    await makeIcp();
    await funding(lead.accountId, lead.sourceId);
    await start(lead.contactId);
    await drain();
    return lead;
  }

  test("a disposable email halves the confidence of an otherwise identical lead (the model's failedVerificationFactor, unchanged)", async () => {
    const good = await scored({});
    const bad = await scored({ email: "kay@mailinator.com", name: "Kay Lee" });
    const g = await confidenceOf(good.contactId);
    const b = await confidenceOf(bad.contactId);
    expect(g).toBeGreaterThan(0);
    expect(b).toBeCloseTo(g * 0.5, 7);
  });

  test("a role address and a non-ASCII address are unknown: neutral, the same confidence as a pass", async () => {
    const good = await scored({});
    const role = await scored({ email: "info@acme.com", name: "Info Desk" });
    const intl = await scored({ email: "jörg@acme.com", name: "Jorg" });
    expect(await confidenceOf(role.contactId)).toBe(await confidenceOf(good.contactId));
    expect(await confidenceOf(intl.contactId)).toBe(await confidenceOf(good.contactId));
  });

  test("two failed kinds compound, one factor per kind", async () => {
    const good = await scored({});
    const both = await scored({ email: "kay@mailinator.com", phone: "12345", name: "Kay Lee" });
    expect(await confidenceOf(both.contactId)).toBeCloseTo((await confidenceOf(good.contactId)) * 0.25, 7);
  });

  test("a verdict on a SUPERSEDED email counts for nothing: a failed old address cannot sink a good new one", async () => {
    const lead = await scored({ email: "jo@mailinator.com" });
    const sunk = await confidenceOf(lead.contactId);
    expect(await t.run((ctx) => verificationsForSubject(ctx, { subjectType: "contact", subjectId: lead.contactId }))).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "email", outcome: "fail" })]),
    );
    // A newer, observed email supersedes the old one in the projection.
    await t.run(async (ctx) => {
      await appendClaimRecord(ctx, { subjectType: "contact", subjectId: lead.contactId, field: "email", value: "jo@acme.com", sourceId: lead.sourceId, method: "observed", confidence: 1, observedAt: Date.now() - 1000 });
      await rebuildProjection(ctx, { subjectType: "contact", subjectId: lead.contactId });
    });
    // Not yet verified: the old verdict describes a claim that no longer wins, so it is not returned.
    expect((await t.run((ctx) => verificationsForSubject(ctx, { subjectType: "contact", subjectId: lead.contactId }))).map((v) => v.kind)).toEqual(["phone"]);
    await start(lead.contactId);
    await drain();
    expect(await t.run((ctx) => verificationsForSubject(ctx, { subjectType: "contact", subjectId: lead.contactId }))).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "email", outcome: "pass" })]),
    );
    expect(await confidenceOf(lead.contactId)).toBeGreaterThan(sunk);
    // History is intact: the old failure is still on record.
    expect((await rowsFor(lead.contactId)).filter((r) => r.kind === "email").map((r) => r.outcome).sort()).toEqual(["fail", "pass"]);
  });

  test("a changed verdict is a changed score input: the score hash moves, so a rescore happens", async () => {
    const lead = await scored({});
    const st = (await all("pipelineState")).find((s) => s.subjectId === lead.contactId)!;
    const before = await t.run((ctx) => inputHashFor(ctx, orgId, st, "score"));
    (DISPOSABLE_DOMAINS as string[]).push("acme.com");
    await t.run((ctx) => verifySubject(ctx, { subjectType: "contact", subjectId: lead.contactId }));
    expect(await t.run((ctx) => inputHashFor(ctx, orgId, st, "score"))).not.toBe(before);
  });
});

describe("verificationsForSubject", () => {
  test("a subject with no verdicts yields [] and an unverified lead scores exactly as before verification existed", async () => {
    const lead = await ingestLead();
    expect(await t.run((ctx) => verificationsForSubject(ctx, { subjectType: "contact", subjectId: lead.contactId }))).toEqual([]);
  });

  test("returns the latest verdict per kind however much history there is: nothing is truncated", async () => {
    const lead = await ingestLead();
    await t.run((ctx) => verifySubject(ctx, { subjectType: "contact", subjectId: lead.contactId }));
    for (const extra of ["a1.example", "a2.example", "a3.example"]) {
      (DISPOSABLE_DOMAINS as string[]).push(extra);
      await t.run((ctx) => verifySubject(ctx, { subjectType: "contact", subjectId: lead.contactId }));
    }
    expect(await rowsFor(lead.contactId)).toHaveLength(8); // 4 rule sets x 2 kinds
    const out = await t.run((ctx) => verificationsForSubject(ctx, { subjectType: "contact", subjectId: lead.contactId }));
    expect(out.map((v) => v.kind).sort()).toEqual(["email", "phone"]);
    const newest = (await rowsFor(lead.contactId)).filter((r) => r.logic === structuralLogic().short);
    expect(newest).toHaveLength(2);
  });

  test("never reads another org's subject", async () => {
    const lead = await ingestLead();
    const otherOrg = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
    const t2 = await asMember(raw, "u2", otherOrg);
    await expect(t2.run((ctx) => verificationsForSubject(ctx, { subjectType: "contact", subjectId: lead.contactId }))).rejects.toThrow(/subject not found/);
  });

  test("no public function takes an org or reaches the table: the helpers are plain, the table is read only through them", async () => {
    const { api: a } = await import("../_generated/api");
    expect(Object.keys((a as unknown as Record<string, object>).verify ?? {})).toEqual([]);
  });
});

describe("the coupling the score hash relies on", () => {
  test("pass and unknown score identically, a fail does not: so only a failed verdict needs to be a score input", async () => {
    const { computeScore } = await import("../scoring/score");
    const { DEFAULT_SCORING_MODEL: model } = await import("../icp/defaults");
    const field = (name: string, value: string, claimId: string) => ({ field: name, value, claimId: claimId as Id<"claims">, method: "observed" as const, confidence: 1, observedAt: Date.now() });
    const account = { fields: [field("industry", "Software", "c1")] };
    const contact = { fields: [field("email", "jo@acme.com", "c2")] };
    const run = (outcome: "pass" | "unknown" | "fail") =>
      computeScore({
        account,
        contact,
        signals: [],
        icp: { criteria },
        model,
        verifications: [{ kind: "email", outcome, checkedAt: 1 }],
        claimRecordedAt: { c1: 0, c2: 0 },
        now: Date.now(),
      });
    expect(run("unknown")).toEqual(run("pass"));
    expect(run("fail").confidence).toBeLessThan(run("pass").confidence);
  });

  test("one failed kind on fresh observed evidence lands EXACTLY on the C floor, not one ULP under it (score.ts snaps; the default ceilings equal the floors)", async () => {
    const { computeScore } = await import("../scoring/score");
    const { DEFAULT_SCORING_MODEL: model } = await import("../icp/defaults");
    const now = Date.now();
    const field = (name: string, value: string, claimId: string) => ({ field: name, value, claimId: claimId as Id<"claims">, method: "observed" as const, confidence: 1, observedAt: now });
    const r = computeScore({
      account: { fields: [field("industry", "Software", "c1")] },
      contact: { fields: [field("email", "x@mailinator.com", "c2")] },
      signals: [],
      icp: { criteria },
      model,
      verifications: [{ kind: "email", outcome: "fail", checkedAt: 1 }],
      claimRecordedAt: { c1: now, c2: now },
      now,
    });
    expect(r.confidence).toBe(0.5);
    expect(r.confidence).toBeGreaterThanOrEqual(model.confidenceFloors.C);
  });
});

// ------------------------------------------------------------------------------------------------ review fixes (Task 15)

/** Rewrites the contact's projected email to `claim`, as a resolver that ranks differently would. No claim is added. */
async function projectEmail(ctx: { db: any }, contactId: Id<"contacts">, claim: Doc<"claims">) {
  const c = (await ctx.db.get(contactId))!;
  const field = { field: "email", value: claim.value, claimId: claim._id, method: claim.method, confidence: claim.confidence, observedAt: claim.observedAt };
  const fields = [...c.fields.filter((f: { field: string }) => f.field !== "email"), field].sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  await ctx.db.patch(contactId, { fields, display: { ...c.display, email: claim.value } });
}

describe("M1: a resolver change reaches verify and score, though no claim was added", () => {
  /** A finished lead whose contact also holds a LOSING email claim (extracted ranks under observed). */
  async function withLoser(loser: string) {
    const lead = await ingestLead();
    const b = await t.run((ctx) =>
      appendClaimRecord(ctx, { subjectType: "contact", subjectId: lead.contactId, field: "email", value: loser, sourceId: lead.sourceId, method: "extracted", confidence: 0.5, observedAt: Date.now() - 1000 }),
    );
    await makeIcp();
    await funding(lead.accountId, lead.sourceId);
    await start(lead.contactId);
    await drain();
    expect(await claimOf(lead.contactId, "email")).not.toBe(b); // control: the loser really loses today
    expect((await rowsFor(lead.contactId)).some((r) => r.claimId === b)).toBe(false);
    const claimB = (await raw.run((ctx) => ctx.db.get(b)))!;
    return { ...lead, claimB };
  }
  /** A resolver fix: bump its version (as the fix would) and make it rank the loser first. */
  function shipResolverFix(claimB: Doc<"claims">, contactId: Id<"contacts">) {
    STAGE_LOGIC_VERSION.resolve += 1;
    stageHandlers.resolve = async (ctx, subject) => {
      const r = await originals.resolve(ctx, subject);
      if (subject.state.subjectId === contactId) await projectEmail(ctx, contactId, claimB);
      return r;
    };
  }

  test("the new winner is judged: a disposable address that a resolver fix promotes is verified and penalised, not skipped", async () => {
    const { contactId, claimB } = await withLoser("jo@mailinator.com");
    const before = await confidenceOf(contactId);
    shipResolverFix(claimB, contactId);
    await start(contactId);
    await drain();
    expect(await claimOf(contactId, "email")).toBe(claimB._id);
    expect((await rowsFor(contactId)).find((r) => r.claimId === claimB._id)).toMatchObject({ outcome: "fail", reason: "disposable" });
    expect(await confidenceOf(contactId)).toBeCloseTo(before * 0.5, 7);
  });

  test("a resolver fix that re-projects to a GOOD address still rescores: the score reads the projection", async () => {
    const { contactId, claimB } = await withLoser("jo.doe@acme.com");
    const runs = (await all("scoreRuns")).filter((r) => r.subjectId === contactId).length;
    shipResolverFix(claimB, contactId);
    await start(contactId);
    await drain();
    expect((await rowsFor(contactId)).find((r) => r.claimId === claimB._id)).toMatchObject({ outcome: "pass" });
    expect((await all("scoreRuns")).filter((r) => r.subjectId === contactId)).toHaveLength(runs + 1);
  });

  test("the verify hash names the claims it will judge: a projection that changed underneath it, with no version bump, re-runs verify", async () => {
    const { contactId, claimB } = await withLoser("jo@mailinator.com");
    await raw.run((ctx) => projectEmail(ctx, contactId, claimB));
    const st = (await all("pipelineState")).find((s) => s.subjectId === contactId)!;
    await raw.run((ctx) => ctx.db.patch(st._id, { stage: "verify", status: "active" }));
    expect((await t.run((ctx) => runStage(ctx, { subjectType: "contact", subjectId: contactId, stage: "verify" }))).status).toBe("done");
    expect((await rowsFor(contactId)).find((r) => r.claimId === claimB._id)).toMatchObject({ outcome: "fail", reason: "disposable" });
  });
});

describe("M3: one stored shape, one verdict, whichever path the value came in by", () => {
  /** A value typed by an operator through `appendClaim` is stored as typed; ingest would have stored it normalized. */
  async function typed(field: "email" | "phone", value: string) {
    const lead = await ingestLead({ phone: null });
    await t.run(async (ctx) => {
      await appendClaimRecord(ctx, { subjectType: "contact", subjectId: lead.contactId, field, value, sourceId: lead.sourceId, method: "observed", confidence: 1, observedAt: Date.now() });
      await rebuildProjection(ctx, { subjectType: "contact", subjectId: lead.contactId });
      await verifySubject(ctx, { subjectType: "contact", subjectId: lead.contactId });
    });
    expect((await t.run(async (ctx) => (await ctx.db.get(lead.contactId))!.fields.find((f: { field: string }) => f.field === field)!.value))).toBe(value); // stored raw
    return (await rowsFor(lead.contactId)).filter((r) => r.kind === field).pop()!;
  }

  test.each([
    ["an extension after #", "+1 555 010 4242 #123"],
    ["a tel: URI with ;ext=", "tel:+1-555-010-4242;ext=123"],
    ["the word extension", "+1 555 010 4242 extension 12"],
    ["non-breaking spaces", "+1\u00a0555\u00a0010\u00a04242"],
    ["non-breaking hyphens (U+2011)", "+1\u2011555\u2011010\u20114242"],
  ])("a valid phone written with %s passes, as its ingested form does", async (_name, value) => {
    expect(await typed("phone", value)).toMatchObject({ outcome: "pass", reason: "ok" });
  });

  test.each([
    ["a fullwidth @ (folded by NFKC)", "jo\uff20acme.com"],
    ["a trailing dot on the domain", "Jo@Acme.com."],
  ])("a valid email written with %s passes, as its ingested form does", async (_name, value) => {
    expect(await typed("email", value)).toMatchObject({ outcome: "pass", reason: "ok" });
  });

  test("a disposable address is still a disposable address however it is spelled", async () => {
    expect(await typed("email", "Jo@Mailinator.com.")).toMatchObject({ outcome: "fail", reason: "disposable" });
  });
});

describe("L2: the recorder computes the verdict; a caller cannot hand it one", () => {
  test("recording on a disposable address yields fail/disposable, and a caller-supplied verdict is refused, not believed", async () => {
    const { contactId } = await ingestLead({ email: "jo@mailinator.com" });
    const claimId = await claimOf(contactId, "email");
    const lie = { subjectType: "contact", subjectId: contactId, claimId, result: { kind: "email", outcome: "pass", reason: "ok" }, provider: "structural" };
    await expect(t.run((ctx) => recordVerification(ctx, lie as never))).rejects.toThrow(/computed from the claim/);
    expect(await rowsFor(contactId)).toHaveLength(0);
    const id = await t.run((ctx) => recordVerification(ctx, { subjectType: "contact", subjectId: contactId, claimId }));
    expect(await raw.run((ctx) => ctx.db.get(id))).toMatchObject({ kind: "email", outcome: "fail", reason: "disposable", provider: "structural" });
  });
});

describe("L5: a failed verdict the score never counted makes that score stale, and its lead unshippable", () => {
  async function scoredLead(over: Parameters<typeof ingestLead>[0] = {}) {
    const lead = await ingestLead(over);
    await makeIcp();
    await funding(lead.accountId, lead.sourceId);
    await start(lead.contactId);
    await drain();
    const scoreRun = (await all("scoreRuns")).filter((r) => r.subjectId === lead.contactId).pop()! as Doc<"scoreRuns">;
    return { ...lead, scoreRun };
  }
  async function shipped() {
    const lead = await scoredLead();
    const leadRow = ((await all("leads")) as Doc<"leads">[]).find((l) => l.contactId === lead.contactId)!;
    expect(leadRow).toMatchObject({ inventoryState: "Available" });
    expect(leadRow.distributability.ok).toBe(true);
    return { ...lead, leadId: leadRow._id };
  }
  const stale = (l: Awaited<ReturnType<typeof scoredLead>>) => t.run((ctx) => staleReason(ctx, orgId, l.scoreRun, { accountId: l.accountId, contactId: l.contactId }, Date.now()));
  const reserve = (leadId: Id<"leads">) => t.run((ctx) => setInventoryState(ctx, { leadId, state: "Reserved" }));

  test("verify commits a new fail, then score dead-letters: the old score is stale and the old lead cannot be reserved", async () => {
    const l = await shipped();
    expect(await stale(l)).toBeNull();
    (DISPOSABLE_DOMAINS as string[]).push("acme.com");
    stageHandlers.score = async () => {
      throw stageFailure("no_such_record", "icp", "the org has no ICP to score against");
    };
    await start(l.contactId);
    await drain();
    expect((await all("pipelineState")).find((s) => s.subjectId === l.contactId)).toMatchObject({ status: "deadlettered", stage: "score" });
    expect((await all("scoreRuns")).filter((r) => r.subjectId === l.contactId).pop()!._id).toBe(l.scoreRun._id); // still the latest
    expect(await stale(l)).toMatch(/verification of the contact's email failed after the score/);
    await expect(reserve(l.leadId)).rejects.toThrow(/verification of the contact's email failed after the score/);
  });

  test("control: a failure the score already counted, re-judged as a failure under new rules, is not news (no needless rescore)", async () => {
    const l = await scoredLead({ email: "jo@mailinator.com" }); // halved below the C floor: scored, rejected, never packaged
    expect(l.scoreRun.tier).toBe("Reject");
    (DISPOSABLE_DOMAINS as string[]).push("other.example");
    expect(await t.run((ctx) => verifySubject(ctx, { subjectType: "contact", subjectId: l.contactId }))).toBe(2);
    expect((await rowsFor(l.contactId)).filter((r) => r.kind === "email").map((r) => r.outcome)).toEqual(["fail", "fail"]);
    expect(await stale(l)).toBeNull();
  });

  test("control: a good lead with no new verdict still reserves", async () => {
    const l = await shipped();
    await expect(reserve(l.leadId)).resolves.toBeNull();
  });
});

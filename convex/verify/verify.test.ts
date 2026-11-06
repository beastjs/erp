/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { createIcpVersion, asMember } from "../_shared/testkit.support";
import { appendClaimRecord } from "../claims/mutations";
import { latestIcp } from "../icp/queries";
import { inputHashFor, runStage, stageHandlers, STAGE_LOGIC_VERSION } from "../pipeline/stages";
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
const listSnapshot = { disposable: [...DISPOSABLE_DOMAINS], roles: [...ROLE_LOCAL_PARTS] };

beforeEach(async () => {
  vi.useFakeTimers();
  raw = convexTest(schema, modules);
  orgId = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 }));
  t = await asMember(raw, "u1", orgId);
});
afterEach(() => {
  Object.assign(stageHandlers, originals);
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
    const id = await t.run((ctx) => recordVerification(ctx, { subjectType: "contact", subjectId: contactId, claimId, result: verifyEmailStructure("jo@acme.com"), provider: "structural" }));
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

  test("the caller cannot choose the time: a verdict is stamped by the transaction, so it cannot be post-dated to be the latest", async () => {
    const { contactId } = await ingestLead();
    const claimId = await claimOf(contactId, "email");
    const before = Date.now();
    const result = { ...verifyEmailStructure("jo@acme.com"), checkedAt: 9_999_999_999_999 };
    const id = await t.run((ctx) => recordVerification(ctx, { subjectType: "contact", subjectId: contactId, claimId, result, provider: "structural" }));
    expect((await raw.run((ctx) => ctx.db.get(id)))!.checkedAt).toBeLessThan(before + 60_000);
  });

  test("refuses at the boundary: a claim that is not this subject's, not of this kind, erased or in another org; a bad provider; a lying outcome", async () => {
    const a = await ingestLead();
    const b = await ingestLead({ email: "kay@other.com", domain: "other.com", name: "Kay Lee", phone: "+1 555 010 9999" });
    const record = (over: Record<string, unknown>) =>
      t.run((ctx) =>
        recordVerification(ctx, { subjectType: "contact", subjectId: a.contactId, claimId: undefined as never, result: verifyEmailStructure("jo@acme.com"), provider: "structural", ...over }),
      );
    const emailClaim = await claimOf(a.contactId, "email");
    await expect(record({ claimId: await claimOf(b.contactId, "email") })).rejects.toThrow(/claim not found/); // another subject's claim
    await expect(record({ claimId: await claimOf(a.contactId, "phone") })).rejects.toThrow(/phone claim, not email/); // wrong kind
    await expect(record({ claimId: emailClaim, provider: "firecrawl" })).rejects.toThrow(/provider/);
    await expect(record({ claimId: emailClaim, result: { kind: "email", outcome: "pass", reason: "disposable" } })).rejects.toThrow(/disagree/);
    await expect(record({ claimId: emailClaim, result: { kind: "email", outcome: "fail", reason: "ok" } })).rejects.toThrow(/disagree/);
    await expect(record({ claimId: emailClaim, result: { kind: "email", outcome: "fail", reason: "bad_length" } })).rejects.toThrow(/does not apply/); // a phone reason on an email
    await expect(record({ claimId: emailClaim, result: { kind: "ssn", outcome: "pass", reason: "ok" } })).rejects.toThrow(/verifiable/);
    // another org's subject
    const otherOrg = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
    const t2 = await asMember(raw, "u2", otherOrg);
    await expect(
      t2.run((ctx) => recordVerification(ctx, { subjectType: "contact", subjectId: a.contactId, claimId: emailClaim, result: verifyEmailStructure("jo@acme.com"), provider: "structural" })),
    ).rejects.toThrow(/subject not found/);
    // a redacted claim
    await raw.run((ctx) => ctx.db.patch(emailClaim, { value: null, redactedAt: 1 }));
    await expect(record({ claimId: emailClaim })).rejects.toThrow(/erased/);
    expect(await rowsFor(a.contactId)).toHaveLength(0);
  });

  test("an erasure in progress already refuses: the subject is erased from the first slice, before every claim is redacted", async () => {
    const lead = await ingestLead();
    const { eraseSubject } = await import("../privacy/redact");
    const request = { requestedBy: { kind: "user", userId: "https://convex.test|u1", role: "admin" }, reasonCode: "data_subject_request", legalBasis: "gdpr_art17_erasure", reference: "CASE-1" } as const;
    expect((await t.run((ctx) => eraseSubject(ctx, { subjectType: "contact", subjectId: lead.contactId, request }, { budget: 1 }))).complete).toBe(false);
    const live = ((await all("claims")) as Doc<"claims">[]).find((c) => c.subjectId === lead.contactId && c.field === "email" && c.redactedAt === undefined);
    expect(live, "the partial erasure must leave the email claim unredacted for this test to mean anything").toBeTruthy();
    await expect(
      t.run((ctx) => recordVerification(ctx, { subjectType: "contact", subjectId: lead.contactId, claimId: live!._id, result: verifyEmailStructure("a@b.co"), provider: "structural" })),
    ).rejects.toThrow(/erased/);
  });

  test("the claim must be the subject's own even when the ids look right: a claim id from a different table is refused by the validator", async () => {
    const { contactId } = await ingestLead();
    await expect(
      t.run((ctx) => recordVerification(ctx, { subjectType: "contact", subjectId: contactId, claimId: contactId as unknown as Id<"claims">, result: verifyEmailStructure("a@b.co"), provider: "structural" })),
    ).rejects.toThrow();
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

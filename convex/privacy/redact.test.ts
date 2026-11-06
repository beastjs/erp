/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { appendClaimRecord } from "../claims/mutations";
import { createIcpVersion } from "../icp/mutations";
import { latestIcp } from "../icp/queries";
import { packageLead, setDisposition, setInventoryState } from "../leads/mutations";
import { applyClaimToProjection, rebuildProjection } from "../projections/build";
import schema from "../schema";
import { insertCandidate } from "../sources/mutations";
import { ingestCandidate } from "../sources/ingest";
import { appendSignal } from "../signals/mutations";
import { markScoreStale } from "../pipeline/stages";
import { enqueueSubject } from "../pipeline/stages";
import { resumeDeadLettered } from "../pipeline/deadletter";
import crons from "../crons";
import { ERASE_STALL_MS, eraseSubject, erasureRetryDelay } from "./redact";
import { addSuppression, isSuppressed } from "./suppress";

const modules = import.meta.glob("/convex/**/*.ts");
const DAY = 24 * 60 * 60 * 1000;
const criteria = { industries: ["software"], geographies: [], technologies: [], decisionMakerRoles: [] };

let raw: ReturnType<typeof convexTest>;
let t: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
let orgId: Id<"orgs">;
beforeEach(async () => {
  vi.useFakeTimers();
  raw = convexTest(schema, modules);
  orgId = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 }));
  t = raw.withIdentity({ subject: "u1", orgId });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Strings that identify the PERSON and nothing the company shares. After erasure none may appear in any table. */
const PII = ["bobby", "tables", "bob.tables", "5550104242", "bobby-tables"];
const person = {
  fullName: "Bobby Tables",
  firstName: "Bobby",
  lastName: "Tables",
  email: "Bob.Tables@Acme.com",
  phone: "+1 555 010 4242",
  profileUrl: "https://www.linkedin.com/in/bobby-tables",
  jobTitle: "CTO",
};
const company = { name: "Acme", domain: "acme.com", industry: "Software" };
const drain = () => raw.finishAllScheduledFunctions(vi.runAllTimers);
const dump = (table: string): Promise<any[]> => raw.run((ctx) => ctx.db.query(table as "claims").collect());

/** Every table that holds a PII string. Reads the whole schema, so a table added later is swept too. */
async function tablesHolding(needles: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const table of Object.keys(schema.tables)) {
    const text = JSON.stringify(await dump(table)).toLowerCase();
    if (needles.some((n) => text.includes(n))) out.push(table);
  }
  return out.sort();
}

/** A subject's claims, read without an index: the test must not share a code path with the code under test. */
const claimsOf = async (subjectType: "contact" | "account", subjectId: string): Promise<Doc<"claims">[]> =>
  ((await dump("claims")) as Doc<"claims">[]).filter((c) => c.orgId === orgId && c.subjectType === subjectType && c.subjectId === subjectId);

type World = { contactId: Id<"contacts">; accountId: Id<"accounts">; sourceId: Id<"sources">; leadId: Id<"leads"> | null };

/** A candidate through the real ingest path, a signal on each subject, and (when `pipeline`) the real chain to a packaged lead. */
async function world(over: { pipeline?: boolean; person?: typeof person; company?: typeof company } = {}): Promise<World> {
  await t.mutation(api.sources.import.addManualLead, {
    candidate: { person: over.person ?? person, company: over.company ?? company, acquisition: { acquiredAt: Date.now() - DAY, campaign: "spring" } },
  });
  const contacts = await raw.run((ctx) => ctx.db.query("contacts").collect());
  const contact = contacts[contacts.length - 1]!;
  const accountId = contact.fields.find((f: { field: string }) => f.field === "accountId")!.value as Id<"accounts">;
  const sourceId = (await raw.run((ctx) => ctx.db.query("claims").first()))!.sourceId;
  await t.mutation(api.signals.mutations.recordSignals, {
    signals: [
      { subjectType: "contact", subjectId: contact._id, kind: "job_change", strength: "medium", confidence: 0.8, observedAt: Date.now() - DAY, sourceId, externalId: "linkedin:evt:bobby-tables-77" },
      { subjectType: "account", subjectId: accountId, kind: "funding", strength: "high", confidence: 1, observedAt: Date.now() - DAY, sourceId, externalId: "round-a" },
    ],
  });
  let leadId: Id<"leads"> | null = null;
  if (over.pipeline) {
    await t.run(async (ctx) => (await latestIcp(ctx, {}))?._id ?? (await createIcpVersion(ctx, { name: "ICP", criteria })));
    await t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: contact._id });
    await drain();
    leadId = (await raw.run((ctx) => ctx.db.query("leads").first()))?._id ?? null;
  }
  return { contactId: contact._id, accountId, sourceId, leadId };
}

const erase = (subjectType: "contact" | "account", subjectId: string, opts?: { budget?: number }) => t.run((ctx) => eraseSubject(ctx, { subjectType, subjectId }, opts));
const lead = (id: Id<"leads">) => raw.run((ctx) => ctx.db.get(id)) as Promise<Doc<"leads">>;

describe("claims: redaction, not deletion", () => {
  test("values are overwritten and stamped; source, method, confidence, observedAt, field and the row itself survive", async () => {
    const w = await world();
    const before = await claimsOf("contact", w.contactId);
    expect(before.length).toBeGreaterThan(5);
    expect(before.some((c) => c.value === "bob.tables@acme.com")).toBe(true);

    const res = await erase("contact", w.contactId);
    expect(res.complete).toBe(true);
    expect(res.claimsRedacted).toBe(before.length);

    const after = await claimsOf("contact", w.contactId);
    expect(after.map((c) => c._id).sort()).toEqual(before.map((c) => c._id).sort()); // nothing deleted
    for (const a of after) {
      const b = before.find((c) => c._id === a._id)!;
      expect(a.value).toBeNull();
      expect(typeof a.redactedAt).toBe("number");
      expect({ ...a, value: b.value, redactedAt: undefined }).toEqual({ ...b, redactedAt: undefined }); // every other column identical
    }
  });

  test("outside erasure nothing touches a claim: the whole pipeline, delivery and acceptance leave every existing claim byte-identical", async () => {
    // The runtime half of the claims append-only guard (redact.guard.test.ts): a lexical net can be aliased past, this cannot.
    const w = await world();
    const before = JSON.stringify(await claimsOf("contact", w.contactId));
    expect(JSON.parse(before).length).toBeGreaterThan(5);
    await t.run(async (ctx) => (await latestIcp(ctx, {}))?._id ?? (await createIcpVersion(ctx, { name: "ICP", criteria })));
    await t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: w.contactId });
    await drain();
    const leadId = (await raw.run((ctx) => ctx.db.query("leads").first()))!._id;
    await t.run((ctx) => setInventoryState(ctx, { leadId, state: "Delivered" }));
    await t.run((ctx) => setDisposition(ctx, { leadId, disposition: "Delivered" }));
    await t.run((ctx) => setDisposition(ctx, { leadId, disposition: "Accepted" }));
    const after = (await claimsOf("contact", w.contactId)).filter((c) => JSON.parse(before).some((b: Doc<"claims">) => b._id === c._id));
    expect(JSON.stringify(after)).toBe(before);
  });

  test("the account's claims are untouched when a contact is erased", async () => {
    const w = await world();
    await erase("contact", w.contactId);
    const acct = await claimsOf("account", w.accountId);
    expect(acct.length).toBeGreaterThan(0);
    expect(acct.every((c) => c.redactedAt === undefined && c.value !== null)).toBe(true);
  });

  test("an erased subject takes no new claims or signals", async () => {
    const w = await world();
    await erase("contact", w.contactId);
    await expect(
      t.run((ctx) => appendClaimRecord(ctx, { subjectType: "contact", subjectId: w.contactId, field: "email", value: "bob.tables@acme.com", sourceId: w.sourceId, method: "observed", confidence: 1, observedAt: 1 })),
    ).rejects.toThrow(/erased/);
    await expect(
      t.run((ctx) => appendSignal(ctx, { subjectType: "contact", subjectId: w.contactId, kind: "x", strength: "low", confidence: 1, observedAt: 1 })),
    ).rejects.toThrow(/erased/);
  });
});

describe("§3.5: projections are a pure function of the claims, after erasure too", () => {
  test("the projection is empty after erasure", async () => {
    const w = await world();
    expect((await raw.run((ctx) => ctx.db.get(w.contactId)))!.fields.length).toBeGreaterThan(3);
    await erase("contact", w.contactId);
    expect(await raw.run((ctx) => ctx.db.get(w.contactId))).toMatchObject({ fields: [], display: {} });
  });

  test("rebuild and incremental application agree after erasure, and do so from the REDACTED CLAIMS alone", async () => {
    const w = await world();
    await erase("contact", w.contactId);
    const read = async () => {
      const row = (await raw.run((ctx) => ctx.db.get(w.contactId)))!;
      return { fields: row.fields, display: row.display };
    };
    const erased = await read();
    // Take the tombstone away, so the ONLY thing that can keep the projection empty is the claims themselves.
    await raw.run(async (ctx) => {
      for (const e of await ctx.db.query("erasures").collect()) await ctx.db.delete(e._id);
    });
    await t.run((ctx) => rebuildProjection(ctx, { subjectType: "contact", subjectId: w.contactId }));
    expect(await read()).toEqual(erased);
    const claims = await claimsOf("contact", w.contactId);
    for (const c of claims) {
      await t.run((ctx) => applyClaimToProjection(ctx, { subjectType: "contact", subjectId: w.contactId, claimId: c._id }));
      expect(await read()).toEqual(erased);
    }
  });

  test("a rebuild of a subject erased mid-way (tombstone present, claims only partly redacted) is still empty", async () => {
    const w = await world();
    const partial = await erase("contact", w.contactId, { budget: 2 });
    expect(partial.complete).toBe(false);
    await t.run((ctx) => rebuildProjection(ctx, { subjectType: "contact", subjectId: w.contactId }));
    expect(await raw.run((ctx) => ctx.db.get(w.contactId))).toMatchObject({ fields: [], display: {} });
  });
});

describe("leads.snapshot: the copy a customer receives", () => {
  test("an erased contact's snapshot side is redacted in place, provenance kept, account side intact", async () => {
    const w = await world({ pipeline: true });
    const l0 = await lead(w.leadId!);
    expect(JSON.stringify(l0.snapshot.contact).toLowerCase()).toContain("bob.tables@acme.com");

    const res = await erase("contact", w.contactId);
    expect(res.leadsRedacted).toBe(1);
    const l1 = await lead(w.leadId!);
    expect(l1.snapshot.contact.display).toEqual({});
    expect(l1.snapshot.contact.fields.length).toBe(l0.snapshot.contact.fields.length);
    for (const [i, f] of l1.snapshot.contact.fields.entries()) {
      expect(f.value).toBeNull();
      expect({ ...f, value: undefined }).toEqual({ ...l0.snapshot.contact.fields[i]!, value: undefined }); // field, claimId, method, confidence, observedAt
    }
    expect(l1.snapshot.account).toEqual(l0.snapshot.account);
    expect(typeof l1.contactErasedAt).toBe("number");
    expect(l1.accountErasedAt).toBeUndefined();
    // Everything else about the packaged lead is the record of packaging, untouched.
    const { snapshot: _s, contactErasedAt: _c, inventoryState: _i, disposition: _d, ...rest0 } = l0;
    const { snapshot: _s1, contactErasedAt: _c1, inventoryState: _i1, disposition: _d1, ...rest1 } = l1;
    expect(rest1).toEqual(rest0);
  });

  test("a lead that has not reached a buyer is withdrawn from inventory; one already delivered keeps its history", async () => {
    const a = await world({ pipeline: true });
    expect(await lead(a.leadId!)).toMatchObject({ inventoryState: "Available", disposition: "ReadyForDistribution" });
    await erase("contact", a.contactId);
    expect(await lead(a.leadId!)).toMatchObject({ inventoryState: "Expired", disposition: "Closed" });

    const b = await world({ pipeline: true, person: { ...person, email: "carol.king@acme.com", fullName: "Carol King", firstName: "Carol", lastName: "King", phone: "+1 555 010 9999", profileUrl: "https://linkedin.com/in/carol-king" } });
    const bLead = (await raw.run((ctx) => ctx.db.query("leads").collect())).find((l) => l.contactId === b.contactId)!;
    await t.run((ctx) => setInventoryState(ctx, { leadId: bLead._id, state: "Delivered" }));
    await t.run((ctx) => setDisposition(ctx, { leadId: bLead._id, disposition: "Delivered" }));
    await erase("contact", b.contactId);
    const after = await lead(bLead._id);
    expect(after).toMatchObject({ inventoryState: "Delivered", disposition: "Delivered" });
    expect(after.snapshot.contact.display).toEqual({});
  });

  test("erasing the company redacts the account side of every lead at it, and withdraws them", async () => {
    const w = await world({ pipeline: true });
    const res = await erase("account", w.accountId);
    expect(res.complete).toBe(true);
    const l = await lead(w.leadId!);
    expect(l.snapshot.account.display).toEqual({});
    expect(l.snapshot.account.fields.every((f) => f.value === null)).toBe(true);
    expect(l.snapshot.contact.display.email).toBe("bob.tables@acme.com"); // the person was not erased
    expect(typeof l.accountErasedAt).toBe("number");
    expect(l.contactErasedAt).toBeUndefined();
    expect(l).toMatchObject({ inventoryState: "Expired", disposition: "Closed" });
  });

  test("an erased lead cannot be reserved, sold, delivered or released, and says why", async () => {
    const w = await world({ pipeline: true });
    await erase("contact", w.contactId);
    for (const state of ["Reserved", "Sold", "Delivered"] as const) {
      await expect(t.run((ctx) => setInventoryState(ctx, { leadId: w.leadId!, state }))).rejects.toThrow(/erased/);
    }
    for (const disposition of ["ReadyForDistribution", "Delivered"] as const) {
      await expect(t.run((ctx) => setDisposition(ctx, { leadId: w.leadId!, disposition }))).rejects.toThrow(/erased/);
    }
    for (const disposition of ["Accepted", "Converted"] as const) {
      await expect(t.run((ctx) => setDisposition(ctx, { leadId: w.leadId!, disposition }))).rejects.toThrow(/not been delivered/);
    }
    expect(await lead(w.leadId!)).toMatchObject({ inventoryState: "Expired", disposition: "Closed" });
  });

  test.each([
    ["contact", "Accepted"],
    ["contact", "Converted"],
    ["account", "Accepted"],
    ["account", "Converted"],
  ] as const)("a lead delivered BEFORE its %s was erased cannot be marked %s (ageing is exempt, erasure is not)", async (side, disposition) => {
    const w = await world({ pipeline: true });
    await t.run((ctx) => setInventoryState(ctx, { leadId: w.leadId!, state: "Delivered" }));
    await t.run((ctx) => setDisposition(ctx, { leadId: w.leadId!, disposition: "Delivered" }));
    await erase(side, side === "contact" ? w.contactId : w.accountId);
    await expect(t.run((ctx) => setDisposition(ctx, { leadId: w.leadId!, disposition }))).rejects.toThrow(/erased/);
    expect((await lead(w.leadId!)).disposition).toBe("Delivered");
  });

  test("ageing is still exempt for Accepted: a delivered, un-erased lead past its freshness window can be accepted", async () => {
    const w = await world({ pipeline: true });
    await t.run((ctx) => setInventoryState(ctx, { leadId: w.leadId!, state: "Delivered" }));
    await t.run((ctx) => setDisposition(ctx, { leadId: w.leadId!, disposition: "Delivered" }));
    vi.setSystemTime(Date.now() + 400 * DAY);
    await t.run((ctx) => setDisposition(ctx, { leadId: w.leadId!, disposition: "Accepted" }));
    expect((await lead(w.leadId!)).disposition).toBe("Accepted");
  });

  test("an erased subject cannot be packaged", async () => {
    const w = await world({ pipeline: true });
    const l = await lead(w.leadId!);
    await erase("contact", w.contactId);
    await expect(t.run((ctx) => packageLead(ctx, { accountId: w.accountId, contactId: w.contactId, scoreRunId: l.scoreRunId }))).rejects.toThrow(/erased/);
  });
});

describe("every store: nothing identifying the person survives", () => {
  test("a sweep of EVERY table finds the person's data before erasure and none after", async () => {
    const w = await world({ pipeline: true });
    // Non-vacuous: the data really is spread over these stores.
    const before = await tablesHolding(PII);
    for (const table of ["candidates", "claims", "contactKeys", "contacts", "leads"]) expect(before, table).toContain(table);

    await erase("contact", w.contactId);
    expect(await tablesHolding(PII)).toEqual([]);
  });

  test("contactKeys: the erased contact's keys are deleted, so it cannot be re-found", async () => {
    const w = await world();
    const keys = await raw.run((ctx) => ctx.db.query("contactKeys").collect());
    expect(keys.filter((k) => k.contactId === w.contactId).length).toBeGreaterThanOrEqual(3);
    const res = await erase("contact", w.contactId);
    expect(res.contactKeysDeleted).toBe(keys.filter((k) => k.contactId === w.contactId).length);
    expect((await raw.run((ctx) => ctx.db.query("contactKeys").collect())).filter((k) => k.contactId === w.contactId)).toEqual([]);
  });

  test("candidates: the consumed payload is nulled and its dedupeHash (the email in plain text) is cleared", async () => {
    const w = await world();
    const before = (await raw.run((ctx) => ctx.db.query("candidates").collect()))[0]!;
    expect(before.dedupeHash).toBe("email:bob.tables@acme.com");
    expect(before.contactId).toBe(w.contactId);
    const res = await erase("contact", w.contactId);
    expect(res.candidatesRedacted).toBe(1);
    const after = (await raw.run((ctx) => ctx.db.get(before._id)))!;
    expect(after).toMatchObject({ candidate: null, dedupeHash: "redacted", status: "consumed", sourceId: before.sourceId });
    expect(typeof after.redactedAt).toBe("number");
  });

  test("candidates: a PENDING candidate for the same email, never ingested, is redacted and rejected too", async () => {
    const w = await world();
    const pending = await t.run((ctx) =>
      insertCandidate(ctx, { candidate: { person: { email: "BOB.TABLES+x@acme.com", fullName: "Robert Tables" }, acquisition: { acquiredAt: 5 } }, sourceId: w.sourceId }),
    );
    expect(pending).not.toBeNull();
    await erase("contact", w.contactId);
    expect(await raw.run((ctx) => ctx.db.get(pending!))).toMatchObject({ candidate: null, dedupeHash: "redacted", status: "rejected", rejectionReason: "erased" });
    expect(await tablesHolding(["robert", ...PII])).toEqual([]);
  });

  test.each([
    ["phone", { phone: "+1 555 010 4242", fullName: "B Tables" }],
    ["profile", { profileUrl: "https://www.linkedin.com/in/bobby-tables/", fullName: "B Tables" }],
  ] as const)("candidates: a PENDING candidate keyed by %s (no email, any company domain) is redacted and rejected by erasure itself", async (_kind, p) => {
    const w = await world();
    const pending = await t.run((ctx) =>
      insertCandidate(ctx, { candidate: { person: p, company: { name: "Other", domain: "other.example" }, acquisition: { acquiredAt: 5 } }, sourceId: w.sourceId }),
    );
    expect(pending).not.toBeNull();
    expect((await raw.run((ctx) => ctx.db.get(pending!)))!.dedupeHash).toMatch(/^domain:other\.example\|(phone|profile):/);
    const res = await erase("contact", w.contactId);
    expect(res.candidatesRedacted).toBe(2);
    expect(await raw.run((ctx) => ctx.db.get(pending!))).toMatchObject({ candidate: null, dedupeHash: "redacted", status: "rejected", rejectionReason: "erased" });
    expect(await tablesHolding(["b tables", ...PII])).toEqual([]);
  });

  test("candidates: a pending candidate keyed by a DIFFERENT person key but carrying the erased phone is destroyed when ingest meets it", async () => {
    const w = await world();
    // Keyed by its own email, so the sweep by the erased contact's identifiers does not reach it: the ingest backstop does.
    const pending = await t.run((ctx) =>
      insertCandidate(ctx, { candidate: { person: { email: "other.person@elsewhere.example", phone: "+1 555 010 4242" }, company, acquisition: { acquiredAt: 5 } }, sourceId: w.sourceId }),
    );
    await erase("contact", w.contactId);
    expect((await raw.run((ctx) => ctx.db.get(pending!)))!.status).toBe("pending");
    const res = await t.run((ctx) => ingestCandidate(ctx, orgId, pending!));
    expect(res).toEqual({ outcome: "rejected", reason: "suppressed" });
    expect(await raw.run((ctx) => ctx.db.get(pending!))).toMatchObject({ candidate: null, dedupeHash: "redacted", status: "rejected" });
    expect(await tablesHolding(PII)).toEqual([]);
  });

  test("signals: externalId is cleared and the event metadata is kept", async () => {
    const w = await world();
    const before = (await raw.run((ctx) => ctx.db.query("signals").collect())).find((s) => s.subjectId === w.contactId)!;
    expect(before.externalId).toContain("bobby");
    const res = await erase("contact", w.contactId);
    expect(res.signalsRedacted).toBe(1);
    const after = (await raw.run((ctx) => ctx.db.get(before._id)))!;
    expect(after.externalId).toBeUndefined();
    expect(typeof after.redactedAt).toBe("number");
    const { externalId: _e, redactedAt: _r, ...kept } = after;
    const { externalId: _e0, ...keptBefore } = before;
    expect(kept).toEqual(keptBefore);
    // The company's signal is not the person's: untouched.
    const acct = (await raw.run((ctx) => ctx.db.query("signals").collect())).find((s) => s.subjectId === w.accountId)!;
    expect(acct).toMatchObject({ externalId: "round-a" });
    expect(acct.redactedAt).toBeUndefined();
  });
});

describe("pipelineState: an erased subject is stopped, not dead-lettered", () => {
  test("a finished, an active and a dead-lettered subject all end done/erased with their error text cleared", async () => {
    const w = await world({ pipeline: true });
    const stateOf = () => raw.run((ctx) => ctx.db.query("pipelineState").first()) as Promise<Doc<"pipelineState">>;
    expect((await stateOf()).status).toBe("done");
    // Make it look dead-lettered, with an error message that quotes the person.
    await raw.run(async (ctx) => {
      const s = (await ctx.db.query("pipelineState").first())!;
      await ctx.db.patch(s._id, {
        status: "deadlettered",
        deadReasonCode: "unexpected_error",
        deadLetteredAt: 1,
        lastError: { stage: "score", reasonCode: "unexpected_error", attempt: 5, message: "bad row for bob.tables@acme.com", at: 1 },
      });
    });
    await erase("contact", w.contactId);
    const s = await stateOf();
    expect(s).toMatchObject({ status: "done", finishedReason: "erased", inputHashes: {} });
    expect(s.lastError).toBeUndefined();
    expect(s.deadReasonCode).toBeUndefined();
    expect(await t.run((ctx) => import("../pipeline/deadletter").then((m) => m.deadLetterQueue(ctx)))).toEqual([]);
    expect(await tablesHolding(PII)).toEqual([]);
  });

  test("nothing restarts it: enqueue, resume and an account-level fan-out all leave it stopped", async () => {
    const w = await world({ pipeline: true });
    await erase("contact", w.contactId);
    await expect(t.run((ctx) => enqueueSubject(ctx, { subjectType: "contact", subjectId: w.contactId }))).rejects.toThrow(/erased/);
    await expect(t.run((ctx) => resumeDeadLettered(ctx, { subjectType: "contact", subjectId: w.contactId }))).rejects.toThrow(/erased/);
    await expect(t.run((ctx) => resumeDeadLettered(ctx, { subjectType: "contact", subjectId: w.contactId, fromStage: "ingest" }))).rejects.toThrow(/erased/);
    // New evidence about the account fans out to every contact pipeline at it.
    await t.run((ctx) => appendSignal(ctx, { subjectType: "account", subjectId: w.accountId, kind: "hiring", strength: "high", confidence: 1, observedAt: Date.now() - DAY }));
    await drain();
    await t.run((ctx) => markScoreStale(ctx, { subjectType: "account", subjectId: w.accountId }));
    await drain();
    const s = (await raw.run((ctx) => ctx.db.query("pipelineState").first()))!;
    expect(s).toMatchObject({ status: "done", finishedReason: "erased" });
  });
});

describe("suppression: erased means kept out", () => {
  test("every identifier the contact carried is suppressed, in any spelling", async () => {
    const w = await world();
    const res = await erase("contact", w.contactId);
    expect(res.suppressionsAdded).toBe(3); // email, phone, profile; NOT the company domain, NOT a name
    for (const [identifier, kind] of [
      ["bob.tables@acme.com", "email"],
      [" BOB.TABLES+news@Acme.com", "email"],
      ["+1 (555) 010-4242", "phone"],
      ["https://linkedin.com/in/Bobby-Tables/", "profile"],
    ] as const) {
      expect(await t.run((ctx) => isSuppressed(ctx, { identifier, kind })), identifier).toBe(true);
    }
    expect(await t.run((ctx) => isSuppressed(ctx, { identifier: "acme.com", kind: "domain" }))).toBe(false);
  });

  test("re-importing an erased contact inserts nothing (spec 7.3), however it is spelled", async () => {
    const w = await world();
    await erase("contact", w.contactId);
    const counts = async () => ({ candidates: (await dump("candidates")).length, contacts: (await dump("contacts")).length, keys: (await dump("contactKeys")).length, claims: (await dump("claims")).length });
    const before = await counts();

    for (const p of [
      { email: "bob.tables@acme.com", fullName: "Bobby Tables" },
      { email: "BOB.TABLES+promo@ACME.com", fullName: "Someone Else" },
      { phone: " +1 555-010-4242 ", fullName: "B. Tables" },
      { profileUrl: "linkedin.com/in/bobby-tables?utm=x", fullName: "Bobby T" },
    ]) {
      const res = await t.mutation(api.sources.import.submitCandidates, {
        sourceId: w.sourceId,
        contractVersion: "1.0.0",
        candidates: [{ person: p, company, acquisition: { acquiredAt: Date.now() } }],
      });
      expect(res).toMatchObject({ inserted: 0, duplicates: 0, candidateIds: [] });
      expect(res.rejected).toHaveLength(1);
      expect(JSON.stringify(res.rejected)).toMatch(/suppressed/);
      expect(JSON.stringify(res.rejected).toLowerCase()).not.toContain("bob");
    }
    await expect(
      t.mutation(api.sources.import.addManualLead, { candidate: { person: { email: "bob.tables@acme.com", fullName: "Bobby Tables" }, company, acquisition: { acquiredAt: Date.now() } } }),
    ).rejects.toThrow(/suppressed/);
    expect(await counts()).toEqual(before);
    expect(await tablesHolding(PII)).toEqual([]);
  });

  test("a stranger at the same company is still welcome", async () => {
    const w = await world();
    await erase("contact", w.contactId);
    const res = await t.mutation(api.sources.import.submitCandidates, {
      sourceId: w.sourceId,
      contractVersion: "1.0.0",
      candidates: [{ person: { email: "dana@acme.com", fullName: "Dana Scully" }, company, acquisition: { acquiredAt: Date.now() } }],
    });
    expect(res.inserted).toBe(1);
  });

  test("erasing a company suppresses its domain, so nobody at it re-enters", async () => {
    const w = await world();
    const res = await erase("account", w.accountId);
    expect(res.complete).toBe(true);
    expect(await t.run((ctx) => isSuppressed(ctx, { identifier: "acme.com", kind: "domain" }))).toBe(true);
    const out = await t.mutation(api.sources.import.submitCandidates, {
      sourceId: w.sourceId,
      contractVersion: "1.0.0",
      candidates: [{ person: { email: "dana@acme.com", fullName: "Dana Scully" }, acquisition: { acquiredAt: Date.now() } }, { company, acquisition: { acquiredAt: Date.now() } }],
    });
    expect(out.inserted).toBe(0);
    expect(out.rejected).toHaveLength(2);
    expect(await raw.run((ctx) => ctx.db.get(w.accountId))).toMatchObject({ fields: [], display: {} });
  });

  test("the list is per org: another org's copy of the same person is untouched", async () => {
    const w = await world();
    const other = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
    const o = raw.withIdentity({ subject: "u2", orgId: other });
    await o.mutation(api.sources.import.addManualLead, { candidate: { person, company, acquisition: { acquiredAt: Date.now() - DAY } } });
    await erase("contact", w.contactId);
    const theirs = (await raw.run((ctx) => ctx.db.query("contacts").collect())).find((c) => c.orgId === other)!;
    expect(theirs.fields.length).toBeGreaterThan(3);
    expect((await raw.run((ctx) => ctx.db.query("claims").collect())).filter((c) => c.orgId === other).every((c) => c.redactedAt === undefined)).toBe(true);
    expect(await o.run((ctx) => isSuppressed(ctx, { identifier: "bob.tables@acme.com" }))).toBe(false);
    await expect(o.run((ctx) => eraseSubject(ctx, { subjectType: "contact", subjectId: w.contactId }))).rejects.toThrow("subject not found");
  });
});

describe("fail closed", () => {
  test("with no salt, erasure refuses BEFORE changing anything", async () => {
    const w = await world();
    vi.stubEnv("SUPPRESSION_SALT", "");
    await expect(erase("contact", w.contactId)).rejects.toThrow(/not configured/);
    expect(await dump("erasures")).toEqual([]);
    expect(((await dump("claims")) as Doc<"claims">[]).every((c) => c.redactedAt === undefined)).toBe(true);
    expect((await raw.run((ctx) => ctx.db.get(w.contactId)))!.fields.length).toBeGreaterThan(3);
  });

  test("with no salt, candidates cannot be inserted either: nothing slips past an unanswerable list", async () => {
    const w = await world();
    vi.stubEnv("SUPPRESSION_SALT", "");
    await expect(
      t.mutation(api.sources.import.submitCandidates, { sourceId: w.sourceId, contractVersion: "1.0.0", candidates: [{ person: { email: "new@x.com", fullName: "New Person" }, company, acquisition: { acquiredAt: 1 } }] }),
    ).rejects.toThrow(/not configured/);
  });

  test("an unknown or foreign subject is refused", async () => {
    await world();
    await expect(erase("contact", "nope")).rejects.toThrow("subject not found");
    await expect(erase("account", (await raw.run((ctx) => ctx.db.query("contacts").first()))!._id)).rejects.toThrow("subject not found");
  });
});

describe("idempotent and resumable", () => {
  test("erasing twice changes nothing the second time", async () => {
    const w = await world({ pipeline: true });
    const first = await erase("contact", w.contactId);
    const snapshot = JSON.stringify([await dump("claims"), await dump("leads"), await dump("suppressions"), await dump("erasures")]);
    const second = await erase("contact", w.contactId);
    expect(second).toEqual({ ...first, snapshotRefs: [] });
    expect(JSON.stringify([await dump("claims"), await dump("leads"), await dump("suppressions"), await dump("erasures")])).toBe(snapshot);
    expect(await dump("erasures")).toHaveLength(1);
  });

  test.each([1, 2, 3, 7, 50])("with a budget of %i documents per call it still finishes, and ends exactly where one big call would", async (budget) => {
    const small = await world({ pipeline: true });
    const claimCount = (await claimsOf("contact", small.contactId)).length;
    expect(claimCount).toBe(9);
    let calls = 0;
    let res = await erase("contact", small.contactId, { budget });
    while (!res.complete) {
      calls++;
      expect(calls).toBeLessThan(200);
      res = await erase("contact", small.contactId, { budget });
    }
    expect(await tablesHolding(PII)).toEqual([]);
    expect(res).toMatchObject({ claimsRedacted: claimCount, contactKeysDeleted: 4, candidatesRedacted: 1, signalsRedacted: 1, leadsRedacted: 1, suppressionsAdded: 3 });
    expect(await t.run((ctx) => isSuppressed(ctx, { identifier: "bob.tables@acme.com" }))).toBe(true);
    expect(await raw.run((ctx) => ctx.db.get(small.contactId))).toMatchObject({ fields: [], display: {} });
  });

  test("a partly erased subject is already inert", async () => {
    const w = await world();
    expect((await erase("contact", w.contactId, { budget: 1 })).complete).toBe(false);
    await expect(
      t.run((ctx) => appendClaimRecord(ctx, { subjectType: "contact", subjectId: w.contactId, field: "email", value: "x@y.com", sourceId: w.sourceId, method: "observed", confidence: 1, observedAt: 1 })),
    ).rejects.toThrow(/erased/);
  });

  test("the internal runner carries an erasure through, with no identity, as the scheduler would", async () => {
    const w = await world({ pipeline: true });
    expect(await raw.mutation(internal.privacy.redact.runErasure, { orgId, subjectType: "contact", subjectId: w.contactId })).toEqual({ complete: true });
    await drain();
    expect(await tablesHolding(PII)).toEqual([]);
  });

  test("snapshot references on the redacted claims are handed back so the raw snapshots (R2) can be deleted", async () => {
    const w = await world();
    await raw.run(async (ctx) => {
      const c = (await ctx.db.query("claims").collect()).find((x) => x.subjectId === w.contactId)!;
      await ctx.db.patch(c._id, { snapshotRef: "r2://crawl/abc123" });
    });
    const res = await erase("contact", w.contactId);
    expect(res.snapshotRefs).toEqual(["r2://crawl/abc123"]);
  });
});

describe("liveness: a stalled erasure is DETECTED and resumed, not merely resumable", () => {
  const MIN = 60 * 1000;
  const erasureRows = () => dump("erasures") as Promise<Doc<"erasures">[]>;
  const tick = () => raw.mutation(internal.privacy.sweep.sweepStalledErasures, {});

  test("a cron is registered for the sweeper", () => {
    const jobs = (crons as unknown as { crons: Record<string, { name: string; schedule: unknown }> }).crons;
    expect(Object.keys(jobs)).toEqual(["resume stalled erasures"]);
    expect(jobs["resume stalled erasures"]).toMatchObject({ name: "privacy/sweep:sweepStalledErasures", schedule: { type: "interval", minutes: 5 } });
  });

  test("an erasure whose chain died is found by the sweep and finished; a fresh one is left alone", async () => {
    const w = await world({ pipeline: true });
    // One call, then nobody calls again: exactly the shape of a scheduled continuation that threw.
    expect((await erase("contact", w.contactId, { budget: 1 })).complete).toBe(false);
    expect((await erasureRows())[0]!.completedAt).toBeUndefined();
    expect((await erasureRows())[0]!.resumeAt).toEqual(expect.any(Number));
    expect(await tablesHolding(PII)).not.toEqual([]);

    // Inside the grace period the chain may simply be slow: the sweep must not pile a second runner onto it.
    await tick();
    await drain();
    expect((await erasureRows())[0]!.completedAt).toBeUndefined();
    expect(await tablesHolding(PII)).not.toEqual([]);

    vi.setSystemTime(Date.now() + ERASE_STALL_MS + MIN);
    await tick();
    await drain();
    const [done] = await erasureRows();
    expect(done!.completedAt).toEqual(expect.any(Number));
    expect([done!.resumeAt, done!.attempts, done!.lastError]).toEqual([undefined, undefined, undefined]);
    expect(await tablesHolding(PII)).toEqual([]);
    expect(await t.run((ctx) => isSuppressed(ctx, { identifier: "bob.tables@acme.com" }))).toBe(true);
  });

  test("a step that throws is recorded on the row, backs off, and is retried once the cause is gone", async () => {
    const w = await world({ pipeline: true });
    await erase("contact", w.contactId, { budget: 1 });
    vi.stubEnv("SUPPRESSION_SALT", ""); // the salt is gone between calls
    const res = await raw.mutation(internal.privacy.redact.runErasure, { orgId, subjectType: "contact", subjectId: w.contactId });
    expect(res).toEqual({ complete: false });
    const [failed] = await erasureRows();
    expect(failed!.completedAt).toBeUndefined();
    expect(failed).toMatchObject({ attempts: 1, lastError: expect.stringMatching(/salt/), failedAt: expect.any(Number) });
    expect(failed!.resumeAt).toBe(failed!.failedAt! + erasureRetryDelay(1));
    expect(erasureRetryDelay(2)).toBeGreaterThan(erasureRetryDelay(1)); // it backs off

    // Still failing: the sweep records another attempt and does not throw.
    vi.setSystemTime(Date.now() + erasureRetryDelay(1) + MIN);
    await tick();
    await drain();
    expect((await erasureRows())[0]!.completedAt).toBeUndefined();
    expect((await erasureRows())[0]!.attempts).toBe(2);

    vi.unstubAllEnvs();
    vi.setSystemTime(Date.now() + erasureRetryDelay(2) + MIN);
    await tick();
    await drain();
    const [fin] = await erasureRows();
    expect(fin!.completedAt).toEqual(expect.any(Number));
    expect([fin!.attempts, fin!.lastError, fin!.failedAt]).toEqual([undefined, undefined, undefined]);
    expect(await tablesHolding(PII)).toEqual([]);
  });

  test("one erasure that can never run does not stop the others: failures are isolated per row", async () => {
    const bad = await world({ person: { ...person, email: "gone@acme.com", phone: "+1 555 010 9999", profileUrl: "https://www.linkedin.com/in/gone", fullName: "Gone Person", firstName: "Gone", lastName: "Person" } });
    const good = await world();
    await erase("contact", bad.contactId, { budget: 1 });
    await erase("contact", good.contactId, { budget: 1 });
    await raw.run(async (ctx) => {
      // the subject vanishes: every future step for it throws "subject not found"
      for (const k of await ctx.db.query("contactKeys").collect()) if (k.contactId === bad.contactId) await ctx.db.delete(k._id);
      await ctx.db.delete(bad.contactId);
    });
    vi.setSystemTime(Date.now() + ERASE_STALL_MS + MIN);
    await tick();
    await drain();
    const rows = await erasureRows();
    expect(rows.find((r) => r.subjectId === good.contactId)!.completedAt).toEqual(expect.any(Number));
    const stuck = rows.find((r) => r.subjectId === bad.contactId)!;
    expect(stuck.completedAt).toBeUndefined();
    expect(stuck).toMatchObject({ attempts: 1, lastError: expect.stringMatching(/subject not found/) });
  });

  test("more stalled erasures than one pass handles are all picked up, none dropped", async () => {
    const { SWEEP_BATCH } = await import("./sweep");
    const ids: string[] = [];
    await raw.run(async (ctx) => {
      for (let i = 0; i < SWEEP_BATCH + 3; i++) {
        const contactId = await ctx.db.insert("contacts", { orgId, fields: [], display: {} });
        ids.push(contactId);
        await ctx.db.insert("erasures", { orgId, subjectType: "contact", subjectId: contactId, requestedAt: 0, resumeAt: 1, claimsRedacted: 0, contactKeysDeleted: 0, candidatesRedacted: 0, signalsRedacted: 0, leadsRedacted: 0, suppressionsAdded: 0 });
      }
    });
    await tick();
    await drain();
    const rows = await erasureRows();
    expect(rows).toHaveLength(SWEEP_BATCH + 3);
    expect(rows.every((r) => typeof r.completedAt === "number")).toBe(true);
  });
});

describe("snapshot references (R2): recorded durably, not handed to a caller that drops them", () => {
  test("the runner's references land in erasureSnapshotRefs, once each, against the erasure", async () => {
    const w = await world();
    await raw.run(async (ctx) => {
      const mine = (await ctx.db.query("claims").collect()).filter((c) => c.subjectId === w.contactId);
      await ctx.db.patch(mine[0]!._id, { snapshotRef: "r2://crawl/abc123" });
      await ctx.db.patch(mine[1]!._id, { snapshotRef: "r2://crawl/abc123" }); // shared
      await ctx.db.patch(mine[2]!._id, { snapshotRef: "r2://crawl/def456" });
    });
    // through the RUNNER, in small steps, as production does: the old runner returned only { complete }
    let res = await raw.mutation(internal.privacy.redact.runErasure, { orgId, subjectType: "contact", subjectId: w.contactId });
    expect(res.complete).toBe(true);
    const refs = (await dump("erasureSnapshotRefs")) as Doc<"erasureSnapshotRefs">[];
    const erasure = (await dump("erasures"))[0]!;
    expect(refs.map((r) => r.ref).sort()).toEqual(["r2://crawl/abc123", "r2://crawl/def456"]);
    expect(refs.every((r) => r.erasureId === erasure._id && r.orgId === orgId && r.deletedAt === undefined)).toBe(true);
    res = await raw.mutation(internal.privacy.redact.runErasure, { orgId, subjectType: "contact", subjectId: w.contactId });
    expect(await dump("erasureSnapshotRefs")).toHaveLength(2); // idempotent
  });

  test("references recorded across several small calls are all kept", async () => {
    const w = await world();
    await raw.run(async (ctx) => {
      const mine = (await ctx.db.query("claims").collect()).filter((c) => c.subjectId === w.contactId);
      for (const [i, c] of mine.entries()) await ctx.db.patch(c._id, { snapshotRef: `r2://crawl/${i}` });
    });
    let res = await erase("contact", w.contactId, { budget: 2 });
    while (!res.complete) res = await erase("contact", w.contactId, { budget: 2 });
    expect(await dump("erasureSnapshotRefs")).toHaveLength((await claimsOf("contact", w.contactId)).length);
  });
});

describe("a suppressed lead reaches no buyer-facing state by ANY route", () => {
  const INVENTORY = ["Reserved", "Sold", "Delivered"] as const;
  const DISPOSITIONS = ["ReadyForDistribution", "Delivered", "Accepted", "Converted"] as const;
  /** Every writer of the two lifecycle fields, tried against one lead. Each must refuse and write nothing. */
  async function everyRouteRefused(leadId: Id<"leads">) {
    const before = await lead(leadId);
    for (const state of INVENTORY) await expect(t.run((ctx) => setInventoryState(ctx, { leadId, state })), `inventory ${state}`).rejects.toThrow();
    for (const disposition of DISPOSITIONS) await expect(t.run((ctx) => setDisposition(ctx, { leadId, disposition })), `disposition ${disposition}`).rejects.toThrow();
    expect(await lead(leadId)).toEqual(before);
  }

  test("sanity: the same lead, not suppressed, can be reserved", async () => {
    const w = await world({ pipeline: true });
    await t.run((ctx) => setInventoryState(ctx, { leadId: w.leadId!, state: "Reserved" }));
    expect((await lead(w.leadId!)).inventoryState).toBe("Reserved");
  });

  test.each([
    ["the address, spelled differently", "BOB.TABLES+x@acme.com", "email"],
    ["the phone number", "+1 (555) 010-4242", "phone"],
    ["the profile URL", "https://linkedin.com/in/bobby-tables", "profile"],
    ["the address's domain", "acme.com", "domain"],
  ] as const)("suppressed AFTER packaging (%s): every route is refused", async (_name, identifier, kind) => {
    const w = await world({ pipeline: true });
    expect((await lead(w.leadId!)).disposition).toBe("ReadyForDistribution");
    await t.run((ctx) => addSuppression(ctx, { identifier, kind, reason: "opt_out" }));
    await everyRouteRefused(w.leadId!);
  });

  test("suppressed BEFORE packaging: the pipeline packages it Held, and every route is refused", async () => {
    const w = await world();
    await t.run((ctx) => addSuppression(ctx, { identifier: "bob.tables@acme.com", reason: "opt_out" }));
    await t.run(async (ctx) => (await latestIcp(ctx, {}))?._id ?? (await createIcpVersion(ctx, { name: "ICP", criteria })));
    await t.mutation(api.pipeline.stages.startPipeline, { subjectType: "contact", subjectId: w.contactId });
    await drain();
    const l = (await dump("leads"))[0] as Doc<"leads">;
    expect(l).toMatchObject({ disposition: "Held", distributability: { ok: false, suppressed: true, failed: ["duplicate_checked"] } });
    await everyRouteRefused(l._id);
  });

  test("with the salt gone the answer is an error, never 'not suppressed'", async () => {
    const w = await world({ pipeline: true });
    vi.stubEnv("SUPPRESSION_SALT", "");
    await expect(t.run((ctx) => setInventoryState(ctx, { leadId: w.leadId!, state: "Reserved" }))).rejects.toThrow(/not configured/);
    await expect(t.run((ctx) => setDisposition(ctx, { leadId: w.leadId!, disposition: "ReadyForDistribution" }))).rejects.toThrow(/not configured/);
    expect(await lead(w.leadId!)).toMatchObject({ inventoryState: "Available", disposition: "ReadyForDistribution" });
  });

  test("a lead already DELIVERED before the suppression keeps its buyer outcomes (the standing Task 12 ruling), and nothing else moves", async () => {
    const w = await world({ pipeline: true });
    await t.run((ctx) => setInventoryState(ctx, { leadId: w.leadId!, state: "Delivered" }));
    await t.run((ctx) => setDisposition(ctx, { leadId: w.leadId!, disposition: "Delivered" }));
    await t.run((ctx) => addSuppression(ctx, { identifier: "bob.tables@acme.com", reason: "opt_out" }));
    await t.run((ctx) => setDisposition(ctx, { leadId: w.leadId!, disposition: "Accepted" }));
    await expect(t.run((ctx) => setInventoryState(ctx, { leadId: w.leadId!, state: "Sold" }))).rejects.toThrow();
  });
});

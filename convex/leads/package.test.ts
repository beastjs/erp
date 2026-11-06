/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { appendClaimRecord } from "../claims/mutations";
import { DEFAULT_SCORING_MODEL } from "../icp/defaults";
import { createIcpVersion, createScoringModel } from "../icp/mutations";
import { latestIcp } from "../icp/queries";
import type { IcpCriteria } from "../icp/schema";
import { MAX_LINKS_SCANNED, linkIdentity, unlinkIdentity } from "../projections/identity";
import { rebuildProjection } from "../projections/build";
import { appendSignal } from "../signals/mutations";
import { scoreLead } from "../scoring/assemble";
import schema from "../schema";
import { packageLead, setDisposition, setInventoryState } from "./mutations";
import { getLead, leadsByDisposition } from "./queries";

const modules = import.meta.glob("/convex/**/*.ts");
const DAY = 24 * 60 * 60 * 1000;

const criteria: IcpCriteria = { industries: ["software"], geographies: [], technologies: [], decisionMakerRoles: [] };

let raw: ReturnType<typeof convexTest>;
let t: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
let orgId: Id<"orgs">;
beforeEach(async () => {
  raw = convexTest(schema, modules);
  orgId = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 }));
  t = raw.withIdentity({ subject: "u1", orgId });
});

type Seed = { accountId: Id<"accounts">; contactId: Id<"contacts">; sourceId: Id<"sources">; icpId: Id<"icpDefinitions"> };

/** A fully shippable subject: observed fields a day old, a registered email key, a strong signal. */
async function seed(opts: { industry?: string; withKey?: boolean; noEmployer?: boolean; org?: Id<"orgs">; observedAt?: number } = {}): Promise<Seed> {
  const org = opts.org ?? orgId;
  const tt = org === orgId ? t : raw.withIdentity({ subject: "u2", orgId: org });
  return await tt.run(async (ctx) => {
    const sourceId = await ctx.db.insert("sources", { orgId: org, key: `s${Math.random()}`, kind: "crm", trustWeight: 1, lawfulBasis: "consent" });
    const accountId = await ctx.db.insert("accounts", { orgId: org, fields: [], display: {} });
    const contactId = await ctx.db.insert("contacts", { orgId: org, fields: [], display: {} });
    const observedAt = opts.observedAt ?? Date.now() - DAY;
    const claim = (subjectType: "account" | "contact", subjectId: string, field: string, value: unknown) =>
      appendClaimRecord(ctx, { subjectType, subjectId, field, value, sourceId, method: "observed", confidence: 1, observedAt });
    const email = `jo${Math.random().toString(36).slice(2)}@acme${Math.random().toString(36).slice(2)}.com`;
    await claim("account", accountId, "name", "Acme");
    await claim("account", accountId, "domain", email.split("@")[1]);
    await claim("account", accountId, "industry", opts.industry ?? "Software");
    await claim("contact", contactId, "name", "Jo Doe");
    if (opts.noEmployer !== true) await claim("contact", contactId, "accountId", accountId);
    await claim("contact", contactId, "email", email);
    await rebuildProjection(ctx, { subjectType: "account", subjectId: accountId });
    await rebuildProjection(ctx, { subjectType: "contact", subjectId: contactId });
    if (opts.withKey !== false) await ctx.db.insert("contactKeys", { orgId: org, scope: "any", kind: "email", value: email, contactId });
    await appendSignal(ctx, { subjectType: "account", subjectId: accountId, kind: "funding", strength: "high", confidence: 1, observedAt: Date.now() - DAY });
    const icpId = (await latestIcp(ctx, {}))?._id ?? (await createIcpVersion(ctx, { name: "ICP", criteria }));
    return { accountId, contactId, sourceId, icpId };
  });
}
const score = (s: Seed) => t.run((ctx) => scoreLead(ctx, { accountId: s.accountId, contactId: s.contactId }));
const scored = async (s: Seed) => {
  const id = await score(s);
  return (await raw.run((ctx) => ctx.db.get(id)))!;
};
const pkg = (s: Seed, scoreRunId: Id<"scoreRuns">, over: { suppressed?: boolean; freshnessWindowDays?: number } = {}) =>
  t.run((ctx) => packageLead(ctx, { accountId: s.accountId, contactId: s.contactId, scoreRunId, suppressed: false, ...over }));
const lead = (id: Id<"leads">) => raw.run((ctx) => ctx.db.get(id)) as Promise<Doc<"leads">>;

describe("packaging", () => {
  test("a shippable tier S subject is packaged ReadyForDistribution and Available", async () => {
    const s = await seed();
    const l = await lead(await pkg(s, await score(s)));
    expect(l).toMatchObject({ orgId, accountId: s.accountId, contactId: s.contactId, tier: "S", inventoryState: "Available", disposition: "ReadyForDistribution" });
    expect(l.distributability).toMatchObject({ ok: true, failed: [], freshnessWindowDays: 90, suppressed: false });
  });

  test("a tier S lead failing a criterion is Held, not downgraded", async () => {
    const s = await seed();
    const run = await score(s);
    const held = await lead(await pkg(s, run, { suppressed: true }));
    expect(held.tier).toBe("S");
    expect(held.disposition).toBe("Held");
    expect(held.distributability).toMatchObject({ ok: false, failed: ["duplicate_checked"], suppressed: true });
    // The score itself is exactly what the scoreRun said.
    const r = (await raw.run((ctx) => ctx.db.get(run)))!;
    expect(held).toMatchObject({ score: r.score, confidence: r.confidence, priority: r.priority, scoreRunId: run });
  });

  test("a subject with no registered email key is Held: the duplicate check never ran", async () => {
    const s = await seed({ withKey: false });
    const l = await lead(await pkg(s, await score(s)));
    expect(l.disposition).toBe("Held");
    expect(l.distributability.failed).toEqual(["duplicate_checked"]);
  });

  test("an email key pointing at another contact, or a second account on the domain, is Held", async () => {
    const s = await seed();
    await t.run(async (ctx) => {
      const other = await ctx.db.insert("contacts", { orgId, fields: [], display: {} });
      const key = await ctx.db.query("contactKeys").first();
      await ctx.db.patch(key!._id, { contactId: other });
    });
    expect((await lead(await pkg(s, await score(s)))).distributability.failed).toEqual(["duplicate_checked"]);

    const s2 = await seed();
    await t.run(async (ctx) => {
      const acct = (await ctx.db.get(s2.accountId))!;
      await ctx.db.insert("accounts", { orgId, fields: [], display: { domain: acct.display.domain } });
    });
    expect((await lead(await pkg(s2, await score(s2)))).distributability.failed).toEqual(["duplicate_checked"]);
  });

  test("a claim whose source is gone leaves permissions undocumented", async () => {
    const s = await seed();
    const run = await score(s);
    await t.run((ctx) => ctx.db.delete(s.sourceId));
    const l = await lead(await pkg(s, run));
    expect(l.disposition).toBe("Held");
    expect(l.distributability.failed).toEqual(["permissions_documented"]);
  });

  test("permissions are checked on the contact's claims too, not just the account's", async () => {
    const s = await seed();
    const other = await t.run(async (ctx) => {
      const sourceId = await ctx.db.insert("sources", { orgId, key: "second", kind: "manual", trustWeight: 1, lawfulBasis: "consent" });
      await appendClaimRecord(ctx, { subjectType: "contact", subjectId: s.contactId, field: "title", value: "CTO", sourceId, method: "observed", confidence: 1, observedAt: Date.now() - DAY });
      await rebuildProjection(ctx, { subjectType: "contact", subjectId: s.contactId });
      return sourceId;
    });
    const run = await score(s);
    await t.run((ctx) => ctx.db.delete(other));
    expect((await lead(await pkg(s, run))).distributability.failed).toEqual(["permissions_documented"]);
  });

  test("a lead older than the freshness window is Held for it", async () => {
    const s = await seed({ observedAt: Date.now() - 100 * DAY });
    const l = await lead(await pkg(s, await score(s)));
    expect(l.distributability.failed).toEqual(["within_freshness_window"]);
    const s2 = await seed({ observedAt: Date.now() - 100 * DAY });
    expect((await lead(await pkg(s2, await score(s2), { freshnessWindowDays: 365 }))).distributability).toMatchObject({ ok: true, freshnessWindowDays: 365 });
  });

  test("packageLead snapshots the projections: later claims do not alter the lead", async () => {
    const s = await seed();
    const id = await pkg(s, await score(s));
    const before = await lead(id);
    await t.run(async (ctx) => {
      await appendClaimRecord(ctx, { subjectType: "account", subjectId: s.accountId, field: "name", value: "Renamed Corp", sourceId: s.sourceId, method: "observed", confidence: 1, observedAt: Date.now() });
      await appendClaimRecord(ctx, { subjectType: "contact", subjectId: s.contactId, field: "title", value: "CEO", sourceId: s.sourceId, method: "observed", confidence: 1, observedAt: Date.now() });
      await rebuildProjection(ctx, { subjectType: "account", subjectId: s.accountId });
      await rebuildProjection(ctx, { subjectType: "contact", subjectId: s.contactId });
    });
    const account = (await raw.run((ctx) => ctx.db.get(s.accountId)))!;
    expect(account.display.name).toBe("Renamed Corp"); // the projection really did move
    const after = await lead(id);
    expect(after).toEqual(before);
    expect(after.snapshot.account.display.name).toBe("Acme");
    expect(after.snapshot.contact.fields.some((f) => f.field === "title")).toBe(false);
    // The snapshot keeps per-field provenance, sorted as the projection is.
    expect(after.snapshot.account.fields.map((f) => f.field)).toEqual(["domain", "industry", "name"]);
    expect(after.snapshot.account.fields[0]).toMatchObject({ method: "observed", confidence: 1 });
    expect(typeof after.snapshot.account.fields[0].claimId).toBe("string");
  });

  test("packageLead refuses a stale scoreRun", async () => {
    const claimAfter = async (s: Seed) =>
      t.run((ctx) => appendClaimRecord(ctx, { subjectType: "contact", subjectId: s.contactId, field: "title", value: "CTO", sourceId: s.sourceId, method: "observed", confidence: 1, observedAt: Date.now() }));

    // 1. superseded by a rescore
    const a = await seed();
    const old = await score(a);
    await score(a);
    await expect(pkg(a, old)).rejects.toThrow("stale scoreRun: a newer scoreRun exists for the subject");

    // 2. a claim about the contact, then the account, recorded after the score
    const b = await seed();
    const runB = await score(b);
    await claimAfter(b);
    await expect(pkg(b, runB)).rejects.toThrow("stale scoreRun: a claim about the contact was recorded after the score");
    const c = await seed();
    const runC = await score(c);
    await t.run((ctx) => appendClaimRecord(ctx, { subjectType: "account", subjectId: c.accountId, field: "size", value: "51-200", sourceId: c.sourceId, method: "observed", confidence: 1, observedAt: Date.now() }));
    await expect(pkg(c, runC)).rejects.toThrow("stale scoreRun: a claim about the account was recorded after the score");

    // 3. a newer ICP is active
    const d = await seed();
    const runD = await score(d);
    await t.run((ctx) => createIcpVersion(ctx, { name: "ICP v2", criteria, supersedesId: d.icpId }));
    await expect(pkg(d, runD)).rejects.toThrow("stale scoreRun: a newer ICP version is active");

    // 4. a newer scoring model is active
    const e = await seed();
    const runE = await score(e);
    await t.run(async (ctx) => {
      const current = (await ctx.db.query("scoringModels").first())!;
      await createScoringModel(ctx, { ...structuredClone(DEFAULT_SCORING_MODEL), supersedesId: current._id });
    });
    await expect(pkg(e, runE)).rejects.toThrow("stale scoreRun: a newer scoring model is active");

    // A fresh rescore is not stale, and nothing was packaged by the refusals.
    const fresh = await score(d);
    await expect(pkg(d, fresh)).resolves.toBeTruthy();
    expect(await raw.run((ctx) => ctx.db.query("leads").collect())).toHaveLength(1);
  });

  test("packageLead refuses a contact that does not belong to the account, or has no employer claim", async () => {
    const a = await seed();
    const b = await seed();
    const run = await score(a);
    await expect(t.run((ctx) => packageLead(ctx, { accountId: b.accountId, contactId: a.contactId, scoreRunId: run, suppressed: false }))).rejects.toThrow("contact does not belong to this account");
    const orphan = await seed({ noEmployer: true });
    const orphanRun = await score(orphan);
    await expect(pkg(orphan, orphanRun)).rejects.toThrow("contact has no accountId claim");
    expect(await raw.run((ctx) => ctx.db.query("leads").collect())).toHaveLength(0);
  });

  test("packageLead refuses a foreign, mismatched, rejected or already-packaged score", async () => {
    const s = await seed();
    const run = await score(s);
    const other = await seed();
    await expect(pkg(other, run)).rejects.toThrow("scoreRun does not score this contact");
    await pkg(s, run);
    await expect(pkg(s, run)).rejects.toThrow("this scoreRun is already packaged");

    const foreignOrg = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
    const f = await seed({ org: foreignOrg });
    await expect(t.run((ctx) => packageLead(ctx, { accountId: f.accountId, contactId: f.contactId, scoreRunId: run, suppressed: false }))).rejects.toThrow("account not found");
    await expect(pkg(s, run, { freshnessWindowDays: NaN })).rejects.toThrow("freshnessWindowDays");
    await expect(t.run((ctx) => packageLead(ctx, { accountId: s.accountId, contactId: s.contactId, scoreRunId: run, suppressed: undefined as never }))).rejects.toThrow("suppressed must be a boolean");

    // A Reject-tier score has nothing to ship or hold.
    const rejecting = await seed({ industry: "Mining" });
    const rejectRun = await score(rejecting);
    expect((await raw.run((ctx) => ctx.db.get(rejectRun)))!.tier).toBe("Reject");
    await expect(pkg(rejecting, rejectRun)).rejects.toThrow("a Reject-tier score is not packaged");
  });
});

describe("state axes", () => {
  test("inventory state and disposition are independent fields", async () => {
    const s = await seed();
    const id = await pkg(s, await score(s));
    const before = await lead(id);
    await t.run((ctx) => setInventoryState(ctx, { leadId: id, state: "Delivered" }));
    let l = await lead(id);
    expect(l).toEqual({ ...before, inventoryState: "Delivered" });
    await t.run((ctx) => setDisposition(ctx, { leadId: id, disposition: "Accepted" }));
    l = await lead(id);
    // Delivered inventory + Accepted disposition: neither write disturbed the other, or anything else.
    expect(l).toEqual({ ...before, inventoryState: "Delivered", disposition: "Accepted" });
    await t.run((ctx) => setInventoryState(ctx, { leadId: id, state: "Replaced" }));
    expect((await lead(id)).disposition).toBe("Accepted");
    const found = await t.run((ctx) => leadsByDisposition(ctx, { disposition: "Accepted", limit: 10 }));
    expect(found.map((x) => x._id)).toEqual([id]);
    expect((await t.run((ctx) => getLead(ctx, { leadId: id })))._id).toBe(id);
  });

  test("a lead that failed the gate cannot be released, reserved, sold or delivered", async () => {
    const s = await seed();
    const id = await pkg(s, await score(s), { suppressed: true });
    for (const disposition of ["ReadyForDistribution", "Delivered", "Accepted", "Converted"] as const) {
      await expect(t.run((ctx) => setDisposition(ctx, { leadId: id, disposition }))).rejects.toThrow("failed distributability");
    }
    for (const state of ["Reserved", "Sold", "Delivered"] as const) {
      await expect(t.run((ctx) => setInventoryState(ctx, { leadId: id, state }))).rejects.toThrow("failed distributability");
    }
    // Moving it somewhere that does not ship is fine.
    await t.run((ctx) => setDisposition(ctx, { leadId: id, disposition: "Closed" }));
    await t.run((ctx) => setInventoryState(ctx, { leadId: id, state: "Expired" }));
    expect(await lead(id)).toMatchObject({ disposition: "Closed", inventoryState: "Expired", tier: "S" });
  });

  test("setters refuse unknown vocabulary, unknown leads and other orgs' leads", async () => {
    const s = await seed();
    const id = await pkg(s, await score(s));
    await expect(t.run((ctx) => setInventoryState(ctx, { leadId: id, state: "Accepted" as never }))).rejects.toThrow("not an inventory state");
    await expect(t.run((ctx) => setDisposition(ctx, { leadId: id, disposition: "Sold" as never }))).rejects.toThrow("not a disposition");
    const other = raw.withIdentity({ subject: "u9", orgId: await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 })) });
    await expect(other.run((ctx) => setDisposition(ctx, { leadId: id, disposition: "Closed" }))).rejects.toThrow("lead not found");
    await expect(other.run((ctx) => getLead(ctx, { leadId: id }))).rejects.toThrow("lead not found");
    await expect(t.run((ctx) => leadsByDisposition(ctx, { disposition: "Held", limit: 0 }))).rejects.toThrow("limit must be");
    await expect(t.run((ctx) => leadsByDisposition(ctx, { disposition: "Held", limit: 201 }))).rejects.toThrow("limit must be");
  });
});

describe("scoring seam (scoreLead)", () => {
  test("claimRecordedAt is wired: a future-dated claim is clamped to when it was recorded", async () => {
    // Observed 30 days AHEAD. Clamped to its recorded time it is brand new, so evidence stays at 1; with no
    // map the scorer fails closed and gives it only the freshness floor (0.5).
    const s = await seed({ observedAt: Date.now() + 30 * DAY });
    const r = await scored(s);
    expect(r.confidence).toBeGreaterThan(0.999);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  test("a score cites a real model and ICP, scores the contact, and reads account signals", async () => {
    const s = await seed();
    const r = await scored(s);
    expect(r).toMatchObject({ subjectType: "contact", subjectId: s.contactId, icpVersionId: s.icpId, intentMayBeStranded: false, tier: "S" });
    expect(r.intent).toBeGreaterThan(90); // the account's funding signal was read
    expect(await raw.run((ctx) => ctx.db.get(r.scoringModelId))).not.toBeNull();
  });

  test("signals on both subjects are summed, not deduped: the same event on both counts twice (convention: one subject per event)", async () => {
    const s = await seed();
    const base = await scored(s);
    await t.run((ctx) => appendSignal(ctx, { subjectType: "account", subjectId: s.accountId, kind: "hire", strength: "low", confidence: 1, observedAt: Date.now() - DAY }));
    const one = await scored(s);
    await t.run((ctx) => appendSignal(ctx, { subjectType: "contact", subjectId: s.contactId, kind: "hire", strength: "low", confidence: 1, observedAt: Date.now() - DAY }));
    const both = await scored(s);
    expect(one.intent).toBeGreaterThanOrEqual(base.intent);
    expect(both.intent).toBeGreaterThan(one.intent);
  });

  test("scoring refuses a projection that cites a claim that does not exist", async () => {
    const s = await seed();
    await t.run(async (ctx) => {
      const claimId = (await ctx.db.get(s.accountId))!.fields[0].claimId;
      await ctx.db.delete(claimId);
    });
    await expect(score(s)).rejects.toThrow("projection cites a missing claim");
  });

  test("an active inbound identityLink is recorded on the scoreRun; a reversed one is not", async () => {
    const s = await seed();
    const absorbed = await t.run((ctx) => ctx.db.insert("accounts", { orgId, fields: [], display: {} }));
    expect((await scored(s)).intentMayBeStranded).toBe(false);

    const linkId = await t.run((ctx) => linkIdentity(ctx, { subjectType: "account", subjectId: s.accountId, mergedFromId: absorbed, score: 1, signals: ["domain"] }));
    expect((await scored(s)).intentMayBeStranded).toBe(true);

    await t.run((ctx) => unlinkIdentity(ctx, { linkId }));
    expect((await scored(s)).intentMayBeStranded).toBe(false);

    // The merged-AWAY side is not the one with stranded intent: only the survivor is flagged.
    const away = await seed();
    await t.run((ctx) => linkIdentity(ctx, { subjectType: "account", subjectId: absorbed, mergedFromId: away.accountId, score: 1, signals: ["domain"] }));
    expect((await scored(away)).intentMayBeStranded).toBe(false);
  });

  test("a contact with an active inbound link is flagged too", async () => {
    const s = await seed();
    const absorbed = await t.run((ctx) => ctx.db.insert("contacts", { orgId, fields: [], display: {} }));
    await t.run((ctx) => linkIdentity(ctx, { subjectType: "contact", subjectId: s.contactId, mergedFromId: absorbed, score: 1, signals: ["email"] }));
    expect((await scored(s)).intentMayBeStranded).toBe(true);
  });

  test("the link walk stops at the first active link, and refuses to guess past its cap", async () => {
    const s = await seed();
    const mk = (n: number, reversedAt: number | undefined) =>
      raw.run(async (ctx) => {
        for (let i = 0; i < n; i++) {
          const from = await ctx.db.insert("accounts", { orgId, fields: [], display: {} });
          await ctx.db.insert("identityLinks", { orgId, subjectType: "account", subjectId: s.accountId, mergedFromId: from, score: 1, signals: [], createdAt: 0, reversedAt });
        }
      });
    await mk(MAX_LINKS_SCANNED, 1);
    expect((await scored(s)).intentMayBeStranded).toBe(false); // exactly at the cap, all reversed: a known "no"
    await mk(1, undefined);
    expect((await scored(s)).intentMayBeStranded).toBe(true);
    const s2 = await seed();
    await raw.run(async (ctx) => {
      for (let i = 0; i < MAX_LINKS_SCANNED + 1; i++) {
        const from = await ctx.db.insert("accounts", { orgId, fields: [], display: {} });
        await ctx.db.insert("identityLinks", { orgId, subjectType: "account", subjectId: s2.accountId, mergedFromId: from, score: 1, signals: [], createdAt: 0, reversedAt: 1 });
      }
    });
    await expect(score(s2)).rejects.toThrow("refusing to guess");
  });
});

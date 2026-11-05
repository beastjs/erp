/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { MAX_CLAIMS } from "../claims/queries";
import type { ClaimMethod, SubjectType } from "../claims/schema";
import schema from "../schema";
import { applyClaimToProjection, rebuildProjection } from "./build";

const modules = import.meta.glob("/convex/**/*.ts");

let raw: ReturnType<typeof convexTest>;
let t: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
let orgId: Id<"orgs">;
let otherOrgId: Id<"orgs">;
// trust: web 0.9, directory 0.5, scraper 0.2, untrusted 0 (present but weightless)
let sources: Id<"sources">[];

// Only Date is faked: it makes claim _creationTime controllable (strictly increasing, never
// tied) and lets a test move the clock between an incremental build and a rebuild.
const BASE = 1_700_000_000_000;
let clock = BASE;
const tick = () => vi.setSystemTime(++clock);

afterEach(() => vi.useRealTimers());

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock = BASE;
  vi.setSystemTime(clock);
  raw = convexTest(schema, modules);
  const seeded = await raw.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 });
    const otherOrgId = await ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 });
    const sources: Id<"sources">[] = [];
    for (const [key, trustWeight] of [["web", 0.9], ["directory", 0.5], ["scraper", 0.2], ["untrusted", 0]] as const) {
      sources.push(await ctx.db.insert("sources", { orgId, key, trustWeight }));
    }
    return { orgId, otherOrgId, sources };
  });
  orgId = seeded.orgId;
  otherOrgId = seeded.otherOrgId;
  sources = seeded.sources;
  t = raw.withIdentity({ subject: "u1", orgId });
});

const newAccount = () => t.run((ctx) => ctx.db.insert("accounts", { orgId, fields: [], display: {} }));

type ClaimSpec = {
  field: string;
  value: unknown;
  sourceId: Id<"sources">;
  method: ClaimMethod;
  confidence: number;
  observedAt: number;
  label?: string;
};

const append = (subjectId: string, c: ClaimSpec, subjectType: SubjectType = "account") =>
  t.mutation(api.claims.mutations.appendClaim, {
    subjectType,
    subjectId,
    field: c.field,
    value: c.value,
    sourceId: c.sourceId,
    method: c.method,
    confidence: c.confidence,
    observedAt: c.observedAt,
    snapshotRef: c.label,
  });

const apply = (subjectId: string, claimId: Id<"claims">, subjectType: SubjectType = "account") =>
  t.run((ctx) => applyClaimToProjection(ctx, { subjectType, subjectId, claimId }));
const rebuild = (subjectId: string, subjectType: SubjectType = "account") =>
  t.run((ctx) => rebuildProjection(ctx, { subjectType, subjectId }));
const getAccount = (accountId: Id<"accounts">) => t.query(api.projections.queries.getAccount, { accountId });

test("a single observed claim appears in the projection with its provenance", async () => {
  const id = await newAccount();
  const claimId = await append(id, {
    field: "domain", value: "acme.com", sourceId: sources[0], method: "observed", confidence: 0.9, observedAt: 1000,
  });
  await apply(id, claimId);
  const account = await getAccount(id);
  expect(account.fields).toEqual([
    { field: "domain", value: "acme.com", claimId, method: "observed", confidence: 0.9, observedAt: 1000 },
  ]);
  expect(account.display).toEqual({ domain: "acme.com" });
});

test("a superseding claim replaces the projected value and its provenance pointer", async () => {
  const id = await newAccount();
  const first = await append(id, {
    field: "name", value: "Acme", sourceId: sources[0], method: "observed", confidence: 0.9, observedAt: 1000,
  });
  await apply(id, first);
  const second = await append(id, {
    field: "name", value: "Acme Corp", sourceId: sources[0], method: "observed", confidence: 0.9, observedAt: 2000,
  });
  await apply(id, second);
  const account = await getAccount(id);
  expect(account.fields).toHaveLength(1);
  expect(account.fields[0]).toMatchObject({ value: "Acme Corp", claimId: second, observedAt: 2000 });
  expect(account.display.name).toBe("Acme Corp");
});

test("rebuild of a subject with no claims yields an empty projection, not an error", async () => {
  const id = await newAccount();
  await rebuild(id);
  const account = await getAccount(id);
  expect(account.fields).toEqual([]);
  expect(account.display).toEqual({});
});

test("rebuild drops anything in the projection that no claim supports", async () => {
  const id = await newAccount();
  const fake = await append(id, {
    field: "domain", value: "x.com", sourceId: sources[0], method: "observed", confidence: 1, observedAt: 1,
  });
  // Corrupt the projection by hand (tests only; no production path can do this).
  await t.run((ctx) =>
    ctx.db.patch(id, {
      fields: [{ field: "ghost", value: 1, claimId: fake, method: "observed", confidence: 1, observedAt: 1 }],
      display: { name: "ghost" },
    }),
  );
  await rebuild(id);
  const account = await getAccount(id);
  expect(account.fields.map((f) => f.field)).toEqual(["domain"]);
  expect(account.display).toEqual({ domain: "x.com" });
});

// ---- property tests -------------------------------------------------------

/** Deterministic PRNG so a failure is reproducible. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const FIELDS = ["name", "domain", "industry", "employee_count", "_hq"]; // "_hq" would be an illegal record key
const METHODS: ClaimMethod[] = ["observed", "extracted", "inferred"];

/**
 * 50 claims over 5 fields (10 each). Methods, sources (four trust levels) and
 * observedAt all vary, and observedAt is unique per claim so the comparator never
 * has to fall through to the claim-id tiebreak (which would differ between two
 * accounts holding "the same" claims).
 *
 * Future-dated claims (observedAt far beyond the time they are recorded) exercise the
 * clamp to _creationTime. Claim 1 is alone in its field's future. With `futurePair`,
 * claims 22 and 37 are a second, competing pair in "industry": both observed/web, 37
 * recorded later but 22 carries higher confidence, and 37 asserts the later observedAt.
 * Clamped to creation time, 37 wins on recency. A clamp to wall-clock now would tie them
 * (confidence picks 22) or, once the clock passes both dates, pick by raw observedAt.
 * The pair is off for the order test, where arrival order legitimately changes
 * _creationTime and therefore which of two future claims is newer.
 */
function genClaims(seed: number, futurePair = false): ClaimSpec[] {
  const rnd = mulberry32(seed);
  const out: ClaimSpec[] = [];
  for (let i = 0; i < 50; i++) {
    out.push({
      field: FIELDS[i % FIELDS.length],
      value: i % 7 === 0 ? { nested: i } : `v${i}`,
      sourceId: sources[Math.floor(rnd() * sources.length)],
      method: METHODS[Math.floor(rnd() * METHODS.length)],
      confidence: Math.round(rnd() * 100) / 100,
      observedAt: 1000 + i * 10 + Math.floor(rnd() * 10),
      label: `c${i}`,
    });
  }
  out[1] = { ...out[1], observedAt: BASE + 1e9 };
  if (futurePair) {
    out[22] = { ...out[22], sourceId: sources[0], method: "observed", confidence: 0.9, observedAt: BASE + 1e9 };
    out[37] = { ...out[37], sourceId: sources[0], method: "observed", confidence: 0.6, observedAt: BASE + 2e9 };
  }
  return out;
}

/** Insert then apply each claim in the given order, as the pipeline will. */
async function applyInOrder(subjectId: string, specs: ClaimSpec[]) {
  for (const spec of specs) {
    tick();
    await apply(subjectId, await append(subjectId, spec));
  }
}

/** Replace claimId with the stable label so projections of different subjects compare. */
async function normalized(accountId: Id<"accounts">) {
  const account = await getAccount(accountId);
  const label = new Map<Id<"claims">, string | undefined>();
  for (const c of await t.query(api.claims.queries.claimsForSubject, { subjectType: "account", subjectId: accountId })) {
    label.set(c._id, c.snapshotRef);
  }
  return {
    display: account.display,
    fields: account.fields.map(({ claimId, ...rest }) => ({ ...rest, claim: label.get(claimId) })),
  };
}

const winnersByLabel = (p: Awaited<ReturnType<typeof normalized>>) => Object.fromEntries(p.fields.map((f) => [f.field, f.claim]));

test("PROPERTY: rebuild equals incremental", async () => {
  for (const seed of [1, 2, 3]) {
    const specs = genClaims(seed, true);
    const id = await newAccount();
    await applyInOrder(id, specs);

    // The claim set must really compete, or this proves only that a claim equals itself.
    const labelled = specs.map((s, i) => ({ ...s, i }));
    expect(new Set(specs.map((s) => s.method)).size).toBe(3);
    expect(new Set(specs.map((s) => s.sourceId)).size).toBeGreaterThanOrEqual(3);
    const winners = winnersByLabel(await normalized(id));
    // 37 was recorded after 22, so the clamp (not raw observedAt, not confidence) decides.
    expect(winners.industry).toBe("c37");
    expect(Object.keys(winners)).toHaveLength(FIELDS.length);
    // Winner is the latest-inserted claim for at most a minority of fields, so method/trust did real work.
    const latestWins = FIELDS.filter((f) => {
      const last = labelled.filter((s) => s.field === f).at(-1)!;
      return winners[f] === last.label;
    });
    expect(latestWins.length).toBeLessThanOrEqual(2);

    // Snapshot, rebuild, compare. Excluded: _id (the rebuild replaces the same row, so it
    // is identical by construction and carries no derived information) and _creationTime
    // (database-assigned insert time, not derived from claims; rebuild's replace preserves
    // it, and a delete+insert rebuild would legitimately change it). Everything derived,
    // including every claimId pointer, is compared.
    const strip = ({ _id, _creationTime, ...rest }: Awaited<ReturnType<typeof getAccount>>) => rest;
    const incremental = strip(await getAccount(id));
    // Move the clock past every observedAt: a rebuild must not depend on when it runs.
    vi.setSystemTime(BASE + 5e9);
    await rebuild(id);
    expect(strip(await getAccount(id))).toEqual(incremental);
  }
});

test("PROPERTY: projection is order-independent", async () => {
  for (const seed of [1, 2, 3]) {
    const specs = genClaims(seed);
    const forward = specs;
    const reversed = [...specs].reverse();
    // Adversarial: splits each field's claims into a first half (in field order) then
    // the second half, back to front, so a field's claims arrive far apart, interleaved
    // with every other field's.
    const half = specs.length / 2;
    const split = [...specs.slice(half).reverse(), ...specs.slice(0, half)];

    const results = [];
    for (const order of [forward, reversed, split]) {
      const id = await newAccount();
      await applyInOrder(id, order);
      results.push(await normalized(id));
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    // The orders must actually differ, or the test says nothing.
    expect(reversed.map((s) => s.label)).not.toEqual(forward.map((s) => s.label));
    expect(split.map((s) => s.label)).not.toEqual(forward.map((s) => s.label));
    expect(split.map((s) => s.label)).not.toEqual(reversed.map((s) => s.label));
  }
});

// ---- boundary validation ---------------------------------------------------

test("a subjectId that is not an id of the implied table is rejected", async () => {
  const id = await newAccount();
  const contactId = await t.run((ctx) => ctx.db.insert("contacts", { orgId, fields: [], display: {} }));
  const claimId = await append(id, {
    field: "name", value: "A", sourceId: sources[0], method: "observed", confidence: 1, observedAt: 1,
  });
  await expect(apply("not-an-id", claimId)).rejects.toThrow("subject not found");
  await expect(rebuild("not-an-id")).rejects.toThrow("subject not found");
  // A contact id presented as an account (and vice versa) fails closed.
  await expect(rebuild(contactId, "account")).rejects.toThrow("subject not found");
  await expect(rebuild(id, "contact")).rejects.toThrow("subject not found");
});

test("a subject in another org is rejected", async () => {
  const foreign = await raw.run((ctx) => ctx.db.insert("accounts", { orgId: otherOrgId, fields: [], display: {} }));
  await expect(rebuild(foreign)).rejects.toThrow("subject not found");
});

test("a claim that belongs to a different subject is rejected", async () => {
  const a = await newAccount();
  const b = await newAccount();
  const claimOnA = await append(a, {
    field: "name", value: "A", sourceId: sources[0], method: "observed", confidence: 1, observedAt: 1,
  });
  await expect(apply(b, claimOnA)).rejects.toThrow("claim not found for subject");
});

test("rebuild propagates the claims read limit instead of building from a truncated ledger", async () => {
  const id = await newAccount();
  await t.run(async (ctx) => {
    for (let i = 0; i <= MAX_CLAIMS; i++) {
      await ctx.db.insert("claims", {
        orgId, subjectType: "account", subjectId: id, field: "name", value: `n${i}`,
        sourceId: sources[0], method: "observed", confidence: 1, observedAt: i,
      });
    }
  });
  await expect(rebuild(id)).rejects.toThrow(/refusing a partial read/);
});

test("contacts project too", async () => {
  const id = await t.run((ctx) => ctx.db.insert("contacts", { orgId, fields: [], display: {} }));
  const claimId = await append(id, {
    field: "email", value: "a@acme.com", sourceId: sources[0], method: "observed", confidence: 1, observedAt: 1,
  }, "contact");
  await apply(id, claimId, "contact");
  const contact = await t.query(api.projections.queries.getContact, { contactId: id });
  expect(contact.display).toEqual({ email: "a@acme.com" });
  await rebuild(id, "contact");
  expect(await t.query(api.projections.queries.getContact, { contactId: id })).toEqual(contact);
});

/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { CANDIDATE_CONTRACT_VERSION, computeDedupeHash, validateCandidate } from "./contract";

const modules = import.meta.glob("/convex/**/*.ts");

const minimal = () => ({
  company: { domain: "acme.com" },
  acquisition: { acquiredAt: 1000 },
});

let raw: ReturnType<typeof convexTest>;
let t: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
let orgId: Id<"orgs">;

beforeEach(async () => {
  raw = convexTest(schema, modules);
  orgId = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 }));
  t = raw.withIdentity({ subject: "u1", orgId });
});

const register = (over: Record<string, unknown> = {}) =>
  t.mutation(api.sources.mutations.registerSource, {
    key: "csv-1",
    kind: "csv",
    trustWeight: 0.5,
    lawfulBasis: "legitimate_interest",
    ...over,
  } as never);

test("a minimal valid candidate passes validation", () => {
  const r = validateCandidate(minimal());
  expect(r.ok).toBe(true);
  expect(validateCandidate({ person: { email: "a@b.com" }, acquisition: { acquiredAt: 0 } }).ok).toBe(true);
});

test("a candidate with neither domain nor email is rejected", () => {
  const r = validateCandidate({ company: { name: "Acme" }, acquisition: { acquiredAt: 1 } });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.join(" ")).toContain("company.domain");
    expect(r.errors.join(" ")).toContain("person.email");
  }
});

test("unknown extra fields are rejected, not silently dropped", () => {
  for (const bad of [
    { ...minimal(), extra: 1 },
    { ...minimal(), company: { domain: "acme.com", faxNumber: "1" } },
    { ...minimal(), person: { email: "a@b.com", nickname: "x" } },
    { ...minimal(), acquisition: { acquiredAt: 1, utm: "x" } },
  ]) {
    const r = validateCandidate(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/not a known field/);
  }
});

test("malformed values are rejected", () => {
  expect(validateCandidate(null).ok).toBe(false);
  expect(validateCandidate({ company: { domain: "acme.com" } }).ok).toBe(false); // no acquisition
  expect(validateCandidate({ ...minimal(), acquisition: { acquiredAt: Number.NaN } }).ok).toBe(false);
  expect(validateCandidate({ ...minimal(), company: { domain: "nodot" } }).ok).toBe(false);
  expect(validateCandidate({ ...minimal(), person: { email: "not-an-email" } }).ok).toBe(false);
  expect(validateCandidate({ ...minimal(), company: { domain: "acme.com", techStack: [1] } }).ok).toBe(false);
});

test("CANDIDATE_CONTRACT_VERSION is exported and semver-shaped", () => {
  expect(CANDIDATE_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

test("the dedupe hash collides across spellings of the same lead and not across different people", () => {
  const a = computeDedupeHash({ person: { email: "Jane+news@WWW.Acme.com" }, acquisition: { acquiredAt: 1 } });
  const b = computeDedupeHash({ person: { email: "jane@acme.com" }, company: { domain: "x.com" }, acquisition: { acquiredAt: 2 } });
  expect(a).toBe(b);
  const jane = computeDedupeHash({ company: { domain: "https://www.Acme.com/" }, person: { fullName: "Jane Doe" }, acquisition: { acquiredAt: 1 } });
  const janeAgain = computeDedupeHash({ company: { domain: "acme.com" }, person: { firstName: "jane", lastName: "DOE" }, acquisition: { acquiredAt: 9 } });
  const john = computeDedupeHash({ company: { domain: "acme.com" }, person: { fullName: "John Roe" }, acquisition: { acquiredAt: 1 } });
  expect(jane).toBe(janeAgain);
  expect(jane).not.toBe(john);
});

test("insertCandidate returns null for a repeat dedupeHash", async () => {
  const sourceId = await register();
  const candidate = minimal();
  const dedupeHash = computeDedupeHash(candidate);
  const first = await t.mutation(api.sources.mutations.insertCandidate, { candidate, sourceId, dedupeHash });
  expect(first).not.toBeNull();
  const second = await t.mutation(api.sources.mutations.insertCandidate, { candidate, sourceId, dedupeHash });
  expect(second).toBeNull();
  const rows = await raw.run((ctx) => ctx.db.query("candidates").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]!.contractVersion).toBe(CANDIDATE_CONTRACT_VERSION);
});

test("insertCandidate fails closed on invalid candidates, mismatched hashes and foreign sources", async () => {
  const sourceId = await register();
  const candidate = minimal();
  const dedupeHash = computeDedupeHash(candidate);
  await expect(
    t.mutation(api.sources.mutations.insertCandidate, { candidate: { ...candidate, extra: 1 }, sourceId, dedupeHash }),
  ).rejects.toThrow("invalid candidate");
  await expect(
    t.mutation(api.sources.mutations.insertCandidate, { candidate, sourceId, dedupeHash: "domain:other.com|name:" }),
  ).rejects.toThrow("dedupeHash does not match");
  const otherOrg = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
  const other = raw.withIdentity({ subject: "u2", orgId: otherOrg });
  await expect(
    other.mutation(api.sources.mutations.insertCandidate, { candidate, sourceId, dedupeHash }),
  ).rejects.toThrow("source not found");
});

test("the same hash in a different org is not a duplicate", async () => {
  const sourceId = await register();
  const candidate = minimal();
  const dedupeHash = computeDedupeHash(candidate);
  await t.mutation(api.sources.mutations.insertCandidate, { candidate, sourceId, dedupeHash });
  const otherOrg = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
  const other = raw.withIdentity({ subject: "u2", orgId: otherOrg });
  const otherSource = await other.mutation(api.sources.mutations.registerSource, {
    key: "csv-1", kind: "csv", trustWeight: 0.5, lawfulBasis: "consent",
  });
  expect(await other.mutation(api.sources.mutations.insertCandidate, { candidate, sourceId: otherSource, dedupeHash })).not.toBeNull();
});

test("registerSource requires a lawfulBasis", async () => {
  await expect(
    t.mutation(api.sources.mutations.registerSource, { key: "k", kind: "csv", trustWeight: 0.5 } as never),
  ).rejects.toThrow();
  await expect(register({ lawfulBasis: "because" })).rejects.toThrow();
  const id = await register();
  const row = await raw.run((ctx) => ctx.db.get(id));
  expect(row).toMatchObject({ orgId, key: "csv-1", lawfulBasis: "legitimate_interest", trustWeight: 0.5 });
});

test("registerSource rejects NaN, Infinity and out-of-range trust weights", async () => {
  for (const [i, bad] of [Number.NaN, Infinity, -Infinity, -0.1, 1.1].entries()) {
    await expect(register({ key: `bad-${i}`, trustWeight: bad })).rejects.toThrow("trustWeight");
  }
  await expect(register({ key: "zero", trustWeight: 0 })).resolves.toBeTruthy();
  await expect(register({ key: "one", trustWeight: 1 })).resolves.toBeTruthy();
});

test("registerSource rejects a duplicate key within an org and requires org context", async () => {
  await register();
  await expect(register()).rejects.toThrow("already registered");
  await expect(
    raw.mutation(api.sources.mutations.registerSource, { key: "z", kind: "csv", trustWeight: 1, lawfulBasis: "consent" }),
  ).rejects.toThrow("no org context");
});

/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asMember } from "../_shared/testkit.support";
import schema from "../schema";
import { normalizeProfileUrl } from "../_shared/normalize";
import { insertCandidate, registerSourceTxn } from "./mutations";
import { CANDIDATE_CONTRACT_VERSION, computeDedupeHash, validateCandidate } from "./contract";

const modules = import.meta.glob("/convex/**/*.ts");

const blankRun = {
  status: "running" as const,
  creditBudget: 0,
  creditsUsed: 0,
  startedAt: 0,
  rowsProcessed: 0,
  candidatesInserted: 0,
  duplicates: 0,
  rowsRejected: 0,
  candidatesConsumed: 0,
  candidatesRejected: 0,
};

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
  t = await asMember(raw, "u1", orgId);
});

const register = (over: Record<string, unknown> = {}) =>
  t.action(api.sources.mutations.registerSource, {
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
  const first = await t.run((ctx) => insertCandidate(ctx, { candidate, sourceId }));
  expect(first).not.toBeNull();
  const second = await t.run((ctx) => insertCandidate(ctx, { candidate, sourceId }));
  expect(second).toBeNull();
  const rows = await raw.run((ctx) => ctx.db.query("candidates").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]!.dedupeHash).toBe(computeDedupeHash(candidate)); // server-derived
  expect(rows[0]!.contractVersion).toBe(CANDIDATE_CONTRACT_VERSION);
});

test("insertCandidate fails closed on invalid candidates and foreign sources", async () => {
  const sourceId = await register();
  const candidate = minimal();
  await expect(
    t.run((ctx) => insertCandidate(ctx, { candidate: { ...candidate, extra: 1 }, sourceId })),
  ).rejects.toThrow("invalid candidate");
  const otherOrg = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
  const other = await asMember(raw, "u2", otherOrg);
  await expect(
    other.run((ctx) => insertCandidate(ctx, { candidate, sourceId })),
  ).rejects.toThrow("source not found");
});

test("the same hash in a different org is not a duplicate", async () => {
  const sourceId = await register();
  const candidate = minimal();
  await t.run((ctx) => insertCandidate(ctx, { candidate, sourceId }));
  const otherOrg = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
  const other = await asMember(raw, "u2", otherOrg);
  const otherSource = await other.action(api.sources.mutations.registerSource, {
    key: "csv-1", kind: "csv", trustWeight: 0.5, lawfulBasis: "consent",
  });
  expect(await other.run((ctx) => insertCandidate(ctx, { candidate, sourceId: otherSource }))).not.toBeNull();
});

test("insertCandidate is not a callable endpoint", () => {
  // Registered Convex functions carry an isMutation marker; a plain helper does not.
  expect((insertCandidate as unknown as { isMutation?: boolean }).isMutation).toBeUndefined();
  expect((registerSourceTxn as unknown as { isMutation?: boolean }).isMutation).toBe(true); // the control: a registered mutation does carry it
});

test("registerSource requires a lawfulBasis", async () => {
  await expect(
    t.action(api.sources.mutations.registerSource, { key: "k", kind: "csv", trustWeight: 0.5 } as never),
  ).rejects.toThrow(/lawfulBasis/);
  await expect(register({ lawfulBasis: "because" })).rejects.toThrow(/Validator error.*because/);
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
    raw.action(api.sources.mutations.registerSource, { key: "z", kind: "csv", trustWeight: 1, lawfulBasis: "consent" }),
  ).rejects.toThrow("no org context");
});

test("registerSource trims the key before storing and comparing", async () => {
  const id = await register({ key: "  a  " });
  expect((await raw.run((ctx) => ctx.db.get(id)))!.key).toBe("a");
  await expect(register({ key: "a" })).rejects.toThrow("already registered");
});

const acq = { acquiredAt: 1 };

test("a person block with no identifier is rejected", () => {
  const r = validateCandidate({ company: { domain: "acme.com" }, person: { jobTitle: "VP Sales" }, acquisition: acq });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.join(" ")).toMatch(/person must carry/);
});

test("distinct nameless/emailless persons at one domain do not collide", () => {
  const h = (person?: object) => computeDedupeHash({ company: { domain: "acme.com" }, ...(person ? { person } : {}), acquisition: acq });
  const hashes = [
    h(),
    h({ profileUrl: "https://linkedin.com/in/x" }),
    h({ profileUrl: "https://www.linkedin.com/in/y/" }),
    h({ phone: "+1 (555) 010-2000" }),
    h({ phone: "+1 555 010 3000" }),
    h({ fullName: "Jane Doe" }),
  ];
  expect(new Set(hashes).size).toBe(hashes.length);
  expect(h({ profileUrl: "HTTPS://www.linkedin.com/in/x/?utm=1" })).toBe(h({ profileUrl: "linkedin.com/in/x" }));
  expect(h({ phone: "1-555-010-2000" })).toBe(h({ phone: "+1 (555) 010-2000" }));
});

test("person names are not mangled by company-suffix stripping", () => {
  const h = (fullName: string) => computeDedupeHash({ company: { domain: "acme.com" }, person: { fullName }, acquisition: acq });
  expect(h("Anna Co")).not.toBe(h("Anna"));
  expect(h("Anna Co")).toBe("domain:acme.com|name:anna co");
});

test("a repeat while pending is deduped; a re-observation after consumption inserts fresh", async () => {
  const sourceId = await register();
  const candidate = minimal();
  const first = await t.run((ctx) => insertCandidate(ctx, { candidate, sourceId }));
  expect(first).not.toBeNull();
  expect((await raw.run((ctx) => ctx.db.get(first!)))!.status).toBe("pending");
  expect(await t.run((ctx) => insertCandidate(ctx, { candidate, sourceId }))).toBeNull();
  await raw.run((ctx) => ctx.db.patch(first!, { status: "consumed" }));
  const again = await t.run((ctx) => insertCandidate(ctx, { candidate, sourceId }));
  expect(again).not.toBeNull();
  expect(again).not.toBe(first);
  // and the new pending row dedupes again
  expect(await t.run((ctx) => insertCandidate(ctx, { candidate, sourceId }))).toBeNull();
});

test("cross-form duplicates insert twice by design", async () => {
  // A lead seen with an email at one source and only domain+name at another hashes differently.
  // Deliberately deferred: we cannot dedupe on an identifier we do not have. Company-level
  // convergence happens at entity resolution; contact-level cross-form duplicates remain possible
  // and are not yet owned by anything.
  const sourceId = await register();
  const withEmail = { person: { fullName: "Jane Doe", email: "jane@acme.com" }, company: { domain: "acme.com" }, acquisition: acq };
  const withoutEmail = { person: { fullName: "Jane Doe" }, company: { domain: "acme.com" }, acquisition: acq };
  expect(await t.run((ctx) => insertCandidate(ctx, { candidate: withEmail, sourceId }))).not.toBeNull();
  expect(await t.run((ctx) => insertCandidate(ctx, { candidate: withoutEmail, sourceId }))).not.toBeNull();
});

test("insertCandidate rejects a run from another org", async () => {
  const sourceId = await register();
  const otherOrg = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
  const foreignRun = await raw.run(async (ctx) => {
    const src = await ctx.db.insert("sources", { orgId: otherOrg, key: "x", kind: "csv", trustWeight: 1, lawfulBasis: "consent" });
    return ctx.db.insert("discoveryRuns", { ...blankRun, orgId: otherOrg, sourceId: src });
  });
  await expect(
    t.run((ctx) => insertCandidate(ctx, { candidate: minimal(), sourceId, runId: foreignRun })),
  ).rejects.toThrow("run not found");
});

test("non-URL profileUrl values are not profile keys and do not collide", () => {
  for (const bad of ["j. smith", "linkedin.com", "https://linkedin.com/", "www.linkedin.com"]) {
    expect(normalizeProfileUrl(bad)).toBeNull();
  }
  expect(normalizeProfileUrl("HTTPS://www.linkedin.com/in/X/?a=1")).toBe("linkedin.com/in/x");
  const h = (person: object) => computeDedupeHash({ company: { domain: "acme.com" }, person, acquisition: acq });
  expect(h({ fullName: "Jane Doe", profileUrl: "linkedin.com" })).not.toBe(h({ fullName: "John Roe", profileUrl: "linkedin.com" }));
  // a lone non-URL profileUrl identifies nobody
  expect(validateCandidate({ company: { domain: "acme.com" }, person: { profileUrl: "j. smith" }, acquisition: acq }).ok).toBe(false);
});

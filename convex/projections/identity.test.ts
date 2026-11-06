/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { emailDomain, normalizeCompanyName, normalizeDomain, normalizeEmail } from "../_shared/normalize";
import { asMember } from "../_shared/testkit.support";
import schema from "../schema";
import {
  linkIdentity,
  matchCandidate,
  MATCH_THRESHOLD,
  unlinkIdentity,
} from "./identity";
import type { AccountProjection } from "./queries";

const modules = import.meta.glob("/convex/**/*.ts");

let raw: ReturnType<typeof convexTest>;
let t: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
let orgId: Id<"orgs">;
let otherOrgId: Id<"orgs">;

beforeEach(async () => {
  raw = convexTest(schema, modules);
  const seeded = await raw.run(async (ctx) => ({
    orgId: await ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 }),
    otherOrgId: await ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }),
  }));
  orgId = seeded.orgId;
  otherOrgId = seeded.otherOrgId;
  t = await asMember(raw, "u1", orgId);
});

const seedAccount = (display: { name?: string; domain?: string }, org = orgId) =>
  raw.run((ctx) => ctx.db.insert("accounts", { orgId: org, fields: [], display }));

const load = (id: Id<"accounts">) =>
  raw.run(async (ctx) => (await ctx.db.get(id)) as AccountProjection);

test("exact domain match resolves to the existing account", async () => {
  const acme = await seedAccount({ name: "Acme Inc", domain: "acme.com" });
  const other = await seedAccount({ name: "Globex", domain: "globex.com" });
  const existing = [await load(other), await load(acme)];
  const match = matchCandidate({ domain: "acme.com", companyName: "ACME" }, existing);
  expect(match).toEqual({ subjectId: acme, score: 1, signals: ["domain", "name"] });
});

test("same company name, different domain does not auto-match", async () => {
  const acme = await seedAccount({ name: "Acme", domain: "acme.com" });
  const existing = [await load(acme)];
  expect(matchCandidate({ companyName: "Acme", domain: "acme.io" }, existing)).toBeNull();
  expect(matchCandidate({ companyName: "Acme Inc." }, existing)).toBeNull();
});

test("match is case- and whitespace-insensitive on domain", async () => {
  const acme = await seedAccount({ domain: "acme.com" });
  const existing = [await load(acme)];
  for (const domain of ["  ACME.com ", "https://www.Acme.com/about", "acme.com."]) {
    expect(matchCandidate({ domain }, existing)?.subjectId).toBe(acme);
  }
});

test("a business email domain matches, below a stated domain; free-mail never does", async () => {
  const acme = await seedAccount({ domain: "acme.com" });
  const gmail = await seedAccount({ domain: "gmail.com" });
  const existing = [await load(acme), await load(gmail)];
  const viaEmail = matchCandidate({ email: "Jo+news@Acme.com" }, existing);
  expect(viaEmail).toMatchObject({ subjectId: acme, signals: ["email_domain"] });
  expect(viaEmail!.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  expect(viaEmail!.score).toBeLessThan(1);
  expect(matchCandidate({ email: "jo@gmail.com" }, existing)).toBeNull();
});

test("no identifiers or no existing accounts yields null", async () => {
  const acme = await seedAccount({ name: "Acme", domain: "acme.com" });
  expect(matchCandidate({}, [await load(acme)])).toBeNull();
  expect(matchCandidate({ domain: "acme.com" }, [])).toBeNull();
});

test("linkIdentity records the match signals and score", async () => {
  const keep = await seedAccount({ domain: "acme.com" });
  const dupe = await seedAccount({ domain: "acme.com" });
  const linkId = await t.run((ctx) =>
    linkIdentity(ctx, { subjectType: "account", subjectId: keep, mergedFromId: dupe, score: 1, signals: ["domain"] }),
  );
  const link = await raw.run((ctx) => ctx.db.get(linkId));
  expect(link).toMatchObject({
    orgId, subjectType: "account", subjectId: keep, mergedFromId: dupe, score: 1, signals: ["domain"],
  });
  expect(link!.reversedAt).toBeUndefined();
});

test("linkIdentity rejects self-links and subjects of another org", async () => {
  const a = await seedAccount({ domain: "acme.com" });
  const foreign = await seedAccount({ domain: "acme.com" }, otherOrgId);
  const args = { subjectType: "account" as const, score: 1, signals: ["domain"] };
  await expect(t.run((ctx) => linkIdentity(ctx, { ...args, subjectId: a, mergedFromId: a }))).rejects.toThrow(/itself/);
  await expect(t.run((ctx) => linkIdentity(ctx, { ...args, subjectId: a, mergedFromId: foreign }))).rejects.toThrow(/subject not found/);
});

test("unlinkIdentity reverses the link without destroying either subject", async () => {
  const keep = await seedAccount({ name: "Acme", domain: "acme.com" });
  const dupe = await seedAccount({ name: "Acme 2", domain: "acme.com" });
  const linkId = await t.run((ctx) =>
    linkIdentity(ctx, { subjectType: "account", subjectId: keep, mergedFromId: dupe, score: 1, signals: ["domain"] }),
  );
  await t.run((ctx) => unlinkIdentity(ctx, { linkId }));
  const after = await raw.run(async (ctx) => ({
    link: await ctx.db.get(linkId),
    keep: await ctx.db.get(keep),
    dupe: await ctx.db.get(dupe),
  }));
  expect(after.keep).toMatchObject({ display: { name: "Acme" } });
  expect(after.dupe).toMatchObject({ display: { name: "Acme 2" } });
  // the decision stays auditable: signals and score survive, only reversedAt is added
  expect(after.link).toMatchObject({ score: 1, signals: ["domain"] });
  expect(after.link!.reversedAt).toBeTypeOf("number");
  // unlinking twice is a no-op
  await t.run((ctx) => unlinkIdentity(ctx, { linkId }));
});

test("unlinkIdentity refuses another org's link", async () => {
  const a = await seedAccount({ domain: "a.com" });
  const b = await seedAccount({ domain: "b.com" });
  const linkId = await t.run((ctx) =>
    linkIdentity(ctx, { subjectType: "account", subjectId: a, mergedFromId: b, score: 1, signals: [] }),
  );
  const other = await asMember(raw, "u2", otherOrgId);
  await expect(other.run((ctx) => unlinkIdentity(ctx, { linkId }))).rejects.toThrow(/link not found/);
});

test("linkIdentity refuses a second active link for the same pair, in either order, until reversed", async () => {
  const a = await seedAccount({ domain: "acme.com" });
  const b = await seedAccount({ domain: "acme.com" });
  const link = (subjectId: Id<"accounts">, mergedFromId: Id<"accounts">) =>
    t.run((ctx) => linkIdentity(ctx, { subjectType: "account", subjectId, mergedFromId, score: 1, signals: ["domain"] }));
  const first = await link(a, b);
  await expect(link(a, b)).rejects.toThrow(/already exists/);
  await expect(link(b, a)).rejects.toThrow(/already exists/);
  await t.run((ctx) => unlinkIdentity(ctx, { linkId: first }));
  // once reversed, the pair may be linked again
  await expect(link(b, a)).resolves.toBeDefined();
});

test("linkIdentity rejects NaN and out-of-range scores", async () => {
  const a = await seedAccount({ domain: "a.com" });
  const b = await seedAccount({ domain: "b.com" });
  for (const score of [NaN, -0.1, 1.1, Infinity]) {
    await expect(
      t.run((ctx) => linkIdentity(ctx, { subjectType: "account", subjectId: a, mergedFromId: b, score, signals: [] })),
    ).rejects.toThrow(/score must be between 0 and 1/);
  }
});

describe("normalize", () => {
  test("domain", () => {
    expect(normalizeDomain(" HTTP://WWW.Acme.com:8080/x?y#z ")).toBe("acme.com");
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("  ")).toBeNull();
  });
  test("email", () => {
    expect(normalizeEmail(" Jo+tag@WWW.Acme.COM ")).toBe("jo@acme.com");
    expect(normalizeEmail("nope")).toBeNull();
    expect(emailDomain("a@Acme.com")).toBe("acme.com");
  });
  test("company name", () => {
    expect(normalizeCompanyName("  Acme, Inc. ")).toBe("acme");
    expect(normalizeCompanyName("Acme & Sons LLC")).toBe("acme and sons");
    expect(normalizeCompanyName("Inc")).toBe("inc");
  });
});

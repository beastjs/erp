/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("/convex/**/*.ts");

let t: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
let raw: ReturnType<typeof convexTest>;
let sourceId: Id<"sources">;
let otherOrgId: Id<"orgs">;

const subject = { subjectType: "account" as const, subjectId: "acct-1" };

beforeEach(async () => {
  raw = convexTest(schema, modules);
  const seeded = await raw.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 });
    const other = await ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 });
    const source = await ctx.db.insert("sources", { orgId, key: "web", trustWeight: 1 });
    return { orgId, other, source };
  });
  sourceId = seeded.source;
  otherOrgId = seeded.other;
  t = raw.withIdentity({ subject: "u1", orgId: seeded.orgId });
});

const observedDomainClaim = () => ({
  ...subject,
  field: "domain",
  value: "acme.com",
  sourceId,
  method: "observed" as const,
  confidence: 0.9,
  observedAt: 1000,
});

const getClaim = (id: Id<"claims">) => raw.run((ctx) => ctx.db.get(id));

test("appendClaim stores a claim with its orgId", async () => {
  const id = await t.mutation(api.claims.mutations.appendClaim, observedDomainClaim());
  const claims = await t.query(api.claims.queries.claimsForSubject, subject);
  expect(claims).toHaveLength(1);
  expect(claims[0]._id).toBe(id);
  expect(claims[0].orgId).toBe((await getClaim(id))!.orgId);
  expect(claims[0].value).toBe("acme.com");
});

test("appendClaim clamps confidence to the method ceiling", async () => {
  const id = await t.mutation(api.claims.mutations.appendClaim, {
    ...observedDomainClaim(),
    method: "inferred",
    confidence: 0.9,
  });
  expect((await getClaim(id))!.confidence).toBe(0.5);
  const ex = await t.mutation(api.claims.mutations.appendClaim, {
    ...observedDomainClaim(),
    method: "extracted",
    confidence: 0.9,
  });
  expect((await getClaim(ex))!.confidence).toBe(0.7);
});

test("appendClaim rejects confidence outside 0..1", async () => {
  await expect(
    t.mutation(api.claims.mutations.appendClaim, { ...observedDomainClaim(), confidence: 1.4 }),
  ).rejects.toThrow("confidence");
  await expect(
    t.mutation(api.claims.mutations.appendClaim, { ...observedDomainClaim(), confidence: -0.1 }),
  ).rejects.toThrow("confidence");
});

test("claimsForField returns only that field's claims", async () => {
  await t.mutation(api.claims.mutations.appendClaim, observedDomainClaim());
  await t.mutation(api.claims.mutations.appendClaim, {
    ...observedDomainClaim(),
    field: "name",
    value: "Acme",
  });
  const domain = await t.query(api.claims.queries.claimsForField, { ...subject, field: "domain" });
  expect(domain).toHaveLength(1);
  expect(domain[0].field).toBe("domain");
  expect(await t.query(api.claims.queries.claimsForSubject, subject)).toHaveLength(2);
});

test("claims are never updated: a second claim for the same field appends", async () => {
  const a = await t.mutation(api.claims.mutations.appendClaim, observedDomainClaim());
  const b = await t.mutation(api.claims.mutations.appendClaim, {
    ...observedDomainClaim(),
    value: "acme.io",
    observedAt: 2000,
  });
  expect(a).not.toBe(b);
  const claims = await t.query(api.claims.queries.claimsForField, { ...subject, field: "domain" });
  expect(claims.map((c) => c.value).sort()).toEqual(["acme.com", "acme.io"]);
});

test("claims are isolated by org", async () => {
  await t.mutation(api.claims.mutations.appendClaim, observedDomainClaim());
  const other = raw.withIdentity({ subject: "u2", orgId: otherOrgId });
  expect(await other.query(api.claims.queries.claimsForSubject, subject)).toHaveLength(0);
});

test("appendClaim rejects a source from another org", async () => {
  const foreign = await raw.run(async (ctx) =>
    ctx.db.insert("sources", { orgId: otherOrgId, key: "x", trustWeight: 1 }),
  );
  await expect(
    t.mutation(api.claims.mutations.appendClaim, { ...observedDomainClaim(), sourceId: foreign }),
  ).rejects.toThrow("source");
});

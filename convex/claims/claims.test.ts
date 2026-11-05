/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { MAX_CLAIMS } from "./queries";

const modules = import.meta.glob("/convex/**/*.ts");

let t: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
let raw: ReturnType<typeof convexTest>;
let sourceId: Id<"sources">;
let otherOrgId: Id<"orgs">;
let orgId: Id<"orgs">;
let contactId: Id<"contacts">;

let subject: { subjectType: "account"; subjectId: string };

beforeEach(async () => {
  raw = convexTest(schema, modules);
  const seeded = await raw.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 });
    const other = await ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 });
    const source = await ctx.db.insert("sources", { orgId, key: "web", trustWeight: 1 });
    const account = await ctx.db.insert("accounts", { orgId, fields: [], display: {} });
    const contact = await ctx.db.insert("contacts", { orgId, fields: [], display: {} });
    return { orgId, other, source, account, contact };
  });
  sourceId = seeded.source;
  otherOrgId = seeded.other;
  orgId = seeded.orgId;
  contactId = seeded.contact;
  subject = { subjectType: "account", subjectId: seeded.account };
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
  expect(claims[0].orgId).toBe(orgId);
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

test("reads throw instead of truncating when a subject exceeds MAX_CLAIMS", async () => {
  await raw.run(async (ctx) => {
    for (let i = 0; i <= MAX_CLAIMS; i++) {
      await ctx.db.insert("claims", {
        orgId,
        ...subject,
        field: "domain",
        value: `d${i}.com`,
        sourceId,
        method: "observed",
        confidence: 0.9,
        observedAt: i,
      });
    }
  });
  const limit = new RegExp(`limit ${MAX_CLAIMS}`);
  await expect(t.query(api.claims.queries.claimsForSubject, subject)).rejects.toThrow(limit);
  await expect(
    t.query(api.claims.queries.claimsForField, { ...subject, field: "domain" }),
  ).rejects.toThrow(limit);
});

test("appendClaim rejects a subject id that is not valid for the declared subjectType", async () => {
  const append = (over: object) =>
    t.mutation(api.claims.mutations.appendClaim, { ...observedDomainClaim(), ...over });
  await expect(append({ subjectId: "acct-1" })).rejects.toThrow("invalid subject id");
  // A contact id presented as an account, and an account id presented as a contact.
  await expect(append({ subjectId: contactId })).rejects.toThrow("invalid subject id");
  await expect(append({ subjectType: "contact" })).rejects.toThrow("invalid subject id");
});

test("appendClaim rejects a well-formed subject id that names no row", async () => {
  const gone = await raw.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", { orgId, fields: [], display: {} });
    await ctx.db.delete(id);
    return id;
  });
  await expect(
    t.mutation(api.claims.mutations.appendClaim, { ...observedDomainClaim(), subjectId: gone }),
  ).rejects.toThrow("subject not found");
});

test("appendClaim rejects a subject belonging to another org", async () => {
  const foreign = await raw.run((ctx) =>
    ctx.db.insert("accounts", { orgId: otherOrgId, fields: [], display: {} }),
  );
  await expect(
    t.mutation(api.claims.mutations.appendClaim, { ...observedDomainClaim(), subjectId: foreign }),
  ).rejects.toThrow("subject not found");
});

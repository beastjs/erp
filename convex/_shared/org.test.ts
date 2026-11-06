/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../schema";
import { resolveOrg, withOrg, withTrustedOrgForInternalOnly } from "./org";

const modules = import.meta.glob("../**/*.ts");

test("withOrg rejects a request with no org context", async () => {
  const t = convexTest(schema, modules);
  await expect(t.run((ctx) => withOrg(ctx, {}))).rejects.toThrow("no org context");
});

test("withOrg rejects an identity that carries no orgId", async () => {
  const t = convexTest(schema, modules).withIdentity({ subject: "u1" });
  await expect(t.run((ctx) => withOrg(ctx, {}))).rejects.toThrow("no org context");
});

test("withOrg returns the caller's orgId", async () => {
  const t = convexTest(schema, modules);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 }),
  );
  const asOrg = t.withIdentity({ subject: "u1", orgId });
  expect(await asOrg.run((ctx) => withOrg(ctx, {}))).toEqual({ orgId });
});

async function newOrg(t: ReturnType<typeof convexTest>) {
  return await t.run((ctx) => ctx.db.insert("orgs", { name: "Org", createdAt: 0 }));
}

// The point of the seam: an internal context must present NO actor, not a counterfeit one. A scheduled function has
// no identity, so anything that asks for an actor (an audit record's createdBy) must get null and handle it loudly.
test("an internal context presents NO identity: getUserIdentity() is null, not a fabricated actor", async () => {
  const t = convexTest(schema, modules);
  const orgId = await newOrg(t);
  const identity = await t.run((ctx) => withTrustedOrgForInternalOnly(ctx, orgId).auth.getUserIdentity());
  expect(identity).toBeNull();
});

test("wrapping never replaces a real identity either: auth is untouched", async () => {
  const t = convexTest(schema, modules);
  const orgId = await newOrg(t);
  const asUser = t.withIdentity({ subject: "alice", orgId });
  const identity = await asUser.run((ctx) => withTrustedOrgForInternalOnly(ctx, orgId).auth.getUserIdentity());
  expect(identity?.subject).toBe("alice");
});

test("resolveOrg returns the trusted org of an internal context, with no identity at all", async () => {
  const t = convexTest(schema, modules);
  const orgId = await newOrg(t);
  expect(await t.run((ctx) => resolveOrg(withTrustedOrgForInternalOnly(ctx, orgId)))).toEqual({ orgId });
});

test("withOrg stays identity-only: a trusted org does not satisfy a public entry's check", async () => {
  const t = convexTest(schema, modules);
  const orgId = await newOrg(t);
  await expect(t.run((ctx) => withOrg(withTrustedOrgForInternalOnly(ctx, orgId), {}))).rejects.toThrow("no org context");
});

test("resolveOrg on an ordinary context falls back to the identity's claim, and rejects without one", async () => {
  const t = convexTest(schema, modules);
  const orgId = await newOrg(t);
  expect(await t.withIdentity({ subject: "u1", orgId }).run((ctx) => resolveOrg(ctx))).toEqual({ orgId });
  await expect(t.run((ctx) => resolveOrg(ctx))).rejects.toThrow("no org context");
  await expect(t.withIdentity({ subject: "u1" }).run((ctx) => resolveOrg(ctx))).rejects.toThrow("no org context");
});

test("a trusted org that is not an org id fails closed", async () => {
  const t = convexTest(schema, modules);
  await expect(t.run((ctx) => resolveOrg(withTrustedOrgForInternalOnly(ctx, "nope" as never)))).rejects.toThrow("no org context");
});

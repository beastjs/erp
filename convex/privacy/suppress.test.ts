/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { asMember } from "../_shared/testkit.support";
import schema from "../schema";
import { addSuppression, getSuppressionSalt, isSuppressed, leadIdentifiers, suppressionHash } from "./suppress";

const modules = import.meta.glob("/convex/**/*.ts");
const SALT = "unit-test-salt-0123456789abcdef";

let raw: ReturnType<typeof convexTest>;
let t: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
let orgId: Id<"orgs">;
beforeEach(async () => {
  raw = convexTest(schema, modules);
  orgId = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 }));
  t = await asMember(raw, "u1", orgId);
});
afterEach(() => vi.unstubAllEnvs());

test("the hash is a keyed digest: stable, 256-bit, spelling-insensitive, and not the identifier", async () => {
  const a = await suppressionHash(" Bob+x@ACME.com ", SALT);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(a).toBe(await suppressionHash("bob@acme.com", SALT));
  expect(a).not.toContain("bob");
  expect(a).not.toBe(await suppressionHash("bob@acme.com", SALT + "x"));
  expect(a).not.toBe(await suppressionHash("bob2@acme.com", SALT));
});

test("naming the kind or leaving it to inference hashes alike, so what add() stores is what ingest looks up", async () => {
  expect(await suppressionHash("Bob@acme.com", SALT)).toBe(await suppressionHash("bob@acme.com", SALT, "email"));
  expect(await suppressionHash("+1 555 010 1234", SALT)).toBe(await suppressionHash("15550101234", SALT, "phone"));
  expect(await suppressionHash("acme.com", SALT)).toBe(await suppressionHash("https://www.acme.com/x", SALT, "domain"));
  expect(await suppressionHash("acme.com", SALT, "domain")).not.toBe(await suppressionHash("acme.org", SALT, "domain"));
});

test("a lead's identifiers include its contact's email DOMAIN even when the account sits on another domain", () => {
  const out = leadIdentifiers(
    { fields: [{ field: "domain", value: "acme.com" }], display: { domain: "acme.com" } },
    { fields: [{ field: "email", value: "x@mail.example.org" }, { field: "phone", value: "15550101234" }], display: { email: "x@mail.example.org" } },
  );
  expect(out).toEqual([
    { kind: "email", value: "x@mail.example.org" },
    { kind: "domain", value: "mail.example.org" },
    { kind: "phone", value: "15550101234" },
    { kind: "domain", value: "acme.com" },
  ]);
});

test("a missing, blank or short salt FAILS CLOSED, in the hash function and in the env reader", async () => {
  for (const bad of ["", "   ", "short", " ".repeat(40)]) {
    await expect(suppressionHash("bob@acme.com", bad), JSON.stringify(bad)).rejects.toThrow(/salt/);
  }
  vi.stubEnv("SUPPRESSION_SALT", "");
  expect(() => getSuppressionSalt()).toThrow(/not configured/);
  vi.stubEnv("SUPPRESSION_SALT", "short");
  expect(() => getSuppressionSalt()).toThrow(/not configured/);
  vi.stubEnv("SUPPRESSION_SALT", undefined as unknown as string);
  expect(() => getSuppressionSalt()).toThrow(/not configured/);
});

test("with the salt unset, neither adding nor looking up answers: no silent 'not suppressed'", async () => {
  await t.run((ctx) => addSuppression(ctx, { identifier: "bob@acme.com", reason: "manual" }));
  vi.stubEnv("SUPPRESSION_SALT", "");
  await expect(t.run((ctx) => isSuppressed(ctx, { identifier: "bob@acme.com" }))).rejects.toThrow(/not configured/);
  await expect(t.run((ctx) => isSuppressed(ctx, { identifier: "someone-else@acme.com" }))).rejects.toThrow(/not configured/);
  await expect(t.run((ctx) => addSuppression(ctx, { identifier: "x@acme.com", reason: "manual" }))).rejects.toThrow(/not configured/);
});

test("a rotated salt is detected and refused, not read as an empty list", async () => {
  await t.run((ctx) => addSuppression(ctx, { identifier: "bob@acme.com", reason: "erasure" }));
  vi.stubEnv("SUPPRESSION_SALT", "a-different-salt-0123456789abcdef");
  await expect(t.run((ctx) => isSuppressed(ctx, { identifier: "bob@acme.com" }))).rejects.toThrow(/differs/);
  await expect(t.run((ctx) => addSuppression(ctx, { identifier: "new@acme.com", reason: "manual" }))).rejects.toThrow(/differs/);
});

test("the table holds a hash, never the identifier", async () => {
  await t.run((ctx) => addSuppression(ctx, { identifier: "Bob@Acme.com", reason: "erasure" }));
  const rows = await raw.run((ctx) => ctx.db.query("suppressions").collect());
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toMatch(/bob|acme/i);
  expect(rows[0]).toMatchObject({ orgId, kind: "email", reason: "erasure" });
});

test("isSuppressed matches every spelling of what was added, and nothing else", async () => {
  const first = await t.run((ctx) => addSuppression(ctx, { identifier: "Bob@Acme.com", reason: "erasure" }));
  expect(first.created).toBe(true);
  for (const same of ["bob@acme.com", " BOB+promo@ACME.COM ", "ｂｏｂ@ａｃｍｅ.ｃｏｍ"]) {
    expect(await t.run((ctx) => isSuppressed(ctx, { identifier: same })), same).toBe(true);
  }
  expect(await t.run((ctx) => isSuppressed(ctx, { identifier: "rob@acme.com" }))).toBe(false);
  // Suppressing a person does not suppress the company; the domain is its own entry.
  expect(await t.run((ctx) => isSuppressed(ctx, { identifier: "acme.com", kind: "domain" }))).toBe(false);
});

test("adding twice is idempotent", async () => {
  const a = await t.run((ctx) => addSuppression(ctx, { identifier: "bob@acme.com", reason: "manual" }));
  const b = await t.run((ctx) => addSuppression(ctx, { identifier: "BOB+z@acme.com", reason: "erasure" }));
  expect(b).toEqual({ id: a.id, created: false });
  expect(await raw.run((ctx) => ctx.db.query("suppressions").collect())).toHaveLength(1);
});

test("the list is per org", async () => {
  await t.run((ctx) => addSuppression(ctx, { identifier: "bob@acme.com", reason: "manual" }));
  const other = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
  const o = await asMember(raw, "u2", other);
  expect(await o.run((ctx) => isSuppressed(ctx, { identifier: "bob@acme.com" }))).toBe(false);
});

test("an unusable identifier is refused on both paths", async () => {
  await expect(t.run((ctx) => addSuppression(ctx, { identifier: "   ", reason: "manual" }))).rejects.toThrow(/not a usable/);
  await expect(t.run((ctx) => isSuppressed(ctx, { identifier: "@" }))).rejects.toThrow(/not a usable/);
});

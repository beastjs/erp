/// <reference types="vite/client" />
import { expect, test } from "vitest";

const files = import.meta.glob("/convex/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const sources = Object.entries(files).filter(([p]) => !p.endsWith(".test.ts") && !p.includes("/_generated/"));
const REDACT = "/convex/privacy/redact.ts";
const MUTATE = /\bdb\.(patch|replace|delete)\(/;
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = (path: string) => strip(files[path] ?? "");
const where = (pattern: RegExp) => sources.filter(([, s]) => pattern.test(strip(s))).map(([p]) => p).sort();

/*
 * `claims` is the system of record and is APPEND-ONLY. Erasure (spec 7.3) is the one sanctioned exception, and it must
 * stay the ONLY one: this task would otherwise quietly license mutating the ledger. Convex's `db.patch(id, ...)`
 * takes no table name, so a purely lexical guard cannot see which table a patch hits. Three independent lexical nets
 * (none sufficient alone, all cheap), backed by redact.test.ts which proves at runtime that redaction changes nothing
 * but `value` and `redactedAt`:
 *   1. no non-test file may name the table in a write: patch/replace/delete("claims", ...);
 *   2. no non-test file may hand a claim-named identifier to patch/replace/delete;
 *   3. the files that read the claims table AND mutate anything are PINNED, so a new one must be added here on purpose.
 */

test("the guard's own patterns match what they are meant to catch", () => {
  const writeByName = /\bdb\.(patch|replace|delete)\(\s*"claims"/;
  const claimIdent = /\bdb\.(patch|replace|delete)\(\s*[\w.]*[cC]laim\w*(?:\._id)?\s*[,)]/;
  expect(writeByName.test('await ctx.db.patch("claims", id, { value: 1 })')).toBe(true);
  expect(claimIdent.test("await ctx.db.delete(claim._id)")).toBe(true);
  expect(claimIdent.test("await ctx.db.patch(args.claimId, {})")).toBe(true);
  expect(claimIdent.test("await ctx.db.patch(state._id, {})")).toBe(false);
  // and the one file allowed to redact does contain a patch of a claim row, so these are not matching nothing
  expect(claimIdent.test(code(REDACT)) || /patch\(row\._id, \{ value: null, redactedAt/.test(code(REDACT))).toBe(true);
});

test("1+2. nothing but privacy/redact.ts writes to a claim", () => {
  const writeByName = /\bdb\.(patch|replace|delete)\(\s*"claims"/;
  const claimIdent = /\bdb\.(patch|replace|delete)\(\s*[\w.]*[cC]laim\w*(?:\._id)?\s*[,)]/;
  expect(where(writeByName).filter((p) => p !== REDACT)).toEqual([]);
  expect(where(claimIdent).filter((p) => p !== REDACT)).toEqual([]);
  expect(where(/\bdb\.insert\(\s*"claims"/)).toEqual(["/convex/claims/mutations.ts"]);
});

test("3. the files that touch the claims table and mutate something are pinned", () => {
  const touchesClaims = /\.query\(\s*"claims"\s*\)|\.insert\(\s*"claims"/;
  const touching = where(touchesClaims).filter((p) => MUTATE.test(code(p)));
  // Each of these mutates OTHER tables (pipelineState, leads, candidates...) next to a claims read.
  // The redaction itself lives in privacy/redact.ts. A new entry here is a decision to review, not a formality.
  expect(touching).toEqual(["/convex/leads/mutations.ts", "/convex/pipeline/stages.ts", "/convex/privacy/redact.ts"]);
});

test("redact.ts redacts a claim by setting exactly value and redactedAt, and nothing else", () => {
  const patches = [...code(REDACT).matchAll(/db\.patch\(row\._id, (\{[^}]*\})\)/g)].map((m) => m[1]);
  expect(patches).toContain("{ value: null, redactedAt: now }");
  expect(code(REDACT)).not.toMatch(/\bdb\.replace\(/);
});

/*
 * `leads` is immutable apart from the two lifecycle setters, now joined by ONE lawful override (erasure). The setters
 * must stay exactly two and the override exactly one; the override must not touch the lifecycle through a second door.
 */
test("leads: one insert, two lifecycle writers in leads/mutations.ts, ONE redaction writer in privacy/redact.ts", () => {
  expect(where(/\bdb\.insert\(\s*"leads"/)).toEqual(["/convex/leads/mutations.ts"]);
  const leadPatch = /\bdb\.(patch|replace|delete)\(\s*lead\b[\w.]*/g;
  const count = (path: string) => (code(path).match(leadPatch) ?? []).length;
  expect(count("/convex/leads/mutations.ts")).toBe(2);
  expect(count(REDACT)).toBe(1);
  const elsewhere = sources.map(([p]) => p).filter((p) => p !== REDACT && p !== "/convex/leads/mutations.ts" && count(p) > 0);
  expect(elsewhere).toEqual([]);
  expect(where(/\bdb\.(patch|replace|delete)\(\s*"leads"/)).toEqual([]);
  // the setters still write one field each
  const setters = [...code("/convex/leads/mutations.ts").matchAll(/db\.patch\(lead\._id, (\{[^}]*\})\)/g)].map((m) => m[1]);
  expect(setters).toEqual(["{ inventoryState: args.state }", "{ disposition: args.disposition }"]);
});

test("suppressions and erasure records are append-only: nothing deletes or rewrites a suppression", () => {
  expect(where(/\bdb\.(patch|replace|delete)\(\s*[\w.]*suppression\w*/i)).toEqual([]);
  expect(where(/\bdb\.insert\(\s*"suppressions"/)).toEqual(["/convex/privacy/suppress.ts"]);
  expect(where(/\bdb\.insert\(\s*"erasures"/)).toEqual([REDACT]);
});

test("the suppression secret is read in exactly one place", () => {
  expect(where(/SUPPRESSION_SALT/)).toEqual(["/convex/privacy/suppress.ts"]);
});

test("a lookup is never a caller-supplied boolean: no lead function takes `suppressed` as a parameter", () => {
  const leads = code("/convex/leads/mutations.ts");
  expect(leads).not.toMatch(/\bsuppressed\s*:\s*boolean/);
  expect(leads).toMatch(/refuseSuppliedSuppression/);
});

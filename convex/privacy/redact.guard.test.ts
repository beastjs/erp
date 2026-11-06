/// <reference types="vite/client" />
import { expect, test } from "vitest";

const files = import.meta.glob("/convex/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const sources = Object.entries(files).filter(([p]) => !p.endsWith(".test.ts") && !p.includes("/_generated/"));
const REDACT = "/convex/privacy/redact.ts";
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = (path: string) => strip(files[path] ?? "");
const where = (pattern: RegExp | ((src: string) => boolean)) =>
  sources.filter(([, s]) => (typeof pattern === "function" ? pattern(strip(s)) : pattern.test(strip(s)))).map(([p]) => p).sort();

/*
 * `claims` is the system of record and is APPEND-ONLY. Erasure (spec 7.3) is the one sanctioned exception, and it must
 * stay the ONLY one: this task would otherwise quietly license mutating the ledger. A purely lexical guard cannot see
 * which table `db.patch(x._id, ...)` hits, and Convex accepts BOTH `db.patch(id, v)` and `db.patch("table", id, v)`
 * (the latter is the form current Convex prefers, and `projections/build.ts` already uses it). So there are three
 * nets, each shown below to catch a mutation the other two miss, and none certified by a fallback:
 *   N1  the table is named in the write:          db.patch("claims", id, ...)
 *   N2  the target is spelled as a claim:         db.patch(claim._id, ...)
 *   N3  the file TOUCHES claims in any way (names the table, or handles a `claimId`) and mutates: every mutation
 *       call in it has its first argument PINNED. A claim fetched by `db.get(f.claimId)` and mutated through any
 *       variable is a new first argument in a touching file, or a mutation in a new touching file, and fails here.
 * redact.test.ts proves at runtime what no lexical check can: redaction changes nothing but `value` and `redactedAt`,
 * and a whole pipeline run leaves every claim untouched.
 */

/** The first argument of every `db.patch|replace|delete(` call, as written, in order. Balanced: `f(a, b)` is one argument. */
export function mutatedTargets(source: string): string[] {
  const out: string[] = [];
  const call = /\bdb\.(?:patch|replace|delete)\(/g;
  for (let m = call.exec(source); m; m = call.exec(source)) {
    let depth = 0;
    let i = call.lastIndex;
    const start = i;
    for (; i < source.length; i++) {
      const c = source[i]!;
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) break;
    }
    out.push(source.slice(start, i).trim());
  }
  return out;
}

/** N1 / N2 / N3's "touches claims". Each takes stripped source. */
export const nets = {
  namedTable: (table: string) => (src: string) => new RegExp(`\\bdb\\.(?:patch|replace|delete)\\(\\s*["'\`]${table}["'\`]`).test(src),
  claimSpelled: (src: string) => /\bdb\.(?:patch|replace|delete)\(\s*[\w.]*[cC]laim\w*(?:\._id)?\s*[,)]/.test(src),
  touchesClaims: (src: string) => /["'`]claims["'`]|\bclaimId\b/.test(src),
  touchesLeads: (src: string) => /["'`]leads["'`]|\bleadId\b/.test(src),
};
/** The files that touch a table and mutate anything, with the exact first argument of each mutation. */
const mutatorsTouching = (touches: (src: string) => boolean): Record<string, string[]> =>
  Object.fromEntries(
    sources
      .map(([p, s]) => [p, strip(s)] as const)
      .filter(([, s]) => touches(s) && mutatedTargets(s).length > 0)
      .map(([p, s]) => [p, mutatedTargets(s)] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

test("the guard's own helpers read real code: they find the sanctioned claim write in redact.ts, and N1 matches real code of its shape", () => {
  // No fallback and no synthetic string: these run over the actual files.
  const redact = mutatedTargets(code(REDACT));
  expect(redact.length).toBeGreaterThan(5);
  expect(redact).toContain("row._id");
  expect(/db\.patch\(row\._id, \{ value: null, redactedAt: now \}\)/.test(code(REDACT))).toBe(true);
  expect(nets.touchesClaims(code(REDACT))).toBe(true);
  // build.ts really writes `db.patch("accounts", ...)`: the named-table net's SHAPE matches live code, so it is not a dead pattern.
  expect(nets.namedTable("accounts")(code("/convex/projections/build.ts"))).toBe(true);
  expect(mutatedTargets('await ctx.db.patch(normalizeId("claims", a, b), { x: 1 }); await ctx.db.delete(k._id)')).toEqual(['normalizeId("claims", a, b)', "k._id"]);
});

/*
 * Each net must catch a mutation the OTHER two miss, or it is redundant (and "redundant" is how a net rots unnoticed).
 * A mutant is a source file that mutates a claim; `caught` is which nets see it.
 */
const caughtBy = (mutant: string) => ({
  N1: nets.namedTable("claims")(strip(mutant)),
  N2: nets.claimSpelled(strip(mutant)),
  // N3 sees a mutant iff it touches claims AND is not the pinned set (a new file, or a new first argument)
  N3: nets.touchesClaims(strip(mutant)) && mutatedTargets(strip(mutant)).length > 0,
});
test.each([
  ["a write that names the table", 'await ctx.db.patch("claims", id, { value: 1 });', { N1: true, N2: false, N3: true }],
  // N3 also sees this one only because the table literal is present; the claim-spelled write below has none
  ["a claim-spelled target with no claims literal and no claimId in the file", "const x = await ctx.db.get(id);\nawait ctx.db.patch(claim._id, { value: 1 });", { N1: false, N2: true, N3: false }],
  ["a claim fetched through a projection field's claimId and mutated through an unremarkable name", "const c = await ctx.db.get(f.claimId);\nawait ctx.db.patch(c._id, { value: 1 });", { N1: false, N2: false, N3: true }],
])("net separation: %s", (_name, mutant, expected) => {
  expect(caughtBy(mutant)).toEqual(expected);
});

test("1. nothing writes to a claim by naming the table", () => {
  expect(where(nets.namedTable("claims"))).toEqual([]);
  expect(where(/\bdb\.insert\(\s*"claims"/)).toEqual(["/convex/claims/mutations.ts"]);
});

test("2. nothing hands a claim-spelled identifier to patch/replace/delete", () => {
  expect(where(nets.claimSpelled)).toEqual([]);
});

test("3. every mutation in a file that touches claims is accounted for, argument by argument", () => {
  // Each of these mutates OTHER tables (pipelineState, leads, candidates, accounts, contacts...) next to a claims read or a
  // claimId. The redaction itself lives in privacy/redact.ts. A change here is a decision to review, not a formality.
  expect(mutatorsTouching(nets.touchesClaims)).toEqual({
    "/convex/leads/mutations.ts": ["lead._id", "lead._id"],
    "/convex/pipeline/stages.ts": ["state._id", "state._id", "state._id", "state._id", "state._id", "state._id", "state._id", "existing._id", "state._id"],
    "/convex/privacy/redact.ts": ["row._id", "lead._id", "state._id", "row._id", "key._id", "row._id", "record._id", "record._id"],
    "/convex/projections/build.ts": ['"accounts"', '"contacts"'],
  });
});

test("redact.ts redacts a claim by setting exactly value and redactedAt, and nothing else", () => {
  const patches = [...code(REDACT).matchAll(/db\.patch\(row\._id, (\{[^}]*\})\)/g)].map((m) => m[1]);
  expect(patches).toContain("{ value: null, redactedAt: now }");
  expect(code(REDACT)).not.toMatch(/\bdb\.replace\(/);
});

/*
 * `leads` is immutable apart from the two lifecycle setters, now joined by ONE lawful override (erasure). The setters
 * must stay exactly two and the override exactly one; the override must not touch the lifecycle through a second door.
 * Matching on the variable's NAME (`lead`) would let `db.patch(l._id, ...)` in a new file count as nothing, so this
 * pins every mutation's first argument in every file that touches `leads` at all, whatever the variable is called.
 */
test("leads: one insert, two lifecycle writers in leads/mutations.ts, ONE redaction writer in privacy/redact.ts, whatever the variable is called", () => {
  expect(where(/\bdb\.insert\(\s*"leads"/)).toEqual(["/convex/leads/mutations.ts"]);
  expect(where(nets.namedTable("leads"))).toEqual([]);
  expect(mutatorsTouching(nets.touchesLeads)).toEqual({
    "/convex/leads/mutations.ts": ["lead._id", "lead._id"],
    "/convex/pipeline/stages.ts": ["state._id", "state._id", "state._id", "state._id", "state._id", "state._id", "state._id", "existing._id", "state._id"],
    "/convex/privacy/redact.ts": ["row._id", "lead._id", "state._id", "row._id", "key._id", "row._id", "record._id", "record._id"],
  });
  // the redaction override is exactly one write of the lead
  expect(mutatedTargets(code(REDACT)).filter((x) => x === "lead._id")).toHaveLength(1);
  // the setters still write one field each
  const setters = [...code("/convex/leads/mutations.ts").matchAll(/db\.patch\(lead\._id, (\{[^}]*\})\)/g)].map((m) => m[1]);
  expect(setters).toEqual(["{ inventoryState: args.state }", "{ disposition: args.disposition }"]);
});

test("net separation for leads: an aliased lead write is seen by the pin, not by a spelling", () => {
  const mutant = 'const l = await ctx.db.get(args.leadId);\nawait ctx.db.patch(l._id, { disposition: "Delivered" });';
  expect(/\bdb\.(patch|replace|delete)\(\s*lead\b/.test(mutant)).toBe(false); // what the old net looked for
  expect(nets.touchesLeads(mutant) && mutatedTargets(mutant)).toEqual(["l._id"]);
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

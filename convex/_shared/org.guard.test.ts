/// <reference types="vite/client" />
import { expect, test } from "vitest";

const NAME = "withTrustedOrgForInternalOnly";
const files = import.meta.glob("/convex/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/**
 * Two lexical holes are closed here (org.args.guard.test.ts closes the third, a public `orgId` argument):
 *  1. `withTrustedOrgForInternalOnly` hands any ctx a trusted org that `resolveOrg` then believes without an identity.
 *     It is only safe inside an internal function, whose `orgId` argument a client cannot reach. Used in a public
 *     function, a helper or a module top level, it would let client-influenced data pick the org.
 *  2. The `trustedOrgId` ctx field IS the trust. If any file other than org.ts wrote it (an object literal, an
 *     `Object.assign`, a hand-built ctx) it would bypass guard 1 entirely, so no other non-test file may name it.
 *     Likewise nothing but org.ts may fabricate an identity: `getUserIdentity:` may not be defined in non-test code.
 *
 * Returns the offending locations of NAME in `source`: any use that is not directly inside a top-level
 * `export const x = internalMutation|internalAction|internalQuery(...)`. The nearest top-level
 * declaration above a use must be such a registration; a use after a plain helper, a public
 * `mutation(...)`, or anywhere else is reported.
 */
export function misplacedUses(source: string): string[] {
  const bad: string[] = [];
  const lines = source.split("\n");
  let owner = "";
  lines.forEach((line, i) => {
    const decl = /^(?:export\s+)?(?:async\s+)?(?:const|function)\s+(\w+)\s*(?:=\s*(\w+)\()?/.exec(line);
    if (decl) owner = decl[2] ?? `function:${decl[1]}`;
    if (line.startsWith("import ") || !line.includes(NAME)) return;
    if (!/^internal(Mutation|Action|Query)$/.test(owner)) bad.push(`line ${i + 1} (inside ${owner || "top level"})`);
  });
  return bad;
}

test("the guard recognises misuse", () => {
  const ok = `export const a = internalMutation({\n  handler: async (c) => {\n    ${NAME}(c, o);\n  },\n});`;
  const publicFn = `export const a = mutation({\n  handler: async (c) => {\n    ${NAME}(c, o);\n  },\n});`;
  const helper = `export const a = internalMutation({ handler: async () => null });\nexport async function help(c) {\n  ${NAME}(c, o);\n}`;
  expect(misplacedUses(ok)).toEqual([]);
  expect(misplacedUses(publicFn)).toHaveLength(1);
  expect(misplacedUses(helper)).toHaveLength(1);
});

test("every use of the org-impersonating ctx wrapper sits inside an internal function registration", () => {
  const offenders: string[] = [];
  let uses = 0;
  for (const [path, source] of Object.entries(files)) {
    if (path.endsWith(".test.ts") || path.endsWith("/_shared/org.ts")) continue;
    if (!source.includes(NAME)) continue;
    const bad = misplacedUses(source);
    uses += source.split("\n").filter((l) => !l.startsWith("import ") && l.includes(NAME)).length;
    offenders.push(...bad.map((b) => `${path}: ${b}`));
  }
  expect(uses).toBeGreaterThanOrEqual(3); // a rename that silently matches nothing must not pass
  expect(offenders).toEqual([]);
});

/** Non-test, non-org.ts files whose source matches `pattern`. */
function filesMatching(pattern: RegExp): string[] {
  return Object.entries(files)
    .filter(([path]) => !path.endsWith(".test.ts") && !path.endsWith("/_shared/org.ts") && !path.includes("/_generated/"))
    .filter(([, source]) => pattern.test(source))
    .map(([path]) => path);
}

test("the trusted-org ctx field and a fabricated identity are never written outside org.ts", () => {
  expect(filesMatching(/\btrustedOrgId\b/)).toEqual([]);
  expect(filesMatching(/\bgetUserIdentity\s*:/)).toEqual([]);
  // self-check: the patterns do match the one place that is allowed to name them, so they are not matching nothing
  const org = files["/convex/_shared/org.ts"] ?? "";
  expect(/\btrustedOrgId\b/.test(org)).toBe(true);
  expect(/\btrustedOrgId\b/.test("const ctx = { trustedOrgId: o };")).toBe(true);
  expect(/\bgetUserIdentity\s*:/.test("auth: { getUserIdentity: async () => fake }")).toBe(true);
});

test("the old identity-fabricating helper is gone", () => {
  expect(filesMatching(/unsafeCtxAsOrgForInternalOnly/)).toEqual([]);
});

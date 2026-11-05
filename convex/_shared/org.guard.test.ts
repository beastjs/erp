/// <reference types="vite/client" />
import { expect, test } from "vitest";

const NAME = "unsafeCtxAsOrgForInternalOnly";
const files = import.meta.glob("/convex/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/**
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

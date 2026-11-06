/// <reference types="vite/client" />
import { expect, test } from "vitest";

const files = import.meta.glob("/convex/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/**
 * `org.guard.test.ts` is lexical: it checks WHERE the org-impersonating wrapper is used, and would still pass if a
 * public function took a client-supplied `orgId` and forwarded it inward. This closes that hole from the other
 * side: no PUBLIC registration (query, mutation, action) may declare an `orgId` argument, however deeply nested.
 * Internal registrations may, and must: it is how scheduled work carries the org.
 */
export function publicOrgArgs(source: string): string[] {
  const bad: string[] = [];
  const decl = /export const (\w+)\s*=\s*(query|mutation|action)\(\{/g;
  for (let m = decl.exec(source); m; m = decl.exec(source)) {
    const argsAt = source.indexOf("args:", m.index);
    const next = source.indexOf("export const", m.index + 1);
    if (argsAt === -1 || (next !== -1 && argsAt > next)) continue;
    const open = source.indexOf("{", argsAt);
    let depth = 0;
    let end = open;
    for (; end < source.length; end++) {
      if (source[end] === "{") depth++;
      else if (source[end] === "}" && --depth === 0) break;
    }
    if (/\borgId\s*:/.test(source.slice(open, end + 1))) bad.push(m[1]!);
  }
  return bad;
}

test("the guard recognises a public function declaring orgId, nested or not", () => {
  expect(publicOrgArgs(`export const a = mutation({\n  args: { orgId: v.id("orgs") },\n  handler: async () => null,\n});`)).toEqual(["a"]);
  expect(publicOrgArgs(`export const b = query({\n  args: { x: v.object({ orgId: v.id("orgs") }) },\n  handler: async () => null,\n});`)).toEqual(["b"]);
  expect(publicOrgArgs(`export const c = internalMutation({\n  args: { orgId: v.id("orgs") },\n  handler: async () => null,\n});`)).toEqual([]);
  expect(publicOrgArgs(`export const d = action({\n  args: { runId: v.id("discoveryRuns") },\n  handler: async () => null,\n});`)).toEqual([]);
});

test("no public function in convex/ declares an orgId argument", () => {
  const offenders: string[] = [];
  let registrations = 0;
  for (const [path, source] of Object.entries(files)) {
    if (path.endsWith(".test.ts") || path.includes("/_generated/")) continue;
    registrations += (source.match(/export const \w+\s*=\s*(query|mutation|action)\(\{/g) ?? []).length;
    offenders.push(...publicOrgArgs(source).map((n) => `${path}: ${n}`));
  }
  expect(registrations).toBeGreaterThan(10); // a pattern that silently matches nothing must not pass
  expect(offenders).toEqual([]);
});

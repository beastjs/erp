/// <reference types="vite/client" />
import { expect, test } from "vitest";

const files = import.meta.glob("/convex/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
type Files = Record<string, string>;
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const isProduct = (p: string) => !/\.test\.ts$/.test(p) && !p.includes("/_generated/");
const product = (all: Files): Files => Object.fromEntries(Object.entries(all).filter(([p]) => isProduct(p)).map(([p, s]) => [p, strip(s)]));

/*
 * `verifications` is APPEND-ONLY and CONTENT-FREE (verify/schema.ts). Content-freedom is pinned by a test that walks
 * the table's validator; this file pins who may WRITE. A verification is history ("what the rules said then"), and the
 * only writer, `recordVerification`, validates at its boundary (the claim is this subject's, live, of this kind; the
 * clock is its own), so a second writer would bypass all of it. Three nets, each shown by the table below to catch a
 * mutant the other two miss, and none certified by a fallback or a variable's spelling:
 *
 *   A  the table's NAME (the quoted literal) appears in exactly one product file, verify/mutations.ts. Every read and
 *      write of the table is spelled with it, so a new reader or writer must be added here on purpose.
 *   B  that file never patches, replaces or deletes, and inserts at exactly one site.
 *   C  a file that reaches rows WITHOUT naming the table (it imports the helpers and is handed a row) may not mutate
 *      anything but the pinned targets below. Matched on the SHAPE of the call's first argument, not a variable name.
 */
const MUTATIONS = "/convex/verify/mutations.ts";

/** The first argument of every `db.patch|replace|delete(` call, as written, in order. Balanced: `f(a, b)` is one argument. Same reading as privacy/redact.guard.test.ts. */
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

const NAMES_TABLE = /["'`]verifications["'`]/;
/** The module's own files; every OTHER file that imports one of them is a consumer. Exact paths, not the directory: a new file in verify/ is a consumer until pinned. */
const VERIFY_FILES = new Set(["/convex/verify/mutations.ts", "/convex/verify/structural.ts", "/convex/verify/schema.ts", "/convex/verify/lists.ts"]);

/** Absolute paths a file imports (static `from "..."` and `import("...")`), relative specifiers resolved against the file. One regex pass each, over a bounded alphabet. */
function importsOf(path: string, src: string): string[] {
  const specs = [...src.matchAll(/\bfrom\s+["']([^"']+)["']/g), ...src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!);
  const dir = path.slice(0, path.lastIndexOf("/"));
  return specs
    .filter((x) => x.startsWith("."))
    .map((x) => {
      const parts = dir.split("/");
      for (const seg of x.split("/")) {
        if (seg === "..") parts.pop();
        else if (seg !== ".") parts.push(seg);
      }
      return `${parts.join("/")}.ts`;
    });
};
/** Consumers of the verify module that do not name the table: they hold rows only because a helper handed them over. */
const reachesWithoutNaming = (path: string, src: string) => !VERIFY_FILES.has(path) && importsOf(path, src).some((i) => VERIFY_FILES.has(i)) && !NAMES_TABLE.test(src);

const netA = (all: Files) => Object.keys(all).filter((p) => NAMES_TABLE.test(all[p]!) && p !== MUTATIONS).sort();
const netB = (all: Files) => {
  const src = all[MUTATIONS];
  if (src === undefined) return ["verify/mutations.ts is missing"];
  const out: string[] = [];
  if (mutatedTargets(src).length > 0) out.push("mutates");
  const inserts = src.match(/\bdb\.insert\(\s*["'`]verifications["'`]/g) ?? [];
  if (inserts.length !== 1) out.push(`${inserts.length} insert sites`);
  return out;
};
const netC = (all: Files, pinned: Record<string, string[]>) =>
  Object.entries(all)
    .filter(([p, s]) => reachesWithoutNaming(p, s) && mutatedTargets(s).length > 0)
    .filter(([p, s]) => JSON.stringify(mutatedTargets(s)) !== JSON.stringify(pinned[p] ?? null))
    .map(([p]) => p)
    .sort();

const real = product(files);
const realStages = mutatedTargets(real["/convex/pipeline/stages.ts"]!);

test("the nets read real code: the table is named only by verify/mutations.ts, which really inserts, and stages.ts really reaches the helpers and mutates", () => {
  // No fallback, no synthetic string: these run over the actual files.
  expect(Object.keys(real).filter((p) => NAMES_TABLE.test(real[p]!))).toEqual([MUTATIONS]);
  expect(netB(real)).toEqual([]);
  expect(/\bdb\.insert\(\s*"verifications"/.test(real[MUTATIONS]!)).toBe(true);
  expect(reachesWithoutNaming("/convex/pipeline/stages.ts", real["/convex/pipeline/stages.ts"]!)).toBe(true);
  expect(realStages.length).toBeGreaterThan(5);
  expect(reachesWithoutNaming("/convex/scoring/assemble.ts", real["/convex/scoring/assemble.ts"]!)).toBe(true);
});

test("stages.ts's mutations are exactly the ones it had before verification existed (all on pipelineState)", () => {
  // Pinned literally: a new mutation in the one file that both consumes verdicts and writes must be reviewed.
  expect(realStages).toEqual(PINNED_STAGES);
});

/*
 * Each mutant is a source tree with ONE deliberate defect; `caught` is the nets that must see it. A net that catches
 * nothing the others miss is redundant, and redundant is how a net rots unnoticed.
 */
const PINNED_STAGES = ["state._id", "state._id", "state._id", "state._id", "state._id", "state._id", "state._id", "existing._id", "state._id"];
const withFile = (path: string, src: string, base: Files = real): Files => ({ ...base, [path]: strip(src) });
const withEdit = (path: string, edit: (s: string) => string): Files => withFile(path, edit(real[path]!));

const MUTANTS: Array<{ name: string; tree: Files; caught: Array<"A" | "B" | "C"> }> = [
  {
    name: "a new file names the table and patches a row",
    tree: withFile("/convex/verify/sneaky.ts", 'export const f = (ctx, id) => ctx.db.patch("verifications", id, { outcome: "pass" });'),
    caught: ["A"],
  },
  {
    name: "a new file names the table with a differently spelled variable and replaces a row",
    tree: withFile("/convex/leads/x.ts", 'export const f = async (ctx, id) => { const r = await ctx.db.query("verifications").first(); await ctx.db.replace(r._id, { ...r, outcome: "pass" }); };'),
    caught: ["A"],
  },
  {
    name: "recordVerification itself gains a patch",
    tree: withEdit(MUTATIONS, (s) => s + '\nexport const f = (ctx, id) => ctx.db.patch(id, { outcome: "pass" });'),
    caught: ["B"],
  },
  {
    name: "recordVerification itself gains a delete",
    tree: withEdit(MUTATIONS, (s) => s + "\nexport const f = (ctx, id) => ctx.db.delete(id);"),
    caught: ["B"],
  },
  {
    name: "a second insert site appears in the writer, bypassing its validation",
    tree: withEdit(MUTATIONS, (s) => s + '\nexport const g = (ctx, row) => ctx.db.insert("verifications", row);'),
    caught: ["B"],
  },
  {
    name: "the only insert disappears (the writer is not the writer any more)",
    tree: withEdit(MUTATIONS, (s) => s.replace('ctx.db.insert("verifications"', "ctx.db.insert(TABLE")),
    caught: ["B"],
  },
  {
    name: "a file imports the helper, is handed a row, and mutates it without ever naming the table",
    tree: withFile(
      "/convex/leads/y.ts",
      'import { latestVerificationForClaim } from "../verify/mutations";\nexport const f = async (ctx, org, claim) => { const r = await latestVerificationForClaim(ctx, org, claim); await ctx.db.patch(r._id, { outcome: "pass" }); };',
    ),
    caught: ["C"],
  },
  {
    name: "the same, through a renamed import and a different variable",
    tree: withFile(
      "/convex/leads/z.ts",
      'import { verificationsForSubject as vs } from "../verify/mutations";\nexport const f = async (ctx, a) => { const [row] = await vs(ctx, a); await ctx.db.delete(row.id); };',
    ),
    caught: ["C"],
  },
  {
    name: "stages.ts gains an unreviewed mutation",
    tree: withEdit("/convex/pipeline/stages.ts", (s) => s + "\nexport const f = (ctx, other) => ctx.db.patch(other._id, { x: 1 });"),
    caught: ["C"],
  },
];

test.each(MUTANTS)("mutant: $name", ({ tree, caught }) => {
  const seen = (
    [
      ["A", netA(tree).length > 0],
      ["B", netB(tree).length > 0],
      ["C", netC(tree, { "/convex/pipeline/stages.ts": PINNED_STAGES }).length > 0],
    ] as const
  )
    .filter(([, hit]) => hit)
    .map(([n]) => n);
  expect(seen).toEqual(caught);
});

test("each net is load-bearing: every net catches a mutant that the other two miss", () => {
  for (const net of ["A", "B", "C"] as const) expect(MUTANTS.some((m) => m.caught.length === 1 && m.caught[0] === net), net).toBe(true);
});

test("the clean tree passes (the mutants differ from it, not from a broken baseline)", () => {
  expect(netA(real)).toEqual([]);
  expect(netB(real)).toEqual([]);
  expect(netC(real, { "/convex/pipeline/stages.ts": PINNED_STAGES })).toEqual([]);
});

/// <reference types="vite/client" />
import { expect, test } from "vitest";

const files = import.meta.glob("/convex/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
/**
 * Test support. It builds a hardcoded `user` actor, so it must NEVER be on a guard's allowlist (a product file forging an
 * actor through it would then be invisible to C2). Instead it is excluded from `sources` here, and C4 pins what makes
 * that safe: Convex's bundler skips a file whose name has more than one dot (so it is not deployed and not in the
 * generated API), and only test files import it.
 */
const TESTKIT = "/convex/_shared/testkit.support.ts";
const sources = Object.entries(files).filter(([p]) => !p.endsWith(".test.ts") && !p.includes("/_generated/") && p !== TESTKIT);
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = (path: string) => strip(files[path] ?? "");
const where = (pattern: RegExp) => sources.filter(([, s]) => pattern.test(strip(s))).map(([p]) => p).sort();

/*
 * THREE LEXICAL NETS FOR TASK 14, each proven load-bearing below by a mutant only IT catches (the standing rule from
 * redact.guard.test.ts: a net that cannot be shown to catch something the others miss is a net that rots unnoticed,
 * and none is certified by a fallback or by a synthetic string).
 *   A. every PUBLIC registration enforces a role, and the role it enforces is the one in the matrix below;
 *   B. the audit log is append-only: one writer, no mutation in any file that touches the table;
 *   C. who can be a `user` actor or a `system` actor: only the files listed.
 *
 * LIMITS, so nobody over-trusts these. They are lexical, and each can be evaded by spelling, none of which is live today:
 *   A. a CONDITIONAL `requireRole` (`if (x) await requireRole(ctx, "admin")`) reads as protected; the net sees the call, not
 *      whether it always runs. Only authz.test.ts (runtime) proves the role is really enforced. Registrations are found by
 *      the `export const x = query|mutation|action({` shape; another declaration style would not be seen at all.
 *   B. mutation is found by the `db.patch|replace|delete(` shape only; an aliased `const d = ctx.db; d.patch(` is invisible.
 *   C. `systemActor(variable)` is not seen (the net wants a string literal), and neither is `kind: K` through a const;
 *      only a literal `kind: "user"` / `kind: "system"` is caught.
 */

// ---------------------------------------------------------------------------------------------------- A. roles

type Registration = { name: string; kind: string; body: string };
/** Every `export const x = query|mutation|action({ ... })` and the text up to the next top-level declaration. */
export function registrations(source: string): Registration[] {
  const out: Registration[] = [];
  const decl = /^export const (\w+)\s*=\s*(query|mutation|action)\(\{/gm;
  for (let m = decl.exec(source); m; m = decl.exec(source)) {
    const rest = source.slice(m.index + m[0].length);
    const next = rest.search(/^export (?:const|async function|function)\b/m);
    out.push({ name: m[1]!, kind: m[2]!, body: next === -1 ? rest : rest.slice(0, next) });
  }
  return out;
}
/** The roles a registration demands, in order of appearance. A registration with none is unprotected. */
export const rolesDemanded = (body: string): string[] => [...body.matchAll(/\brequireRole\(\s*ctx\s*,\s*"(\w+)"\s*\)/g)].map((m) => m[1]!);

/**
 * The spec 7.1 matrix AS IMPLEMENTED: every public function and the least role it demands. A change here is a
 * decision about who may do what. (Runtime proof of the same table: authz.test.ts.)
 */
const MATRIX: Record<string, string> = {
  "/convex/audit/api.ts": "recentAudit:admin auditForTarget:admin",
  "/convex/claims/mutations.ts": "appendClaim:operator",
  "/convex/claims/queries.ts": "claimsForSubject:operator claimsForField:operator",
  "/convex/icp/api.ts": "createIcp:analyst createModel:analyst",
  "/convex/leads/api.ts": "markInventoryState:operator markDisposition:operator",
  "/convex/members/api.ts": "setMemberRole:admin myRole:operator",
  "/convex/pipeline/deadletter.ts": "listDeadLetters:operator resumeSubject:operator",
  "/convex/pipeline/stages.ts": "startPipeline:operator pipelineStatus:operator",
  "/convex/privacy/api.ts": "requestErasure:admin suppressIdentifier:admin",
  "/convex/projections/queries.ts": "getAccount:operator getContact:operator",
  "/convex/runs/mutations.ts": "startRun:admin consumeCredits:operator finishRun:operator",
  "/convex/runs/queries.ts": "getRun:operator rejectionsForRun:operator",
  "/convex/signals/mutations.ts": "recordSignals:operator",
  "/convex/sources/import.ts":
    "saveMapping:operator getMapping:operator importRows:operator resumeImport:operator importCsv:(delegates) addManualLead:operator submitCandidates:operator",
  "/convex/sources/ingest.ts": "ingestCandidates:operator",
  "/convex/sources/mutations.ts": "registerSource:admin",
};
/** Registrations with no `requireRole` of their own, and what they do instead. Each must be re-verified, not assumed. */
const DELEGATES: Record<string, RegExp> = {
  // An action has no db. It authenticates by calling getMapping, a query that requires the operator role and returns the caller's org.
  importCsv: /ctx\.runQuery\(\s*api\.sources\.import\.getMapping\b/,
};

function describeAll(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, source] of sources) {
    const regs = registrations(strip(source));
    if (regs.length === 0) continue;
    out[path] = regs
      .map((r) => `${r.name}:${rolesDemanded(r.body).length === 0 ? (DELEGATES[r.name]?.test(r.body) ? "(delegates)" : "NONE") : [...new Set(rolesDemanded(r.body))].join("+")}`)
      .join(" ");
  }
  return out;
}

test("A1. every public function demands a role, and the matrix is exactly the one in the spec", () => {
  expect(describeAll()).toEqual(MATRIX);
});

test("A2. the helpers read real code: they find the registrations and roles that are really there", () => {
  const regs = registrations(code("/convex/icp/api.ts"));
  expect(regs.map((r) => r.name)).toEqual(["createIcp", "createModel"]);
  expect(rolesDemanded(regs[0]!.body)).toEqual(["analyst"]);
  expect(Object.values(describeAll()).join(" ").split(" ").length).toBeGreaterThan(30);
  // every delegate named above really exists and really delegates (a stale entry would excuse nothing)
  const importCsv = registrations(code("/convex/sources/import.ts")).find((r) => r.name === "importCsv")!;
  expect(DELEGATES.importCsv!.test(importCsv.body)).toBe(true);
  expect(rolesDemanded(registrations(code("/convex/sources/import.ts")).find((r) => r.name === "getMapping")!.body)).toEqual(["operator"]);
});

test.each([
  ["a public mutation with no role check", "export const m = mutation({\n  args: {},\n  handler: async (ctx) => { await withOrg(ctx, {}); },\n});", ["NONE"]],
  ["an org check is not a role check", "export const q = query({\n  args: {},\n  handler: async (ctx) => (await withOrg(ctx, {})).orgId,\n});", ["NONE"]],
  ["a role check in a DIFFERENT registration does not protect this one", "export const a = mutation({ handler: async (ctx) => { await requireRole(ctx, \"admin\"); } });\nexport const b = mutation({ handler: async (ctx) => null });", ["admin", "NONE"]],
  ["a weakened role shows in the matrix", "export const a = mutation({ handler: async (ctx) => { await requireRole(ctx, \"operator\"); } });", ["operator"]],
])("A3. net separation: %s", (_n, mutant, expected) => {
  const got = registrations(mutant).map((r) => (rolesDemanded(r.body)[0] ?? "NONE"));
  expect(got).toEqual(expected);
});

// ------------------------------------------------------------------------------------------- B. audit append-only

/** The first argument of every `db.patch|replace|delete(` call, balanced. Same reader as redact.guard.test.ts. */
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
/**
 * B1  the table is INSERTED from exactly one file (audit/log.ts, which validates), by any spelling of `db.insert("auditLog"`.
 * B2  a file that TOUCHES auditLog at all (names the table, or types an id of it) may not mutate ANYTHING: it matches the
 *     SHAPE `db.patch|replace|delete(<anything>` in such a file, so aliasing the row to another variable name does not hide it.
 */
export const nets = {
  insertsAudit: (src: string) => /\bdb\.insert\(\s*["'`]auditLog["'`]/.test(src),
  touchesAudit: (src: string) => /\bauditLog\b/.test(src),
  mutatesAnything: (src: string) => mutatedTargets(src).length > 0,
};
const caughtByB = (mutant: string, path = "/convex/other.ts") => ({
  B1: nets.insertsAudit(strip(mutant)) && path !== "/convex/audit/log.ts",
  B2: nets.touchesAudit(strip(mutant)) && nets.mutatesAnything(strip(mutant)),
});

test.each([
  ["a second writer: an insert from another file (no mutation call at all)", 'await ctx.db.insert("auditLog", { x: 1 });', { B1: true, B2: false }],
  ["an aliased rewrite: the row fetched by id and patched through an unremarkable name, in a file that only TYPES the table", 'async function f(ctx, id: Id<"auditLog">) { const r = await ctx.db.get(id); await ctx.db.patch(r._id, { after: null }); }', { B1: false, B2: true }],
  ["a delete naming the table", 'await ctx.db.delete("auditLog", id);', { B1: false, B2: true }],
  ["a rewrite in a file that imports the table object by name (the schema's shorthand spelling)", 'import { auditLog } from "./audit/schema";\nawait ctx.db.replace(r._id, {});', { B1: false, B2: true }],
  ["an unrelated file that mutates other tables is left alone", "await ctx.db.patch(state._id, { x: 1 });", { B1: false, B2: false }],
])("B3. net separation: %s", (_n, mutant, expected) => {
  expect(caughtByB(mutant)).toEqual(expected);
});

test("B4. the audit log is append-only: one inserter, and no file that touches it mutates anything", () => {
  expect(where(/\bdb\.insert\(\s*["'`]auditLog["'`]/)).toEqual(["/convex/audit/log.ts"]);
  const touching = sources.filter(([, s]) => nets.touchesAudit(strip(s))).map(([p]) => p).sort();
  // self-check on real files, no fallback: the net finds the table where it really is (a quoted name, a type argument,
  // a shorthand in the schema), so it is not matching nothing
  expect(touching).toEqual(["/convex/audit/api.ts", "/convex/audit/log.ts", "/convex/audit/schema.ts", "/convex/schema.ts"]);
  for (const p of touching) expect(mutatedTargets(code(p)), p).toEqual([]);
});

// ---------------------------------------------------------------------------------------------- C. actor construction

/**
 * C1  a `system` actor is built only where a process legitimately acts with no person: each site below is a scheduled or
 *     internal path. A PUBLIC handler must never present its caller's action as the system's, so a new site is a decision.
 * C2  a `user` actor is built only by `requireRole` (the role is the one it just verified); the log re-validates the shape.
 */
test("C1. systemActor( is called from exactly the places where nobody is acting", () => {
  expect(where(/\bsystemActor\(\s*["']/)).toEqual([
    "/convex/icp/mutations.ts", // ensureActiveScoringModel: the default model seed, possibly inside a scheduled stage
    "/convex/members/api.ts", // bootstrapMember: internal, run from the dashboard
    "/convex/pipeline/stages.ts", // the supersession of an unsold lead by a rescore, inside a stage
    "/convex/privacy/redact.ts", // erasure completion
  ]);
  // the registrations those sit in are internal (or plain helpers called by them), never public: checked on real code
  const publicWithSystem = sources
    .flatMap(([p, s]) => registrations(strip(s)).map((r) => ({ p, r })))
    .filter(({ r }) => /\bsystemActor\(/.test(r.body))
    .map(({ p, r }) => `${p}:${r.name}`);
  expect(publicWithSystem).toEqual([]);
});

test("C2. no file but the actor modules builds a `user` actor", () => {
  expect(where(/kind:\s*["']user["']/)).toEqual(["/convex/_shared/actor.ts", "/convex/_shared/authz.ts", "/convex/audit/log.ts"]);
  expect(where(/kind:\s*["']system["']/)).toEqual(["/convex/_shared/actor.ts", "/convex/_shared/authz.ts", "/convex/audit/log.ts"]);
  expect(where(/system:default-scoring-model-seed|SYSTEM_ACTOR_DEFAULT_MODEL_SEED/)).toEqual([]); // the magic string is gone
});

/** Files (other than the support module itself) that import it, by any spelling of the specifier. */
export const importersOfTestkit = (all: Record<string, string>): string[] =>
  Object.entries(all)
    .filter(([p, s]) => p !== TESTKIT && /\btestkit\.support\b/.test(strip(s)))
    .map(([p]) => p)
    .sort();

test("C4. the testkit forges an actor, so it is neither deployed nor reachable from product code", () => {
  expect(Object.keys(files)).toContain(TESTKIT); // the exclusion above is not pointing at nothing
  // not deployed: Convex's bundler skips any file with more than one dot in its name (bundler/index.ts), so it is also absent from _generated/api
  expect(TESTKIT.split("/").pop()!.split(".").length).toBeGreaterThan(2);
  const importers = importersOfTestkit(files);
  expect(importers.length).toBeGreaterThan(10); // real importers exist, so the net is not matching nothing
  expect(importers.filter((p) => !p.endsWith(".test.ts"))).toEqual([]);
});

test("C4b. net separation: a product file importing the testkit is caught", () => {
  const mutant = { ...files, "/convex/leads/sneaky.ts": 'import { TEST_ACTOR } from "../_shared/testkit.support";\nexport const a = TEST_ACTOR;' };
  expect(importersOfTestkit(mutant).filter((p) => !p.endsWith(".test.ts"))).toEqual(["/convex/leads/sneaky.ts"]);
});

test("C3. a stored actor is a typed union: createdBy and the log never hold a bare string", () => {
  expect(where(/createdBy:\s*v\.string\(\)/)).toEqual([]);
});

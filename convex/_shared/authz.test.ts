/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { DEFAULT_SCORING_MODEL } from "../icp/defaults";
import schema from "../schema";
import { ROLES, isRole, requireRole, roleSatisfies, systemActor, type Role } from "./authz";
import { asMember, grant, tokenOf } from "./testkit.support";
import { withTrustedOrgForInternalOnly } from "./org";

const modules = import.meta.glob("/convex/**/*.ts");

let raw: ReturnType<typeof convexTest>;
let orgId: Id<"orgs">;
beforeEach(async () => {
  raw = convexTest(schema, modules);
  orgId = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 }));
});

const as = (subject: string, role: Role | null, org: Id<"orgs"> = orgId) =>
  role === null ? Promise.resolve(raw.withIdentity({ subject, orgId: org })) : asMember(raw, subject, org, role);

describe("requireRole: fails closed", () => {
  test("a valid identity with NO membership has no role, whatever the token says", async () => {
    const nobody = await as("nobody", null);
    await expect(nobody.run((ctx) => requireRole(ctx, "operator"))).rejects.toThrow("forbidden: not a member");
    // a role CLAIM in the token is ignored: the role comes from the membership row
    const claimsAdmin = raw.withIdentity({ subject: "claims", orgId, role: "admin" });
    await expect(claimsAdmin.run((ctx) => requireRole(ctx, "operator"))).rejects.toThrow("forbidden: not a member");
  });

  test("someone ELSE's membership in the same org grants nothing: the lookup is by user, not 'any member of this org'", async () => {
    await grant(raw, orgId, "boss", "admin");
    const nobody = raw.withIdentity({ subject: "nobody", orgId });
    await expect(nobody.run((ctx) => requireRole(ctx, "operator"))).rejects.toThrow("not a member");
  });

  test("no identity at all, and an identity with no org, are refused", async () => {
    await expect(raw.run((ctx) => requireRole(ctx, "operator"))).rejects.toThrow("no org context");
    await expect(raw.withIdentity({ subject: "u" }).run((ctx) => requireRole(ctx, "operator"))).rejects.toThrow("no org context");
  });

  test("a membership in ANOTHER org grants nothing here", async () => {
    const other = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
    await grant(raw, other, "traveller", "admin");
    const t = raw.withIdentity({ subject: "traveller", orgId });
    await expect(t.run((ctx) => requireRole(ctx, "operator"))).rejects.toThrow("not a member");
  });

  test("two membership rows for one user is ambiguous and refused, not resolved by picking one", async () => {
    await grant(raw, orgId, "dup", "operator");
    await grant(raw, orgId, "dup", "admin");
    const t = raw.withIdentity({ subject: "dup", orgId });
    await expect(t.run((ctx) => requireRole(ctx, "operator"))).rejects.toThrow();
  });

  test("a stored role that is not one of the three is neither weakest nor strongest: refused, at every level", async () => {
    // The schema validators stop such a row being written, so the read side is exercised with a ctx that returns one.
    for (const bad of ["root", "ADMIN", "", "operator ", null, undefined, 3]) {
      const ctx = {
        auth: { getUserIdentity: async () => ({ tokenIdentifier: tokenOf("m"), orgId }) },
        db: { normalizeId: (_t: string, id: string) => id, query: () => ({ withIndex: () => ({ take: async () => [{ role: bad }] }) }) },
      };
      for (const need of ROLES) await expect(requireRole(ctx as never, need)).rejects.toThrow("malformed membership");
    }
  });

  test("every membership refusal carries its typed reason, which is what refusal recording classifies by", async () => {
    const reasonOf = (p: Promise<unknown>) => p.then(() => "resolved", (e: { data?: unknown }) => e.data);
    expect(await reasonOf((await as("nobody", null)).run((ctx) => requireRole(ctx, "operator")))).toEqual({ code: "forbidden", reason: "not_member" });
    expect(await reasonOf((await as("op", "operator")).run((ctx) => requireRole(ctx, "admin")))).toEqual({ code: "forbidden", reason: "insufficient_role" });
    await grant(raw, orgId, "dup", "operator");
    await grant(raw, orgId, "dup", "admin");
    expect(await reasonOf(raw.withIdentity({ subject: "dup", orgId }).run((ctx) => requireRole(ctx, "operator")))).toEqual({ code: "forbidden", reason: "malformed_membership" });
    const noToken = { auth: { getUserIdentity: async () => ({ orgId }) }, db: { normalizeId: (_t: string, id: string) => id } };
    expect(await reasonOf(requireRole(noToken as never, "operator"))).toEqual({ code: "forbidden", reason: "no_identity" });
    // not an authorization refusal: no org to count it against, and a call-site typo
    expect(await reasonOf(raw.run((ctx) => requireRole(ctx, "operator")))).toBeUndefined();
    expect(await reasonOf((await as("ad", "admin")).run((ctx) => requireRole(ctx, "root" as never)))).toBeUndefined();
  });

  test("an unknown REQUIRED role is refused: a typo at a call site must not mean 'anyone'", async () => {
    const admin = await as("ad", "admin");
    await expect(admin.run((ctx) => requireRole(ctx, "superadmin" as never))).rejects.toThrow("unknown required role");
    await expect(admin.run((ctx) => requireRole(ctx, undefined as never))).rejects.toThrow("unknown required role");
  });

  test("a scheduled/internal context carries an org but no user, and cannot pass a role check", async () => {
    await grant(raw, orgId, "ad", "admin");
    await expect(raw.run((ctx) => requireRole(withTrustedOrgForInternalOnly(ctx, orgId), "operator"))).rejects.toThrow("no org context");
  });
});

describe("the role order", () => {
  test("operator < analyst < admin, and nothing unknown satisfies anything", () => {
    for (const [have, need, ok] of [
      ["operator", "operator", true], ["operator", "analyst", false], ["operator", "admin", false],
      ["analyst", "operator", true], ["analyst", "analyst", true], ["analyst", "admin", false],
      ["admin", "operator", true], ["admin", "analyst", true], ["admin", "admin", true],
    ] as const) expect(roleSatisfies(have, need), `${have} vs ${need}`).toBe(ok);
    for (const bad of ["root", "", undefined, null, 1]) {
      expect(isRole(bad)).toBe(false);
      for (const r of ROLES) {
        expect(roleSatisfies(bad, r)).toBe(false);
        expect(roleSatisfies(r, bad)).toBe(false);
      }
    }
  });

  test("a system actor is built from a closed set and cannot name a free-form label", () => {
    expect(systemActor("erasure")).toEqual({ kind: "system", process: "erasure" });
    expect(() => systemActor("system:default-scoring-model-seed" as never)).toThrow("unknown system process");
  });
});

/** One call per public function the spec's matrix names, each of which SUCCEEDS for a sufficiently privileged caller. */
const modelArgs = () => ({ ...structuredClone(DEFAULT_SCORING_MODEL) });
const calls: Array<{ name: string; min: Role; call: (t: ReturnType<typeof raw.withIdentity>) => Promise<unknown> }> = [
  { name: "pipelineStatus (work the pipeline)", min: "operator", call: (t) => t.query(api.pipeline.stages.pipelineStatus, { subjectType: "contact", subjectId: "x" }) },
  { name: "listDeadLetters (work the dead-letter queue)", min: "operator", call: (t) => t.query(api.pipeline.deadletter.listDeadLetters, { paginationOpts: { numItems: 5, cursor: null } }) },
  { name: "createModel (edit scoring models)", min: "analyst", call: (t) => t.mutation(api.icp.api.createModel, modelArgs()) },
  { name: "createIcp (edit ICP definitions)", min: "analyst", call: (t) => t.mutation(api.icp.api.createIcp, { name: "ICP", criteria: { industries: [], geographies: [], technologies: [], decisionMakerRoles: [] } }) },
  { name: "registerSource (manage sources)", min: "admin", call: (t) => t.action(api.sources.mutations.registerSource, { key: "crm", kind: "crm", trustWeight: 0.5, lawfulBasis: "consent" }) },
  { name: "setMemberRole (manage users)", min: "admin", call: (t) => t.action(api.members.api.setMemberRole, { userId: "someone-else", role: "operator" }) },
  { name: "recentAudit (read the audit log)", min: "admin", call: (t) => t.action(api.audit.api.recentAudit, { paginationOpts: { numItems: 5, cursor: null } }) },
];

describe("the matrix of spec 7.1, as enforced", () => {
  const cases = calls.flatMap((c) => ([null, ...ROLES] as const).map((role) => [c.name, role, c.min, c] as const));
  test.each(cases)("%s as %s (needs %s)", async (_name, role, min, c) => {
    const t = await as("caller", role);
    const allowed = role !== null && roleSatisfies(role, min);
    if (allowed) await expect(c.call(t)).resolves.not.toThrow();
    else await expect(c.call(t)).rejects.toThrow(/forbidden/);
  });

  test("starting a run sets its credit budget, so it is admin: an operator and an analyst are refused", async () => {
    const admin = await as("ad", "admin");
    const sourceId = await admin.action(api.sources.mutations.registerSource, { key: "crm", kind: "crm", trustWeight: 0.5, lawfulBasis: "consent" });
    for (const role of ["operator", "analyst"] as const) {
      const t = await as(`u-${role}`, role);
      await expect(t.action(api.runs.mutations.startRun, { sourceId, creditBudget: 10 })).rejects.toThrow("forbidden");
    }
    await expect(admin.action(api.runs.mutations.startRun, { sourceId, creditBudget: 10 })).resolves.toBeTruthy();
  });

  test("an operator can still work a run an admin opened: spend, finish and read it", async () => {
    const admin = await as("ad", "admin");
    const op = await as("op", "operator");
    const sourceId = await admin.action(api.sources.mutations.registerSource, { key: "crm", kind: "crm", trustWeight: 0.5, lawfulBasis: "consent" });
    const runId = await admin.action(api.runs.mutations.startRun, { sourceId, creditBudget: 10 });
    await op.mutation(api.runs.mutations.consumeCredits, { runId, credits: 1 });
    await op.mutation(api.runs.mutations.finishRun, { runId });
    expect((await op.query(api.runs.queries.getRun, { runId })).status).toBe("completed");
  });

  test("an admin may change another user's role but never their own", async () => {
    const admin = await as("ad", "admin");
    await expect(admin.action(api.members.api.setMemberRole, { userId: tokenOf("ad"), role: "operator" })).rejects.toThrow("own role");
    await admin.action(api.members.api.setMemberRole, { userId: tokenOf("new"), role: "analyst" });
    const created = await raw.withIdentity({ subject: "new", orgId }).query(api.members.api.myRole, {});
    expect(created).toBe("analyst");
    await admin.action(api.members.api.setMemberRole, { userId: tokenOf("new"), role: "operator" });
    expect(await raw.withIdentity({ subject: "new", orgId }).query(api.members.api.myRole, {})).toBe("operator");
  });

  test("a role change takes effect on the next call: there is no token to wait out", async () => {
    const admin = await as("ad", "admin");
    const user = await as("u", "analyst");
    await user.mutation(api.icp.api.createIcp, { name: "ICP", criteria: { industries: [], geographies: [], technologies: [], decisionMakerRoles: [] } });
    await admin.action(api.members.api.setMemberRole, { userId: tokenOf("u"), role: "operator" });
    await expect(user.mutation(api.icp.api.createModel, modelArgs())).rejects.toThrow("forbidden");
  });

  test("a query for another org's data returns nothing, even for an admin of this one (spec 7.1)", async () => {
    const mine = await as("ad", "admin");
    const other = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
    const theirs = await as("them", "admin", other);
    const sourceId = await theirs.action(api.sources.mutations.registerSource, { key: "crm", kind: "crm", trustWeight: 0.5, lawfulBasis: "consent" });
    const runId = await theirs.action(api.runs.mutations.startRun, { sourceId, creditBudget: 1 });
    await expect(mine.query(api.runs.queries.getRun, { runId })).rejects.toThrow("run not found");
    const audit = await mine.action(api.audit.api.recentAudit, { paginationOpts: { numItems: 50, cursor: null } });
    expect(audit.page.every((r) => r.orgId === orgId)).toBe(true);
    expect(audit.page.some((r) => r.targetId === runId)).toBe(false);
  });

  test("through the public API an org never loses its last admin: the 'A promotes C, C demotes A, C demotes B' walk ends with C, and a long random walk never reaches zero", async () => {
    const users = ["A", "B", "C", "D"];
    const t = Object.fromEntries(await Promise.all(users.map(async (u) => [u, await as(u, u === "A" || u === "B" ? "admin" : "operator")])));
    const adminCount = async () => (await raw.run((ctx) => ctx.db.query("memberships").collect())).filter((m) => m.role === "admin").length;
    const set = (by: string, target: string, role: Role) => t[by]!.action(api.members.api.setMemberRole, { userId: tokenOf(target), role }).then(() => true, () => false);
    expect(await set("A", "C", "admin")).toBe(true);
    expect(await set("C", "A", "operator")).toBe(true);
    expect(await set("C", "B", "operator")).toBe(true);
    expect(await adminCount()).toBe(1); // C, who cannot demote themselves, and nobody else can without being an admin
    expect(await set("C", "C", "operator")).toBe(false);
    expect(await set("A", "C", "operator")).toBe(false); // A is no longer an admin
    // deterministic pseudo-random walk over every actor, target and role: each attempt may succeed or be refused, never leave zero admins
    let x = 12345;
    const next = (n: number) => ((x = (x * 1103515245 + 12345) % 2147483648), x % n);
    for (let i = 0; i < 80; i++) {
      await set(users[next(4)]!, users[next(4)]!, ROLES[next(3)]!);
      expect(await adminCount(), `step ${i}`).toBeGreaterThanOrEqual(1);
    }
  });
});

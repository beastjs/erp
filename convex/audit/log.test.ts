/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { systemActor } from "../_shared/authz";
import { withTrustedOrgForInternalOnly } from "../_shared/org";
import { TEST_ACTOR, asMember, tokenOf } from "../_shared/testkit";
import { DEFAULT_SCORING_MODEL } from "../icp/defaults";
import schema from "../schema";
import { AUDIT_ACTIONS, writeAudit } from "./log";

const modules = import.meta.glob("/convex/**/*.ts");

let raw: ReturnType<typeof convexTest>;
let orgId: Id<"orgs">;
beforeEach(async () => {
  raw = convexTest(schema, modules);
  orgId = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 }));
});
const rows = () => raw.run((ctx) => ctx.db.query("auditLog").collect()) as Promise<Doc<"auditLog">[]>;
const sourceRow = () => raw.run((ctx) => ctx.db.insert("sources", { orgId, key: "k", kind: "crm", trustWeight: 1, lawfulBasis: "consent" }));
const userRun = async <T>(f: (ctx: Parameters<Parameters<typeof raw.run>[0]>[0]) => Promise<T>) => (await asMember(raw, "u1", orgId, "admin")).run(f);

describe("what an entry may hold: no content, ever", () => {
  test("a field outside the action's declared allowlist is refused, so a document cannot be logged whole", async () => {
    const sourceId = await sourceRow();
    for (const field of ["email", "name", "value", "snapshot", "key", "criteria"]) {
      await expect(
        userRun((ctx) => writeAudit(ctx, { actor: TEST_ACTOR, action: "source.registered", targetTable: "sources", targetId: sourceId, after: { [field]: "x" } })),
        field,
      ).rejects.toThrow(/not allowed for source\.registered/);
    }
    expect(await rows()).toHaveLength(0);
  });

  test("even on an allowed field, a value that is not a number, flag, null or short token is refused: a name or address cannot ride along", async () => {
    const sourceId = await sourceRow();
    for (const value of ["Bobby Tables", "bob.tables@acme.com", "+1 555 010 4242", "https://linkedin.com/in/bobby", "x".repeat(65), "", { nested: "bob" }, ["bob"], NaN, Infinity, undefined]) {
      await expect(
        userRun((ctx) => writeAudit(ctx, { actor: TEST_ACTOR, action: "source.registered", targetTable: "sources", targetId: sourceId, after: { kind: value as never } })),
        String(JSON.stringify(value)),
      ).rejects.toThrow(/must be a finite number|flat record/);
    }
    expect(await rows()).toHaveLength(0);
  });

  test("an unknown action, a table that is not the action's, and an id of another table are all refused", async () => {
    const sourceId = await sourceRow();
    await expect(userRun((ctx) => writeAudit(ctx, { actor: TEST_ACTOR, action: "constructor" as never, targetTable: "sources", targetId: sourceId }))).rejects.toThrow("unknown audit action");
    await expect(userRun((ctx) => writeAudit(ctx, { actor: TEST_ACTOR, action: "source.registered", targetTable: "leads", targetId: sourceId }))).rejects.toThrow("concerns sources");
    await expect(userRun((ctx) => writeAudit(ctx, { actor: TEST_ACTOR, action: "run.started", targetTable: "discoveryRuns", targetId: sourceId }))).rejects.toThrow("not an id of that table");
  });

  test("every declared field name is free of personal-data vocabulary (a review prompt for whoever adds one)", () => {
    const banned = /name|email|phone|address|profile|title|value|snapshot|payload|reason$|note|text|comment/i;
    const all = Object.values(AUDIT_ACTIONS).flatMap((s) => [...s.fields]);
    expect(all.length).toBeGreaterThan(10);
    expect(all.filter((f) => banned.test(f))).toEqual([]);
  });
});

describe("the actor: a person, or a typed system process, never invented", () => {
  test("an entry without an actor, or with a malformed one, is refused (fail closed, nothing defaulted)", async () => {
    const sourceId = await sourceRow();
    const base = { action: "source.registered", targetTable: "sources", targetId: sourceId } as const;
    for (const actor of [undefined, null, {}, { kind: "user" }, { kind: "user", userId: "", role: "admin" }, { kind: "user", userId: "u", role: "root" }, { kind: "system", process: "cron" }, { kind: "system", process: "system:default-scoring-model-seed" }, "system"]) {
      await expect(userRun((ctx) => writeAudit(ctx, { ...base, actor: actor as never })), JSON.stringify(actor)).rejects.toThrow("audit requires an actor");
    }
    expect(await rows()).toHaveLength(0);
  });

  test("in a scheduled context (no identity) the entry is a SYSTEM actor by type, and no user is invented", async () => {
    const sourceId = await sourceRow();
    // exactly what a cron / scheduled function sees: a trusted org and NO identity
    const written = await raw.run(async (ctx) => {
      const sctx = withTrustedOrgForInternalOnly(ctx, orgId);
      expect(await sctx.auth.getUserIdentity()).toBeNull();
      return await writeAudit(sctx, { actor: systemActor("erasure"), action: "source.registered", targetTable: "sources", targetId: sourceId, after: { kind: "crm" } });
    });
    const [row] = await rows();
    expect(row!._id).toBe(written);
    expect(row!.actor).toEqual({ kind: "system", process: "erasure" });
    expect(JSON.stringify(row)).not.toMatch(/internal\||user/);
  });

  test("a scheduled seed of the default scoring model is audited as the system, and the model names the same typed actor", async () => {
    // exactly the pipeline path: an internal context, no identity, asks for the active model
    const { ensureActiveScoringModel } = await import("../icp/mutations");
    const model = await raw.run((ctx) => ensureActiveScoringModel(withTrustedOrgForInternalOnly(ctx, orgId)));
    expect(model.createdBy).toEqual({ kind: "system", process: "default_scoring_model_seed" });
    const [row] = await rows();
    expect(row).toMatchObject({ action: "scoring_model.created", targetTable: "scoringModels", targetId: model._id, actor: model.createdBy, after: { version: 1 } });
  });

  test("a person's entry carries the id and the role they were VERIFIED to hold, not one they claim", async () => {
    const t = await asMember(raw, "ana", orgId, "analyst");
    await t.mutation(api.icp.api.createModel, { ...structuredClone(DEFAULT_SCORING_MODEL) });
    const [row] = await rows();
    expect(row!.actor).toEqual({ kind: "user", userId: tokenOf("ana"), role: "analyst" });
  });
});

describe("what gets audited, with before and after", () => {
  test("creating a scoring model version records who, which version, and the one it replaced", async () => {
    const t = await asMember(raw, "ana", orgId, "analyst");
    const v1 = await t.mutation(api.icp.api.createModel, { ...structuredClone(DEFAULT_SCORING_MODEL) });
    await t.mutation(api.icp.api.createModel, { ...structuredClone(DEFAULT_SCORING_MODEL), supersedesId: v1 });
    const log = (await rows()).filter((r) => r.action === "scoring_model.created");
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ orgId, targetTable: "scoringModels", targetId: v1, after: { version: 1 } });
    expect(log[0]!.before).toBeUndefined();
    expect(log[1]).toMatchObject({ before: { version: 1 }, after: { version: 2 }, actor: { kind: "user", role: "analyst" } });
  });

  test("a refused action leaves NO entry: the throw rolls the whole transaction back (refusals are not audited here)", async () => {
    const op = await asMember(raw, "op", orgId, "operator");
    await expect(op.mutation(api.icp.api.createModel, { ...structuredClone(DEFAULT_SCORING_MODEL) })).rejects.toThrow("forbidden");
    // and a role-correct call whose helper then throws writes neither the version nor its entry
    const an = await asMember(raw, "an", orgId, "analyst");
    await expect(an.mutation(api.icp.api.createModel, { ...structuredClone(DEFAULT_SCORING_MODEL), weights: { companyFit: 1, contactFit: 1, intent: 1 } })).rejects.toThrow(/weights/);
    expect(await rows()).toHaveLength(0);
    expect(await raw.run((ctx) => ctx.db.query("scoringModels").collect())).toHaveLength(0);
  });

  test("a change whose entry cannot be written does not happen", async () => {
    const t = await asMember(raw, "ad", orgId, "admin");
    // trustWeight 0.5 is fine; a source whose audit fields were rejected would roll the source back too
    const sourceId = await t.mutation(api.sources.mutations.registerSource, { key: "crm", kind: "crm", trustWeight: 0.5, lawfulBasis: "consent" });
    expect(await rows()).toMatchObject([{ action: "source.registered", targetId: sourceId, after: { kind: "crm", trustWeight: 0.5, lawfulBasis: "consent" } }]);
  });

  test("starting a run records its budget; role changes record the old and new role", async () => {
    const t = await asMember(raw, "ad", orgId, "admin");
    const sourceId = await t.mutation(api.sources.mutations.registerSource, { key: "crm", kind: "crm", trustWeight: 0.5, lawfulBasis: "consent" });
    const runId = await t.mutation(api.runs.mutations.startRun, { sourceId, creditBudget: 250 });
    await t.mutation(api.members.api.setMemberRole, { userId: tokenOf("x"), role: "operator" });
    await t.mutation(api.members.api.setMemberRole, { userId: tokenOf("x"), role: "analyst" });
    const log = await rows();
    expect(log.find((r) => r.action === "run.started")).toMatchObject({ targetId: runId, after: { creditBudget: 250 } });
    const roles = log.filter((r) => r.action === "member.role_set");
    expect(roles.map((r) => [r.before?.role, r.after?.role])).toEqual([[undefined, "operator"], ["operator", "analyst"]]);
  });

  test("bootstrapping an org's first admin is a SYSTEM act, audited as such", async () => {
    await raw.mutation(internal.members.api.bootstrapMember, { orgId, userId: tokenOf("boss"), role: "admin" });
    expect(await raw.withIdentity({ subject: "boss", orgId }).query(api.members.api.myRole, {})).toBe("admin");
    expect(await rows()).toMatchObject([{ action: "member.role_set", actor: { kind: "system", process: "membership_bootstrap" }, after: { role: "admin" } }]);
    await expect(raw.mutation(internal.members.api.bootstrapMember, { orgId: "nope" as never, userId: "x", role: "admin" })).rejects.toThrow();
  });
});

describe("reading the log", () => {
  test("is admin-only and paginated, so a growing log is never silently cut short", async () => {
    const admin = await asMember(raw, "ad", orgId, "admin");
    await admin.mutation(api.sources.mutations.registerSource, { key: "a", kind: "crm", trustWeight: 0.5, lawfulBasis: "consent" });
    await admin.mutation(api.sources.mutations.registerSource, { key: "b", kind: "crm", trustWeight: 0.5, lawfulBasis: "consent" });
    await admin.mutation(api.sources.mutations.registerSource, { key: "c", kind: "crm", trustWeight: 0.5, lawfulBasis: "consent" });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page: { page: Doc<"auditLog">[]; isDone: boolean; continueCursor: string } = await admin.query(api.audit.api.recentAudit, { paginationOpts: { numItems: 1, cursor } });
      seen.push(...page.page.map((r) => r._id));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(seen).toHaveLength(3);
    const first = (await rows())[0]!;
    const forTarget = await admin.query(api.audit.api.auditForTarget, { targetTable: "sources", targetId: first.targetId, paginationOpts: { numItems: 10, cursor: null } });
    expect(forTarget.page).toHaveLength(1);
    const op = await asMember(raw, "op", orgId, "operator");
    await expect(op.query(api.audit.api.recentAudit, { paginationOpts: { numItems: 1, cursor: null } })).rejects.toThrow("forbidden");
    await expect(op.query(api.audit.api.auditForTarget, { targetTable: "sources", targetId: first.targetId, paginationOpts: { numItems: 1, cursor: null } })).rejects.toThrow("forbidden");
  });
});

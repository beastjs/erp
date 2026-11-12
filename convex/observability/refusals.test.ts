/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { refusalReasonOf } from "../_shared/authz";
import { asMember, tokenOf } from "../_shared/testkit.support";
import schema from "../schema";
import { REFUSAL_SCAN_CAP } from "./definitions";
import { MAX_REFUSAL_WINDOW_HOURS, hourOf, recordRefusals } from "./refusals";
import { CALLER_CLASSES, REFUSABLE_FUNCTIONS, REFUSAL_DOMAINS, REFUSAL_REASONS, callerClass, refusableFunction, refusalReason } from "./schema";

const modules = import.meta.glob("/convex/**/*.ts");
const HOUR = 60 * 60 * 1000;
/** An hour well after the real clock: convex-test's transaction time never runs behind its last commit, which is real time. */
const H0 = (Math.ceil(Date.now() / HOUR) + 100) * HOUR;

type Raw = ReturnType<typeof convexTest>;
let raw: Raw;
let orgId: Id<"orgs">;
beforeEach(async () => {
  raw = convexTest(schema, modules);
  orgId = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 }));
});
afterEach(() => vi.useRealTimers());

const rows = () => raw.run((ctx) => ctx.db.query("refusalCounts").collect());
const membershipOf = (subject: string, org = orgId) =>
  raw.run(async (ctx) => (await ctx.db.query("memberships").collect()).find((m) => m.orgId === org && m.userId === tokenOf(subject))!._id as Id<"memberships">);
/** The error a call rejects with (fails the test if it resolves). */
async function refusalOf(p: Promise<unknown>): Promise<Error & { data?: unknown }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { data?: unknown };
  }
  throw new Error("expected the call to be refused");
}
const sourceArgs = { key: "crm", kind: "crm" as const, trustWeight: 0.5, lawfulBasis: "consent" as const };

describe("a refused admin-tier call is recorded, and still refused", () => {
  test("setMemberRole by an operator: same refusal, nothing changed, one member bucket", async () => {
    const op = await asMember(raw, "op", orgId, "operator");
    const before = await raw.run((ctx) => ctx.db.query("memberships").collect());
    const err = await refusalOf(op.action(api.members.api.setMemberRole, { userId: tokenOf("op"), role: "admin" }));
    // the caller sees the refusal it always saw: the same words, and now a typed payload that survives the action boundary
    expect(err.message).toBe("forbidden: requires the admin role");
    expect(err.data).toEqual({ code: "forbidden", reason: "insufficient_role" });
    expect(await raw.run((ctx) => ctx.db.query("memberships").collect())).toEqual(before);
    expect(await raw.run((ctx) => ctx.db.query("auditLog").collect())).toEqual([]);
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ orgId, fn: "setMemberRole", reason: "insufficient_role", callerClass: "member", membershipId: await membershipOf("op"), count: 1 });
  });

  test("recentAudit by an analyst is recorded (a read: the query itself could not have written it)", async () => {
    const an = await asMember(raw, "an", orgId, "analyst");
    await expect(an.action(api.audit.api.recentAudit, { paginationOpts: { numItems: 5, cursor: null } })).rejects.toThrow("forbidden: requires the admin role");
    expect(await rows()).toMatchObject([{ fn: "recentAudit", reason: "insufficient_role", callerClass: "member", membershipId: await membershipOf("an"), count: 1 }]);
  });

  test("every one of the seven is recorded under its own name", async () => {
    const admin = await asMember(raw, "ad", orgId, "admin");
    const sourceId = await admin.action(api.sources.mutations.registerSource, sourceArgs);
    const contactId = await raw.run((ctx) => ctx.db.insert("contacts", { orgId, fields: [], display: {} }));
    const op = await asMember(raw, "op", orgId, "operator");
    const page = { paginationOpts: { numItems: 5, cursor: null } };
    const calls: Record<(typeof REFUSABLE_FUNCTIONS)[number], () => Promise<unknown>> = {
      setMemberRole: () => op.action(api.members.api.setMemberRole, { userId: tokenOf("x"), role: "operator" }),
      requestErasure: () =>
        op.action(api.privacy.api.requestErasure, { subjectType: "contact", subjectId: contactId, reasonCode: "data_subject_request", legalBasis: "gdpr_art17_erasure", reference: "CASE-1001" }),
      suppressIdentifier: () => op.action(api.privacy.api.suppressIdentifier, { identifier: "bob@acme.com", reason: "opt_out" }),
      startRun: () => op.action(api.runs.mutations.startRun, { sourceId, creditBudget: 1 }),
      registerSource: () => op.action(api.sources.mutations.registerSource, { ...sourceArgs, key: "other" }),
      recentAudit: () => op.action(api.audit.api.recentAudit, page),
      auditForTarget: () => op.action(api.audit.api.auditForTarget, { targetTable: "sources", targetId: sourceId, ...page }),
    };
    for (const fn of REFUSABLE_FUNCTIONS) await expect(calls[fn](), fn).rejects.toThrow("forbidden");
    const opId = await membershipOf("op");
    expect((await rows()).map((r) => `${r.fn}:${r.reason}:${r.callerClass}:${r.membershipId === opId}:${r.count}`).sort()).toEqual(
      REFUSABLE_FUNCTIONS.map((fn) => `${fn}:insufficient_role:member:true:1`).sort(),
    );
  });

  test("a second refusal in the same hour increments the bucket in place; the next hour opens a new one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(H0 + 5);
    const op = await asMember(raw, "op", orgId, "operator");
    const call = () => op.action(api.audit.api.recentAudit, { paginationOpts: { numItems: 1, cursor: null } }).catch(() => null);
    await call();
    vi.setSystemTime(H0 + HOUR - 1);
    await call();
    expect(await rows()).toMatchObject([{ hour: H0, count: 2 }]);
    vi.setSystemTime(H0 + HOUR);
    await call();
    expect((await rows()).map((r) => [r.hour, r.count])).toEqual([[H0, 2], [H0 + HOUR, 1]]);
  });
});

describe("who is recorded, and as what", () => {
  test("a stranger with no org claim is refused and nothing is recorded", async () => {
    await expect(raw.withIdentity({ subject: "stranger" }).action(api.members.api.setMemberRole, { userId: "x", role: "admin" })).rejects.toThrow("no org context");
    await expect(raw.action(api.audit.api.recentAudit, { paginationOpts: { numItems: 1, cursor: null } })).rejects.toThrow("no org context");
    expect(await rows()).toEqual([]);
  });

  test("an org claim that names no existing org (a well-formed id of a deleted org) is refused and nothing is recorded", async () => {
    const gone = await raw.run(async (ctx) => {
      const id = await ctx.db.insert("orgs", { name: "gone", createdAt: 0 });
      await ctx.db.delete(id);
      return id;
    });
    await expect(raw.withIdentity({ subject: "s", orgId: gone }).action(api.audit.api.recentAudit, { paginationOpts: { numItems: 1, cursor: null } })).rejects.toThrow("forbidden: not a member");
    expect(await rows()).toEqual([]);
  });

  test("a non-member of a real org is recorded only as the class non_member: no identifier anywhere in the table", async () => {
    const stranger = raw.withIdentity({ subject: "eve-the-stranger", orgId });
    const err = await refusalOf(stranger.action(api.privacy.api.suppressIdentifier, { identifier: "bob@acme.com", reason: "opt_out" }));
    expect(err.data).toEqual({ code: "forbidden", reason: "not_member" });
    const all = await rows();
    expect(all).toMatchObject([{ orgId, fn: "suppressIdentifier", reason: "not_member", callerClass: "non_member", membershipId: null, count: 1 }]);
    // exactly the declared fields, and nothing that names the caller in any form
    expect(Object.keys(all[0]!).sort()).toEqual(["_creationTime", "_id", "callerClass", "count", "fn", "hour", "membershipId", "orgId", "reason"]);
    const text = JSON.stringify(all);
    for (const needle of ["eve", tokenOf("eve-the-stranger"), "convex.test", "bob"]) expect(text).not.toContain(needle);
  });

  test("a member's bucket names its membershipId, never its userId", async () => {
    const op = await asMember(raw, "op", orgId, "operator");
    await op.action(api.audit.api.recentAudit, { paginationOpts: { numItems: 1, cursor: null } }).catch(() => null);
    expect(JSON.stringify(await rows())).not.toContain(tokenOf("op"));
  });

  test("the recorder derives the caller from its OWN identity: a member reason for a caller with no membership is not recorded", async () => {
    // reachable only by a membership removed between the refusal and the record; the reason fixes the class, so it is dropped
    await raw.withIdentity({ subject: "nobody", orgId }).mutation(internal.observability.refusals.recordRefusal, { fn: "startRun", reason: "insufficient_role" });
    await raw.mutation(internal.observability.refusals.recordRefusal, { fn: "startRun", reason: "not_member" }); // no identity at all
    expect(await rows()).toEqual([]);
  });
});

describe("what is NOT recorded", () => {
  test("a business-rule refusal is not recorded", async () => {
    const admin = await asMember(raw, "ad", orgId, "admin");
    await expect(admin.action(api.members.api.setMemberRole, { userId: tokenOf("ad"), role: "operator" })).rejects.toThrow("own role");
    await expect(admin.action(api.runs.mutations.startRun, { sourceId: await admin.action(api.sources.mutations.registerSource, sourceArgs), creditBudget: Number.NaN })).rejects.toThrow("creditBudget must be a finite number");
    await expect(admin.action(api.sources.mutations.registerSource, sourceArgs)).rejects.toThrow("source key already registered");
    expect(await rows()).toEqual([]);
  });

  test("a successful call records nothing", async () => {
    const admin = await asMember(raw, "ad", orgId, "admin");
    await admin.action(api.sources.mutations.registerSource, sourceArgs);
    await admin.action(api.audit.api.recentAudit, { paginationOpts: { numItems: 5, cursor: null } });
    expect(await rows()).toEqual([]);
  });

  test("an error that merely SAYS forbidden is not a refusal: classification reads typed data, never words", () => {
    expect(refusalReasonOf(new Error("forbidden: requires the admin role"))).toBeNull();
    expect(refusalReasonOf(new ConvexError("forbidden: not a member of this org"))).toBeNull();
    expect(refusalReasonOf(new ConvexError({ code: "forbidden", reason: "made_up" }))).toBeNull();
    expect(refusalReasonOf(new ConvexError({ code: "nope", reason: "not_member" }))).toBeNull();
    expect(refusalReasonOf(null)).toBeNull();
    // the shape Convex really delivers to an action: a PLAIN ConvexError rebuilt from the message, with the data restored
    // (convex/src/server/impl/syscall.ts), not our subclass. convex-test hands back the original object, so this is pinned here.
    const rebuilt = new ConvexError<{ code: string; reason: string } | string>("Uncaught ConvexError: something else entirely");
    rebuilt.data = { code: "forbidden", reason: "not_member" };
    expect(refusalReasonOf(rebuilt)).toBe("not_member");
  });
});

describe("a failure to record never changes the outcome", () => {
  test("a recorder that throws (two rows for one bucket, so .unique() fails) does not mask the refusal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(H0 + 3 * HOUR);
    const op = await asMember(raw, "op", orgId, "operator");
    const membershipId = await membershipOf("op");
    const bucket = { orgId, hour: H0 + 3 * HOUR, fn: "recentAudit" as const, reason: "insufficient_role" as const, callerClass: "member" as const, membershipId, count: 1 };
    await raw.run(async (ctx) => {
      await ctx.db.insert("refusalCounts", bucket);
      await ctx.db.insert("refusalCounts", bucket);
    });
    // the recorder really does throw on this state ...
    await expect(op.mutation(internal.observability.refusals.recordRefusal, { fn: "recentAudit", reason: "insufficient_role" })).rejects.toThrow();
    // ... and the caller still gets the original refusal, not the recorder's error
    const err = await refusalOf(op.action(api.audit.api.recentAudit, { paginationOpts: { numItems: 1, cursor: null } }));
    expect(err.message).toBe("forbidden: requires the admin role");
    expect(err.data).toEqual({ code: "forbidden", reason: "insufficient_role" });
    expect((await rows()).map((r) => r.count)).toEqual([1, 1]);
  });

  test("the wrapper rethrows the ORIGINAL error object when recording fails, and never records a non-refusal", async () => {
    const recorded: unknown[] = [];
    const failing = { runMutation: async (_f: unknown, a: unknown) => { recorded.push(a); throw new Error("recorder down"); } };
    const refusal = new ConvexError({ code: "forbidden", reason: "insufficient_role" });
    await expect(recordRefusals(failing as never, "startRun", async () => { throw refusal; })).rejects.toBe(refusal);
    expect(recorded).toEqual([{ fn: "startRun", reason: "insufficient_role" }]); // only fn and reason: nothing about the caller
    const business = new Error("run not found");
    await expect(recordRefusals(failing as never, "startRun", async () => { throw business; })).rejects.toBe(business);
    expect(recorded).toHaveLength(1);
    expect(await recordRefusals(failing as never, "startRun", async () => 7)).toBe(7);
    expect(recorded).toHaveLength(1);
  });
});

describe("the action runs the work as the caller", () => {
  test("auth identity propagates from the action to the internal function: the audit entry names the caller", async () => {
    const admin = await asMember(raw, "ad", orgId, "admin");
    const sourceId = await admin.action(api.sources.mutations.registerSource, sourceArgs);
    const log = await raw.run((ctx) => ctx.db.query("auditLog").collect());
    expect(log).toMatchObject([{ orgId, action: "source.registered", targetId: sourceId, actor: { kind: "user", userId: tokenOf("ad"), role: "admin" } }]);
  });
});

describe("refusalCounts (the read)", () => {
  const read = (fromHour: number, toHour: number) => raw.withIdentity({ subject: "ad", orgId }).query(api.observability.refusals.refusalCounts, { fromHour, toHour });
  beforeEach(async () => void (await asMember(raw, "ad", orgId, "admin")));
  const seed = (over: Partial<Doc<"refusalCounts">>, n = 1) =>
    raw.run(async (ctx) => {
      for (let i = 0; i < n; i++) await ctx.db.insert("refusalCounts", { orgId, hour: 0, fn: "startRun", reason: "not_member", callerClass: "non_member", membershipId: null, count: 1, ...over });
    });

  test("admin only, like the rest of the admin tier", async () => {
    for (const role of ["operator", "analyst"] as const) {
      const t = await asMember(raw, role, orgId, role);
      await expect(t.query(api.observability.refusals.refusalCounts, { fromHour: 0, toHour: 0 })).rejects.toThrow("forbidden");
    }
  });

  test("returns the window's buckets for the caller's org only, with a total", async () => {
    const other = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
    await seed({ hour: 0, count: 3 });
    await seed({ hour: HOUR, fn: "recentAudit", count: 2 });
    await seed({ hour: 2 * HOUR, count: 50 }); // outside the window
    await seed({ orgId: other, hour: 0, count: 9 }); // another org
    const r = await read(0, HOUR);
    expect(r.buckets.map((b) => [b.hour, b.fn, b.count])).toEqual([[0, "startRun", 3], [HOUR, "recentAudit", 2]]);
    expect(r.total).toEqual({ value: 5, bound: "exact" });
    expect(r.more).toBe(false);
  });

  test("never a silent truncation: past the cap, more is true and the total is at_least", async () => {
    await seed({ hour: 0 }, REFUSAL_SCAN_CAP + 1);
    const r = await read(0, 0);
    expect(r.buckets).toHaveLength(REFUSAL_SCAN_CAP);
    expect(r.more).toBe(true);
    expect(r.total).toEqual({ value: REFUSAL_SCAN_CAP, bound: "at_least" });
  });

  test("a window that is not hour-aligned, reversed, non-finite or too wide is refused, never rounded or clamped", async () => {
    await expect(read(1, HOUR)).rejects.toThrow("fromHour must be");
    await expect(read(0, HOUR + 1)).rejects.toThrow("toHour must be");
    await expect(read(HOUR, 0)).rejects.toThrow("must not be before");
    await expect(read(Number.NaN, 0)).rejects.toThrow("fromHour must be");
    await expect(read(0, Number.POSITIVE_INFINITY)).rejects.toThrow("toHour must be");
    await expect(read(-HOUR, 0)).rejects.toThrow("fromHour must be");
    await expect(read(0, MAX_REFUSAL_WINDOW_HOURS * HOUR)).rejects.toThrow("at most");
    await expect(read(0, (MAX_REFUSAL_WINDOW_HOURS - 1) * HOUR)).resolves.toMatchObject({ more: false });
  });
});

describe("the stored domains", () => {
  const literalsOf = (validator: { members: readonly { value?: unknown }[] }) => validator.members.map((m) => m.value);
  test("each field's declared domain is the same closed set the schema enforces", () => {
    expect(literalsOf(refusableFunction as never)).toEqual([...REFUSABLE_FUNCTIONS]);
    expect(literalsOf(refusalReason as never)).toEqual([...REFUSAL_REASONS]);
    expect(literalsOf(callerClass as never)).toEqual([...CALLER_CLASSES]);
    expect(REFUSAL_DOMAINS.fn.enum).toBe(REFUSABLE_FUNCTIONS);
    expect(REFUSAL_DOMAINS.reason.enum).toBe(REFUSAL_REASONS);
    expect(REFUSAL_DOMAINS.callerClass.enum).toBe(CALLER_CLASSES);
    expect(REFUSAL_REASONS).toEqual(["no_identity", "not_member", "malformed_membership", "insufficient_role"]);
  });

  test("the recorder checks every field against its domain before writing: a count past MAX_SAFE_INTEGER is refused, not written", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(H0);
    const op = await asMember(raw, "op", orgId, "operator");
    const membershipId = await membershipOf("op");
    await raw.run((ctx) =>
      ctx.db.insert("refusalCounts", { orgId, hour: H0, fn: "startRun", reason: "insufficient_role", callerClass: "member", membershipId, count: Number.MAX_SAFE_INTEGER }),
    );
    await expect(op.mutation(internal.observability.refusals.recordRefusal, { fn: "startRun", reason: "insufficient_role" })).rejects.toThrow('refusal field "count" is outside its declared domain');
    expect((await rows()).map((r) => r.count)).toEqual([Number.MAX_SAFE_INTEGER]);
  });

  test("the hour comes from the recorder's clock and a broken clock is refused, not clamped", () => {
    expect(hourOf(3 * HOUR + 59 * 60 * 1000)).toBe(3 * HOUR);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) expect(() => hourOf(bad)).toThrow("clock");
  });
});

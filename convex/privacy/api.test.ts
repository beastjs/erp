/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { asMember, tokenOf } from "../_shared/testkit.support";
import schema from "../schema";
import { isSuppressed } from "./suppress";

const modules = import.meta.glob("/convex/**/*.ts");

let raw: ReturnType<typeof convexTest>;
let orgId: Id<"orgs">;
let contactId: Id<"contacts">;
beforeEach(async () => {
  raw = convexTest(schema, modules);
  orgId = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 }));
  contactId = await raw.run((ctx) => ctx.db.insert("contacts", { orgId, fields: [], display: {} }));
});
const good = () => ({ subjectType: "contact" as const, subjectId: contactId as string, reasonCode: "data_subject_request" as const, legalBasis: "gdpr_art17_erasure" as const, reference: "CASE-2044" });
const dump = (table: "erasures" | "auditLog" | "suppressions") => raw.run((ctx) => ctx.db.query(table).collect());

describe("requestErasure: who may erase, and the record that makes it answerable", () => {
  test.each(["operator", "analyst"] as const)("an %s is refused, and nothing is erased or recorded", async (role) => {
    const t = await asMember(raw, "u", orgId, role);
    await expect(t.mutation(api.privacy.api.requestErasure, good())).rejects.toThrow("forbidden");
    expect(await dump("erasures")).toHaveLength(0);
    expect(await dump("auditLog")).toHaveLength(0);
  });

  test("a caller with a valid token and no membership is refused", async () => {
    await expect(raw.withIdentity({ subject: "stranger", orgId }).mutation(api.privacy.api.requestErasure, good())).rejects.toThrow("forbidden");
  });

  test("an admin erases; the erasures row records who, why, on what basis and under which case reference", async () => {
    const admin = await asMember(raw, "boss", orgId, "admin");
    expect(await admin.mutation(api.privacy.api.requestErasure, good())).toMatchObject({ complete: true });
    expect(await dump("erasures")).toMatchObject([
      { requestedBy: { kind: "user", userId: tokenOf("boss"), role: "admin" }, reasonCode: "data_subject_request", legalBasis: "gdpr_art17_erasure", reference: "CASE-2044", completedAt: expect.any(Number) },
    ]);
    const actions = ((await dump("auditLog")) as Doc<"auditLog">[]).map((r) => [r.action, r.actor.kind]);
    expect(actions).toEqual([["erasure.requested", "user"], ["erasure.completed", "system"]]);
  });

  test("asking again does not record a second request or a second completion", async () => {
    const admin = await asMember(raw, "boss", orgId, "admin");
    await admin.mutation(api.privacy.api.requestErasure, good());
    await admin.mutation(api.privacy.api.requestErasure, { ...good(), reference: "CASE-9999" });
    expect(await dump("erasures")).toHaveLength(1);
    expect(((await dump("erasures")) as Doc<"erasures">[])[0]!.reference).toBe("CASE-2044"); // the original request stands
    expect(await dump("auditLog")).toHaveLength(2);
  });

  test("the accountability fields are closed vocabularies and an opaque id: prose, a name or an address cannot be recorded", async () => {
    const admin = await asMember(raw, "boss", orgId, "admin");
    for (const reference of ["", "ab", "Bobby Tables", "bobby-tables", "bob.tables@acme.com", "CASE 1001", "x".repeat(65), "CASE-1001\n"]) {
      await expect(admin.mutation(api.privacy.api.requestErasure, { ...good(), reference }), JSON.stringify(reference)).rejects.toThrow(/reference must be an opaque case id/);
    }
    await expect(admin.mutation(api.privacy.api.requestErasure, { ...good(), reasonCode: "because Bob asked" as never })).rejects.toThrow();
    await expect(admin.mutation(api.privacy.api.requestErasure, { ...good(), legalBasis: "whim" as never })).rejects.toThrow();
    expect(await dump("erasures")).toHaveLength(0);
    expect(await dump("auditLog")).toHaveLength(0);
  });

  test("an admin of ANOTHER org cannot erase this org's subject", async () => {
    const other = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
    const theirAdmin = await asMember(raw, "them", other, "admin");
    await expect(theirAdmin.mutation(api.privacy.api.requestErasure, good())).rejects.toThrow("subject not found");
    expect(await dump("erasures")).toHaveLength(0);
  });
});

describe("suppressIdentifier", () => {
  test("is admin only, lists the identifier, and the audit entry holds the kind and reason but never the identifier", async () => {
    const op = await asMember(raw, "op", orgId, "operator");
    await expect(op.mutation(api.privacy.api.suppressIdentifier, { identifier: "bob.tables@acme.com", reason: "opt_out" })).rejects.toThrow("forbidden");
    const admin = await asMember(raw, "boss", orgId, "admin");
    expect(await admin.mutation(api.privacy.api.suppressIdentifier, { identifier: "bob.tables@acme.com", reason: "opt_out" })).toEqual({ created: true });
    expect(await admin.mutation(api.privacy.api.suppressIdentifier, { identifier: "Bob.Tables@acme.com", reason: "opt_out" })).toEqual({ created: false });
    expect(await admin.run((ctx) => isSuppressed(ctx, { identifier: "bob.tables@acme.com" }))).toBe(true);
    const log = (await dump("auditLog")) as Doc<"auditLog">[];
    expect(log).toHaveLength(1); // the repeat wrote nothing
    expect(log[0]).toMatchObject({ action: "suppression.added", actor: { kind: "user", role: "admin" }, after: { kind: "email", reasonCode: "opt_out" } });
    expect(JSON.stringify(await dump("auditLog")).toLowerCase()).not.toMatch(/bob|tables|acme/);
  });
});

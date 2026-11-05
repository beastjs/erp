/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../schema";
import { withOrg } from "./org";

const modules = import.meta.glob("../**/*.ts");

test("withOrg rejects a request with no org context", async () => {
  const t = convexTest(schema, modules);
  await expect(t.run((ctx) => withOrg(ctx, {}))).rejects.toThrow("no org context");
});

test("withOrg rejects an identity that carries no orgId", async () => {
  const t = convexTest(schema, modules).withIdentity({ subject: "u1" });
  await expect(t.run((ctx) => withOrg(ctx, {}))).rejects.toThrow("no org context");
});

test("withOrg returns the caller's orgId", async () => {
  const t = convexTest(schema, modules);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 }),
  );
  const asOrg = t.withIdentity({ subject: "u1", orgId });
  expect(await asOrg.run((ctx) => withOrg(ctx, {}))).toEqual({ orgId });
});

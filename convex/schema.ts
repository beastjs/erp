import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { claims } from "./claims/schema";

export default defineSchema({
  claims,
  orgs: defineTable({
    name: v.string(),
    createdAt: v.number(),
  }),
  // Minimal shapes so later tasks can reference Id<"sources"> / Id<"discoveryRuns">;
  // tasks 6 and 7 extend these tables.
  sources: defineTable({
    orgId: v.id("orgs"),
    key: v.string(),
    trustWeight: v.number(),
  }),
  discoveryRuns: defineTable({
    orgId: v.id("orgs"),
    sourceId: v.id("sources"),
    status: v.string(),
  }),
});

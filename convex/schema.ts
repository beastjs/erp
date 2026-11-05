import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { claims } from "./claims/schema";
import { sources, candidates } from "./sources/schema";
import { accounts, contacts, identityLinks } from "./projections/schema";

export default defineSchema({
  claims,
  accounts,
  contacts,
  identityLinks,
  orgs: defineTable({
    name: v.string(),
    createdAt: v.number(),
  }),
  // Minimal shape so later tasks can reference Id<"discoveryRuns">; task 7 extends this table.
  sources,
  candidates,
  discoveryRuns: defineTable({
    orgId: v.id("orgs"),
    sourceId: v.id("sources"),
    status: v.string(),
  }),
});

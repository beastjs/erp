import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { claims } from "./claims/schema";
import { sources, candidates, columnMappings } from "./sources/schema";
import { discoveryRuns } from "./runs/schema";
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
  sources,
  candidates,
  columnMappings,
  discoveryRuns,
});

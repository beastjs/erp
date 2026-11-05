import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { claims } from "./claims/schema";
import { sources, candidates, columnMappings, importChunks, importRejections } from "./sources/schema";
import { discoveryRuns } from "./runs/schema";
import { signals } from "./signals/schema";
import { accounts, contacts, contactKeys, identityLinks } from "./projections/schema";

export default defineSchema({
  claims,
  accounts,
  contacts,
  contactKeys,
  identityLinks,
  orgs: defineTable({
    name: v.string(),
    createdAt: v.number(),
  }),
  sources,
  candidates,
  columnMappings,
  importChunks,
  importRejections,
  discoveryRuns,
  signals,
});

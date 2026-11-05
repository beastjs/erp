import { defineTable } from "convex/server";
import { v, type Infer } from "convex/values";
import { claimMethod } from "../claims/schema";

/** The winning claim for one field, with enough provenance to explain it. */
export const projectedField = v.object({
  field: v.string(),
  value: v.any(),
  claimId: v.id("claims"),
  method: claimMethod,
  confidence: v.number(),
  observedAt: v.number(),
});
export type ProjectedField = Infer<typeof projectedField>;

/*
 * `fields` is an array sorted by field name, not a record: claim field names are
 * free-form strings, and Convex record keys may not start with `$` or `_`, so one
 * odd claim could otherwise make the whole projection unwritable.
 *
 * `display` is denormalized from `fields` for the leads table (no joins). It is
 * derived in the same step as `fields` and never written on its own.
 */
export const accounts = defineTable({
  orgId: v.id("orgs"),
  fields: v.array(projectedField),
  display: v.object({
    name: v.optional(v.string()),
    domain: v.optional(v.string()),
  }),
}).index("by_org", ["orgId"]);

export const contacts = defineTable({
  orgId: v.id("orgs"),
  fields: v.array(projectedField),
  display: v.object({
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    title: v.optional(v.string()),
  }),
}).index("by_org", ["orgId"]);

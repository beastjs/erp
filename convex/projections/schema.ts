import { defineTable } from "convex/server";
import { v, type Infer } from "convex/values";
import { claimMethod, subjectType } from "../claims/schema";

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
})
  .index("by_org", ["orgId"])
  // Ingest looks accounts up by the normalized domain the winning claim carries.
  .index("by_org_and_domain", ["orgId", "display.domain"]);

export const contacts = defineTable({
  orgId: v.id("orgs"),
  fields: v.array(projectedField),
  display: v.object({
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    title: v.optional(v.string()),
  }),
})
  .index("by_org", ["orgId"]);

/*
 * Lookup keys that let ingest find an existing contact instead of minting a duplicate. `scope` is
 * "any" for email (a mailbox identifies one person wherever they were seen) and the account id (or
 * "none") for profileUrl/phone/name, which only identify someone within a company. `value` is always
 * the output of the shared normalizers. Derived data: written only by ingest.
 * TASK 13 (erasure) MUST delete an erased contact's keys: a stale key lets the contact be re-found and
 * re-attached to new claims after erasure. There is no rebuild path or uniqueness enforcement yet.
 */
export const contactKeys = defineTable({
  orgId: v.id("orgs"),
  scope: v.string(),
  kind: v.union(v.literal("email"), v.literal("profile"), v.literal("phone"), v.literal("name")),
  value: v.string(),
  contactId: v.id("contacts"),
}).index("by_key", ["orgId", "scope", "kind", "value"]);

/*
 * A reversible record that `mergedFromId` is the same entity as `subjectId`.
 * Never a destructive merge: both subjects stay. Unlinking stamps `reversedAt`
 * rather than deleting, so the decision, its signals and its score stay auditable.
 */
export const identityLinks = defineTable({
  orgId: v.id("orgs"),
  subjectType,
  subjectId: v.union(v.id("accounts"), v.id("contacts")),
  mergedFromId: v.union(v.id("accounts"), v.id("contacts")),
  score: v.number(),
  signals: v.array(v.string()),
  createdAt: v.number(),
  reversedAt: v.optional(v.number()),
})
  .index("by_subject", ["orgId", "subjectId"])
  .index("by_pair", ["orgId", "subjectId", "mergedFromId", "reversedAt"]);

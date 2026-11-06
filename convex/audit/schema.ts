import { defineTable } from "convex/server";
import { v } from "convex/values";
import { actor } from "../_shared/actor";

/** A value an audit entry may hold: a controlled-vocabulary token, a number or a flag. See `log.ts` for what that excludes. */
export const auditScalar = v.union(v.string(), v.number(), v.boolean(), v.null());

/**
 * The append-only record of who changed what (spec 7.2). NO PERSONAL DATA OF A DATA SUBJECT IS EVER STORED HERE, by
 * construction rather than by promise: `log.ts` accepts only fields from a per-action allowlist of non-personal
 * attributes (a version number, a state name, a budget, a count), so erasing a subject has nothing to redact in this
 * table, and it can stay immutable. The content of a change lives in the domain row it concerns (a versioned model,
 * a lead), where erasure reaches it; the log says THAT it changed and from which state to which.
 * `actor` is a typed union: a person (with the role they were verified to hold) or a named system process, never a string
 * that someone has to recognise. No code path patches, replaces or deletes a row (audit.guard.test.ts).
 */
export const auditLog = defineTable({
  orgId: v.id("orgs"),
  actor,
  action: v.string(),
  targetTable: v.string(),
  targetId: v.string(),
  before: v.optional(v.record(v.string(), auditScalar)),
  after: v.optional(v.record(v.string(), auditScalar)),
  createdAt: v.number(),
})
  .index("by_org_and_created", ["orgId", "createdAt"])
  .index("by_org_and_target", ["orgId", "targetTable", "targetId"]);

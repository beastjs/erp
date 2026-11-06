import { defineTable } from "convex/server";
import { v } from "convex/values";
import { tier } from "../icp/schema";
import { projectedField } from "../projections/schema";

/** Where a lead sits in inventory. Independent of `disposition`: delivered is not accepted is not converted. */
export const INVENTORY_STATES = ["Available", "Reserved", "Sold", "Delivered", "Expired", "Replaced"] as const;
export type InventoryState = (typeof INVENTORY_STATES)[number];
export const inventoryState = v.union(
  v.literal("Available"),
  v.literal("Reserved"),
  v.literal("Sold"),
  v.literal("Delivered"),
  v.literal("Expired"),
  v.literal("Replaced"),
);

/** Lifecycle position, its own axis. Technical delivery, commercial acceptance and conversion stay distinct. */
export const DISPOSITIONS = [
  "Captured",
  "PendingValidation",
  "Validated",
  "Qualified",
  "Held",
  "Rejected",
  "ReadyForDistribution",
  "Delivered",
  "Accepted",
  "Converted",
  "Closed",
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
export const disposition = v.union(
  v.literal("Captured"),
  v.literal("PendingValidation"),
  v.literal("Validated"),
  v.literal("Qualified"),
  v.literal("Held"),
  v.literal("Rejected"),
  v.literal("ReadyForDistribution"),
  v.literal("Delivered"),
  v.literal("Accepted"),
  v.literal("Converted"),
  v.literal("Closed"),
);

const criterion = v.union(
  v.literal("required_fields"),
  v.literal("source_recorded"),
  v.literal("provenance_available"),
  v.literal("within_freshness_window"),
  v.literal("duplicate_checked"),
  v.literal("permissions_documented"),
);

/**
 * A FROZEN package (Spec §3.1, §12): everything a customer sees is copied here at packaging time, so no later
 * claim, rescore or projection rebuild can change a delivered lead. APPEND-ONLY apart from exactly two
 * fields, `inventoryState` and `disposition`, which only `setInventoryState` / `setDisposition` write, and ONE
 * lawful override: erasure (spec 7.3) redacts a side of `snapshot` in place and stamps `contactErasedAt` /
 * `accountErasedAt`, written only by privacy/redact.ts (a guard test pins all three writers).
 * `tier` is the commercial worth and is never changed by the gate: a Held lead keeps its tier.
 */
export const leads = defineTable({
  orgId: v.id("orgs"),
  accountId: v.id("accounts"),
  contactId: v.id("contacts"),
  scoreRunId: v.id("scoreRuns"),
  tier,
  score: v.number(),
  confidence: v.number(),
  fit: v.number(),
  intent: v.number(),
  priority: v.number(),
  /** Deep copies of the projections as they were when packaged, with per-field provenance. */
  snapshot: v.object({
    account: v.object({ fields: v.array(projectedField), display: v.object({ name: v.optional(v.string()), domain: v.optional(v.string()) }) }),
    contact: v.object({
      fields: v.array(projectedField),
      display: v.object({ name: v.optional(v.string()), email: v.optional(v.string()), title: v.optional(v.string()) }),
    }),
  }),
  /** Why a lead is Held: the failing criteria, with the window and clock they were judged against. */
  distributability: v.object({
    ok: v.boolean(),
    failed: v.array(criterion),
    freshnessWindowDays: v.number(),
    suppressed: v.boolean(),
    checkedAt: v.number(),
  }),
  inventoryState,
  disposition,
  packagedAt: v.number(),
  /**
   * Set by erasure alone. The matching side of `snapshot` has then been overwritten: every field value is null (its
   * provenance survives) and `display` is empty. The lead can no longer be reserved, sold or delivered.
   */
  contactErasedAt: v.optional(v.number()),
  accountErasedAt: v.optional(v.number()),
})
  .index("by_org_and_score_run", ["orgId", "scoreRunId"])
  .index("by_org_and_contact", ["orgId", "contactId"])
  .index("by_org_and_disposition", ["orgId", "disposition"])
  .index("by_org_and_contact_and_erased", ["orgId", "contactId", "contactErasedAt"])
  .index("by_org_and_account_and_erased", ["orgId", "accountId", "accountErasedAt"]);

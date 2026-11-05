import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * One row per import / crawl / enrichment run, and the single source of truth for what it cost.
 *
 * Cost per qualified lead is computed from stored data, not reconstructed: `creditsUsed` is the
 * numerator, and the denominator is a count of leads whose candidates/claims carry this `_id` as
 * `runId` (candidates have the `by_org_and_run_and_status` index; ingest stamps `runId` on every claim).
 *
 * Counters are monotonic and only ever incremented by the function that did the work, so
 * `rowsProcessed` is the progress a client can watch while a large import is in flight.
 */
export const discoveryRuns = defineTable({
  orgId: v.id("orgs"),
  sourceId: v.id("sources"),
  /** Opaque until the ICP tables exist (Task 9), which tightens this to an id. */
  icpVersionId: v.optional(v.string()),
  status: v.union(v.literal("running"), v.literal("completed")),
  /** Credits the run may spend; consumeCredits refuses to exceed it. */
  creditBudget: v.number(),
  creditsUsed: v.number(),
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
  /** Set when a chunked import is staged: the run completes itself once this many rows are processed and every candidate is settled. */
  rowsExpected: v.optional(v.number()),
  /** Rows (or submitted candidates) taken off the input, whatever their outcome. */
  rowsProcessed: v.number(),
  candidatesInserted: v.number(),
  /** Rows that were valid but matched a pending candidate. */
  duplicates: v.number(),
  /** Rows that failed mapping or validation. */
  rowsRejected: v.number(),
  /** Candidates ingest turned into subject rows and claims. */
  candidatesConsumed: v.number(),
  /** Candidates ingest turned away (contract violation) or could not process. */
  candidatesRejected: v.number(),
});

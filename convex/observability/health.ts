import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireRole } from "../_shared/authz";
import { resolveOrg } from "../_shared/org";
import type { SubjectType } from "../claims/schema";
import { ERASE_STALL_MS } from "../privacy/redact";
import { BACKOFF_CAP_MS, MAX_ATTEMPTS, REASON_CODES, backoffMs, type ReasonCode, type Stage } from "../pipeline/schema";
import { REJUDGE_LEASE_MS } from "../verify/sweep";
import { structuralLogic } from "../verify/structural";
import { COUNT_CAP, LIST_CAP, asOf as checkAsOf, countUpTo, tally, type Count, type ObsCtx } from "./definitions";

/*
 * The Jobs screen's numbers (spec 10, 4.5), and WEDGED WORK. Every chain in this system is self-scheduled, and Convex
 * does not retry a scheduled mutation that throws, so a chain can stop with nothing failed on record and nothing
 * scheduled: it then appears in no queue. Each listing below is one such chain, found from durable state that the
 * last COMMITTED step left behind (a failing transaction can write nothing, ledger: Task 12 M1, Task 13 H-1):
 *
 *   staleActive       pipeline subjects `active` whose row has not moved for longer than STALE_ACTIVE_MS
 *   stalledErasures   incomplete erasures that failed at least once, or that even the sweeper has stopped reaching
 *   stalledPurges     finished runs whose raw staged rows are still being purged (runs.purgePendingSince ages)
 *   stalledImports    running staged imports whose counters stopped moving (runs.progressAt ages)
 *   verificationSweep the re-judge walk lapsing, and the subjects it passed over (Task 15 carry)
 *
 * `retrying` is DERIVED here from `attempt > 0` on active rows; nothing stores it.
 * Bounded reads only: a count is a `Count` (cap + 1 rows, `at_least` past the cap), a listing has a `more` flag.
 * Content-free: ids, closed-set labels, counts and times. Never an error message (free text), never a subject's data.
 */

/**
 * An active subject is listed as stale after this long without its row changing. Every live wait is shorter: a retry
 * is scheduled after at most backoffMs(MAX_ATTEMPTS - 1) (4 minutes today), and a stage itself runs in seconds.
 * Pinned by a test to exceed the longest scheduled retry, so a subject waiting on its backoff is never called wedged.
 */
export const STALE_ACTIVE_MS = 30 * 60 * 1000;
/** An erasure whose `resumeAt` is this far past has been missed by the sweeper itself (it claims due rows for ERASE_SWEEP_CLAIM_MS, 10 min, every 5 min). */
export const ERASURE_OVERDUE_MS = 3 * ERASE_STALL_MS;
/** A purge continuation is scheduled at once and each link takes seconds: minutes of pending means the chain stopped. */
export const PURGE_STALLED_MS = 10 * 60 * 1000;
/** A staged import whose counters have not moved for this long has lost its chunk chain. */
export const IMPORT_STALLED_MS = 30 * 60 * 1000;
/** The re-judge cron runs every 15 minutes and a slice holds a REJUDGE_LEASE_MS lease: past both twice over, the slice fails on every tick. */
export const SWEEP_LAPSED_MS = 2 * (15 * 60 * 1000) + REJUDGE_LEASE_MS;

type Listing<T> = { count: Count; items: T[]; more: boolean };

export type PipelineHealth = {
  asOf: number;
  inFlight: Count;
  retrying: Count;
  deadLettered: Record<ReasonCode, Count>;
  staleActive: Listing<{ stateId: Id<"pipelineState">; subjectType: SubjectType; subjectId: string; stage: Stage; attempt: number; updatedAt: number }>;
  stalledErasures: Listing<{ erasureId: Id<"erasures">; subjectType: SubjectType; attempts: number; failedAt: number | null; resumeAt: number | null; overdue: boolean }>;
  stalledPurges: Listing<{ runId: Id<"discoveryRuns">; status: "completed" | "failed"; pendingSince: number }>;
  stalledImports: Listing<{ runId: Id<"discoveryRuns">; chunksExpected: number; chunksProcessed: number; lastProgressAt: number }>;
  verificationSweep: { state: "not_started" | "walking" | "lapsed" | "done"; passedOver: number; lastPassedOver: Id<"contacts"> | null };
  thresholds: { staleActiveAfterMs: number; erasureOverdueAfterMs: number; purgeStalledAfterMs: number; importStalledAfterMs: number; sweepLapsedAfterMs: number };
};

function listing<T>(rows: T[], cap = LIST_CAP): Listing<T> {
  return { count: tally(Math.min(rows.length, COUNT_CAP), rows.length > COUNT_CAP), items: rows.slice(0, cap), more: rows.length > cap };
}

export async function pipelineHealthOf(ctx: ObsCtx, args: { asOf: number }): Promise<PipelineHealth> {
  const now = checkAsOf(args.asOf);
  const { orgId } = await resolveOrg(ctx);

  // In flight and retrying: one bounded read of the active rows. `retrying` is a property of the rows read, so it is
  // at_least whenever inFlight is (some active rows were not read).
  const active = await ctx.db
    .query("pipelineState")
    .withIndex("by_org_and_status_and_reason", (q) => q.eq("orgId", orgId).eq("status", "active"))
    .take(COUNT_CAP + 1);
  const activeTruncated = active.length > COUNT_CAP;
  const inFlight = tally(Math.min(active.length, COUNT_CAP), activeTruncated);
  const retrying = tally(active.slice(0, COUNT_CAP).filter((s) => s.attempt > 0).length, activeTruncated);

  const deadLettered = {} as Record<ReasonCode, Count>;
  for (const code of REASON_CODES) {
    deadLettered[code] = await countUpTo(
      ctx.db.query("pipelineState").withIndex("by_org_and_status_and_reason", (q) => q.eq("orgId", orgId).eq("status", "deadlettered").eq("deadReasonCode", code)),
    );
  }

  const stale = await ctx.db
    .query("pipelineState")
    .withIndex("by_org_and_status_and_updated", (q) => q.eq("orgId", orgId).eq("status", "active").lt("updatedAt", now - STALE_ACTIVE_MS))
    .take(COUNT_CAP + 1);
  const staleActive = listing(
    stale.map((s) => ({ stateId: s._id, subjectType: s.subjectType, subjectId: s.subjectId, stage: s.stage, attempt: s.attempt, updatedAt: s.updatedAt })),
  );

  const incomplete = await ctx.db
    .query("erasures")
    .withIndex("by_org_and_completed_and_resume", (q) => q.eq("orgId", orgId).eq("completedAt", undefined))
    .take(COUNT_CAP + 1);
  const erasureRows = incomplete
    .slice(0, COUNT_CAP)
    .map((e) => ({
      erasureId: e._id,
      subjectType: e.subjectType,
      attempts: e.attempts ?? 0,
      failedAt: e.failedAt ?? null,
      resumeAt: e.resumeAt ?? null,
      overdue: e.resumeAt !== undefined && e.resumeAt < now - ERASURE_OVERDUE_MS,
    }))
    .filter((e) => e.attempts > 0 || e.overdue);
  // A truncated read of incomplete erasures makes the stalled count a lower bound even if fewer than the cap stalled.
  const stalledErasures = { ...listing(erasureRows), count: tally(erasureRows.length, incomplete.length > COUNT_CAP) };

  const pending = await ctx.db
    .query("discoveryRuns")
    .withIndex("by_org_and_purge_pending", (q) => q.eq("orgId", orgId).gte("purgePendingSince", 0).lt("purgePendingSince", now - PURGE_STALLED_MS))
    .take(COUNT_CAP + 1);
  const stalledPurges = listing(
    pending.flatMap((r) => (r.status === "running" || r.purgePendingSince === undefined ? [] : [{ runId: r._id, status: r.status, pendingSince: r.purgePendingSince }])),
  );

  const running = await ctx.db
    .query("discoveryRuns")
    .withIndex("by_org_and_status", (q) => q.eq("orgId", orgId).eq("status", "running"))
    .take(COUNT_CAP + 1);
  const importRows = running.slice(0, COUNT_CAP).flatMap((r) => {
    if (r.chunksExpected === undefined || (r.chunksProcessed ?? 0) >= r.chunksExpected) return [];
    const lastProgressAt = r.progressAt ?? r.startedAt;
    return lastProgressAt < now - IMPORT_STALLED_MS ? [{ runId: r._id, chunksExpected: r.chunksExpected, chunksProcessed: r.chunksProcessed ?? 0, lastProgressAt }] : [];
  });
  const stalledImports = { ...listing(importRows), count: tally(importRows.length, running.length > COUNT_CAP) };

  const logic = structuralLogic().short;
  const sweep = await ctx.db.query("verificationSweeps").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique();
  const sameWalk = sweep !== null && sweep.logic === logic;
  const verificationSweep: PipelineHealth["verificationSweep"] = {
    state: !sameWalk ? "not_started" : sweep.done ? "done" : sweep.leaseUntil < now - SWEEP_LAPSED_MS ? "lapsed" : "walking",
    passedOver: sameWalk ? (sweep.passedOver ?? 0) : 0,
    lastPassedOver: sameWalk ? (sweep.lastPassedOver ?? null) : null,
  };

  return {
    asOf: now,
    inFlight,
    retrying,
    deadLettered,
    staleActive,
    stalledErasures,
    stalledPurges,
    stalledImports,
    verificationSweep,
    thresholds: {
      staleActiveAfterMs: STALE_ACTIVE_MS,
      erasureOverdueAfterMs: ERASURE_OVERDUE_MS,
      purgeStalledAfterMs: PURGE_STALLED_MS,
      importStalledAfterMs: IMPORT_STALLED_MS,
      sweepLapsedAfterMs: SWEEP_LAPSED_MS,
    },
  };
}

/** The longest delay before a scheduled retry of a stage; STALE_ACTIVE_MS must exceed it (tested). */
export const LONGEST_RETRY_WAIT_MS = Math.min(backoffMs(MAX_ATTEMPTS - 1), BACKOFF_CAP_MS);

/**
 * Operator (spec 7.1: operators work the dead-letter queue, and this is that queue's health). It names subjects and
 * runs by id only, which an operator already reads through `listDeadLetters` and `getRun`; for erasures it gives the
 * erasure's own id and attempt count, never the subject or the recorded error text.
 */
export const pipelineHealth = query({
  args: { asOf: v.number() },
  handler: async (ctx, args): Promise<PipelineHealth> => {
    await requireRole(ctx, "operator");
    return await pipelineHealthOf(ctx, args);
  },
});

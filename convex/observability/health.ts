import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireRole } from "../_shared/authz";
import { resolveOrg } from "../_shared/org";
import type { SubjectType } from "../claims/schema";
import { findErasure } from "../privacy/erased";
import { ERASE_STALL_MS } from "../privacy/redact";
import { BACKOFF_CAP_MS, MAX_ATTEMPTS, REASON_CODES, backoffMs, type ReasonCode, type Stage } from "../pipeline/schema";
import { REJUDGE_LEASE_MS } from "../verify/sweep";
import { firstVerdictUnderLogic } from "../verify/mutations";
import { structuralLogic } from "../verify/structural";
import { COUNT_CAP, LIST_CAP, asOf as checkAsOf, countUpTo, tally, type Count, type ObsCtx } from "./definitions";

/*
 * The Jobs screen's numbers (spec 10, 4.5), and WEDGED WORK. Every chain in this system is self-scheduled, and Convex
 * does not retry a scheduled mutation that throws, so a chain can stop with nothing failed on record and nothing
 * scheduled: it then appears in no queue. Each listing below is one such chain, found from durable state that the
 * last COMMITTED step left behind (a failing transaction can write nothing, ledger: Task 12 M1, Task 13 H-1):
 *
 *   staleActive       pipeline subjects `active` whose row has not moved for longer than STALE_ACTIVE_MS
 *   stalledPurges     finished runs whose raw staged rows are still being purged (runs.purgePendingSince ages)
 *   stalledImports    running staged imports that stopped moving (runs.progressAt ages), by phase: staging, chunks, ingest
 *   verificationSweep the re-judge walk lapsing or never reached, and the subjects it passed over (Task 15 carry)
 * and, in a separate ADMIN read (`stalledErasures`), because erasure is admin-only everywhere else:
 *   stalledErasures   incomplete erasures that failed, or whose last committed step is too long ago (erasures.progressAt)
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
/**
 * An incomplete erasure with no COMMITTED step for this long is overdue. A healthy chain commits a step every few
 * seconds, and the sweeper (every 5 min) re-runs a row ERASE_STALL_MS (10 min) after its last commit, so three stall
 * periods without one means neither the chain nor the sweeper is getting work through.
 */
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
  stalledPurges: Listing<{ runId: Id<"discoveryRuns">; status: "running" | "completed" | "failed"; pendingSince: number }>;
  stalledImports: Listing<{ runId: Id<"discoveryRuns">; phase: ImportPhase; chunksExpected: number | null; chunksProcessed: number; lastProgressAt: number }>;
  verificationSweep: { state: "not_started" | "walking" | "lapsed" | "done"; passedOver: number; lastPassedOver: Id<"contacts"> | null };
  thresholds: { staleActiveAfterMs: number; purgeStalledAfterMs: number; importStalledAfterMs: number; sweepLapsedAfterMs: number };
};

/** Which link of a staged import stopped. A closed set. */
export type ImportPhase = "staging" | "chunks" | "ingest";

/** The phase a RUNNING run's staged import is in, or null when the run is not a staged import or has nothing left to do. */
function importPhase(r: Doc<"discoveryRuns">): ImportPhase | null {
  if (r.chunksExpected === undefined) return r.stagedAt !== undefined ? "staging" : null;
  if ((r.chunksProcessed ?? 0) < r.chunksExpected) return "chunks";
  if (r.candidatesConsumed + r.candidatesRejected < r.candidatesInserted) return "ingest";
  return null;
}

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

  const pending = await ctx.db
    .query("discoveryRuns")
    .withIndex("by_org_and_purge_pending", (q) => q.eq("orgId", orgId).gte("purgePendingSince", 0).lt("purgePendingSince", now - PURGE_STALLED_MS))
    .take(COUNT_CAP + 1);
  // The index range is the whole filter: `purgePendingSince` is set only on a run that has ended (purgeStagedChunks refuses
  // a running one), so there is no status to check, and `?? 0` cannot be reached (the range starts at 0).
  const stalledPurges = listing(pending.map((r) => ({ runId: r._id, status: r.status, pendingSince: r.purgePendingSince ?? 0 })));

  const running = await ctx.db
    .query("discoveryRuns")
    .withIndex("by_org_and_status", (q) => q.eq("orgId", orgId).eq("status", "running"))
    .take(COUNT_CAP + 1);
  // Every phase is judged from `progressAt`, which bumpRun stamps on chunk AND ingest progress, and staging stamps too.
  const importRows = running.slice(0, COUNT_CAP).flatMap((r) => {
    const phase = importPhase(r);
    if (phase === null) return [];
    const lastProgressAt = r.progressAt ?? r.startedAt;
    return lastProgressAt < now - IMPORT_STALLED_MS
      ? [{ runId: r._id, phase, chunksExpected: r.chunksExpected ?? null, chunksProcessed: r.chunksProcessed ?? 0, lastProgressAt }]
      : [];
  });
  const stalledImports = { ...listing(importRows), count: tally(importRows.length, running.length > COUNT_CAP) };

  const logic = structuralLogic().short;
  const sweep = await ctx.db.query("verificationSweeps").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique();
  const sameWalk = sweep !== null && sweep.logic === logic;
  // Not started under today's rules: since when has a walk been due? With no row at all, since the org was created; with a
  // row under older rules, at least since the org's first verdict under today's rules (one indexed read). Due for longer
  // than SWEEP_LAPSED_MS with no slice committing means the cron is not reaching this org: lapsed, not merely not started.
  let dueSince: number | null = null;
  if (!sameWalk) {
    if (sweep === null) dueSince = (await ctx.db.get(orgId))?.createdAt ?? null;
    else {
      const first = await firstVerdictUnderLogic(ctx, orgId, logic);
      dueSince = first?.checkedAt ?? null;
    }
  }
  // A passed-over contact erased since is not named: the listing would otherwise point at a person who is gone.
  const named = sameWalk ? (sweep.lastPassedOver ?? null) : null;
  const lastPassedOver = named !== null && (await findErasure(ctx, orgId, "contact", named)) !== null ? null : named;
  const verificationSweep: PipelineHealth["verificationSweep"] = {
    state: !sameWalk
      ? dueSince !== null && dueSince < now - SWEEP_LAPSED_MS
        ? "lapsed"
        : "not_started"
      : sweep.done
        ? "done"
        : sweep.leaseUntil < now - SWEEP_LAPSED_MS
          ? "lapsed"
          : "walking",
    passedOver: sameWalk ? (sweep.passedOver ?? 0) : 0,
    lastPassedOver,
  };

  return {
    asOf: now,
    inFlight,
    retrying,
    deadLettered,
    staleActive,
    stalledPurges,
    stalledImports,
    verificationSweep,
    thresholds: {
      staleActiveAfterMs: STALE_ACTIVE_MS,
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
 * runs by id only, which an operator already reads through `listDeadLetters` and `getRun`. It says NOTHING about
 * erasures: erasure is admin-only, so its wedged work is `stalledErasures`, below, at admin.
 */
export const pipelineHealth = query({
  args: { asOf: v.number() },
  handler: async (ctx, args): Promise<PipelineHealth> => {
    await requireRole(ctx, "operator");
    return await pipelineHealthOf(ctx, args);
  },
});

export type StalledErasures = {
  asOf: number;
  stalled: Listing<{ erasureId: Id<"erasures">; subjectType: SubjectType; attempts: number; failedAt: number | null; lastProgressAt: number; overdue: boolean }>;
  overdueAfterMs: number;
};

/**
 * Incomplete erasures that failed (attempts > 0) or are overdue: no step has COMMITTED for ERASURE_OVERDUE_MS. Judged
 * from `progressAt`, which every committed erasure step stamps, and not from `resumeAt`: the sweeper pushes `resumeAt`
 * forward on every pass whether or not the run it schedules then gets through, so a chain whose failure-catching code
 * also fails would never look overdue by it. (The standing rule: a transaction that fails records nothing; the last
 * COMMITTED step does.) A row from before `progressAt` existed is judged from its request time.
 */
export async function stalledErasuresOf(ctx: ObsCtx, args: { asOf: number }): Promise<StalledErasures> {
  const now = checkAsOf(args.asOf);
  const { orgId } = await resolveOrg(ctx);
  const incomplete = await ctx.db
    .query("erasures")
    .withIndex("by_org_and_completed_and_resume", (q) => q.eq("orgId", orgId).eq("completedAt", undefined))
    .take(COUNT_CAP + 1);
  const rows = incomplete
    .slice(0, COUNT_CAP)
    .map((e) => {
      const lastProgressAt = e.progressAt ?? e.requestedAt;
      return { erasureId: e._id, subjectType: e.subjectType, attempts: e.attempts ?? 0, failedAt: e.failedAt ?? null, lastProgressAt, overdue: lastProgressAt < now - ERASURE_OVERDUE_MS };
    })
    .filter((e) => e.attempts > 0 || e.overdue);
  // A truncated read of incomplete erasures makes the stalled count a lower bound even if fewer than the cap stalled.
  return { asOf: now, stalled: { ...listing(rows), count: tally(rows.length, incomplete.length > COUNT_CAP) }, overdueAfterMs: ERASURE_OVERDUE_MS };
}

/**
 * Admin: erasure is admin-only everywhere else (`requestErasure`), so its state is too. Ids, attempt counts and times;
 * never the subject or the recorded error text. A plain query (like `refusalCounts`): a refused read is not recorded.
 */
export const stalledErasures = query({
  args: { asOf: v.number() },
  handler: async (ctx, args): Promise<StalledErasures> => {
    await requireRole(ctx, "admin");
    return await stalledErasuresOf(ctx, args);
  },
});

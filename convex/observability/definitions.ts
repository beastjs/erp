import type { QueryCtx } from "../_generated/server";
import { CONVEX_READ_LIMIT_BYTES, MAX_CLAIM_DOC_BYTES } from "../_shared/limits";

/*
 * Spec 10 / TECH.md: metric definitions travel with the metrics, and an observed value is told apart from a modelled
 * (estimated) one. Every field a Task 16 query returns is a key here, spelled `<query>.<field>` (pinned by a test that
 * walks real results), so a dashboard can always show what a number means and how far it can be trusted.
 *
 *   basis     observed: counted from stored rows. modelled: an estimate of a population from a declared sample.
 *   coverage  exact:       the whole population was read.
 *             lower_bound: a count over a bounded read; when the bound was hit the value says `at_least` (see Count).
 *             upper_bound: a ratio whose denominator is such a count; exact unless that count is at_least, and then
 *                          the value is at most this (its companion field says `at_most`).
 *             sample:      computed over a declared sample, named in the definition.
 *             listing:     a bounded list of examples; its `more` flag says when there are others.
 *
 * NEVER A SILENT UNDERCOUNT. Convex has no count operator and a query has read limits, so every count over a table
 * that can grow without bound is a `Count`: the reader takes cap+1 rows, and a value at the cap says `at_least`.
 * Nothing here reports a truncated count as if it were the total.
 */

export type Basis = "observed" | "modelled";
export type Coverage = "exact" | "lower_bound" | "upper_bound" | "sample" | "listing";
export type MetricDefinition = { readonly definition: string; readonly basis: Basis; readonly coverage: Coverage };

/** A count that is either exact or a stated lower bound. Never a bare number that might be short. */
export type Count = { value: number; bound: "exact" | "at_least" };

/** Rows a single count may read before it reports `at_least`. Several counts share one query's read budget. */
export const COUNT_CAP = 500;
/** Example rows a listing returns; `more` says whether there are others. */
export const LIST_CAP = 25;
/** Newest claims the data-quality sample reads at most, when its byte budget allows (see QUALITY_CLAIM_READ_BUDGET). */
export const QUALITY_SAMPLE = 500;
/**
 * Bytes of claims the data-quality sample may read. Claims are read whole and a claim document can be as large as
 * MAX_CLAIM_DOC_BYTES (668,676: see _shared/limits.ts), so a fixed count cannot be safe: QUALITY_SAMPLE + 1 claims of
 * that size is about 335 MB against a 16 MiB read limit. The sample therefore reads page by page, each page no more
 * claims than the budget left could hold at MAX_CLAIM_DOC_BYTES each, and stops when no further claim is sure to fit:
 *   claims       14 MiB = 14,680,064 bytes -> at least floor(14,680,064 / 668,676) = 21 maximum-size claims; 500 ordinary ones
 *   verdicts      1 MiB reserved for at most one verification row per sampled claim (each well under 1 KB)
 *   everything else (membership, org): the remaining 1 MiB of CONVEX_READ_LIMIT_BYTES (16 MiB).
 * Pinned by observability/quality.test.ts.
 */
export const QUALITY_CLAIM_READ_BUDGET = 14 * 1024 * 1024;
export const QUALITY_VERDICT_RESERVE = 1024 * 1024;
if (QUALITY_CLAIM_READ_BUDGET + QUALITY_VERDICT_RESERVE >= CONVEX_READ_LIMIT_BYTES || QUALITY_CLAIM_READ_BUDGET < MAX_CLAIM_DOC_BYTES) {
  throw new Error("the data-quality read budget does not fit the read limit, or cannot hold one claim");
}
/** Pipeline rows of ONE run that a run metric reads. */
export const RUN_SCAN_CAP = 1000;
/** Refusal buckets one refusalCounts read returns; past that `more` is true and `total` is at_least. */
export const REFUSAL_SCAN_CAP = 1000;
/** Milliseconds per day, for ages. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Counts the rows of an index range, reading at most `cap` + 1 of them. */
export async function countUpTo(q: { take(n: number): Promise<unknown[]> }, cap = COUNT_CAP): Promise<Count> {
  const rows = await q.take(cap + 1);
  return rows.length > cap ? { value: cap, bound: "at_least" } : { value: rows.length, bound: "exact" };
}

/** A tally over a read that may have stopped at its cap: every count from it is a lower bound when it did. */
export const tally = (value: number, truncated: boolean): Count => ({ value, bound: truncated ? "at_least" : "exact" });

/**
 * Median; 0 for an empty set (spec: never NaN). Fails closed on a non-finite input instead of dropping it, so a median
 * is always over exactly the values its caller counted (appendClaim refuses a non-finite observedAt, so none arrives).
 */
export function median(values: readonly number[]): number {
  if (!values.every((x) => Number.isFinite(x))) throw new Error("median: every value must be a finite number");
  const xs = [...values].sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

/** `num / den`, or null when it is not a finite number (zero denominator, non-finite operand). Validated, never clamped. */
export function ratio(num: number, den: number): number | null {
  if (den === 0) return null;
  const r = num / den;
  return Number.isFinite(r) ? r : null;
}

/** A wall-clock instant handed to a query. Queries must not read the clock, so the caller states "as of when". */
export function asOf(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("asOf must be a finite, non-negative epoch-millisecond time");
  return value;
}

export type ObsCtx = Pick<QueryCtx, "db" | "auth">;

export const METRIC_DEFINITIONS = {
  // ------------------------------------------------------------------------------------------------ runSummary
  "runSummary.runId": { definition: "The run summarised (an id).", basis: "observed", coverage: "exact" },
  "runSummary.status": { definition: "The run's status: running, completed or failed.", basis: "observed", coverage: "exact" },
  "runSummary.countsByStage": {
    definition: `For each pipeline stage, the run's subjects whose chain currently sits at that stage (the stage it runs next, or the last one it ran when finished). Reads at most ${RUN_SCAN_CAP} of the run's pipeline rows; past that every count is at_least.`,
    basis: "observed",
    coverage: "lower_bound",
  },
  "runSummary.countsByStatus": {
    definition: `The run's subjects by pipeline status: active, done, deadlettered. Same read as countsByStage, and the same at_least rule.`,
    basis: "observed",
    coverage: "lower_bound",
  },
  "runSummary.countsByOutcome": {
    definition: "The run's own counters (discoveryRuns): rows processed, candidates inserted, duplicates, rows rejected, candidates consumed and rejected by ingest. Maintained transactionally by the work itself, so exact.",
    basis: "observed",
    coverage: "exact",
  },
  "runSummary.creditsConsumed": { definition: "discoveryRuns.creditsUsed: credits the run has been charged.", basis: "observed", coverage: "exact" },
  "runSummary.durationMs": { definition: "finishedAt - startedAt for a finished run; null while it is running (a query does not read the clock).", basis: "observed", coverage: "exact" },

  // ------------------------------------------------------------------------------------------- costPerQualifiedLead
  "costPerQualifiedLead.runId": { definition: "The run (an id).", basis: "observed", coverage: "exact" },
  "costPerQualifiedLead.credits": { definition: "discoveryRuns.creditsUsed.", basis: "observed", coverage: "exact" },
  "costPerQualifiedLead.qualified": {
    definition: `The run's subjects whose pipeline packaged a lead (tier S, A, B or C; a Reject tier is never packaged). A Held lead counts: qualification is the tier, and distributability is a separate gate (spec 5.5). Counted once per subject however often it was rescored. Reads at most ${RUN_SCAN_CAP} pipeline rows; past that it is at_least.`,
    basis: "observed",
    coverage: "lower_bound",
  },
  "costPerQualifiedLead.costPerLead": {
    definition: "credits / qualified. Null when nothing qualified (never Infinity or NaN). Exact when qualified is exact; when qualified is at_least, this is an UPPER bound and costBound says at_most.",
    basis: "observed",
    coverage: "upper_bound",
  },
  "costPerQualifiedLead.costBound": { definition: "exact, or at_most when qualified is a lower bound.", basis: "observed", coverage: "exact" },

  // ------------------------------------------------------------------------------------------------- dataQuality
  "dataQuality.asOf": { definition: "The instant ages are measured from, as the caller passed it.", basis: "observed", coverage: "exact" },
  "dataQuality.sample": {
    definition: `What the other dataQuality numbers were computed over: the org's newest claims by creation, at most ${QUALITY_SAMPLE} and at most what a ${QUALITY_CLAIM_READ_BUDGET}-byte read budget is sure to hold (fewer when claims are large); claimsRead is how many were read. scope is whole_ledger only when the read reached the org's oldest claim, newest_sample otherwise. Redacted claims are then excluded; claimsCounted is how many remained, and every other number is over exactly those.`,
    basis: "observed",
    coverage: "exact",
  },
  "dataQuality.methodMix": {
    definition: "Claims in the sample by method (observed, extracted, inferred). Sums to sample.claimsCounted. An estimate of the whole ledger's mix unless sample.scope is whole_ledger.",
    basis: "modelled",
    coverage: "sample",
  },
  "dataQuality.verificationPassRate": {
    definition: "Of the sample's email and phone claims that have a verdict, the share whose latest verdict is pass (fail and unknown are in the denominator). Null when none has a verdict.",
    basis: "modelled",
    coverage: "sample",
  },
  "dataQuality.verificationsJudged": { definition: "The denominator of verificationPassRate.", basis: "observed", coverage: "sample" },
  "dataQuality.medianClaimAgeDays": {
    definition: "Median over the counted claims (sample.claimsCounted, all of them: every stored observedAt is finite) of (asOf - observedAt) in days. 0 for an empty sample. A source that dates a claim in the future gives a negative age; it is not clamped.",
    basis: "modelled",
    coverage: "sample",
  },

  // ----------------------------------------------------------------------------------------------- pipelineHealth
  "pipelineHealth.asOf": { definition: "The instant staleness is judged at, as the caller passed it.", basis: "observed", coverage: "exact" },
  "pipelineHealth.inFlight": { definition: `Subjects with pipeline status active. Reads at most ${COUNT_CAP}; past that at_least.`, basis: "observed", coverage: "lower_bound" },
  "pipelineHealth.retrying": {
    definition: "Active subjects whose current stage has failed at least once (attempt > 0). Derived from the same read as inFlight, never stored, and at_least whenever inFlight is.",
    basis: "observed",
    coverage: "lower_bound",
  },
  "pipelineHealth.deadLettered": { definition: `Dead-lettered subjects by reason code (a closed set). Each code reads at most ${COUNT_CAP}; past that at_least.`, basis: "observed", coverage: "lower_bound" },
  "pipelineHealth.staleActive": {
    definition: "Active subjects whose pipeline row has not changed for longer than staleActiveAfterMs: no stage completed, failed or was retried. Longer than the longest scheduled retry, so a subject waiting on its backoff is never listed. count is a lower-bound Count; subjects lists the oldest first.",
    basis: "observed",
    coverage: "listing",
  },
  "pipelineHealth.stalledPurges": {
    definition: "Finished runs whose staged raw import rows were still being purged longer than purgeStalledAfterMs ago: the purge chain stopped with raw rows left.",
    basis: "observed",
    coverage: "listing",
  },
  "pipelineHealth.stalledImports": {
    definition: "Running staged imports that have not moved for longer than importStalledAfterMs, each with the phase that stopped (a closed set): staging (the file was staged but its size never declared: the importing action died; finishRun closes the run and purges its staged rows, and the file is imported again into a new run), chunks (chunks still to process: the chunk chain stopped; resumeImport restarts it) or ingest (every chunk processed, but not every inserted candidate consumed or rejected: the ingest batches stopped; resumeImport re-arms the pending candidates, a bounded slice per call). chunksExpected is null in staging.",
    basis: "observed",
    coverage: "listing",
  },
  "pipelineHealth.verificationSweep": {
    definition: "The org's re-judge walk under the current verification rules: not_started, walking, lapsed or done. lapsed: work has been due for longer than sweepLapsedAfterMs with no slice committing, either because a started walk's slice fails on every tick, or because the cron never reached the org (no walk at all, judged from the org's creation; or a walk under older rules, judged from the org's first verdict under today's rules). not_started: due, but not yet for that long, or nothing says since when. Also the subjects this walk passed over because their rewind threw, and the latest of them, or null when that contact has since been erased.",
    basis: "observed",
    coverage: "exact",
  },
  "pipelineHealth.thresholds": { definition: "The staleness thresholds the listings above were judged with, in milliseconds.", basis: "observed", coverage: "exact" },

  // --------------------------------------------------------------------------------------- stalledErasures (admin)
  "stalledErasures.asOf": { definition: "The instant staleness is judged at, as the caller passed it.", basis: "observed", coverage: "exact" },
  "stalledErasures.stalled": {
    definition: "Incomplete erasures that have failed at least once (attempts > 0), or are overdue: no erasure step has COMMITTED for longer than overdueAfterMs (judged from the progress stamp each committed step writes, never from resumeAt, which the sweeper pushes forward on every pass whether or not the work then succeeds). Either kind may have zero attempts. Each: erasure id, subject type, attempts, time of last recorded failure, time of last committed step, overdue. Never the error text or the subject. Admin only.",
    basis: "observed",
    coverage: "listing",
  },
  "stalledErasures.overdueAfterMs": { definition: "The threshold overdue was judged with, in milliseconds.", basis: "observed", coverage: "exact" },

  // ----------------------------------------------------------------------------------------------- refusalCounts
  "refusalCounts.fromHour": { definition: "First hour of the window (epoch ms of an hour start), as the caller passed it.", basis: "observed", coverage: "exact" },
  "refusalCounts.toHour": { definition: "Last hour of the window (epoch ms of an hour start, inclusive), as the caller passed it.", basis: "observed", coverage: "exact" },
  "refusalCounts.buckets": {
    definition: `Authorization refusals of the admin-tier functions (setMemberRole, requestErasure, suppressIdentifier, startRun, registerSource, recentAudit, auditForTarget), one row per (hour, function, reason, caller class, membershipId or null), hour from the recorder's clock. Reasons: no_identity, not_member, malformed_membership, insufficient_role; business-rule refusals are never counted, nor callers whose org claim names no org. A member is named by membershipId only; anyone else is the class non_member with no identifier. Each count is a LOWER BOUND: an increment is lost when the recorder fails (a write conflict on a hot bucket that outlasts Convex's retries, or the caller's membership changing between the refusal and the record), and a lost increment never changes what the caller was told. At most ${REFUSAL_SCAN_CAP} buckets per read; more says when there are others.`,
    basis: "observed",
    coverage: "lower_bound",
  },
  "refusalCounts.more": { definition: `True when the window holds more than ${REFUSAL_SCAN_CAP} buckets and only the first ${REFUSAL_SCAN_CAP} (oldest hours first) were returned.`, basis: "observed", coverage: "exact" },
  "refusalCounts.total": {
    definition: "Sum of the returned buckets' counts. at_least when more is true; even when exact over the buckets, it is a lower bound of refusals, as each count is.",
    basis: "observed",
    coverage: "lower_bound",
  },
} as const satisfies Record<string, MetricDefinition>;

export type MetricKey = keyof typeof METRIC_DEFINITIONS;

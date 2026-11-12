import type { QueryCtx } from "../_generated/server";

/*
 * Spec 10 / TECH.md: metric definitions travel with the metrics, and an observed value is told apart from a modelled
 * (estimated) one. Every field a Task 16 query returns is a key here, spelled `<query>.<field>` (pinned by a test that
 * walks real results), so a dashboard can always show what a number means and how far it can be trusted.
 *
 *   basis     observed: counted from stored rows. modelled: an estimate of a population from a declared sample.
 *   coverage  exact:       the whole population was read.
 *             lower_bound: a count over a bounded read; when the bound was hit the value says `at_least` (see Count).
 *             sample:      computed over a declared sample, named in the definition.
 *             listing:     a bounded list of examples; its `more` flag says when there are others.
 *
 * NEVER A SILENT UNDERCOUNT. Convex has no count operator and a query has read limits, so every count over a table
 * that can grow without bound is a `Count`: the reader takes cap+1 rows, and a value at the cap says `at_least`.
 * Nothing here reports a truncated count as if it were the total.
 */

export type Basis = "observed" | "modelled";
export type Coverage = "exact" | "lower_bound" | "sample" | "listing";
export type MetricDefinition = { readonly definition: string; readonly basis: Basis; readonly coverage: Coverage };

/** A count that is either exact or a stated lower bound. Never a bare number that might be short. */
export type Count = { value: number; bound: "exact" | "at_least" };

/** Rows a single count may read before it reports `at_least`. Several counts share one query's read budget. */
export const COUNT_CAP = 500;
/** Example rows a listing returns; `more` says whether there are others. */
export const LIST_CAP = 25;
/** Newest claims the data-quality sample reads (a claim can be a few KB; this keeps the query far inside its limits). */
export const QUALITY_SAMPLE = 500;
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

/** Median of finite numbers; 0 for an empty set (spec: never NaN). Non-finite inputs are the caller's to exclude. */
export function median(values: readonly number[]): number {
  const xs = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
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
    definition: "credits / qualified. Null when nothing qualified (never Infinity or NaN). When qualified is at_least, this is an upper bound and costBound says at_most.",
    basis: "observed",
    coverage: "lower_bound",
  },
  "costPerQualifiedLead.costBound": { definition: "exact, or at_most when qualified is a lower bound.", basis: "observed", coverage: "exact" },

  // ------------------------------------------------------------------------------------------------- dataQuality
  "dataQuality.asOf": { definition: "The instant ages are measured from, as the caller passed it.", basis: "observed", coverage: "exact" },
  "dataQuality.sample": {
    definition: `What the other dataQuality numbers were computed over: the org's newest ${QUALITY_SAMPLE} claims by creation (whole_ledger when the org has no more than that), with redacted claims excluded. claimsCounted is how many remained.`,
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
    definition: "Median over the sample of (asOf - observedAt) in days. 0 for an empty sample. A source that dates a claim in the future gives a negative age; it is not clamped.",
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
  "pipelineHealth.stalledErasures": {
    definition: "Incomplete erasures that have failed at least once (attempts > 0): id, subject type, attempts, time of last failure. Never the error text or the subject.",
    basis: "observed",
    coverage: "listing",
  },
  "pipelineHealth.stalledPurges": {
    definition: "Finished runs whose staged raw import rows were still being purged longer than purgeStalledAfterMs ago: the purge chain stopped with raw rows left.",
    basis: "observed",
    coverage: "listing",
  },
  "pipelineHealth.stalledImports": {
    definition: "Running staged imports with chunks still to process and no counter movement for longer than importStalledAfterMs: the chunk chain stopped. resumeImport restarts it.",
    basis: "observed",
    coverage: "listing",
  },
  "pipelineHealth.verificationSweep": {
    definition: "The org's re-judge walk under the current verification rules: not_started, walking, lapsed (no slice has committed for longer than sweepLapsedAfterMs, so the slice is failing on every tick) or done; and the subjects this walk passed over because their rewind threw, with the latest one.",
    basis: "observed",
    coverage: "exact",
  },
  "pipelineHealth.thresholds": { definition: "The staleness thresholds the listings above were judged with, in milliseconds.", basis: "observed", coverage: "exact" },

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

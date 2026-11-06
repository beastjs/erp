import { defineTable } from "convex/server";
import { v } from "convex/values";
import { subjectType } from "../claims/schema";

/** The chain, in order. A stage's position here is its only ordering: `nextStage` walks this array. */
export const STAGES = ["ingest", "resolve", "enrich", "verify", "signals", "score", "qualify", "package"] as const;
export type Stage = (typeof STAGES)[number];
export const stage = v.union(
  v.literal("ingest"),
  v.literal("resolve"),
  v.literal("enrich"),
  v.literal("verify"),
  v.literal("signals"),
  v.literal("score"),
  v.literal("qualify"),
  v.literal("package"),
);

export const nextStage = (s: Stage): Stage | null => STAGES[STAGES.indexOf(s) + 1] ?? null;
export const stageIndex = (s: Stage): number => STAGES.indexOf(s);

/** A provider hiccup: worth retrying, with backoff, up to MAX_ATTEMPTS. */
export const TRANSIENT_REASONS = ["timeout", "rate_limited", "provider_error"] as const;
/**
 * A verdict, not a hiccup: retrying cannot change it, so the subject is dead-lettered at once.
 * `unexpected_error` is the catch-all for anything a stage threw without classifying it (a bug, a platform
 * limit): it fails closed and loudly rather than being retried blindly.
 */
export const TERMINAL_REASONS = ["invalid_domain", "no_such_record", "budget_exhausted", "policy_refused", "unexpected_error"] as const;
export const REASON_CODES = [...TRANSIENT_REASONS, ...TERMINAL_REASONS] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export const reasonCode = v.union(
  v.literal("timeout"),
  v.literal("rate_limited"),
  v.literal("provider_error"),
  v.literal("invalid_domain"),
  v.literal("no_such_record"),
  v.literal("budget_exhausted"),
  v.literal("policy_refused"),
  v.literal("unexpected_error"),
);

export const isReasonCode = (x: unknown): x is ReasonCode => typeof x === "string" && (REASON_CODES as readonly string[]).includes(x);
export const isTransient = (r: ReasonCode): boolean => (TRANSIENT_REASONS as readonly string[]).includes(r);

/** Attempts a stage gets for transient failures; the attempt that would be the next one dead-letters instead. */
export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 60 * 60 * 1000;
/** Delay before retry number `attempt` (1-based): base x 2^(attempt-1), capped. Deterministic: no jitter in a mutation. */
export const backoffMs = (attempt: number): number => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_CAP_MS);

/** Rescores a subject may trigger from qualify/package finding its score stale before the pipeline gives up and dead-letters it. */
export const MAX_REWINDS = 3;
/** Credits one subject costs at the enqueue gate when it belongs to a run. Providers bill their own calls inside their stages. */
export const CREDITS_PER_SUBJECT = 1;

export const failure = v.object({
  stage,
  reasonCode,
  providerRef: v.optional(v.string()),
  attempt: v.number(),
  message: v.string(),
  at: v.number(),
});
export type Failure = { stage: Stage; reasonCode: ReasonCode; providerRef?: string; attempt: number; message: string; at: number };

const hashes = v.object({
  ingest: v.optional(v.string()),
  resolve: v.optional(v.string()),
  enrich: v.optional(v.string()),
  verify: v.optional(v.string()),
  signals: v.optional(v.string()),
  score: v.optional(v.string()),
  qualify: v.optional(v.string()),
  package: v.optional(v.string()),
});

/**
 * No global queue: each subject carries its own place in the chain. `stage` is the stage to run NEXT (the last one
 * once the pipeline has finished). `inputHashes[s]` is the hash of the inputs stage `s` last COMPLETED on; a stage
 * whose current inputs hash the same is a no-op. Written only by the pipeline.
 */
export const pipelineState = defineTable({
  orgId: v.id("orgs"),
  subjectType,
  subjectId: v.string(),
  stage,
  status: v.union(v.literal("active"), v.literal("done"), v.literal("deadlettered")),
  /** Failed attempts at the current stage; reset when a stage completes. */
  attempt: v.number(),
  /** Times qualify/package sent the subject back for a fresh score; bounded by MAX_REWINDS. */
  rewinds: v.number(),
  inputHashes: hashes,
  runId: v.optional(v.id("discoveryRuns")),
  /** The lead's account, once resolve has read it from the contact's projection. */
  accountId: v.optional(v.id("accounts")),
  scoreRunId: v.optional(v.id("scoreRuns")),
  leadId: v.optional(v.id("leads")),
  /** Why a finished pipeline stopped before `package` (a Reject tier, an account that cannot be scored). */
  finishedReason: v.optional(v.string()),
  lastError: v.optional(failure),
  /** Mirrors lastError.reasonCode while dead-lettered, so the queue can be filtered by it on an index. */
  deadReasonCode: v.optional(reasonCode),
  deadLetteredAt: v.optional(v.number()),
  updatedAt: v.number(),
})
  .index("by_org_and_subject", ["orgId", "subjectType", "subjectId"])
  .index("by_org_and_account", ["orgId", "accountId"])
  .index("by_org_and_status_and_reason", ["orgId", "status", "deadReasonCode"]);

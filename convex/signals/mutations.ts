import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { resolveOrg, withOrg } from "../_shared/org";
import { scoringConfigForRead, getScoringModel } from "../icp/queries";
import { subjectType, type SubjectType } from "../claims/schema";
import { markScoreStale } from "../pipeline/stages";
import { assertNotErased } from "../privacy/erased";
import { decayedWeight, signalContribution } from "./decay";
import { signalStrength, type Signal, type SignalStrength } from "./schema";

/** Upper bound on signals read per subject; newest first, so the cap only drops the stalest. */
export const MAX_SIGNALS = 200;

/** A mutation may refuse observedAt this far ahead of its clock (timezone-parsed dates, drift). Catches typo'd years. */
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

export type AppendSignalArgs = {
  subjectType: SubjectType;
  subjectId: string;
  kind: string;
  strength: SignalStrength;
  confidence: number;
  observedAt: number;
  expiresAt?: number;
  sourceId?: Id<"sources">;
  /** The reporter's identity for the event; see the schema. Makes a retry an idempotent no-op and tells same-day events apart. */
  externalId?: string;
};

/** An externalId is an opaque key, not a document. */
export const MAX_EXTERNAL_ID_LENGTH = 200;

function canonicalSubject(ctx: Pick<QueryCtx, "db">, type: SubjectType, id: string) {
  return ctx.db.normalizeId(type === "account" ? "accounts" : "contacts", id);
}

/**
 * Append-only write, validated and failing closed. A plain helper, deliberately not a public
 * function: signals come from ingest, and nothing here accepts an org from a caller.
 *
 * IDEMPOTENT: re-reporting an event that is already recorded changes nothing and returns the existing row
 * with `created: false`, so a retried batch is safe. (It used to throw, which aborted the whole mutation.)
 * An event's identity is `(subject, kind, source, externalId)` when the reporter supplies an externalId,
 * else the exact `(subject, kind, observedAt, source)` tuple. Both are index lookups ending in `.first()`:
 * there is no bound a duplicate could hide behind. A new signal makes any score of the subject stale.
 */
export async function appendSignal(ctx: MutationCtx, args: AppendSignalArgs): Promise<{ id: Id<"signals">; created: boolean }> {
  const { orgId } = await resolveOrg(ctx);
  if (!(Number.isFinite(args.confidence) && args.confidence >= 0 && args.confidence <= 1)) {
    throw new Error("confidence must be between 0 and 1");
  }
  if (!Number.isFinite(args.observedAt)) throw new Error("observedAt must be a finite number");
  if (args.observedAt > Date.now() + MAX_FUTURE_SKEW_MS) {
    throw new Error("observedAt is in the future");
  }
  if (args.expiresAt !== undefined) {
    if (!Number.isFinite(args.expiresAt)) throw new Error("expiresAt must be a finite number");
    if (args.expiresAt <= args.observedAt) throw new Error("expiresAt must be after observedAt");
  }
  if (args.externalId !== undefined && (args.externalId.trim() === "" || args.externalId.length > MAX_EXTERNAL_ID_LENGTH)) {
    throw new Error(`externalId must be a non-empty string of at most ${MAX_EXTERNAL_ID_LENGTH} characters`);
  }
  const subjectId = canonicalSubject(ctx, args.subjectType, args.subjectId);
  if (!subjectId) throw new Error("invalid subject id");
  const subject = await ctx.db.get(subjectId);
  if (!subject || subject.orgId !== orgId) throw new Error("subject not found");
  await assertNotErased(ctx, orgId, args.subjectType, subjectId);
  if (args.sourceId) {
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.orgId !== orgId) throw new Error("source not found");
  }
  const existing =
    args.externalId !== undefined
      ? await ctx.db
          .query("signals")
          .withIndex("by_subject_external", (q) =>
            q.eq("orgId", orgId).eq("subjectType", args.subjectType).eq("subjectId", subjectId).eq("kind", args.kind).eq("sourceId", args.sourceId).eq("externalId", args.externalId),
          )
          .first()
      : await ctx.db
          .query("signals")
          .withIndex("by_subject_event", (q) =>
            q
              .eq("orgId", orgId)
              .eq("subjectType", args.subjectType)
              .eq("subjectId", subjectId)
              .eq("kind", args.kind)
              .eq("observedAt", args.observedAt)
              .eq("sourceId", args.sourceId)
              .eq("externalId", undefined),
          )
          .first();
  if (existing) return { id: existing._id, created: false };
  const id = await ctx.db.insert("signals", { ...args, subjectId, orgId });
  await markScoreStale(ctx, { subjectType: args.subjectType, subjectId });
  return { id, created: true };
}

/** A retried ingest batch must stay small enough for one transaction: each signal is an index read, a write and a staleness mark. */
export const MAX_SIGNAL_BATCH = 100;

/**
 * KNOWN LIMITATION (unowned, no task owns it yet; flagged for Task 10 and the final review): this does not follow identityLinks. Signals on a merged-away account
 * are stranded and never reach the survivor, so a merged account can score low for lack of intent it
 * really has. Link traversal needs decisions not yet made (transitivity, reversed links, the same
 * signal on two linked subjects).
 *
 * The subject's signals that still carry weight at `now`, newest first, each annotated with its
 * decayed `weight` and its `contribution` (weight x confidence; intent uses `contribution`). Filters: zero-weight (expired) signals are omitted. `now` is an argument because
 * queries must not read the clock.
 */
export async function activeSignals(
  ctx: QueryCtx,
  args: { subjectType: SubjectType; subjectId: string; now: number; scoringModelId?: Id<"scoringModels"> },
): Promise<Array<Signal & { weight: number; contribution: number }>> {
  const { orgId } = await resolveOrg(ctx);
  const subjectId = canonicalSubject(ctx, args.subjectType, args.subjectId);
  if (!subjectId) return [];
  // Decay runs under a model: the one a caller names (to reproduce a historical score), else the active one.
  const params = args.scoringModelId ? await getScoringModel(ctx, { id: args.scoringModelId }) : await scoringConfigForRead(ctx, args);
  const rows = await ctx.db
    .query("signals")
    .withIndex("by_subject_observed", (q) =>
      q.eq("orgId", orgId).eq("subjectType", args.subjectType).eq("subjectId", subjectId),
    )
    .order("desc")
    .take(MAX_SIGNALS + 1);
  // Filtering expiry happens after the read, so a silent cut could push live older signals out of the
  // window and quietly lower intent. Refuse the partial read instead (same remedy as claimsForSubject).
  if (rows.length > MAX_SIGNALS) {
    throw new Error(
      `subject ${args.subjectType}:${subjectId} has more than ${MAX_SIGNALS} signals (limit ${MAX_SIGNALS}); refusing a partial read`,
    );
  }
  return rows
    .map((s) => ({ ...s, weight: decayedWeight(s, args.now, params), contribution: signalContribution(s, args.now, params) }))
    .filter((s) => s.weight > 0);
}

/**
 * Public signal ingestion: a batch of dated events, authenticated once. The org comes from identity; no
 * argument names one. ALL-OR-NOTHING: one invalid item throws and nothing is written, so a client can fix
 * the batch and resend it whole. Resending a batch that already landed is a no-op for every item that has
 * an identity (see appendSignal) and reports how many were new. Give each event an `externalId` whenever
 * the reporter has one: without it two same-day events from one source are indistinguishable.
 */
export const recordSignals = mutation({
  args: {
    signals: v.array(
      v.object({
        subjectType,
        subjectId: v.string(),
        kind: v.string(),
        strength: signalStrength,
        confidence: v.number(),
        observedAt: v.number(),
        expiresAt: v.optional(v.number()),
        sourceId: v.optional(v.id("sources")),
        externalId: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ created: number; duplicates: number }> => {
    await withOrg(ctx, args);
    if (args.signals.length > MAX_SIGNAL_BATCH) {
      throw new Error(`batch_too_large: at most ${MAX_SIGNAL_BATCH} signals per call (got ${args.signals.length})`);
    }
    let created = 0;
    for (const s of args.signals) {
      if ((await appendSignal(ctx, s)).created) created++;
    }
    return { created, duplicates: args.signals.length - created };
  },
});

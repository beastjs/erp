import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { withOrg } from "../_shared/org";
import { scoringConfigForRead, getScoringModel } from "../icp/queries";
import type { SubjectType } from "../claims/schema";
import { decayedWeight, signalContribution } from "./decay";
import type { Signal, SignalStrength } from "./schema";

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
};

function canonicalSubject(ctx: Pick<QueryCtx, "db">, type: SubjectType, id: string) {
  return ctx.db.normalizeId(type === "account" ? "accounts" : "contacts", id);
}

/**
 * Append-only write, validated and failing closed. A plain helper, deliberately not a public
 * function: signals come from ingest, and nothing here accepts an org from a caller.
 */
export async function appendSignal(ctx: MutationCtx, args: AppendSignalArgs): Promise<Id<"signals">> {
  const { orgId } = await withOrg(ctx, args);
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
  const subjectId = canonicalSubject(ctx, args.subjectType, args.subjectId);
  if (!subjectId) throw new Error("invalid subject id");
  const subject = await ctx.db.get(subjectId);
  if (!subject || subject.orgId !== orgId) throw new Error("subject not found");
  if (args.sourceId) {
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.orgId !== orgId) throw new Error("source not found");
  }
  // Re-observing one event (same source twice, or the same report via a retry) must not double intent.
  // Deliberately narrow: only an exact subject+kind+observedAt+sourceId match; fuzzier "probably the
  // same event" supersession needs its own design and belongs with signal ingestion.
  const sameInstant = await ctx.db
    .query("signals")
    .withIndex("by_subject_observed", (q) =>
      q.eq("orgId", orgId).eq("subjectType", args.subjectType).eq("subjectId", subjectId).eq("observedAt", args.observedAt),
    )
    .take(MAX_SIGNALS);
  if (sameInstant.some((s) => s.kind === args.kind && s.sourceId === args.sourceId)) {
    throw new Error("duplicate signal");
  }
  return await ctx.db.insert("signals", { ...args, subjectId, orgId });
}

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
  const { orgId } = await withOrg(ctx, args);
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

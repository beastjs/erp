import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { withOrg } from "../_shared/org";
import type { SubjectType } from "../claims/schema";
import { decayedWeight } from "./decay";
import type { Signal, SignalStrength } from "./schema";

/** Upper bound on signals read per subject; newest first, so the cap only drops the stalest. */
export const MAX_SIGNALS = 200;

export type AppendSignalArgs = {
  subjectType: SubjectType;
  subjectId: string;
  kind: string;
  strength: SignalStrength;
  confidence: number;
  observedAt: number;
  expiresAt?: number;
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
  if (args.expiresAt !== undefined) {
    if (!Number.isFinite(args.expiresAt)) throw new Error("expiresAt must be a finite number");
    if (args.expiresAt <= args.observedAt) throw new Error("expiresAt must be after observedAt");
  }
  const subjectId = canonicalSubject(ctx, args.subjectType, args.subjectId);
  if (!subjectId) throw new Error("invalid subject id");
  const subject = await ctx.db.get(subjectId);
  if (!subject || subject.orgId !== orgId) throw new Error("subject not found");
  return await ctx.db.insert("signals", { ...args, subjectId, orgId });
}

/**
 * The subject's signals that still carry weight at `now`, newest first, each annotated with its
 * decayed weight. Filters: zero-weight (expired) signals are omitted. `now` is an argument because
 * queries must not read the clock.
 */
export async function activeSignals(
  ctx: QueryCtx,
  args: { subjectType: SubjectType; subjectId: string; now: number },
): Promise<Array<Signal & { weight: number }>> {
  const { orgId } = await withOrg(ctx, args);
  const subjectId = canonicalSubject(ctx, args.subjectType, args.subjectId);
  if (!subjectId) return [];
  const rows = await ctx.db
    .query("signals")
    .withIndex("by_subject_observed", (q) =>
      q.eq("orgId", orgId).eq("subjectType", args.subjectType).eq("subjectId", subjectId),
    )
    .order("desc")
    .take(MAX_SIGNALS);
  return rows
    .map((s) => ({ ...s, weight: decayedWeight(s, args.now) }))
    .filter((s) => s.weight > 0);
}

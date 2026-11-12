import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalMutation } from "../_generated/server";
import { requireRole } from "../_shared/authz";
import { writeAudit } from "../audit/log";
import { recordRefusals } from "../observability/refusals";
import { subjectType } from "../claims/schema";
import { eraseSubject, type ErasureResult } from "./redact";
import { erasureReason, legalBasis, suppressionReason } from "./schema";
import { addSuppression } from "./suppress";

/**
 * THE PUBLIC ERASURE ENDPOINT. Role: `admin`. Spec 7.1 gives retention to admin, and erasure is its most
 * destructive form: it irreversibly overwrites an org's evidence, so it is the one action here that no lesser role may
 * start, and the one whose requester must be accountable. `operator` and `analyst` are refused.
 *
 * The caller must say WHY and ON WHAT BASIS (closed vocabularies) and cite an opaque case `reference`; together with
 * who asked, that is recorded on the `erasures` row itself and in the audit log, in the same transaction that makes the
 * subject inert. The request takes no `orgId` (the org is the caller's) and no free text.
 *
 * Returns what this transaction finished. A subject too large for one transaction returns `complete: false` and the
 * rest is carried by `runErasure` (scheduled here, and re-armed by the cron sweeper if the chain ever dies).
 *
 * A public ACTION so that an authorization refusal can be recorded (observability/refusals.ts); the work, the role check
 * and the scheduling of `runErasure` happen in `requestErasureTxn`, one transaction, with the caller's identity.
 */
export const requestErasure = action({
  args: { subjectType, subjectId: v.string(), reasonCode: erasureReason, legalBasis, reference: v.string() },
  handler: async (ctx, args): Promise<Omit<ErasureResult, "snapshotRefs">> =>
    await recordRefusals(ctx, "requestErasure", () => ctx.runMutation(internal.privacy.api.requestErasureTxn, args)),
});

/** The work of `requestErasure`, in one transaction. Internal: reachable only through the action above. */
export const requestErasureTxn = internalMutation({
  args: { subjectType, subjectId: v.string(), reasonCode: erasureReason, legalBasis, reference: v.string() },
  handler: async (ctx, args): Promise<Omit<ErasureResult, "snapshotRefs">> => {
    const { orgId, actor } = await requireRole(ctx, "admin");
    const { snapshotRefs: _refs, ...result } = await eraseSubject(ctx, {
      subjectType: args.subjectType,
      subjectId: args.subjectId,
      request: { requestedBy: actor, reasonCode: args.reasonCode, legalBasis: args.legalBasis, reference: args.reference },
    });
    if (!result.complete) {
      await ctx.scheduler.runAfter(0, internal.privacy.redact.runErasure, { orgId, subjectType: args.subjectType, subjectId: args.subjectId });
    }
    return result;
  },
});

/**
 * Adds an identifier to the org's suppression list so that it cannot re-enter. Role: `admin` (retention). The
 * identifier is in this call's ARGUMENTS and nowhere else: the table stores only a keyed hash, and the audit entry
 * records the kind and reason, never the value. Idempotent: an identifier already listed writes no second audit entry.
 * A public ACTION so that an authorization refusal can be recorded; the work runs in `suppressIdentifierTxn`.
 */
export const suppressIdentifier = action({
  args: { identifier: v.string(), reason: suppressionReason },
  handler: async (ctx, args): Promise<{ created: boolean }> =>
    await recordRefusals(ctx, "suppressIdentifier", () => ctx.runMutation(internal.privacy.api.suppressIdentifierTxn, args)),
});

/** The work of `suppressIdentifier`, in one transaction. Internal: reachable only through the action above. */
export const suppressIdentifierTxn = internalMutation({
  args: { identifier: v.string(), reason: suppressionReason },
  handler: async (ctx, args): Promise<{ created: boolean }> => {
    const { actor } = await requireRole(ctx, "admin");
    const { id, created } = await addSuppression(ctx, { identifier: args.identifier, reason: args.reason });
    if (created) {
      const row = (await ctx.db.get(id as Id<"suppressions">))!;
      await writeAudit(ctx, { actor, action: "suppression.added", targetTable: "suppressions", targetId: id, after: { kind: row.kind, reasonCode: row.reason } });
    }
    return { created };
  },
});

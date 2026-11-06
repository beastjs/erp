import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";

/*
 * THE LIVENESS NET FOR ERASURE. An erasure that does not fit one transaction is carried by a self-scheduled chain
 * (`runErasure`), and nothing in Convex retries a scheduled mutation that throws. An OCC conflict with a concurrent
 * import, a transaction limit or a rotated salt would end the chain with the person half-erased and no queue that
 * shows it. The data subject has already been told the request was accepted, so this is a regulatory obligation, not
 * a commercial loss: a cron (convex/crons.ts) calls `sweepStalledErasures` on a fixed interval, and that re-runs every
 * incomplete erasure whose `resumeAt` has passed.
 *
 * THE CRON MUST NOT BE A SINGLE POINT OF FAILURE. Work is fanned out, never done inline:
 *   sweepStalledErasures (cron)  one page of org ids, one scheduled `resumeStalledErasures` per org, a continuation
 *   resumeStalledErasures(org)   up to SWEEP_BATCH due rows, one scheduled `runErasure` per row
 *   runErasure(row)              catches its own failures and records them (see redact.ts)
 * so a throw anywhere loses at most its own slice, never the slices beside it, and the next tick starts again from
 * the top: nothing here is stateful and every pass re-reads what is due. Cron ticks themselves are independent: a
 * tick that throws does not cancel the next.
 */

/** Orgs read per cron-entry transaction. The entry paginates, so there is no cap on the number of orgs, only on a page. */
export const SWEEP_ORG_PAGE = 100;
/** Stalled erasures re-run per org per pass. More than this reschedules the same org (see `resumeStalledErasures`), never drops the rest. */
export const SWEEP_BATCH = 25;
/** How long a row the sweeper has handed to `runErasure` is left alone before it is due again. */
const ERASE_SWEEP_CLAIM_MS = 10 * 60 * 1000;

/**
 * The cron's entry point. The one internal function here that takes no `orgId`, because it is the system-wide tick:
 * it reads org IDS only (a table every org is a row of) and hands each to a function that is scoped to that org.
 */
export const sweepStalledErasures = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db.query("orgs").paginate({ numItems: SWEEP_ORG_PAGE, cursor: args.cursor ?? null });
    for (const org of page.page) await ctx.scheduler.runAfter(0, internal.privacy.sweep.resumeStalledErasures, { orgId: org._id });
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.privacy.sweep.sweepStalledErasures, { cursor: page.continueCursor });
    return null;
  },
});

/**
 * Re-runs this org's incomplete erasures that are past their `resumeAt`. Each is its own scheduled `runErasure`,
 * which stamps `resumeAt` forward when it commits (or records the failure and backs off when it does not), so a row
 * picked here leaves the due set and the query below never loops on it. If more than SWEEP_BATCH are due, this
 * schedules itself for the rest rather than leaving them to the next tick.
 */
export const resumeStalledErasures = internalMutation({
  args: { orgId: v.id("orgs") },
  handler: async (ctx, args): Promise<{ resumed: number }> => {
    const now = Date.now();
    const due = await ctx.db
      .query("erasures")
      .withIndex("by_org_and_completed_and_resume", (q) => q.eq("orgId", args.orgId).eq("completedAt", undefined).lt("resumeAt", now))
      .take(SWEEP_BATCH + 1);
    const batch = due.slice(0, SWEEP_BATCH);
    for (const row of batch) {
      // Push the row out of the due set NOW, in this transaction: two sweeps must not both schedule it, and a
      // scheduled run that is lost must come back round after the grace period, not at the very next tick.
      await ctx.db.patch(row._id, { resumeAt: now + ERASE_SWEEP_CLAIM_MS });
      await ctx.scheduler.runAfter(0, internal.privacy.redact.runErasure, { orgId: row.orgId, subjectType: row.subjectType, subjectId: row.subjectId });
    }
    if (due.length > SWEEP_BATCH) await ctx.scheduler.runAfter(0, internal.privacy.sweep.resumeStalledErasures, { orgId: args.orgId });
    return { resumed: batch.length };
  },
});

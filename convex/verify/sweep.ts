import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type QueryCtx } from "../_generated/server";
import { withTrustedOrgForInternalOnly } from "../_shared/org";
import { findState, rewindToResolve } from "../pipeline/stages";
import { latestVerificationForClaim } from "./mutations";
import { VERIFICATION_KINDS } from "./schema";
import { structuralLogic } from "./structural";

/*
 * NEW RULES MUST REACH FINISHED SUBJECTS. A list edit or a `STRUCTURAL_RULES_REVISION` bump changes the verify stage's
 * input hash, but a hash is only compared when a stage runs, and nothing runs a `done` subject. So a contact scored
 * under a verdict the current rules no longer give (revision 2 turned `phone:fail:bad_length` into `unknown`) kept
 * its halved confidence, and its Available lead kept shipping at the C floor, indefinitely. This sweep finds every
 * contact whose projected email or phone was last judged under a `logic` other than today's and sends it back
 * through the pipeline with THE rewind (`rewindToResolve`, pipeline/stages.ts): verify re-judges, and when a verdict
 * moved in a way the score reads, score reruns and package replaces the old lead.
 *
 * CHEAP WHEN NOTHING IS STALE. Each org has one `verificationSweeps` row saying how far the walk has got under which
 * `logic`. Once a walk finishes under today's rules the row says `done`, and a tick costs one org page plus ONE
 * exact-key read per org and schedules nothing: subjects are not re-walked on every tick forever. A rules change
 * makes every row's `logic` stale, which restarts each org's walk once. (A contact first verified after the walk
 * passed it was verified under today's rules, so it cannot be stale: the code that judged it IS today's code.)
 *
 * THE CRON IS NOT A SINGLE POINT OF FAILURE (the shape of privacy/sweep.ts, Task 13 H-1):
 *   sweepStaleVerdicts (cron)  one page of orgs; one scheduled `rejudgeSlice` per org whose walk is unfinished and
 *                              not leased; then itself for the next page
 *   rejudgeSlice(org)          one page of the org's contact pipelines; rewinds each stale one in its own nested
 *                              mutation (`rejudgeSubject`); records progress; schedules the next slice
 * Each hop is its own transaction. A scheduled mutation that throws is not retried (Task 12 H1), so a throwing slice
 * rolls back its own rewinds AND its progress, and its lease is the previous slice's: when it lapses, a later tick
 * re-schedules the org from the last COMMITTED `after`. No failure is recorded anywhere; the recovery state is the
 * last success (Task 13's rule: the transaction that fails can write nothing durable). Other orgs are untouched.
 *
 * Never revives a dead-lettered or erased subject: `rewindToResolve` refuses both, and an erased contact's projection
 * is empty, so it names no claim to be stale about.
 */

/** Orgs read per cron-entry transaction. The entry paginates, so this bounds a page, not the number of orgs. */
export const SWEEP_ORG_PAGE = 100;
/** Tunable by tests only (as `STAGE_LOGIC_VERSION` is): contact pipelines read per slice. */
export const REJUDGE = { page: 50 };
/** How long a committed slice owns its org's walk. The next slice is scheduled at once; the lease only matters if it is lost. */
export const REJUDGE_LEASE_MS = 10 * 60 * 1000;

const marker = (ctx: Pick<QueryCtx, "db">, orgId: Id<"orgs">) => ctx.db.query("verificationSweeps").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique();

/** The walk for today's rules is over, or another slice of it holds the lease: a tick has nothing to start. */
const nothingToStart = (row: Doc<"verificationSweeps"> | null, logic: number, now: number) => row !== null && row.logic === logic && (row.done || row.leaseUntil > now);

/** The contact's projected email or phone was last judged under rules other than `logic`. Exact-key reads only. */
async function judgedUnderOtherRules(ctx: Pick<QueryCtx, "db">, orgId: Id<"orgs">, subjectId: string, logic: number): Promise<boolean> {
  const id = ctx.db.normalizeId("contacts", subjectId);
  const contact = id && (await ctx.db.get(id));
  if (!contact || contact.orgId !== orgId) return false;
  for (const kind of VERIFICATION_KINDS) {
    const field = contact.fields.find((f) => f.field === kind);
    if (!field) continue;
    const latest = await latestVerificationForClaim(ctx, orgId, field.claimId);
    if (latest && latest.logic !== logic) return true;
  }
  return false;
}

/**
 * The cron's entry point. Like `sweepStalledErasures`, the one function here with no `orgId`: it is the system-wide
 * tick, reads org IDS and each org's progress row only, and hands each org needing work to an org-scoped slice.
 */
export const sweepStaleVerdicts = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args): Promise<{ scheduled: number }> => {
    const logic = structuralLogic().short;
    const now = Date.now();
    const page = await ctx.db.query("orgs").paginate({ numItems: SWEEP_ORG_PAGE, cursor: args.cursor ?? null });
    let scheduled = 0;
    for (const org of page.page) {
      if (nothingToStart(await marker(ctx, org._id), logic, now)) continue;
      await ctx.scheduler.runAfter(0, internal.verify.sweep.rejudgeSlice, { orgId: org._id });
      scheduled++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.verify.sweep.sweepStaleVerdicts, { cursor: page.continueCursor });
    return { scheduled };
  },
});

/**
 * One slice of one org's walk under today's rules: the next page of its contact pipelines after the committed `after`,
 * each stale one rewound, then progress and a fresh lease recorded and the next slice scheduled, all in this one
 * transaction. A walk under older rules restarts from the beginning. Idempotent: a duplicate slice (a tick racing a
 * continuation) conflicts on the progress row and re-reads it, and rewinding a subject already rewound is harmless.
 *
 * Each rewind runs as a NESTED mutation (`rejudgeSubject`), the isolation `executeStage` uses: a subject whose rewind
 * throws (a duplicate pipelineState row fails `findState` loudly) has its own writes rolled back and is passed over,
 * instead of rolling back the slice and so failing the same page on every tick forever, which would stop this org's
 * walk at that subject. The passed-over subject stays as it was (not rewound, not revived); this slice counts it in
 * the org's `passedOver` and names the latest in `lastPassedOver`, which `pipelineHealth` reports (Task 16).
 */
export const rejudgeSlice = internalMutation({
  args: { orgId: v.id("orgs") },
  handler: async (rawCtx, args): Promise<{ rewound: number; failed: number; done: boolean }> => {
    const ctx = withTrustedOrgForInternalOnly(rawCtx, args.orgId);
    const logic = structuralLogic().short;
    const now = Date.now();
    const sweepRow = await marker(ctx, args.orgId);
    if (sweepRow && sweepRow.logic === logic && sweepRow.done) return { rewound: 0, failed: 0, done: true };
    const after = sweepRow && sweepRow.logic === logic ? sweepRow.after : undefined;

    const states = await ctx.db
      .query("pipelineState")
      .withIndex("by_org_and_subject", (q) => {
        const contacts = q.eq("orgId", args.orgId).eq("subjectType", "contact");
        return after === undefined ? contacts : contacts.gt("subjectId", after);
      })
      .take(REJUDGE.page + 1);
    const page = states.slice(0, REJUDGE.page);
    let rewound = 0;
    let failed = 0;
    let lastFailed: Id<"contacts"> | undefined;
    const failedSubjects = new Set<string>();
    for (const state of page) {
      if (!(await judgedUnderOtherRules(ctx, args.orgId, state.subjectId, logic))) continue;
      try {
        if (await ctx.runMutation(internal.verify.sweep.rejudgeSubject, { orgId: args.orgId, subjectId: state.subjectId })) rewound++;
      } catch {
        failed++;
        // Counted per SUBJECT: a duplicated pipeline row (one cause of the throw) lists the subject twice, adjacently.
        failedSubjects.add(state.subjectId);
        lastFailed = state.subjectId as Id<"contacts">;
      }
    }

    const done = states.length <= REJUDGE.page;
    const last = page.length > 0 ? (page[page.length - 1]!.subjectId as Id<"contacts">) : after;
    // The passed-over tally belongs to THIS walk: a walk under new rules starts again from zero. It is written here, by
    // the slice that caught the nested failure and is about to commit, which is the only place it can be durable.
    const sameWalk = sweepRow !== null && sweepRow.logic === logic;
    const passedOver = (sameWalk ? (sweepRow.passedOver ?? 0) : 0) + failedSubjects.size;
    const lastPassedOver = lastFailed ?? (sameWalk ? sweepRow.lastPassedOver : undefined);
    const progress = { logic, after: last, done, leaseUntil: done ? 0 : now + REJUDGE_LEASE_MS, passedOver, lastPassedOver };
    if (sweepRow) await ctx.db.patch(sweepRow._id, progress);
    else await ctx.db.insert("verificationSweeps", { orgId: args.orgId, ...progress });
    if (!done) await ctx.scheduler.runAfter(0, internal.verify.sweep.rejudgeSlice, { orgId: args.orgId });
    return { rewound, failed, done };
  },
});

/** The isolation unit for one subject's rewind (see `rejudgeSlice`). Internal; the org comes from the caller. THE rewind, not a second one. */
export const rejudgeSubject = internalMutation({
  args: { orgId: v.id("orgs"), subjectId: v.string() },
  handler: async (rawCtx, args): Promise<boolean> => {
    const ctx = withTrustedOrgForInternalOnly(rawCtx, args.orgId);
    const state = await findState(ctx, args.orgId, "contact", args.subjectId);
    return state ? await rewindToResolve(ctx, state) : false;
  },
});

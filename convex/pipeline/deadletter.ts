import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { resolveOrg, withOrg } from "../_shared/org";
import { subjectType as subjectTypeValidator, type SubjectType } from "../claims/schema";
import { advance, findState } from "./stages";
import { STAGES, reasonCode as reasonCodeValidator, stage as stageValidator, stageIndex, type ReasonCode, type Stage } from "./schema";

/**
 * Most dead letters `deadLetterQueue` returns whole. Past it the call throws, named, rather than hand back a
 * prefix that looks like the whole queue; the paginated `deadLetters` query has no such limit.
 */
export const MAX_DEAD_LETTERS = 500;

export type DeadLetterRow = {
  stateId: Id<"pipelineState">;
  subjectType: SubjectType;
  subjectId: string;
  stage: Stage;
  reasonCode: ReasonCode;
  providerRef?: string;
  attempt: number;
  message: string;
  deadLetteredAt: number;
};

function toRow(s: Doc<"pipelineState">): DeadLetterRow {
  const e = s.lastError;
  if (!e) throw new Error(`dead-lettered pipelineState ${s._id} has no recorded error`);
  return {
    stateId: s._id,
    subjectType: s.subjectType,
    subjectId: s.subjectId,
    stage: e.stage,
    reasonCode: e.reasonCode,
    providerRef: e.providerRef,
    attempt: e.attempt,
    message: e.message,
    deadLetteredAt: s.deadLetteredAt ?? s.updatedAt,
  };
}

const deadLetters = (ctx: QueryCtx, orgId: Id<"orgs">, code?: ReasonCode) =>
  ctx.db.query("pipelineState").withIndex("by_org_and_status_and_reason", (q) => {
    const base = q.eq("orgId", orgId).eq("status", "deadlettered");
    return code ? base.eq("deadReasonCode", code) : base;
  });

/** Every dead-lettered subject in the org, optionally of one reason. Throws past MAX_DEAD_LETTERS instead of truncating. */
export async function deadLetterQueue(ctx: QueryCtx, args: { reasonCode?: ReasonCode } = {}): Promise<DeadLetterRow[]> {
  const { orgId } = await resolveOrg(ctx);
  const rows = await deadLetters(ctx, orgId, args.reasonCode).take(MAX_DEAD_LETTERS + 1);
  if (rows.length > MAX_DEAD_LETTERS) {
    throw new Error(`more than ${MAX_DEAD_LETTERS} dead letters; use the paginated deadLetters query`);
  }
  return rows.map(toRow);
}

export const listDeadLetters = query({
  args: { reasonCode: v.optional(reasonCodeValidator), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<PaginationResult<DeadLetterRow>> => {
    const { orgId } = await withOrg(ctx, args);
    const page = await deadLetters(ctx, orgId, args.reasonCode).paginate(args.paginationOpts);
    return { ...page, page: page.page.map(toRow) };
  },
});

/**
 * Puts a subject back in the chain. HOW A DEAD-LETTERED SUBJECT IS RESUMED: someone fixes the cause (tops up the
 * budget, corrects the record, ships the resolver fix), then calls this. It re-runs the failed stage with a fresh
 * attempt count; if the cause is not fixed it fails and dead-letters again, loudly. `fromStage` goes further back:
 * it forgets the recorded hashes of that stage and every later one, so they re-execute even over unchanged inputs
 * (a replay after a logic fix, a manual re-run). Also restarts a finished subject.
 *
 * AN ACTIVE SUBJECT is re-advanced, which is the recovery for one the platform forgot: a scheduled mutation that
 * throws is not retried, and the chain can fail outside its try blocks (OCC exhaustion, a transaction limit), leaving
 * `active` with nothing scheduled and no dead letter to find. Re-advancing is idempotent by construction, so it is
 * safe on a subject that IS correctly scheduled: it only schedules the current stage again, `step` runs a stage only
 * while it is still current and the stage hash skips recorded work, so a redundant continuation finds the stage
 * moved on (or its work recorded) and does nothing. Without `fromStage` it touches no recorded hash and no counter.
 * (A subject in retry backoff will run its stage now instead of at the backoff time; the backoff's own
 * continuation then finds the stage moved on, or retries it once more. That is the cost of not being able to ask the
 * scheduler whether a continuation exists.)
 */
export async function resumeDeadLettered(ctx: MutationCtx, args: { subjectType: SubjectType; subjectId: string; fromStage?: Stage }): Promise<void> {
  const { orgId } = await resolveOrg(ctx);
  const state = await findState(ctx, orgId, args.subjectType, args.subjectId);
  if (!state) throw new Error("pipeline not started for this subject");
  if (args.fromStage !== undefined && !STAGES.includes(args.fromStage)) throw new Error("not a pipeline stage");
  if (state.status === "active" && args.fromStage === undefined) {
    await advance(ctx, { subjectType: args.subjectType, subjectId: args.subjectId });
    return;
  }
  const from: Stage = args.fromStage ?? state.lastError?.stage ?? state.stage;
  const hashes = Object.fromEntries(Object.entries(state.inputHashes).filter(([s]) => stageIndex(s as Stage) < stageIndex(from)));
  await ctx.db.patch(state._id, {
    status: "active",
    stage: from,
    attempt: 0,
    rewinds: 0,
    inputHashes: hashes,
    lastError: undefined,
    deadReasonCode: undefined,
    deadLetteredAt: undefined,
    finishedReason: undefined,
    updatedAt: Date.now(),
  });
  await advance(ctx, { subjectType: args.subjectType, subjectId: args.subjectId });
}

export const resumeSubject = mutation({
  args: { subjectType: subjectTypeValidator, subjectId: v.string(), fromStage: v.optional(stageValidator) },
  handler: async (ctx, args): Promise<null> => {
    await resumeDeadLettered(ctx, args);
    return null;
  },
});

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { unsafeCtxAsOrgForInternalOnly, withOrg } from "../_shared/org";
import { loadClaimsForSubject } from "../claims/queries";
import { subjectType as subjectTypeValidator, type SubjectType } from "../claims/schema";
import { ensureActiveScoringModel } from "../icp/mutations";
import { latestIcp } from "../icp/queries";
import { packageLead, setInventoryState, staleReason } from "../leads/mutations";
import { rebuildProjection } from "../projections/build";
import { spendCredits } from "../runs/mutations";
import { scoreLead } from "../scoring/assemble";
import { MAX_SIGNALS, activeSignals } from "../signals/mutations";
import { stageInputHash } from "./hash";
import {
  CREDITS_PER_SUBJECT,
  MAX_ATTEMPTS,
  MAX_REWINDS,
  STAGES,
  backoffMs,
  isReasonCode,
  isTransient,
  nextStage,
  stage as stageValidator,
  stageIndex,
  type Failure,
  type ReasonCode,
  type Stage,
} from "./schema";

/*
 * The pipeline. No global queue: every subject carries a `pipelineState` row (current stage, attempts, last error,
 * per-stage input hash) and the stages chain through the scheduler, each one writing its output AND scheduling the
 * next inside one mutation, so there is never a moment where output exists and state disagrees.
 *
 * ORG: scheduled functions carry no auth identity. A public entry point (`startPipeline`, `recordSignals`, any
 * write that calls `markScoreStale`) authenticates once with `withOrg`; every scheduled continuation here is an
 * `internalMutation` that receives `orgId` as an explicit argument. Internal functions are unreachable by
 * clients, which is what makes that safe. No PUBLIC function in this module (or anywhere) may declare an `orgId`
 * argument; a guard test asserts it.
 */

// ------------------------------------------------------------------------------------------------ contracts

export type StageOutput = {
  /** `null` clears it: the contact no longer names an account. */
  accountId?: Id<"accounts"> | null;
  scoreRunId?: Id<"scoreRuns">;
  leadId?: Id<"leads">;
};

/** What a stage handler reports. `rewind` sends the subject back to `resolve` because its score went stale under it. */
export type StageResult =
  | { kind: "done"; output?: StageOutput }
  | { kind: "stop"; reason: string; output?: StageOutput }
  | { kind: "rewind"; reason: string };

export type StageSubject = { orgId: Id<"orgs">; state: Doc<"pipelineState"> };
export type StageHandler = (ctx: MutationCtx, subject: StageSubject) => Promise<StageResult>;

export type StageRunResult = {
  /** `retrying` is a transient failure with a retry scheduled; it is not one of the three outcomes of the contract and is reported honestly rather than as `skipped`. */
  status: "done" | "skipped" | "deadlettered" | "retrying";
  reasonCode?: string;
  output?: StageOutput;
};

/**
 * Bump a stage's version when its LOGIC changes (a resolver fix): the version is part of the stage's input hash, so
 * the fix invalidates every recorded completion and a replay re-runs the stage instead of being skipped as a no-op.
 */
export const STAGE_LOGIC_VERSION: Record<Stage, number> = {
  ingest: 1,
  resolve: 1,
  enrich: 1,
  verify: 1,
  signals: 1,
  score: 1,
  qualify: 1,
  package: 1,
};

/** Throw from a stage to classify a failure. A ConvexError so the code survives the nested-mutation boundary. */
export function stageFailure(code: ReasonCode, providerRef?: string, message?: string): ConvexError<{ stageFailure: true; reasonCode: ReasonCode; providerRef?: string; message: string }> {
  return new ConvexError({ stageFailure: true as const, reasonCode: code, providerRef, message: message ?? code });
}

type Classified = { reasonCode: ReasonCode; providerRef?: string; message: string };

/** Anything a stage throws that was not classified fails closed as `unexpected_error`. */
function classify(e: unknown): Classified {
  if (e instanceof ConvexError) {
    const d = e.data as { stageFailure?: unknown; reasonCode?: unknown; providerRef?: unknown; message?: unknown } | null;
    if (d && typeof d === "object" && d.stageFailure === true && isReasonCode(d.reasonCode)) {
      return { reasonCode: d.reasonCode, providerRef: typeof d.providerRef === "string" ? d.providerRef : undefined, message: String(d.message ?? d.reasonCode).slice(0, 500) };
    }
  }
  return { reasonCode: "unexpected_error", message: (e instanceof Error ? e.message : String(e)).slice(0, 500) };
}

// ------------------------------------------------------------------------------------------------ state access

const tableFor = (t: SubjectType) => (t === "account" ? ("accounts" as const) : ("contacts" as const));

async function findState(ctx: Pick<QueryCtx, "db">, orgId: Id<"orgs">, subjectType: SubjectType, subjectId: string): Promise<Doc<"pipelineState"> | null> {
  return await ctx.db
    .query("pipelineState")
    .withIndex("by_org_and_subject", (q) => q.eq("orgId", orgId).eq("subjectType", subjectType).eq("subjectId", subjectId))
    .first();
}

async function requireState(ctx: Pick<QueryCtx, "db">, orgId: Id<"orgs">, subjectType: SubjectType, subjectId: string): Promise<Doc<"pipelineState">> {
  const state = await findState(ctx, orgId, subjectType, subjectId);
  if (!state) throw new Error("pipeline not started for this subject");
  return state;
}

function outputOf(state: Doc<"pipelineState">): StageOutput {
  return { accountId: state.accountId, scoreRunId: state.scoreRunId, leadId: state.leadId };
}

/** Schedules the subject's CURRENT stage. The only thing that moves the chain; the stage then re-checks that it is still current. */
export async function advance(ctx: MutationCtx, args: { subjectId: string; subjectType: SubjectType }): Promise<void> {
  const { orgId } = await withOrg(ctx, args);
  const state = await requireState(ctx, orgId, args.subjectType, args.subjectId);
  if (state.status !== "active") return;
  await ctx.scheduler.runAfter(0, internal.pipeline.stages.step, { orgId, subjectType: state.subjectType, subjectId: state.subjectId, stage: state.stage });
}

// ------------------------------------------------------------------------------------------------ input hashing

async function signalIds(ctx: QueryCtx, orgId: Id<"orgs">, subjectType: SubjectType, subjectId: string): Promise<string[]> {
  const rows = await ctx.db
    .query("signals")
    .withIndex("by_subject_created", (q) => q.eq("orgId", orgId).eq("subjectType", subjectType).eq("subjectId", subjectId))
    .take(MAX_SIGNALS + 1);
  if (rows.length > MAX_SIGNALS) throw new Error(`subject ${subjectType}:${subjectId} has more than ${MAX_SIGNALS} signals; refusing a partial read`);
  return rows.map((s) => `signal:${s._id}`);
}

/** Every account the contact's claims say it works at. A hash must not depend on what resolve will later write to the state, so it reads the claims, not the projection. */
function claimedAccounts(ctx: QueryCtx, claims: Doc<"claims">[]): Id<"accounts">[] {
  const ids = new Set<Id<"accounts">>();
  for (const c of claims) {
    const id = c.field === "accountId" && typeof c.value === "string" ? ctx.db.normalizeId("accounts", c.value) : null;
    if (id) ids.add(id);
  }
  return [...ids];
}

/** The hash of exactly what `stage` reads for this subject right now. */
export async function inputHashFor(ctx: MutationCtx, orgId: Id<"orgs">, state: Doc<"pipelineState">, stage: Stage): Promise<string> {
  const own = await loadClaimsForSubject(ctx, orgId, { subjectType: state.subjectType, subjectId: state.subjectId });
  const ownIds = own.map((c) => c._id);
  const accountClaimIds = async () => {
    const ids: Id<"claims">[] = [];
    if (state.subjectType === "contact") {
      for (const account of claimedAccounts(ctx, own)) ids.push(...(await loadClaimsForSubject(ctx, orgId, { subjectType: "account", subjectId: account })).map((c) => c._id));
    }
    return ids;
  };
  const signals = async () => [
    ...(await signalIds(ctx, orgId, state.subjectType, state.subjectId)),
    ...(state.subjectType === "contact" && state.accountId ? await signalIds(ctx, orgId, "account", state.accountId) : []),
  ];
  const icpVersionId = (await latestIcp(ctx, {}))?._id ?? null;
  // Scoring seeds the org's first model on first use; seeding it here (the same helper) keeps the hash from
  // changing merely because scoring ran, which would make the first score look like new input forever after.
  const scoringModelId = stage === "score" || stage === "qualify" ? (await ensureActiveScoringModel(ctx))._id : null;
  const version = `logic:${STAGE_LOGIC_VERSION[stage]}`;
  switch (stage) {
    case "ingest":
      return stageInputHash({ claimIds: ownIds, icpVersionId: null, scoringModelId: null, extra: [version] });
    case "resolve":
    case "enrich":
    case "verify":
      return stageInputHash({ claimIds: [...ownIds, ...(await accountClaimIds())], icpVersionId: null, scoringModelId: null, extra: [version] });
    case "signals":
      return stageInputHash({ claimIds: [], icpVersionId: null, scoringModelId: null, extra: [version, ...(await signals())] });
    case "score":
      return stageInputHash({ claimIds: [...ownIds, ...(await accountClaimIds())], icpVersionId, scoringModelId, extra: [version, ...(await signals())] });
    case "qualify":
      return stageInputHash({ claimIds: [], icpVersionId, scoringModelId, extra: [version, `scoreRun:${state.scoreRunId ?? "none"}`] });
    case "package":
      return stageInputHash({ claimIds: [], icpVersionId: null, scoringModelId: null, extra: [version, `scoreRun:${state.scoreRunId ?? "none"}`] });
  }
}

// ------------------------------------------------------------------------------------------------ the stage runner

/** Writes a failure onto the state: retry with backoff when transient and attempts remain, else dead-letter. */
async function recordFailure(ctx: MutationCtx, state: Doc<"pipelineState">, stage: Stage, c: Classified): Promise<StageRunResult> {
  const now = Date.now();
  // budget_exhausted is refused before any work starts, so it does not burn an attempt.
  const attempt = c.reasonCode === "budget_exhausted" ? state.attempt : state.attempt + 1;
  const lastError: Failure = { stage, reasonCode: c.reasonCode, providerRef: c.providerRef, attempt, message: c.message, at: now };
  if (isTransient(c.reasonCode) && attempt < MAX_ATTEMPTS) {
    await ctx.db.patch(state._id, { attempt, lastError, updatedAt: now });
    await ctx.scheduler.runAfter(backoffMs(attempt), internal.pipeline.stages.step, { orgId: state.orgId, subjectType: state.subjectType, subjectId: state.subjectId, stage });
    return { status: "retrying", reasonCode: c.reasonCode };
  }
  await ctx.db.patch(state._id, { status: "deadlettered", attempt, lastError, deadReasonCode: c.reasonCode, deadLetteredAt: now, updatedAt: now });
  return { status: "deadlettered", reasonCode: c.reasonCode };
}

/**
 * Runs one stage for one subject, idempotently, and chains the next.
 *  - Same inputs as the last completed run of this stage: a no-op that returns the prior result (and, when this IS the
 *    subject's current stage, still moves the chain on, so a rewind over unchanged inputs does not stall).
 *  - Otherwise the handler runs in a NESTED mutation, so a throw rolls back everything it wrote (no partial claims),
 *    and this transaction then records the failure; on success it records the hash and output, and schedules the
 *    next stage, in this one transaction.
 * Only the subject's current stage executes; any other stage is skipped (a stale or duplicate scheduled call).
 */
export async function runStage(ctx: MutationCtx, args: { subjectId: string; subjectType: SubjectType; stage: Stage }): Promise<StageRunResult> {
  const { orgId } = await withOrg(ctx, args);
  if (!STAGES.includes(args.stage)) throw new Error("not a pipeline stage");
  const state = await requireState(ctx, orgId, args.subjectType, args.subjectId);
  if (state.status === "deadlettered") return { status: "deadlettered", reasonCode: state.deadReasonCode };
  const stage = args.stage;

  let hash: string;
  try {
    hash = await inputHashFor(ctx, orgId, state, stage);
  } catch (e) {
    // An unreadable input set (past a read bound) is a failure to record, not a crash that leaves the chain silent.
    return await recordFailure(ctx, state, stage, classify(e));
  }

  if (state.inputHashes[stage] === hash) {
    if (state.status === "active" && state.stage === stage) await completeStage(ctx, state, stage, hash, { kind: "done" });
    return { status: "skipped", output: outputOf(state) };
  }
  if (state.status !== "active" || state.stage !== stage) {
    return { status: "skipped", reasonCode: stageIndex(stage) > stageIndex(state.stage) ? "stage_not_reached" : "stage_mismatch", output: outputOf(state) };
  }

  let result: StageResult;
  try {
    result = await ctx.runMutation(internal.pipeline.stages.executeStage, { orgId, subjectType: state.subjectType, subjectId: state.subjectId, stage });
  } catch (e) {
    return await recordFailure(ctx, state, stage, classify(e));
  }
  return await completeStage(ctx, state, stage, hash, result);
}

/** Records a stage's success and chains. Re-reads the state: the stage may have been rewound by an event it caused or raced with. */
async function completeStage(ctx: MutationCtx, before: Doc<"pipelineState">, stage: Stage, hash: string, result: StageResult): Promise<StageRunResult> {
  const state = (await ctx.db.get(before._id)) ?? before;
  const now = Date.now();

  if (result.kind === "rewind") {
    if (state.rewinds + 1 > MAX_REWINDS) {
      return await recordFailure(ctx, state, stage, {
        reasonCode: "unexpected_error",
        message: `score still stale after ${MAX_REWINDS} rescores: ${result.reason}`,
      });
    }
    await ctx.db.patch(state._id, { stage: "resolve", status: "active", rewinds: state.rewinds + 1, attempt: 0, finishedReason: undefined, updatedAt: now });
    await advance(ctx, { subjectType: state.subjectType, subjectId: state.subjectId });
    return { status: "skipped", reasonCode: "rewound" };
  }

  const out = result.output ?? {};
  const patch: Partial<Doc<"pipelineState">> = {
    inputHashes: { ...state.inputHashes, [stage]: hash },
    attempt: 0,
    lastError: undefined,
    updatedAt: now,
  };
  if (out.accountId !== undefined) patch.accountId = out.accountId ?? undefined;
  if (out.scoreRunId !== undefined) patch.scoreRunId = out.scoreRunId;
  if (out.leadId !== undefined) patch.leadId = out.leadId;

  // The stage may have been moved (a rewind from an event its own writes caused): record the work, leave the chain where it now is.
  if (state.status !== "active" || state.stage !== stage) {
    await ctx.db.patch(state._id, patch);
    return { status: "done", output: { ...outputOf(state), ...out } };
  }
  if (result.kind === "stop") {
    // A stop is not a completion: its hash is NOT recorded, so a replay re-evaluates the stage (cheaply) and stops
    // again, instead of skipping it as done and walking a stopped subject into the stage it was stopped before.
    const { inputHashes: _unrecorded, ...rest } = patch;
    await ctx.db.patch(state._id, { ...rest, status: "done", finishedReason: result.reason, rewinds: 0 });
    return { status: "done", reasonCode: result.reason, output: { ...outputOf(state), ...out } };
  }
  const next = nextStage(stage);
  if (next) {
    await ctx.db.patch(state._id, { ...patch, stage: next });
    await advance(ctx, { subjectType: state.subjectType, subjectId: state.subjectId });
  } else {
    // Finished: the rewind budget is per run through the chain, not for the life of the subject.
    await ctx.db.patch(state._id, { ...patch, status: "done", finishedReason: undefined, rewinds: 0 });
  }
  return { status: "done", output: { ...outputOf(state), ...out } };
}

/** Isolation unit for a stage's work: a nested mutation, so a throw rolls back every write the handler made. Internal; the org comes from the caller. */
export const executeStage = internalMutation({
  args: { orgId: v.id("orgs"), subjectType: subjectTypeValidator, subjectId: v.string(), stage: stageValidator },
  handler: async (rawCtx, args): Promise<StageResult> => {
    const ctx = unsafeCtxAsOrgForInternalOnly(rawCtx, args.orgId);
    const state = await findState(ctx, args.orgId, args.subjectType, args.subjectId);
    if (!state) throw stageFailure("no_such_record", "pipelineState");
    return await stageHandlers[args.stage](ctx, { orgId: args.orgId, state });
  },
});

/** The scheduled link of the chain. Runs the subject's stage only if it is still that stage's turn. */
export const step = internalMutation({
  args: { orgId: v.id("orgs"), subjectType: subjectTypeValidator, subjectId: v.string(), stage: stageValidator },
  handler: async (rawCtx, args): Promise<null> => {
    const ctx = unsafeCtxAsOrgForInternalOnly(rawCtx, args.orgId);
    const state = await findState(ctx, args.orgId, args.subjectType, args.subjectId);
    if (!state || state.status !== "active" || state.stage !== args.stage) return null;
    await runStage(ctx, { subjectType: args.subjectType, subjectId: args.subjectId, stage: args.stage });
    return null;
  },
});

// ------------------------------------------------------------------------------------------------ stage handlers

/** How many earlier leads of one contact a new package will retire. A contact rescored past this many times needs a human. */
const MAX_PRIOR_LEADS = 100;

/**
 * The stage bodies. `enrich` and `verify` are DECLARED PASS-THROUGHS: they sit in the chain so it is complete and
 * every subject's state moves through them, but they do nothing until a provider exists (verification: Task 15).
 * The registry is a plain object so a stage's body is replaced in one place without touching the runner.
 */
export const stageHandlers: Record<Stage, StageHandler> = {
  async ingest(ctx, { orgId, state }) {
    const id = ctx.db.normalizeId(tableFor(state.subjectType), state.subjectId);
    const row = id && (await ctx.db.get(id));
    if (!row || row.orgId !== orgId) throw stageFailure("no_such_record", state.subjectType, "subject not found");
    const claim = await ctx.db
      .query("claims")
      .withIndex("by_subject", (q) => q.eq("orgId", orgId).eq("subjectType", state.subjectType).eq("subjectId", state.subjectId))
      .first();
    if (!claim) throw stageFailure("no_such_record", state.subjectType, "nothing was ingested for this subject");
    return { kind: "done" };
  },

  async resolve(ctx, { orgId, state }) {
    await rebuildProjection(ctx, { subjectType: state.subjectType, subjectId: state.subjectId });
    if (state.subjectType === "account") return { kind: "done" };
    const contact = await ctx.db.get(state.subjectId as Id<"contacts">);
    const raw = contact?.fields.find((f) => f.field === "accountId")?.value;
    const accountId = typeof raw === "string" ? ctx.db.normalizeId("accounts", raw) : null;
    const account = accountId && (await ctx.db.get(accountId));
    if (!accountId || !account || account.orgId !== orgId) return { kind: "done", output: { accountId: null } };
    await rebuildProjection(ctx, { subjectType: "account", subjectId: accountId });
    return { kind: "done", output: { accountId } };
  },

  // Declared pass-through: no enrichment provider exists yet.
  async enrich() {
    return { kind: "done" };
  },

  // Declared pass-through until Task 15 replaces this body with real verification.
  async verify() {
    return { kind: "done" };
  },

  async signals(ctx, { state }) {
    // Reading the active signals is the stage's whole effect: a subject whose signals cannot be read whole (past
    // MAX_SIGNALS) fails here, named, rather than at scoring.
    const now = Date.now();
    await activeSignals(ctx, { subjectType: state.subjectType, subjectId: state.subjectId, now });
    if (state.subjectType === "contact" && state.accountId) await activeSignals(ctx, { subjectType: "account", subjectId: state.accountId, now });
    return { kind: "done" };
  },

  async score(ctx, { state }) {
    if (state.subjectType === "account") return { kind: "stop", reason: "account_not_scorable" };
    if (!state.accountId) throw stageFailure("no_such_record", "account", "the contact has no account to be scored at");
    if (!(await latestIcp(ctx, {}))) throw stageFailure("no_such_record", "icp", "the org has no ICP to score against");
    const scoreRunId = await scoreLead(ctx, { accountId: state.accountId, contactId: state.subjectId as Id<"contacts"> });
    return { kind: "done", output: { scoreRunId } };
  },

  async qualify(ctx, { orgId, state }) {
    const scoreRun = state.scoreRunId ? await ctx.db.get(state.scoreRunId) : null;
    if (!scoreRun || scoreRun.orgId !== orgId || !state.accountId) throw stageFailure("no_such_record", "scoreRun");
    const stale = await staleReason(ctx, orgId, scoreRun, { accountId: state.accountId, contactId: state.subjectId as Id<"contacts"> });
    if (stale) return { kind: "rewind", reason: stale };
    if (scoreRun.tier === "Reject") return { kind: "stop", reason: "rejected_tier" };
    return { kind: "done" };
  },

  async package(ctx, { orgId, state }) {
    const scoreRun = state.scoreRunId ? await ctx.db.get(state.scoreRunId) : null;
    if (!scoreRun || scoreRun.orgId !== orgId || !state.accountId) throw stageFailure("no_such_record", "scoreRun");
    const contactId = state.subjectId as Id<"contacts">;
    // Idempotent per scoreRun: packaging is append-only, so a replay finds the lead it already made.
    const existing = await ctx.db.query("leads").withIndex("by_org_and_score_run", (q) => q.eq("orgId", orgId).eq("scoreRunId", scoreRun._id)).first();
    if (existing) return { kind: "done", output: { leadId: existing._id } };
    const stale = await staleReason(ctx, orgId, scoreRun, { accountId: state.accountId, contactId });
    if (stale) return { kind: "rewind", reason: stale };
    // TASK 13 replaces `suppressed: false` with a live isSuppressed(...) lookup. Until then nothing is ever suppressed here.
    const leadId = await packageLead(ctx, { accountId: state.accountId, contactId, scoreRunId: scoreRun._id, suppressed: false });
    // A rescore supersedes the lead it replaces. One that has not been reserved or sold must stop being offered.
    const prior = await ctx.db.query("leads").withIndex("by_org_and_contact", (q) => q.eq("orgId", orgId).eq("contactId", contactId)).take(MAX_PRIOR_LEADS + 1);
    if (prior.length > MAX_PRIOR_LEADS) throw new Error(`contact ${contactId} has more than ${MAX_PRIOR_LEADS} leads; refusing a partial read`);
    for (const p of prior) {
      if (p._id !== leadId && p.inventoryState === "Available") await setInventoryState(ctx, { leadId: p._id, state: "Replaced", suppressed: false });
    }
    return { kind: "done", output: { leadId } };
  },
};

// ------------------------------------------------------------------------------------------------ entry points

/**
 * Puts a subject in the pipeline. Idempotent: a second enqueue (a webhook retry) finds the row and adds nothing; a
 * finished one is restarted from `ingest`, where every unchanged stage skips on its hash; a dead-lettered one stays
 * dead until `resumeSubject`. BACKPRESSURE: when the subject belongs to a run, the run is charged
 * `CREDITS_PER_SUBJECT` here, and an exhausted budget REFUSES (throws `budget_exhausted`, queues nothing).
 */
export async function enqueueSubject(
  ctx: MutationCtx,
  args: { subjectType: SubjectType; subjectId: string; runId?: Id<"discoveryRuns"> },
): Promise<{ stateId: Id<"pipelineState">; created: boolean }> {
  const { orgId } = await withOrg(ctx, args);
  const id = ctx.db.normalizeId(tableFor(args.subjectType), args.subjectId);
  const row = id && (await ctx.db.get(id));
  if (!id || !row || row.orgId !== orgId) throw new Error("subject not found");
  const existing = await findState(ctx, orgId, args.subjectType, id);
  if (existing) {
    if (existing.status === "done") {
      await ctx.db.patch(existing._id, { status: "active", stage: "ingest", attempt: 0, finishedReason: undefined, updatedAt: Date.now() });
      await advance(ctx, { subjectType: args.subjectType, subjectId: id });
    }
    return { stateId: existing._id, created: false };
  }
  if (args.runId) await spendCredits(ctx, orgId, args.runId, CREDITS_PER_SUBJECT);
  const stateId = await ctx.db.insert("pipelineState", {
    orgId,
    subjectType: args.subjectType,
    subjectId: id,
    stage: "ingest",
    status: "active",
    attempt: 0,
    rewinds: 0,
    inputHashes: {},
    runId: args.runId,
    updatedAt: Date.now(),
  });
  await advance(ctx, { subjectType: args.subjectType, subjectId: id });
  return { stateId, created: true };
}

/** Public entry point. The org comes from identity; no argument names one. */
export const startPipeline = mutation({
  args: { subjectType: subjectTypeValidator, subjectId: v.string(), runId: v.optional(v.id("discoveryRuns")) },
  handler: async (ctx, args) => {
    await withOrg(ctx, args);
    return await enqueueSubject(ctx, args);
  },
});

export const pipelineStatus = query({
  args: { subjectType: subjectTypeValidator, subjectId: v.string() },
  handler: async (ctx, args): Promise<Doc<"pipelineState"> | null> => {
    const { orgId } = await withOrg(ctx, args);
    return await findState(ctx, orgId, args.subjectType, args.subjectId);
  },
});

/** Contacts rewound per continuation, so no single mutation walks an unbounded account. */
const REWIND_PAGE = 50;

async function rewindToResolve(ctx: MutationCtx, state: Doc<"pipelineState">): Promise<void> {
  // Nothing past `resolve` has completed for a subject still at or before it; its hashes will see the new evidence on their own.
  if (state.status === "deadlettered" || (state.status === "active" && stageIndex(state.stage) <= stageIndex("resolve"))) return;
  await ctx.db.patch(state._id, { stage: "resolve", status: "active", attempt: 0, finishedReason: undefined, updatedAt: Date.now() });
  await advance(ctx, { subjectType: state.subjectType, subjectId: state.subjectId });
}

/**
 * New evidence (a claim or a signal) about a subject makes any score of it stale. Sends the subject back to `resolve`
 * so projections, then the score, are rebuilt from the new evidence: stages whose inputs did not change skip on their
 * hash, so over-rewinding costs reads, not work. A subject not in the pipeline is untouched; a dead-lettered one
 * stays dead (new data does not resurrect a subject someone must look at). Evidence about an ACCOUNT reaches every
 * contact pipeline at it, in pages through the scheduler.
 *
 * Staleness itself is not stored: `staleReason` derives it from the ledger whenever a score is used, so this only has
 * to make sure a rescore HAPPENS. Idempotent: rewinding a subject already rewound changes nothing.
 */
export async function markScoreStale(ctx: MutationCtx, args: { subjectType: SubjectType; subjectId: string }): Promise<void> {
  const { orgId } = await withOrg(ctx, args);
  if (args.subjectType === "contact") {
    const state = await findState(ctx, orgId, "contact", args.subjectId);
    if (state) await rewindToResolve(ctx, state);
    return;
  }
  const own = await findState(ctx, orgId, "account", args.subjectId);
  if (own) await rewindToResolve(ctx, own);
  const any = await ctx.db.query("pipelineState").withIndex("by_org_and_account", (q) => q.eq("orgId", orgId).eq("accountId", args.subjectId as Id<"accounts">)).first();
  if (any) await ctx.scheduler.runAfter(0, internal.pipeline.stages.markAccountStale, { orgId, accountId: args.subjectId as Id<"accounts">, cursor: null });
}

/** Continuation of markScoreStale for an account: one page of its contacts' pipelines, then the next page. */
export const markAccountStale = internalMutation({
  args: { orgId: v.id("orgs"), accountId: v.id("accounts"), cursor: v.union(v.string(), v.null()) },
  handler: async (rawCtx, args): Promise<null> => {
    const ctx = unsafeCtxAsOrgForInternalOnly(rawCtx, args.orgId);
    const page = await ctx.db
      .query("pipelineState")
      .withIndex("by_org_and_account", (q) => q.eq("orgId", args.orgId).eq("accountId", args.accountId))
      .paginate({ numItems: REWIND_PAGE, cursor: args.cursor });
    for (const state of page.page) await rewindToResolve(ctx, state);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.pipeline.stages.markAccountStale, { ...args, cursor: page.continueCursor });
    return null;
  },
});

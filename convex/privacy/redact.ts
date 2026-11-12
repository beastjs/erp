import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import type { Actor } from "../_shared/actor";
import { systemActor } from "../_shared/authz";
import { resolveOrg, withTrustedOrgForInternalOnly } from "../_shared/org";
import { writeAudit } from "../audit/log";
import { subjectType as subjectTypeValidator, type SubjectType } from "../claims/schema";
import { hasBeenDelivered } from "../leads/mutations";
import { storeEmptyProjection } from "../projections/build";
import { ERASED_REASON, findErasure } from "./erased";
import { ERASURE_REASONS, LEGAL_BASES, REFERENCE_PATTERN, type ErasureReason, type LegalBasis } from "./schema";
import type { IdentifierKind } from "./normalize";
import { tryNormalizeIdentifier } from "./normalize";
import { addSuppression, getSuppressionSalt, type KindedIdentifier } from "./suppress";

/*
 * ERASURE BY REDACTION (spec 7.3). The ledger stays append-only in SHAPE: no row is ever deleted from `claims`,
 * `signals` or `leads`; their personal VALUES are overwritten and their metadata (source, method, confidence,
 * observedAt, that a claim existed) survives. THIS FILE IS THE ONLY SANCTIONED WRITER to an existing claim, signal
 * or lead snapshot for that purpose; privacy/redact.guard.test.ts fails if any other file writes to one.
 *
 * Personal data lives in more places than `claims`. Everything below is swept for a subject, and a store this file
 * does not name is a store erasure does not reach:
 *   claims        value -> null, redactedAt set                          (the system of record)
 *   projections   emptied (accounts / contacts .fields and .display)     (derived, but holds the winning values)
 *   leads         snapshot side overwritten in place, erased-at stamped  (the exact payload a customer receives)
 *   contactKeys   deleted                                                (would let the contact be re-found)
 *   candidates    payload -> null, dedupeHash -> "redacted"              (raw input, and dedupeHash IS the email)
 *   signals       externalId cleared, redactedAt set; event metadata kept
 *   pipelineState stopped: done / "erased"; error text and hashes cleared
 *   suppressions  the subject's identifiers are added (salted hash) so a re-import inserts nothing
 */

export const ERASE_BATCH = 200;
/** Documents one call may rewrite. Past it the call returns `complete: false` and is simply called again. */
export const ERASE_BUDGET = 2000;
export const REDACTED_HASH = "redacted";
/** How long an in-progress erasure may go without a committed call before the sweeper takes it for stalled. */
export const ERASE_STALL_MS = 10 * 60 * 1000;
const ERASE_RETRY_BASE_MS = 60 * 1000;
const ERASE_RETRY_MAX_MS = 60 * 60 * 1000;
/** Back-off after `attempts` consecutive failures: 1, 2, 4 ... minutes, capped at an hour. Never gives up: the obligation does not lapse. */
export const erasureRetryDelay = (attempts: number): number => Math.min(ERASE_RETRY_BASE_MS * 2 ** Math.min(Math.max(attempts, 0), 20), ERASE_RETRY_MAX_MS);

type Tally = {
  claimsRedacted: number;
  contactKeysDeleted: number;
  candidatesRedacted: number;
  signalsRedacted: number;
  leadsRedacted: number;
  suppressionsAdded: number;
};
const zero = (): Tally => ({ claimsRedacted: 0, contactKeysDeleted: 0, candidatesRedacted: 0, signalsRedacted: 0, leadsRedacted: 0, suppressionsAdded: 0 });

export type ErasureResult = Tally & {
  /** True once every store has been swept. False means call again: the work did not fit one transaction. */
  complete: boolean;
  /** Raw-snapshot references (R2) found on the claims redacted by THIS call. The snapshots hold the same data and live outside this database. */
  snapshotRefs: string[];
};

type Budget = { left: number };

/**
 * Handles up to `budget.left` rows, `ERASE_BATCH` at a time. `fetch` must return rows that are STILL TO DO: `handle`
 * must make every row it is given disappear from that set, which is what makes this resumable with no cursor, and
 * what makes an empty fetch mean "exhausted" rather than "gave up". `handle` returns false to stop (a sub-step ran out of budget).
 * Returns true only when the set is exhausted. The budget is soft: one batch always runs (see below).
 */
async function drain<T>(budget: Budget, fetch: (n: number) => Promise<T[]>, handle: (rows: T[]) => Promise<boolean>): Promise<boolean> {
  // The first batch always runs, even on an empty budget: a step that spends the budget before a sub-step (a claim
  // that must first sweep candidates) would otherwise starve that sub-step, and the call would make no progress, ever.
  // Every call therefore does at least one batch of real work, which is what guarantees erasure terminates.
  let first = true;
  while (first || budget.left > 0) {
    first = false;
    const rows = await fetch(Math.max(1, Math.min(ERASE_BATCH, budget.left)));
    if (rows.length === 0) return true;
    budget.left -= rows.length;
    if (!(await handle(rows))) return false;
  }
  return false;
}

/**
 * Overwrites a candidate's payload. `dedupeHash` is cleared too: for a candidate with a person it is `email:<address>`,
 * i.e. the personal data in plain text. A PENDING candidate is also rejected, so nothing ever ingests the husk.
 * Used by erasure and by ingest when it meets a suppressed candidate.
 */
export async function redactCandidate(ctx: MutationCtx, row: Doc<"candidates">, rejectWith?: string): Promise<void> {
  await ctx.db.patch(row._id, {
    candidate: null,
    dedupeHash: REDACTED_HASH,
    personKey: undefined,
    redactedAt: Date.now(),
    ...(row.status === "pending" || rejectWith !== undefined ? { status: "rejected" as const, rejectionReason: rejectWith ?? "erased" } : {}),
  });
}

/**
 * Redacts every candidate keyed by this identifier, in every status. An email is also found by `dedupeHash`
 * (`email:<addr>`, which older rows carry without a `personKey`); a phone or profile only by `personKey`, because
 * its dedupeHash is `domain:<company>|phone:<v>` and the company is not known here. False when the budget ran out first.
 */
async function redactCandidatesFor(ctx: MutationCtx, orgId: Id<"orgs">, ident: KindedIdentifier, budget: Budget, tally: Tally): Promise<boolean> {
  const key = `${ident.kind}:${ident.value}`;
  for (const status of ["pending", "consumed", "rejected"] as const) {
    const lookups: Array<(n: number) => Promise<Doc<"candidates">[]>> = [
      (n) => ctx.db.query("candidates").withIndex("by_org_and_person_key_and_status", (q) => q.eq("orgId", orgId).eq("personKey", key).eq("status", status)).take(n),
    ];
    if (ident.kind === "email") {
      lookups.push((n) => ctx.db.query("candidates").withIndex("by_org_and_dedupe_hash_and_status", (q) => q.eq("orgId", orgId).eq("dedupeHash", key).eq("status", status)).take(n));
    }
    for (const fetch of lookups) {
      const done = await drain(budget, fetch, async (rows) => {
        for (const row of rows) await redactCandidate(ctx, row);
        tally.candidatesRedacted += rows.length;
        return true;
      });
      if (!done) return false;
    }
  }
  return true;
}

/**
 * Puts an identifier on the suppression list and sweeps what could otherwise find it again. Called BEFORE the row
 * that carried the identifier is destroyed: once the claim or key is gone the value is gone with it, so a later
 * call could not suppress it. False means the sweep did not finish; the caller must NOT destroy its source row.
 */
async function releaseIdentifier(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
  ident: KindedIdentifier,
  seen: Set<string>,
  budget: Budget,
  tally: Tally,
): Promise<boolean> {
  const key = `${ident.kind}:${ident.value}`;
  if (seen.has(key)) return true;
  if ((await addSuppression(ctx, { identifier: ident.value, kind: ident.kind, reason: "erasure" })).created) tally.suppressionsAdded++;
  if (ident.kind !== "domain" && !(await redactCandidatesFor(ctx, orgId, ident, budget, tally))) return false;
  seen.add(key);
  return true;
}

/** Claim fields whose value is an identifier, by subject type. The company's own domain is suppressed only when the COMPANY is erased. */
const IDENTIFIER_FIELDS: Record<SubjectType, Record<string, IdentifierKind>> = {
  contact: { email: "email", phone: "phone", profileUrl: "profile" },
  account: { domain: "domain", website: "domain" },
};

function claimIdentifier(c: Doc<"claims">): KindedIdentifier | null {
  const kind = IDENTIFIER_FIELDS[c.subjectType][c.field];
  const value = kind === undefined ? null : tryNormalizeIdentifier(c.value, kind);
  return kind !== undefined && value !== null ? { kind, value } : null;
}

const redactedSide = (side: Doc<"leads">["snapshot"]["contact"] | Doc<"leads">["snapshot"]["account"]) => ({
  // Provenance survives (which claim, how it was learned, how sure, when); the value does not.
  fields: side.fields.map((f) => ({ ...f, value: null })),
  display: {},
});

/**
 * THE THIRD WRITER to an existing lead (the other two are setInventoryState and setDisposition, which touch one field
 * each and cannot be loosened by this). It overwrites one side of the frozen snapshot and stamps that side's
 * erased-at; and, if the lead has not reached a buyer, withdraws it from inventory so it is not listed as shippable.
 * A lead already DELIVERED keeps its inventory and disposition: that is history, and we cannot recall what a buyer holds.
 */
async function redactLeadSide(ctx: MutationCtx, lead: Doc<"leads">, side: "contact" | "account", now: number): Promise<void> {
  const patch: Partial<Doc<"leads">> = {
    snapshot: { ...lead.snapshot, [side]: redactedSide(lead.snapshot[side]) } as Doc<"leads">["snapshot"],
    ...(side === "contact" ? { contactErasedAt: now } : { accountErasedAt: now }),
  };
  if (!hasBeenDelivered(lead)) {
    patch.inventoryState = lead.inventoryState === "Replaced" ? "Replaced" : "Expired";
    patch.disposition = "Closed";
  }
  await ctx.db.patch(lead._id, patch);
}

/**
 * Records the raw-snapshot references of the claims this call redacted, against the erasure. Idempotent per
 * (erasure, ref): two claims may share a snapshot. Runs in the SAME transaction as the redaction, so a claim is never
 * redacted without its reference being kept: the claim's own `snapshotRef` is the only other place it lives, and
 * that is not erased, but nothing should depend on it.
 */
async function recordSnapshotRefs(ctx: MutationCtx, orgId: Id<"orgs">, erasureId: Id<"erasures">, refs: Set<string>, now: number): Promise<void> {
  for (const ref of refs) {
    const have = await ctx.db
      .query("erasureSnapshotRefs")
      .withIndex("by_org_and_erasure_and_ref", (q) => q.eq("orgId", orgId).eq("erasureId", erasureId).eq("ref", ref))
      .first();
    if (!have) await ctx.db.insert("erasureSnapshotRefs", { orgId, erasureId, ref, recordedAt: now });
  }
}

/** Who asked for an erasure, why and on what legal basis. Required to START one; see `eraseSubject`. */
export type ErasureRequest = { requestedBy: Actor; reasonCode: ErasureReason; legalBasis: LegalBasis; reference: string };

function checkRequest(request: ErasureRequest | undefined): ErasureRequest {
  if (!request) throw new Error("an erasure must record who requested it, why and on what legal basis");
  if (!(ERASURE_REASONS as readonly string[]).includes(request.reasonCode)) throw new Error("not an erasure reason");
  if (!(LEGAL_BASES as readonly string[]).includes(request.legalBasis)) throw new Error("not a legal basis");
  if (typeof request.reference !== "string" || !REFERENCE_PATTERN.test(request.reference)) {
    throw new Error("reference must be an opaque case id (3-64 characters of letters, digits and ._:-, with at least one digit)");
  }
  return request;
}

/**
 * Erases one subject. A plain helper (the role check, `admin`, is in privacy/api.ts), and IDEMPOTENT and RESUMABLE: if the subject has more
 * rows than one transaction may rewrite it returns `complete: false` having made progress, and is called again;
 * a completed erasure returns its totals and writes nothing. Everything is scoped by the caller's org.
 *
 * FAILS CLOSED on a missing suppression salt BEFORE touching anything: an erasure that could not suppress the
 * identifiers would let the next import bring the person straight back.
 *
 * The first call writes an `erasures` row, which makes the subject inert at once: no new claims or signals, an empty
 * projection, a stopped pipeline. So even an erasure still in progress cannot be undone by new data.
 */
export async function eraseSubject(
  ctx: MutationCtx,
  args: { subjectType: SubjectType; subjectId: string; /** Required on the call that STARTS the erasure; later calls (resuming) find the row and need none. */ request?: ErasureRequest },
  opts: { budget?: number } = {},
): Promise<ErasureResult> {
  const { orgId } = await resolveOrg(ctx);
  const budgetSize = opts.budget ?? ERASE_BUDGET;
  if (!(Number.isInteger(budgetSize) && budgetSize >= 1)) throw new Error("budget must be a positive integer");
  getSuppressionSalt();

  const table = args.subjectType === "account" ? ("accounts" as const) : ("contacts" as const);
  const id = ctx.db.normalizeId(table, args.subjectId);
  const subject = id && (await ctx.db.get(id));
  if (!id || !subject || subject.orgId !== orgId) throw new Error("subject not found");

  const now = Date.now();
  let record = await findErasure(ctx, orgId, args.subjectType, id);
  if (!record) {
    // No row without an accountable request, and no request without its audit entry: all in this transaction.
    const request = checkRequest(args.request);
    const recordId = await ctx.db.insert("erasures", {
      orgId,
      subjectType: args.subjectType,
      subjectId: id,
      requestedAt: now,
      requestedBy: request.requestedBy,
      reasonCode: request.reasonCode,
      legalBasis: request.legalBasis,
      reference: request.reference,
      resumeAt: now + ERASE_STALL_MS,
      ...zero(),
    });
    await writeAudit(ctx, {
      actor: request.requestedBy,
      action: "erasure.requested",
      targetTable: "erasures",
      targetId: recordId,
      after: { legalBasis: request.legalBasis, reasonCode: request.reasonCode },
    });
    record = (await ctx.db.get(recordId))!;
  }
  const finished = (): ErasureResult => ({
    claimsRedacted: record!.claimsRedacted,
    contactKeysDeleted: record!.contactKeysDeleted,
    candidatesRedacted: record!.candidatesRedacted,
    signalsRedacted: record!.signalsRedacted,
    leadsRedacted: record!.leadsRedacted,
    suppressionsAdded: record!.suppressionsAdded,
    complete: record!.completedAt !== undefined,
    snapshotRefs: [],
  });
  if (record.completedAt !== undefined) return finished();

  const tally = zero();
  const budget: Budget = { left: budgetSize };
  const seen = new Set<string>();
  const snapshotRefs = new Set<string>();

  // Projections hold the winning VALUES, so they are emptied first, whatever else happens. And the pipeline stops.
  await storeEmptyProjection(ctx, orgId, args.subjectType, id);
  const state = await ctx.db
    .query("pipelineState")
    .withIndex("by_org_and_subject", (q) => q.eq("orgId", orgId).eq("subjectType", args.subjectType).eq("subjectId", id))
    .unique();
  if (state) {
    await ctx.db.patch(state._id, {
      status: "done",
      finishedReason: ERASED_REASON,
      attempt: 0,
      rewinds: 0,
      inputHashes: {},
      lastError: undefined,
      deadReasonCode: undefined,
      deadLetteredAt: undefined,
      updatedAt: now,
    });
  }

  const claimsDone = await drain(
    budget,
    (n) =>
      ctx.db
        .query("claims")
        .withIndex("by_subject_redacted", (q) => q.eq("orgId", orgId).eq("subjectType", args.subjectType).eq("subjectId", id).eq("redactedAt", undefined))
        .take(n),
    async (rows) => {
      for (const row of rows) {
        const ident = claimIdentifier(row);
        if (ident && !(await releaseIdentifier(ctx, orgId, ident, seen, budget, tally))) return false;
      }
      for (const row of rows) {
        await ctx.db.patch(row._id, { value: null, redactedAt: now });
        if (row.snapshotRef) snapshotRefs.add(row.snapshotRef);
      }
      tally.claimsRedacted += rows.length;
      return true;
    },
  );

  const keysDone =
    claimsDone &&
    (args.subjectType === "account" ||
      (await drain(
        budget,
        (n) => ctx.db.query("contactKeys").withIndex("by_contact", (q) => q.eq("orgId", orgId).eq("contactId", id as Id<"contacts">)).take(n),
        async (rows) => {
          for (const key of rows) {
            // A name key is not an identifier (two people share a name); only strong keys are suppressed.
            if (key.kind === "name") continue;
            if (!(await releaseIdentifier(ctx, orgId, { kind: key.kind, value: key.value }, seen, budget, tally))) return false;
          }
          for (const key of rows) await ctx.db.delete(key._id);
          tally.contactKeysDeleted += rows.length;
          return true;
        },
      )));

  const candidatesDone =
    keysDone &&
    (await drain(
      budget,
      (n) =>
        args.subjectType === "contact"
          ? ctx.db.query("candidates").withIndex("by_org_and_contact_and_redacted", (q) => q.eq("orgId", orgId).eq("contactId", id as Id<"contacts">).eq("redactedAt", undefined)).take(n)
          : ctx.db.query("candidates").withIndex("by_org_and_account_and_redacted", (q) => q.eq("orgId", orgId).eq("accountId", id as Id<"accounts">).eq("redactedAt", undefined)).take(n),
      async (rows) => {
        for (const row of rows) await redactCandidate(ctx, row);
        tally.candidatesRedacted += rows.length;
        return true;
      },
    ));

  const signalsDone =
    candidatesDone &&
    (await drain(
      budget,
      (n) =>
        ctx.db
          .query("signals")
          .withIndex("by_subject_redacted", (q) => q.eq("orgId", orgId).eq("subjectType", args.subjectType).eq("subjectId", id).eq("redactedAt", undefined))
          .take(n),
      async (rows) => {
        // Kind, strength, confidence, observedAt and source are event metadata with no identifying text (the same
        // line claims draw). `externalId` is the reporter's own id for the event and can be person-keyed, so it goes.
        for (const row of rows) await ctx.db.patch(row._id, { externalId: undefined, redactedAt: now });
        tally.signalsRedacted += rows.length;
        return true;
      },
    ));

  const leadsDone =
    signalsDone &&
    (await drain(
      budget,
      (n) =>
        args.subjectType === "contact"
          ? ctx.db.query("leads").withIndex("by_org_and_contact_and_erased", (q) => q.eq("orgId", orgId).eq("contactId", id as Id<"contacts">).eq("contactErasedAt", undefined)).take(n)
          : ctx.db.query("leads").withIndex("by_org_and_account_and_erased", (q) => q.eq("orgId", orgId).eq("accountId", id as Id<"accounts">).eq("accountErasedAt", undefined)).take(n),
      async (rows) => {
        for (const lead of rows) await redactLeadSide(ctx, lead, args.subjectType, now);
        tally.leadsRedacted += rows.length;
        return true;
      },
    ));

  await recordSnapshotRefs(ctx, orgId, record._id, snapshotRefs, now);
  await ctx.db.patch(record._id, {
    claimsRedacted: record.claimsRedacted + tally.claimsRedacted,
    contactKeysDeleted: record.contactKeysDeleted + tally.contactKeysDeleted,
    candidatesRedacted: record.candidatesRedacted + tally.candidatesRedacted,
    signalsRedacted: record.signalsRedacted + tally.signalsRedacted,
    leadsRedacted: record.leadsRedacted + tally.leadsRedacted,
    suppressionsAdded: record.suppressionsAdded + tally.suppressionsAdded,
    // A call that got this far COMMITTED: whatever failed before it is over, and the clock for "stalled" restarts.
    attempts: undefined,
    lastError: undefined,
    failedAt: undefined,
    // The progress stamp: this step committed. Observability's "overdue" is judged from this alone (Task 16 L6).
    progressAt: now,
    ...(leadsDone ? { completedAt: now, resumeAt: undefined } : { resumeAt: now + ERASE_STALL_MS }),
  });
  record = (await ctx.db.get(record._id))!;
  // Completion is the PROCESS finishing, not a person acting (it may happen in a scheduled step with no identity, or
  // inline in the request's own transaction): a system actor either way. The requester is on the erasures row.
  if (leadsDone) {
    await writeAudit(ctx, {
      actor: systemActor("erasure"),
      action: "erasure.completed",
      targetTable: "erasures",
      targetId: record._id,
      after: {
        claimsRedacted: record.claimsRedacted,
        contactKeysDeleted: record.contactKeysDeleted,
        candidatesRedacted: record.candidatesRedacted,
        signalsRedacted: record.signalsRedacted,
        leadsRedacted: record.leadsRedacted,
        suppressionsAdded: record.suppressionsAdded,
      },
    });
  }
  return { ...finished(), snapshotRefs: [...snapshotRefs] };
}

/**
 * One transaction's worth of erasure. INTERNAL (the org is an argument: scheduled work carries no identity). Called
 * only by `runErasure`, as a nested mutation, so that a throw here rolls back THIS work and leaves the caller free
 * to record that it failed.
 */
export const erasureStep = internalMutation({
  args: { orgId: v.id("orgs"), subjectType: subjectTypeValidator, subjectId: v.string() },
  handler: async (rawCtx, args): Promise<{ complete: boolean }> => {
    const ctx = withTrustedOrgForInternalOnly(rawCtx, args.orgId);
    const result = await eraseSubject(ctx, { subjectType: args.subjectType, subjectId: args.subjectId });
    return { complete: result.complete };
  },
});

const MAX_ERROR_CHARS = 500;
const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR_CHARS);

/**
 * Runs an erasure to completion across as many transactions as it needs. INTERNAL: it takes the org as an argument
 * because scheduled work carries no identity, so it cannot be called by a client. The public entry is
 * `requestErasure` in privacy/api.ts, which requires the `admin` role and then schedules this.
 *
 * A scheduled mutation that throws is not retried by the platform, so a thrown step would end the chain with the
 * person half-erased and nothing the wiser. The step therefore runs NESTED: when it throws, its writes roll back,
 * this function records the failure on the `erasures` row (attempts, last error, and a back-off in `resumeAt`) and
 * returns normally. Either way the row stays incomplete and the sweeper (privacy/sweep.ts) will call this again.
 * A failure that precedes the `erasures` row (an unknown subject, a missing salt on the very first call) has
 * nothing to record against and propagates: no erasure was ever accepted.
 */
export const runErasure = internalMutation({
  args: { orgId: v.id("orgs"), subjectType: subjectTypeValidator, subjectId: v.string() },
  handler: async (ctx, args): Promise<{ complete: boolean }> => {
    try {
      const result: { complete: boolean } = await ctx.runMutation(internal.privacy.redact.erasureStep, args);
      if (!result.complete) await ctx.scheduler.runAfter(0, internal.privacy.redact.runErasure, args);
      return result;
    } catch (e) {
      const record = await findErasure(ctx, args.orgId, args.subjectType, args.subjectId);
      if (!record || record.completedAt !== undefined) throw e;
      const now = Date.now();
      const attempts = (record.attempts ?? 0) + 1;
      await ctx.db.patch(record._id, { attempts, lastError: describeError(e), failedAt: now, resumeAt: now + erasureRetryDelay(attempts) });
      return { complete: false };
    }
  },
});

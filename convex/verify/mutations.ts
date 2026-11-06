import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { resolveOrg } from "../_shared/org";
import type { SubjectType } from "../claims/schema";
import { assertNotErased } from "../privacy/erased";
import type { VerificationResult } from "../scoring/score";
import { VERIFICATION_KINDS, type VerificationKind, type VerificationReason } from "./schema";
import { structuralLogic, verifyEmailStructure, verifyPhoneStructure, type StructuralCheck } from "./structural";

/*
 * Recording and reading verdicts. A verification row holds no value (see `verifications` in ./schema); this file is
 * the ONLY writer of it, and only ever inserts. verify/verify.guard.test.ts pins both facts.
 */

const tableFor = (t: SubjectType) => (t === "account" ? ("accounts" as const) : ("contacts" as const));

/** Which reasons may accompany which kind: a phone cannot be "disposable". `ok` is the only reason that passes. */
const REASONS_FOR: Record<VerificationKind, readonly VerificationReason[]> = {
  email: ["ok", "empty", "not_text", "too_long", "syntax", "domain_shape", "non_ascii", "disposable", "role"],
  phone: ["ok", "empty", "not_text", "too_long", "syntax", "bad_length"],
};

/**
 * Appends one verdict on one claim and returns its id. The caller supplies WHAT was concluded, never when or under
 * which rules: `checkedAt` is the transaction's clock (a caller cannot post-date a verdict to make it the "latest"),
 * and `logic` is the fingerprint of the rules in force. Everything is checked at this boundary and a bad call throws:
 * the claim must be this org's, belong to this subject, be live (not redacted) and be a claim OF the kind being
 * verified; the subject must not be erased; the outcome must agree with the reason.
 */
export async function recordVerification(
  ctx: MutationCtx,
  args: { subjectType: SubjectType; subjectId: string; claimId: Id<"claims">; result: StructuralCheck; provider: "structural" },
): Promise<Id<"verifications">> {
  const { orgId } = await resolveOrg(ctx);
  if (args.provider !== "structural") throw new Error("unknown verification provider");
  const { kind, outcome, reason } = args.result;
  if (!(VERIFICATION_KINDS as readonly string[]).includes(kind)) throw new Error("not a verifiable kind");
  if (!REASONS_FOR[kind].includes(reason)) throw new Error(`reason ${reason} does not apply to ${kind}`);
  if ((outcome === "pass") !== (reason === "ok")) throw new Error("outcome and reason disagree");

  const subjectId = ctx.db.normalizeId(tableFor(args.subjectType), args.subjectId);
  const subject = subjectId && (await ctx.db.get(subjectId));
  if (!subjectId || !subject || subject.orgId !== orgId) throw new Error("subject not found");
  await assertNotErased(ctx, orgId, args.subjectType, subjectId);
  const claim = await ctx.db.get(args.claimId);
  if (!claim || claim.orgId !== orgId || claim.subjectType !== args.subjectType || claim.subjectId !== subjectId) throw new Error("claim not found for this subject");
  if (claim.field !== kind) throw new Error(`claim is a ${claim.field} claim, not ${kind}`);
  if (claim.redactedAt !== undefined) throw new Error("claim has been erased");

  return await ctx.db.insert("verifications", {
    orgId,
    subjectType: args.subjectType,
    subjectId,
    claimId: args.claimId,
    kind,
    outcome,
    reason,
    provider: args.provider,
    logic: structuralLogic().short,
    checkedAt: Date.now(),
  });
}

/**
 * The newest verdict on one claim. `by_org_and_claim` is the full key of the thing asked for and the read wants the
 * single latest by creation order, so `.first()` on a descending scan is the whole answer, not a truncated list.
 */
export async function latestVerificationForClaim(ctx: Pick<QueryCtx, "db">, orgId: Id<"orgs">, claimId: Id<"claims">): Promise<Doc<"verifications"> | null> {
  return await ctx.db.query("verifications").withIndex("by_org_and_claim", (q) => q.eq("orgId", orgId).eq("claimId", claimId)).order("desc").first();
}

/**
 * The verdicts that describe the subject AS PROJECTED NOW: for each verifiable field the projection carries, the
 * latest verdict on the claim that currently wins that field. A verdict on a claim that has since been superseded (the
 * contact's email changed) is history, not evidence, and is not returned, so a failed old address cannot sink a good
 * new one. At most one per kind, read by exact key: nothing is truncated. A subject with none returns `[]`.
 */
export async function verificationsForSubject(ctx: Pick<QueryCtx, "db" | "auth">, args: { subjectType: SubjectType; subjectId: string }): Promise<VerificationResult[]> {
  const { orgId } = await resolveOrg(ctx);
  const id = ctx.db.normalizeId(tableFor(args.subjectType), args.subjectId);
  const subject = id && (await ctx.db.get(id));
  if (!subject || subject.orgId !== orgId) throw new Error("subject not found");
  const out: VerificationResult[] = [];
  for (const kind of VERIFICATION_KINDS) {
    const field = subject.fields.find((f) => f.field === kind);
    if (!field) continue;
    const row = await latestVerificationForClaim(ctx, orgId, field.claimId);
    if (row && row.kind === kind) out.push({ kind: row.kind, outcome: row.outcome, checkedAt: row.checkedAt });
  }
  return out;
}

/**
 * The verify stage's body for one subject: judge the email and phone the projection currently carries and record a
 * verdict for each claim not already judged under the CURRENT rules. Idempotent: a claim whose latest verdict was made
 * under today's `logic` is left alone, so a replay adds nothing; a changed list changes `logic`, so the same claim
 * is judged again and the old row stays as the record of what the old rules said. Returns the rows it added.
 */
export async function verifySubject(ctx: MutationCtx, args: { subjectType: SubjectType; subjectId: string }): Promise<number> {
  const { orgId } = await resolveOrg(ctx);
  const id = ctx.db.normalizeId(tableFor(args.subjectType), args.subjectId);
  const subject = id && (await ctx.db.get(id));
  if (!id || !subject || subject.orgId !== orgId) throw new Error("subject not found");
  const logic = structuralLogic().short;
  let added = 0;
  for (const kind of VERIFICATION_KINDS) {
    const field = subject.fields.find((f) => f.field === kind);
    if (!field) continue;
    const latest = await latestVerificationForClaim(ctx, orgId, field.claimId);
    if (latest && latest.logic === logic) continue;
    const value: unknown = field.value;
    const result: StructuralCheck =
      typeof value !== "string" ? { kind, outcome: "unknown", reason: "not_text" } : kind === "email" ? verifyEmailStructure(value) : verifyPhoneStructure(value);
    await recordVerification(ctx, { subjectType: args.subjectType, subjectId: id, claimId: field.claimId, result, provider: "structural" });
    added++;
  }
  return added;
}

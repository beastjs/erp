import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { normalizeEmail, normalizePhone } from "../_shared/normalize";
import { resolveOrg } from "../_shared/org";
import type { SubjectType } from "../claims/schema";
import { assertNotErased } from "../privacy/erased";
import type { VerificationResult } from "../scoring/score";
import { MAX_STRING } from "../sources/contract";
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
  phone: ["ok", "empty", "not_text", "too_long", "syntax", "bad_length", "ambiguous_length"],
};

const isVerifiableKind = (field: string): field is VerificationKind => (VERIFICATION_KINDS as readonly string[]).includes(field);

/**
 * THE verdict on a stored claim value, the same on every path. Ingest stores `normalizeEmail`/`normalizePhone` output,
 * but the public `appendClaim` stores what the operator typed, so the value is normalized HERE before it is judged:
 * `+1 555 010 4242 #123` typed by an operator and the `15550104242123` ingest would have stored get one verdict, not
 * a `syntax` failure on one path and a pass on the other. The normalizers are NOT changed to make this so (suppression
 * hashes are HMACs over their output) and claim values are not rewritten (the ledger is append-only); a value the
 * normalizer rejects is judged as stored, which is the only way the `+`/region/`ext` grammar is still reached.
 *
 * Normalized only up to MAX_STRING, the longest value a candidate may carry: `normalizeDomain`'s regexes are not linear
 * on every input (`\.+$` backtracks on a long run of dots), ingest never runs them on more than this, and a longer value
 * can only have come through `appendClaim` (v.any(), up to a document's size). Such a value is judged raw, where the
 * single-pass scanners and their caps apply. Pure; never throws.
 */
export function judgeClaimValue(kind: VerificationKind, value: unknown): StructuralCheck {
  if (typeof value !== "string") return { kind, outcome: "unknown", reason: "not_text" };
  const short = value.length <= MAX_STRING;
  if (kind === "email") return verifyEmailStructure((short && normalizeEmail(value)) || value);
  return verifyPhoneStructure((short && normalizePhone(value)) || value);
}

const RECORD_ARGS = new Set(["subjectType", "subjectId", "claimId"]);

/**
 * Judges one claim and appends the verdict; returns its id. The caller names WHICH claim, never WHAT was concluded,
 * when, or under which rules: the verdict is computed here from the claim's own stored value (`judgeClaimValue`), so a
 * caller cannot record `pass` on a disposable address; `checkedAt` is the transaction's clock (a verdict cannot be
 * post-dated to become the "latest"); `logic` is the fingerprint of the rules in force. A caller still passing a
 * verdict, a provider or anything else is REFUSED, not ignored, so nobody believes their verdict was recorded.
 * Everything is checked at this boundary and a bad call throws: the claim must be this org's, belong to this subject,
 * be live (not redacted) and be an email or phone claim; the subject must not be erased.
 *
 * Before Task 15's review this took the verdict from its caller and was safe only because `verifySubject` was its sole
 * caller: a control that held by coincidence at every call site. It is now written down here, at the boundary.
 */
export async function recordVerification(ctx: MutationCtx, args: { subjectType: SubjectType; subjectId: string; claimId: Id<"claims"> }): Promise<Id<"verifications">> {
  const { orgId } = await resolveOrg(ctx);
  const extra = Object.keys(args).filter((k) => !RECORD_ARGS.has(k));
  if (extra.length > 0) throw new Error(`recordVerification takes no ${extra.join(", ")}: the verdict is computed from the claim, never supplied`);

  const subjectId = ctx.db.normalizeId(tableFor(args.subjectType), args.subjectId);
  const subject = subjectId && (await ctx.db.get(subjectId));
  if (!subjectId || !subject || subject.orgId !== orgId) throw new Error("subject not found");
  await assertNotErased(ctx, orgId, args.subjectType, subjectId);
  const claim = await ctx.db.get(args.claimId);
  if (!claim || claim.orgId !== orgId || claim.subjectType !== args.subjectType || claim.subjectId !== subjectId) throw new Error("claim not found for this subject");
  if (claim.redactedAt !== undefined) throw new Error("claim has been erased");
  if (!isVerifiableKind(claim.field)) throw new Error(`a ${claim.field} claim is not a verifiable kind`);

  const { kind, outcome, reason } = judgeClaimValue(claim.field, claim.value);
  // The verifier's own output, checked anyway: the stored row must be coherent whatever a future verifier returns.
  if (kind !== claim.field) throw new Error(`verifier judged a ${kind}, not the ${claim.field} it was given`);
  if (!REASONS_FOR[kind].includes(reason)) throw new Error(`reason ${reason} does not apply to ${kind}`);
  if ((outcome === "pass") !== (reason === "ok")) throw new Error("outcome and reason disagree");

  return await ctx.db.insert("verifications", {
    orgId,
    subjectType: args.subjectType,
    subjectId,
    claimId: args.claimId,
    kind,
    outcome,
    reason,
    provider: "structural",
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
 * For each verifiable field the contact projects NOW, a verdict on its claim that FAILED after `since` and that the
 * verdict standing at `since` did not already say: a failure a score taken at `since` never counted. Returns the
 * kinds, `[]` when there are none. A fail re-judged as a fail under new rules is not news (the score already halved
 * for it), so it is not returned: otherwise every list edit would rescore and replace every failed lead for an
 * identical score. Two exact-key reads per kind, each `.first()` on the claim's own key: nothing is truncated.
 */
export async function uncountedFailuresSince(ctx: Pick<QueryCtx, "db">, orgId: Id<"orgs">, contactId: Id<"contacts">, since: number): Promise<VerificationKind[]> {
  const contact = await ctx.db.get(contactId);
  if (!contact || contact.orgId !== orgId) return [];
  const out: VerificationKind[] = [];
  for (const kind of VERIFICATION_KINDS) {
    const field = contact.fields.find((f) => f.field === kind);
    if (!field) continue;
    const latest = await latestVerificationForClaim(ctx, orgId, field.claimId);
    if (!latest || latest.outcome !== "fail" || latest._creationTime <= since) continue;
    const standing = await ctx.db
      .query("verifications")
      .withIndex("by_org_and_claim", (q) => q.eq("orgId", orgId).eq("claimId", field.claimId).lt("_creationTime", since))
      .order("desc")
      .first();
    if (standing?.outcome !== "fail") out.push(kind);
  }
  return out;
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
    // `row.kind === kind` is DEFENCE IN DEPTH that no test can separate: recordVerification refuses to write a row
    // whose kind differs from its claim's field, and a claim's field never changes, so a row on an email claim is
    // always an email row. It stays so that a row written around the recorder cannot score as the wrong kind.
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
    // The recorder reads the claim and judges it; this only says which claim.
    await recordVerification(ctx, { subjectType: args.subjectType, subjectId: id, claimId: field.claimId });
    added++;
  }
  return added;
}

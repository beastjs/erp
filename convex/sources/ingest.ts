import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, mutation, type MutationCtx } from "../_generated/server";
import {
  emailDomain,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
  normalizeProfileUrl,
} from "../_shared/normalize";
import { appendClaimRecord } from "../claims/mutations";
import type { SubjectType } from "../claims/schema";
import { rebuildProjection } from "../projections/build";
import { matchCandidate } from "../projections/identity";
import { bumpRun, type RunCounter } from "../runs/mutations";
import { withOrg } from "../_shared/org";
import { checkContractVersion, validateCandidate, type NormalizedCandidate } from "./contract";

/** Per-mutation cap: each candidate costs ~30 document writes, and a mutation may write 16k. */
export const INGEST_BATCH = 50;

/** Confidence an ingested claim carries before method ceilings; a crawler's reading is weaker than a person's. */
const CONFIDENCE: Record<"observed" | "extracted", number> = { observed: 0.9, extracted: 0.6 };

type Pair = [field: string, value: unknown];
export type Outcome = { outcome: "consumed" | "rejected" | "skipped"; reason?: string };

const clean = (s: string | undefined) => (s === undefined || s.trim() === "" ? undefined : s.trim());

/**
 * Pure. The claims a candidate asserts, with identifiers NORMALIZED through the shared module (the
 * stored candidate keeps the raw input) and display values merely trimmed. One module normalizes so
 * the privacy suppression list and this path can never disagree about what an identifier is.
 */
export function planClaims(c: NormalizedCandidate) {
  const account: Pair[] = [];
  const co = c.company;
  const rawDomain = co?.domain ?? co?.website;
  const domain = rawDomain ? normalizeDomain(rawDomain) : null;
  if (co) {
    if (clean(co.name)) account.push(["name", clean(co.name)]);
    if (domain) account.push(["domain", domain]);
    for (const f of ["website", "industry", "size", "revenueRange", "location", "country", "description"] as const) {
      if (clean(co[f])) account.push([f, clean(co[f])]);
    }
    if (co.techStack && co.techStack.length > 0) account.push(["techStack", co.techStack.map((s) => s.trim())]);
  }

  const contact: Pair[] = [];
  const p = c.person;
  let email: string | null = null;
  if (p) {
    email = p.email ? normalizeEmail(p.email) : null;
    const name = clean(p.fullName) ?? clean([p.firstName, p.lastName].filter(Boolean).join(" "));
    if (name) contact.push(["name", name]);
    if (clean(p.firstName)) contact.push(["firstName", clean(p.firstName)]);
    if (clean(p.lastName)) contact.push(["lastName", clean(p.lastName)]);
    if (clean(p.jobTitle)) contact.push(["title", clean(p.jobTitle)]);
    if (clean(p.department)) contact.push(["department", clean(p.department)]);
    if (clean(p.seniority)) contact.push(["seniority", clean(p.seniority)]);
    if (email) contact.push(["email", email]);
    const phone = p.phone ? normalizePhone(p.phone) : null;
    if (phone) contact.push(["phone", phone]);
    const profile = p.profileUrl ? normalizeProfileUrl(p.profileUrl) : null;
    if (profile) contact.push(["profileUrl", profile]);
  }

  // How the lead was acquired belongs to the person if there is one, else the company.
  const acquisition: Pair[] = [];
  for (const f of ["campaign", "channel", "queryContext", "landingPage", "referral"] as const) {
    if (clean(c.acquisition[f])) acquisition.push([`acquisition.${f}`, clean(c.acquisition[f])]);
  }
  return {
    account,
    contact,
    acquisition,
    domain,
    email,
    companyName: clean(co?.name),
    hasCompany: Boolean(co),
    hasPerson: Boolean(p),
  };
}

async function reject(ctx: MutationCtx, row: Doc<"candidates">, reason: string): Promise<Outcome> {
  await ctx.db.patch(row._id, { status: "rejected", rejectionReason: reason });
  return { outcome: "rejected", reason };
}

/**
 * Consumes ONE pending candidate: re-validate -> re-normalize -> resolve subjects -> claims ->
 * projection -> mark consumed.
 *
 * Order matters and is fixed: a subject row must exist before its first claim (appendClaim refuses
 * claims about a row that is not there), and projections read claims rather than creating rows, so
 * the sequence is row, claims, projection, never the other way round.
 *
 * Marking the candidate `consumed` is what lets a later re-observation insert fresh: candidate dedupe
 * is scoped to pending rows, so a candidate left pending would block that lead forever.
 */
export async function ingestCandidate(ctx: MutationCtx, candidateId: Id<"candidates">): Promise<Outcome> {
  const { orgId } = await withOrg(ctx, {});
  const row = await ctx.db.get(candidateId);
  if (!row || row.orgId !== orgId) throw new Error("candidate not found");
  if (row.status !== "pending") return { outcome: "skipped" };

  const version = checkContractVersion(row.contractVersion);
  if (!version.ok) return await reject(ctx, row, version.error);
  const checked = validateCandidate(row.candidate);
  if (!checked.ok) return await reject(ctx, row, `invalid candidate: ${checked.errors.join("; ")}`);
  const source = await ctx.db.get(row.sourceId);
  if (!source || source.orgId !== orgId) throw new Error("source not found");

  const candidate = checked.value;
  const plan = planClaims(candidate);
  const method: "observed" | "extracted" = source.kind === "crawler" ? "extracted" : "observed";
  const confidence = CONFIDENCE[method];
  const observedAt = candidate.acquisition.acquiredAt;
  const append = async (subjectType: SubjectType, subjectId: string, pairs: Pair[]) => {
    for (const [field, value] of pairs) {
      await appendClaimRecord(ctx, { subjectType, subjectId, field, value, sourceId: row.sourceId, method, confidence, observedAt, runId: row.runId });
    }
  };

  // Account: reuse a match, else create one when the candidate describes a company.
  const near = new Map<Id<"accounts">, Doc<"accounts">>();
  for (const d of new Set([plan.domain, plan.email ? emailDomain(plan.email) : null])) {
    if (!d) continue;
    const hits = await ctx.db
      .query("accounts")
      .withIndex("by_org_and_domain", (q) => q.eq("orgId", orgId).eq("display.domain", d))
      .take(10);
    for (const a of hits) near.set(a._id, a);
  }
  const match = matchCandidate(
    { domain: plan.domain ?? undefined, companyName: plan.companyName, email: plan.email ?? undefined },
    [...near.values()],
  );
  let accountId: Id<"accounts"> | null = match?.subjectId ?? null;
  if (!accountId && plan.hasCompany) {
    accountId = await ctx.db.insert("accounts", { orgId, fields: [], display: {} });
  }
  if (accountId) {
    await append("account", accountId, [...plan.account, ...(plan.hasPerson ? [] : plan.acquisition)]);
    await rebuildProjection(ctx, { subjectType: "account", subjectId: accountId });
  }

  // Contact: one per normalized email. Other identifiers cannot be looked up yet, so a contact seen
  // only by name/phone/profile is created each time it is observed (see report: known limit).
  let contactId: Id<"contacts"> | null = null;
  if (plan.hasPerson) {
    if (plan.email) {
      const found = await ctx.db
        .query("contacts")
        .withIndex("by_org_and_email", (q) => q.eq("orgId", orgId).eq("display.email", plan.email!))
        .first();
      contactId = found?._id ?? null;
    }
    contactId ??= await ctx.db.insert("contacts", { orgId, fields: [], display: {} });
    await append("contact", contactId, [
      ...plan.contact,
      ...(accountId ? ([["accountId", accountId]] as Pair[]) : []),
      ...plan.acquisition,
    ]);
    await rebuildProjection(ctx, { subjectType: "contact", subjectId: contactId });
  }

  await ctx.db.patch(row._id, { status: "consumed" });
  return { outcome: "consumed" };
}

/** Isolation unit: called as a nested mutation so a failure rolls back only this candidate's writes. */
export const ingestOne = internalMutation({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, args): Promise<Outcome> => ingestCandidate(ctx, args.candidateId),
});

/**
 * Consumes a batch of pending candidates. Called by the import action after each chunk (scheduled
 * functions carry no auth identity, so org-scoped writes must start from a client or action call).
 * A candidate that cannot be processed is rejected with a reason instead of aborting its neighbours.
 */
export const ingestCandidates = mutation({
  args: { candidateIds: v.array(v.id("candidates")) },
  handler: async (ctx, args): Promise<{ consumed: number; rejected: number }> => {
    const { orgId } = await withOrg(ctx, args);
    if (args.candidateIds.length > INGEST_BATCH) throw new Error(`batch_too_large: at most ${INGEST_BATCH} candidates per call`);
    const rows: Doc<"candidates">[] = [];
    for (const id of args.candidateIds) {
      const row = await ctx.db.get(id);
      if (!row || row.orgId !== orgId) throw new Error("candidate not found");
      rows.push(row);
    }
    let consumed = 0;
    let rejected = 0;
    const perRun = new Map<Id<"discoveryRuns">, Partial<Record<RunCounter, number>>>();
    for (const row of rows) {
      let result: Outcome;
      try {
        result = await ctx.runMutation(internal.sources.ingest.ingestOne, { candidateId: row._id });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        result = await reject(ctx, row, reason);
      }
      if (result.outcome === "skipped") continue;
      if (result.outcome === "consumed") consumed++;
      else rejected++;
      if (row.runId) {
        const delta = perRun.get(row.runId) ?? {};
        const key: RunCounter = result.outcome === "consumed" ? "candidatesConsumed" : "candidatesRejected";
        delta[key] = (delta[key] ?? 0) + 1;
        perRun.set(row.runId, delta);
      }
    }
    for (const [runId, delta] of perRun) {
      const run = await ctx.db.get(runId);
      if (run) await bumpRun(ctx, run, delta);
    }
    return { consumed, rejected };
  },
});

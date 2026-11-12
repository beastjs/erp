import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { resolveOrg } from "../_shared/org";
import { normalizeEmail, normalizeDomain } from "../_shared/normalize";
import { getScoringModel, latestIcp, latestScoringModel } from "../icp/queries";
import { decayedWeight } from "../signals/decay";
import { MAX_SIGNALS } from "../signals/mutations";
import { MAX_PROJECTED_FIELDS } from "../scoring/assemble";
import { leadIsErased, assertNotErased } from "../privacy/erased";
import { anySuppressed, leadIdentifiers } from "../privacy/suppress";
import { checkDistributability, dispositionFor, DEFAULT_FRESHNESS_WINDOW_DAYS } from "../qualify/distributability";
import { uncountedFailuresSince } from "../verify/mutations";
import { DISPOSITIONS, INVENTORY_STATES, type Disposition, type InventoryState } from "./schema";

/**
 * Why a scoreRun can no longer back a lead, or null when it still can. A score is stale when the world it
 * described has moved on:
 *  - a newer scoreRun exists for its subject (it was superseded);
 *  - a claim about the account or the contact was recorded after it (the evidence changed);
 *  - the org has since activated a newer ICP or scoring model (it was scored under superseded rules).
 *  - a signal about the account or the contact was recorded after it (intent is weighted 45 of 100, so a
 *    new funding signal must not be scored around). `by_subject_created` orders signals by recorded-at.
 *  - a signal the score COUNTED has since lost all weight (it passed its `expiresAt`): the world moved on
 *    without any write, so no event could mark it. Spec 4.6: scores drift visibly, they do not age silently.
 *  - a verification of the contact's projected email or phone FAILED after it, where the verdict standing when it
 *    was taken did not (`uncountedFailuresSince`): a failure halves confidence, and this score never counted it.
 *    Without this, verify committing a new `fail` and score then dead-lettering (no ICP) left the old scoreRun the
 *    latest, with no newer claim, so it read as current. A fail re-judged as a fail is not news and does not count.
 * The pipeline's markScoreStale is the event-driven side of this; this is the check at the point of use.
 *
 * `now` is an argument, not a clock read here, and the answer is ADVISORY: it is never persisted and never
 * feeds an inputHash. (The pipeline uses it to decide whether a recorded score stage may be skipped; the hash
 * itself stays a pure function of stored data.) Continuous half-life decay is not flagged: it never reaches zero
 * at a defined moment, so "stale" would need a policy threshold that does not exist yet. An expiry is a stored,
 * discrete boundary.
 */
export async function staleReason(
  ctx: QueryCtx,
  orgId: Id<"orgs">,
  scoreRun: Doc<"scoreRuns">,
  subjects: { accountId: Id<"accounts">; contactId: Id<"contacts"> },
  now: number,
): Promise<string | null> {
  if (!Number.isFinite(now)) throw new Error("now must be a finite number");
  const latest = await ctx.db
    .query("scoreRuns")
    .withIndex("by_subject", (q) => q.eq("orgId", orgId).eq("subjectType", scoreRun.subjectType).eq("subjectId", scoreRun.subjectId))
    .order("desc")
    .first();
  if (!latest || latest._id !== scoreRun._id) return "a newer scoreRun exists for the subject";

  for (const [subjectType, subjectId] of [["account", subjects.accountId], ["contact", subjects.contactId]] as const) {
    const newer = await ctx.db
      .query("claims")
      .withIndex("by_subject", (q) => q.eq("orgId", orgId).eq("subjectType", subjectType).eq("subjectId", subjectId).gt("_creationTime", scoreRun._creationTime))
      .first();
    if (newer) return `a claim about the ${subjectType} was recorded after the score`;
  }

  for (const [subjectType, subjectId] of [["account", subjects.accountId], ["contact", subjects.contactId]] as const) {
    const newer = await ctx.db
      .query("signals")
      .withIndex("by_subject_created", (q) => q.eq("orgId", orgId).eq("subjectType", subjectType).eq("subjectId", subjectId).gt("_creationTime", scoreRun._creationTime))
      .first();
    if (newer) return `a signal about the ${subjectType} was recorded after the score`;
  }

  const failed = await uncountedFailuresSince(ctx, orgId, subjects.contactId, scoreRun._creationTime);
  if (failed.length > 0) return `a verification of the contact's ${failed.join(" and ")} failed after the score`;

  // A signal that carried weight when the score was taken and has none now. Scored under the score's own model.
  const params = await getScoringModel(ctx, { id: scoreRun.scoringModelId });
  for (const [subjectType, subjectId] of [["account", subjects.accountId], ["contact", subjects.contactId]] as const) {
    const rows = await ctx.db
      .query("signals")
      .withIndex("by_subject_observed", (q) => q.eq("orgId", orgId).eq("subjectType", subjectType).eq("subjectId", subjectId))
      .take(MAX_SIGNALS + 1);
    if (rows.length > MAX_SIGNALS) throw new Error(`subject ${subjectType}:${subjectId} has more than ${MAX_SIGNALS} signals; refusing a partial read`);
    if (rows.some((s) => s.expiresAt !== undefined && decayedWeight(s, scoreRun.scoredAt, params) > 0 && decayedWeight(s, now, params) === 0)) {
      return `a signal about the ${subjectType} expired after the score`;
    }
  }

  const icp = await latestIcp(ctx, {});
  const model = await latestScoringModel(ctx, {});
  if (!icp || icp._id !== scoreRun.icpVersionId) return "a newer ICP version is active";
  if (!model || model._id !== scoreRun.scoringModelId) return "a newer scoring model is active";
  return null;
}

/** The email resolves, through the dedupe keys ingest records, to exactly this contact; the domain to exactly this account. */
async function duplicatesChecked(
  ctx: QueryCtx,
  orgId: Id<"orgs">,
  account: Pick<Doc<"accounts">, "_id" | "display">,
  contact: Pick<Doc<"contacts">, "_id" | "display">,
): Promise<boolean> {
  const email = contact.display.email === undefined ? null : normalizeEmail(contact.display.email);
  const domain = account.display.domain === undefined ? null : normalizeDomain(account.display.domain);
  if (!email || !domain) return false;
  const key = await ctx.db
    .query("contactKeys")
    .withIndex("by_key", (q) => q.eq("orgId", orgId).eq("scope", "any").eq("kind", "email").eq("value", email))
    .first();
  if (!key || key.contactId !== contact._id) return false;
  const sameDomain = await ctx.db
    .query("accounts")
    .withIndex("by_org_and_domain", (q) => q.eq("orgId", orgId).eq("display.domain", account.display.domain))
    .take(2);
  return sameDomain.length === 1 && sameDomain[0]._id === account._id;
}

/** Every claim behind the snapshot exists in this org and cites a source that records a lawful basis. */
async function permissionsDocumented(ctx: QueryCtx, orgId: Id<"orgs">, fields: Doc<"accounts">["fields"]): Promise<boolean> {
  for (const f of fields) {
    const claim = await ctx.db.get(f.claimId);
    if (!claim || claim.orgId !== orgId) return false;
    const source = await ctx.db.get(claim.sourceId);
    if (!source || source.orgId !== orgId || !source.lawfulBasis) return false;
  }
  return true;
}

/**
 * `suppressed` used to be an argument. It is gone: a caller-supplied verdict is a bypass, and the live lookup replaces
 * it. A stale caller (or one built around the types) that still passes it is refused, not ignored, so nobody
 * believes they are overriding a check that no longer takes their word.
 */
function refuseSuppliedSuppression(args: object): void {
  if ("suppressed" in args) throw new Error("suppressed is no longer an argument: suppression is looked up live");
}

/**
 * Snapshots a scored account+contact into an immutable `leads` row. A plain helper (the org comes from the
 * auth identity; nothing here accepts one). Suppression is a LIVE lookup of the person's and company's identifiers
 * on the org's suppression list, made here and never supplied by a caller: there is no argument to forge, and a
 * lookup that cannot be answered (no salt, a changed salt) throws rather than reading as "not suppressed".
 * A subject that has been erased is refused outright.
 *
 * The lead is `ReadyForDistribution` only when the gate passes; otherwise `Held` with the failing criteria
 * recorded, and its tier is untouched. A Reject-tier score is refused: there is nothing to ship or hold.
 * A company with no contacts can never be packaged: `required_fields` demands a contactable person, and the
 * pairing check below demands a contact asserted to work there. That is intended for a lead product.
 * The contact must belong to the account: its projected `accountId` field (an ingest claim, with provenance)
 * must equal `args.accountId`; absent or different is refused, so a missing relation fails closed.
 */
export async function packageLead(
  ctx: MutationCtx,
  args: { accountId: Id<"accounts">; contactId: Id<"contacts">; scoreRunId: Id<"scoreRuns">; freshnessWindowDays?: number },
): Promise<Id<"leads">> {
  const { orgId } = await resolveOrg(ctx);
  const windowDays = args.freshnessWindowDays ?? DEFAULT_FRESHNESS_WINDOW_DAYS;
  if (!(Number.isFinite(windowDays) && windowDays > 0)) throw new Error("freshnessWindowDays must be a finite number > 0");
  refuseSuppliedSuppression(args);

  const account = await ctx.db.get(args.accountId);
  if (!account || account.orgId !== orgId) throw new Error("account not found");
  const contact = await ctx.db.get(args.contactId);
  if (!contact || contact.orgId !== orgId) throw new Error("contact not found");
  const scoreRun = await ctx.db.get(args.scoreRunId);
  if (!scoreRun || scoreRun.orgId !== orgId) throw new Error("scoreRun not found");
  await assertNotErased(ctx, orgId, "contact", contact._id);
  await assertNotErased(ctx, orgId, "account", account._id);
  if (scoreRun.subjectType !== "contact" || scoreRun.subjectId !== contact._id) throw new Error("scoreRun does not score this contact");
  const employer = contact.fields.find((f) => f.field === "accountId")?.value;
  if (employer === undefined) throw new Error("contact has no accountId claim; cannot tie it to an account");
  if (employer !== account._id) throw new Error("contact does not belong to this account");
  if (account.fields.length > MAX_PROJECTED_FIELDS || contact.fields.length > MAX_PROJECTED_FIELDS) {
    throw new Error(`projection has more than ${MAX_PROJECTED_FIELDS} fields; refusing to package a partial read`);
  }

  const stale = await staleReason(ctx, orgId, scoreRun, { accountId: account._id, contactId: contact._id }, Date.now());
  if (stale) throw new Error(`stale scoreRun: ${stale}`);
  if (scoreRun.tier === "Reject") throw new Error("a Reject-tier score is not packaged");
  const already = await ctx.db.query("leads").withIndex("by_org_and_score_run", (q) => q.eq("orgId", orgId).eq("scoreRunId", scoreRun._id)).first();
  if (already) throw new Error("this scoreRun is already packaged");

  const now = Date.now();
  const suppressed = await anySuppressed(ctx, leadIdentifiers(account, contact));
  const gate = checkDistributability({
    account,
    contact,
    scoreRun,
    now,
    freshnessWindowDays: windowDays,
    suppressed,
    duplicateChecked: await duplicatesChecked(ctx, orgId, account, contact),
    permissionsDocumented: (await permissionsDocumented(ctx, orgId, account.fields)) && (await permissionsDocumented(ctx, orgId, contact.fields)),
  });

  return await ctx.db.insert("leads", {
    orgId,
    accountId: account._id,
    contactId: contact._id,
    scoreRunId: scoreRun._id,
    tier: scoreRun.tier,
    score: scoreRun.score,
    confidence: scoreRun.confidence,
    fit: scoreRun.fit,
    intent: scoreRun.intent,
    priority: scoreRun.priority,
    // Deep copies: the lead must not share structure with a projection that a later rebuild will rewrite.
    snapshot: {
      account: structuredClone({ fields: account.fields, display: account.display }),
      contact: structuredClone({ fields: contact.fields, display: contact.display }),
    },
    distributability: { ok: gate.ok, failed: gate.failed, freshnessWindowDays: windowDays, suppressed, checkedAt: now },
    inventoryState: "Available",
    disposition: dispositionFor(scoreRun.tier, gate),
    packagedAt: now,
  });
}

/** States that put a lead in a buyer's hands or on the way there. A lead that failed the gate may not enter them. */
const SHIPPING_INVENTORY: readonly InventoryState[] = ["Reserved", "Sold", "Delivered"];
const SHIPPING_DISPOSITIONS: readonly Disposition[] = ["ReadyForDistribution", "Delivered", "Accepted", "Converted"];
/**
 * The transitions that RELEASE a lead and so re-run the gate. Accepted and Converted are what a buyer does
 * with a lead already delivered; ageing past the freshness window afterwards must not block a customer from
 * accepting what they were given, so those read only the persisted verdict.
 */
const RECHECKED_INVENTORY: readonly InventoryState[] = SHIPPING_INVENTORY;
const RECHECKED_DISPOSITIONS: readonly Disposition[] = ["ReadyForDistribution", "Delivered"];

/**
 * What a buyer does with a lead already in their hands. These skip the gate re-check on purpose (see above), which
 * is only safe if they cannot be the FIRST shipping act: otherwise they would release a lead that was never
 * re-checked at all. So they require proof of delivery. This is one precondition, not a transition graph.
 */
const BUYER_OUTCOMES: readonly Disposition[] = ["Accepted", "Converted"];
/** Delivery is recorded in either field; Accepted and Converted are themselves reachable only after it, so they count as proof. */
export const hasBeenDelivered = (lead: Doc<"leads">) =>
  lead.inventoryState === "Delivered" || lead.disposition === "Delivered" || lead.disposition === "Accepted" || lead.disposition === "Converted";

export async function loadLead(ctx: MutationCtx, leadId: Id<"leads">): Promise<Doc<"leads">> {
  const { orgId } = await resolveOrg(ctx);
  const lead = await ctx.db.get(leadId);
  if (!lead || lead.orgId !== orgId) throw new Error("lead not found");
  return lead;
}

/**
 * Re-evaluates the gate NOW for a lead about to be released. The verdict persisted at packaging is a
 * point-in-time fact: a lead packaged clean can be suppressed, age out of its window, or lose a source's
 * lawful basis before it ships. The gate is re-run over the lead's FROZEN snapshot (what the customer would
 * receive) with the current clock, the current suppression answer and the live duplicate/permission lookups.
 * Re-check was chosen over invalidating the row because ageing is a function of the clock and suppression is
 * an external event; only the transition itself observes both with no window, and nothing has to sweep.
 * A failure throws and writes nothing; the persisted verdict is left as the record of packaging.
 * Suppression is looked up LIVE over the snapshot's identifiers (what the customer would receive), never passed in.
 * An erased lead is refused first: its snapshot has been redacted, so the gate would fail anyway, but "this lead was
 * erased" is the reason a person needs, and it must not depend on which criterion happens to fail.
 */
async function assertStillDistributable(ctx: MutationCtx, lead: Doc<"leads">, what: string): Promise<void> {
  if (leadIsErased(lead)) throw new Error(`a lead whose subject was erased cannot be ${what}`);
  if (!lead.distributability.ok) throw new Error(`a lead that failed distributability cannot be ${what}`);
  const scoreRun = await ctx.db.get(lead.scoreRunId);
  if (!scoreRun || scoreRun.orgId !== lead.orgId) throw new Error("scoreRun not found");
  // A failed verdict this lead's score never counted: the confidence it would ship at is no longer true. Normally the
  // rescore that follows replaces this lead within the chain; this holds it when that rescore fails (Task 15 L5).
  // Deliberately NOT the whole of `staleReason`: a newer claim, signal or ICP is routine and is resolved by
  // repackaging, whereas a halving of confidence is the one change that can move a lead out of its tier.
  const failed = await uncountedFailuresSince(ctx, lead.orgId, lead.contactId, scoreRun._creationTime);
  if (failed.length > 0) throw new Error(`a verification of the contact's ${failed.join(" and ")} failed after the score; the lead cannot be ${what}`);
  const { account, contact } = lead.snapshot;
  const gate = checkDistributability({
    account,
    contact,
    scoreRun,
    now: Date.now(),
    freshnessWindowDays: lead.distributability.freshnessWindowDays,
    suppressed: await anySuppressed(ctx, leadIdentifiers(account, contact)),
    duplicateChecked: await duplicatesChecked(ctx, lead.orgId, { _id: lead.accountId, display: account.display }, { _id: lead.contactId, display: contact.display }),
    permissionsDocumented: (await permissionsDocumented(ctx, lead.orgId, account.fields)) && (await permissionsDocumented(ctx, lead.orgId, contact.fields)),
  });
  if (!gate.ok) throw new Error(`lead no longer passes distributability (${gate.failed.join(", ")}); it cannot be ${what}`);
}

/** One of exactly two writes to an existing lead. Touches `inventoryState` and nothing else. */
export async function setInventoryState(ctx: MutationCtx, args: { leadId: Id<"leads">; state: InventoryState }): Promise<void> {
  refuseSuppliedSuppression(args);
  if (!INVENTORY_STATES.includes(args.state)) throw new Error("not an inventory state");
  const lead = await loadLead(ctx, args.leadId);
  if (SHIPPING_INVENTORY.includes(args.state) && !lead.distributability.ok) {
    throw new Error("a lead that failed distributability cannot be reserved, sold or delivered");
  }
  if (RECHECKED_INVENTORY.includes(args.state)) await assertStillDistributable(ctx, lead, "reserved, sold or delivered");
  await ctx.db.patch(lead._id, { inventoryState: args.state });
}

/** The other of exactly two writes to an existing lead. Touches `disposition` and nothing else. */
export async function setDisposition(ctx: MutationCtx, args: { leadId: Id<"leads">; disposition: Disposition }): Promise<void> {
  refuseSuppliedSuppression(args);
  if (!DISPOSITIONS.includes(args.disposition)) throw new Error("not a disposition");
  const lead = await loadLead(ctx, args.leadId);
  if (SHIPPING_DISPOSITIONS.includes(args.disposition) && !lead.distributability.ok) {
    throw new Error("a lead that failed distributability cannot be released");
  }
  if (RECHECKED_DISPOSITIONS.includes(args.disposition)) await assertStillDistributable(ctx, lead, "released");
  if (BUYER_OUTCOMES.includes(args.disposition) && !hasBeenDelivered(lead)) {
    throw new Error(`a lead that has not been delivered cannot be ${args.disposition}`);
  }
  // Erasure is a different question from ageing: a buyer may accept a lead that has aged, but not one whose subject has
  // since been erased. Asked here, independently of the gate re-check, so those two stay exempt from ageing.
  if (BUYER_OUTCOMES.includes(args.disposition) && leadIsErased(lead)) {
    throw new Error(`a lead whose subject was erased cannot be ${args.disposition}`);
  }
  await ctx.db.patch(lead._id, { disposition: args.disposition });
}

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { withOrg } from "../_shared/org";
import { normalizeEmail, normalizeDomain } from "../_shared/normalize";
import { latestIcp, latestScoringModel } from "../icp/queries";
import { MAX_PROJECTED_FIELDS } from "../scoring/assemble";
import { checkDistributability, dispositionFor, DEFAULT_FRESHNESS_WINDOW_DAYS } from "../qualify/distributability";
import { DISPOSITIONS, INVENTORY_STATES, type Disposition, type InventoryState } from "./schema";

/**
 * Why a scoreRun can no longer back a lead, or null when it still can. A score is stale when the world it
 * described has moved on:
 *  - a newer scoreRun exists for its subject (it was superseded);
 *  - a claim about the account or the contact was recorded after it (the evidence changed);
 *  - the org has since activated a newer ICP or scoring model (it was scored under superseded rules).
 * NOT covered, deliberately: a signal appended after scoring. Signals carry no recorded-at index, and the
 * pipeline's markScoreStale (Task 12) is the owner of event-driven invalidation.
 */
export async function staleReason(
  ctx: QueryCtx,
  orgId: Id<"orgs">,
  scoreRun: Doc<"scoreRuns">,
  subjects: { accountId: Id<"accounts">; contactId: Id<"contacts"> },
): Promise<string | null> {
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

  const icp = await latestIcp(ctx, {});
  const model = await latestScoringModel(ctx, {});
  if (!icp || icp._id !== scoreRun.icpVersionId) return "a newer ICP version is active";
  if (!model || model._id !== scoreRun.scoringModelId) return "a newer scoring model is active";
  return null;
}

/** The email resolves, through the dedupe keys ingest records, to exactly this contact; the domain to exactly this account. */
async function duplicatesChecked(ctx: QueryCtx, orgId: Id<"orgs">, account: Doc<"accounts">, contact: Doc<"contacts">): Promise<boolean> {
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
 * Snapshots a scored account+contact into an immutable `leads` row. A plain helper (the org comes from the
 * auth identity; nothing here accepts one). `suppressed` is required, not defaulted: Task 13 replaces the
 * argument with a live `isSuppressed` lookup, and until then the caller must decide, visibly.
 *
 * The lead is `ReadyForDistribution` only when the gate passes; otherwise `Held` with the failing criteria
 * recorded, and its tier is untouched. A Reject-tier score is refused: there is nothing to ship or hold.
 */
export async function packageLead(
  ctx: MutationCtx,
  args: { accountId: Id<"accounts">; contactId: Id<"contacts">; scoreRunId: Id<"scoreRuns">; suppressed: boolean; freshnessWindowDays?: number },
): Promise<Id<"leads">> {
  const { orgId } = await withOrg(ctx, args);
  const windowDays = args.freshnessWindowDays ?? DEFAULT_FRESHNESS_WINDOW_DAYS;
  if (!(Number.isFinite(windowDays) && windowDays > 0)) throw new Error("freshnessWindowDays must be a finite number > 0");
  if (typeof args.suppressed !== "boolean") throw new Error("suppressed must be a boolean");

  const account = await ctx.db.get(args.accountId);
  if (!account || account.orgId !== orgId) throw new Error("account not found");
  const contact = await ctx.db.get(args.contactId);
  if (!contact || contact.orgId !== orgId) throw new Error("contact not found");
  const scoreRun = await ctx.db.get(args.scoreRunId);
  if (!scoreRun || scoreRun.orgId !== orgId) throw new Error("scoreRun not found");
  if (scoreRun.subjectType !== "contact" || scoreRun.subjectId !== contact._id) throw new Error("scoreRun does not score this contact");
  if (account.fields.length > MAX_PROJECTED_FIELDS || contact.fields.length > MAX_PROJECTED_FIELDS) {
    throw new Error(`projection has more than ${MAX_PROJECTED_FIELDS} fields; refusing to package a partial read`);
  }

  const stale = await staleReason(ctx, orgId, scoreRun, { accountId: account._id, contactId: contact._id });
  if (stale) throw new Error(`stale scoreRun: ${stale}`);
  if (scoreRun.tier === "Reject") throw new Error("a Reject-tier score is not packaged");
  const already = await ctx.db.query("leads").withIndex("by_org_and_score_run", (q) => q.eq("orgId", orgId).eq("scoreRunId", scoreRun._id)).first();
  if (already) throw new Error("this scoreRun is already packaged");

  const now = Date.now();
  const gate = checkDistributability({
    account,
    contact,
    scoreRun,
    now,
    freshnessWindowDays: windowDays,
    suppressed: args.suppressed,
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
    distributability: { ok: gate.ok, failed: gate.failed, freshnessWindowDays: windowDays, suppressed: args.suppressed, checkedAt: now },
    inventoryState: "Available",
    disposition: dispositionFor(scoreRun.tier, gate),
    packagedAt: now,
  });
}

/** States that put a lead in a buyer's hands or on the way there. A lead that failed the gate may not enter them. */
const SHIPPING_INVENTORY: readonly InventoryState[] = ["Reserved", "Sold", "Delivered"];
const SHIPPING_DISPOSITIONS: readonly Disposition[] = ["ReadyForDistribution", "Delivered", "Accepted", "Converted"];

async function loadLead(ctx: MutationCtx, leadId: Id<"leads">): Promise<Doc<"leads">> {
  const { orgId } = await withOrg(ctx, { leadId });
  const lead = await ctx.db.get(leadId);
  if (!lead || lead.orgId !== orgId) throw new Error("lead not found");
  return lead;
}

/** One of exactly two writes to an existing lead. Touches `inventoryState` and nothing else. */
export async function setInventoryState(ctx: MutationCtx, args: { leadId: Id<"leads">; state: InventoryState }): Promise<void> {
  if (!INVENTORY_STATES.includes(args.state)) throw new Error("not an inventory state");
  const lead = await loadLead(ctx, args.leadId);
  if (SHIPPING_INVENTORY.includes(args.state) && !lead.distributability.ok) {
    throw new Error("a lead that failed distributability cannot be reserved, sold or delivered");
  }
  await ctx.db.patch(lead._id, { inventoryState: args.state });
}

/** The other of exactly two writes to an existing lead. Touches `disposition` and nothing else. */
export async function setDisposition(ctx: MutationCtx, args: { leadId: Id<"leads">; disposition: Disposition }): Promise<void> {
  if (!DISPOSITIONS.includes(args.disposition)) throw new Error("not a disposition");
  const lead = await loadLead(ctx, args.leadId);
  if (SHIPPING_DISPOSITIONS.includes(args.disposition) && !lead.distributability.ok) {
    throw new Error("a lead that failed distributability cannot be released");
  }
  await ctx.db.patch(lead._id, { disposition: args.disposition });
}

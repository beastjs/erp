import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { resolveOrg } from "../_shared/org";
import { activeIcp, getIcpVersion } from "../icp/queries";
import { ensureActiveScoringModel } from "../icp/mutations";
import { activeSignals } from "../signals/mutations";
import { recordScoreRun } from "./mutations";
import { computeScore } from "./score";

/** A projection citing more fields than this is not one we assembled evidence for; refuse rather than skip some. */
export const MAX_PROJECTED_FIELDS = 200;

/**
 * The seam between projections/signals and the pure scorer: loads everything `computeScore` needs, scores a
 * lead (a contact at an account) and records the result. A lead is scored AS its contact: the scoreRun's
 * subject is the contact, and intent reads the signals of both the contact and the account.
 *
 * Two obligations live here because `recordScoreRun` deliberately loads nothing:
 *  - `claimRecordedAt`: every cited claim's `_creationTime`, so claim age runs from min(observedAt, recordedAt)
 *    and a normal claim is not scored from a raw, possibly forged, `observedAt`.
 *  - identity links: `recordScoreRun` is told which subjects fed the score and stamps `intentMayBeStranded`
 *    when any has an active inbound link (signals are not followed across links).
 */
export async function scoreLead(
  ctx: MutationCtx,
  args: { accountId: Id<"accounts">; contactId: Id<"contacts">; icpVersionId?: Id<"icpDefinitions"> },
): Promise<Id<"scoreRuns">> {
  const { orgId } = await resolveOrg(ctx);
  const account = await ctx.db.get(args.accountId);
  if (!account || account.orgId !== orgId) throw new Error("account not found");
  const contact = await ctx.db.get(args.contactId);
  if (!contact || contact.orgId !== orgId) throw new Error("contact not found");
  if (account.fields.length > MAX_PROJECTED_FIELDS || contact.fields.length > MAX_PROJECTED_FIELDS) {
    throw new Error(`projection has more than ${MAX_PROJECTED_FIELDS} fields; refusing to score a partial read`);
  }

  const icp = args.icpVersionId ? await getIcpVersion(ctx, { id: args.icpVersionId }) : await activeIcp(ctx, {});
  const model = await ensureActiveScoringModel(ctx);
  const now = Date.now();

  const claimRecordedAt: Record<string, number> = {};
  for (const f of [...account.fields, ...contact.fields]) {
    const claim = await ctx.db.get(f.claimId);
    // A projection citing a claim we cannot find is corrupt; scoring it would trust unverifiable evidence.
    if (!claim || claim.orgId !== orgId) throw new Error(`projection cites a missing claim for field ${f.field}`);
    claimRecordedAt[f.claimId] = claim._creationTime;
  }

  // CONVENTION: a real-world event is attached to exactly ONE subject (the account for company events, the
  // contact for personal ones). Contact and account signals are concatenated WITHOUT dedupe and intent is a
  // noisy-or, so the same event logged on both subjects counts twice. Two contacts at one account each
  // inheriting the account's signals is correct and per-lead. Pinned by a test in leads/package.test.ts.
  const signals = [
    ...(await activeSignals(ctx, { subjectType: "contact", subjectId: contact._id, now, scoringModelId: model._id })),
    ...(await activeSignals(ctx, { subjectType: "account", subjectId: account._id, now, scoringModelId: model._id })),
  ];
  const result = computeScore({ account, contact, signals, icp, model, claimRecordedAt, now });
  return await recordScoreRun(ctx, {
    subjectType: "contact",
    subjectId: contact._id,
    icpVersionId: icp._id,
    scoringModelId: model._id,
    result,
    alsoSignalSubjects: [{ subjectType: "account", subjectId: account._id }],
  });
}

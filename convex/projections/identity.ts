import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { withOrg } from "../_shared/org";
import {
  emailDomain,
  normalizeCompanyName,
  normalizeDomain,
} from "../_shared/normalize";
import type { SubjectType } from "../claims/schema";
import type { AccountProjection } from "./queries";

/**
 * Minimum score for an automatic match. Only a domain-level signal reaches it;
 * name similarity tops out at NAME_SCORE, so a shared name can never auto-match.
 */
export const MATCH_THRESHOLD = 0.9;
export const SIGNAL_SCORES = {
  domain: 1.0, // normalized domain equality: decisive
  email_domain: 0.9, // domain taken from the candidate's email; slightly less certain
  name: 0.5, // normalized name equality: corroboration only
} as const;

// Mailbox providers say nothing about which company an address belongs to.
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com",
  "live.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
]);

export type MatchResult = {
  subjectId: Id<"accounts">;
  score: number;
  signals: string[];
};

/** Pure. Returns the best existing account scoring >= MATCH_THRESHOLD, else null. */
export function matchCandidate(
  input: { domain?: string; companyName?: string; email?: string },
  existing: AccountProjection[],
): MatchResult | null {
  const explicit = input.domain ? normalizeDomain(input.domain) : null;
  const fromEmail = input.email ? emailDomain(input.email) : null;
  const viaEmail = !explicit && fromEmail && !FREE_MAIL.has(fromEmail) ? fromEmail : null;
  const domain = explicit ?? viaEmail;
  const name = input.companyName ? normalizeCompanyName(input.companyName) : null;

  let best: (MatchResult & { created: number }) | null = null;
  for (const account of existing) {
    const signals: string[] = [];
    let score = 0;
    const accountDomain = account.display.domain ? normalizeDomain(account.display.domain) : null;
    if (domain && accountDomain === domain) {
      signals.push(explicit ? "domain" : "email_domain");
      score = explicit ? SIGNAL_SCORES.domain : SIGNAL_SCORES.email_domain;
    }
    const accountName = account.display.name ? normalizeCompanyName(account.display.name) : null;
    if (name && accountName === name) {
      signals.push("name");
      if (score === 0) score = SIGNAL_SCORES.name;
    }
    if (score < MATCH_THRESHOLD) continue;
    // Deterministic tie-break: higher score, then the older account.
    if (
      !best ||
      score > best.score ||
      (score === best.score && account._creationTime < best.created)
    ) {
      best = { subjectId: account._id, score, signals, created: account._creationTime };
    }
  }
  return best && { subjectId: best.subjectId, score: best.score, signals: best.signals };
}

const table = (t: SubjectType) => (t === "account" ? "accounts" : "contacts");

/**
 * Record that `mergedFromId` is the same real-world entity as `subjectId`.
 * Nothing is merged or deleted; the link is a reversible record.
 */
export async function linkIdentity(
  ctx: MutationCtx,
  args: {
    subjectType: SubjectType;
    subjectId: Id<"accounts"> | Id<"contacts">;
    mergedFromId: Id<"accounts"> | Id<"contacts">;
    score: number;
    signals: string[];
  },
): Promise<Id<"identityLinks">> {
  const { orgId } = await withOrg(ctx, args);
  if (args.subjectId === args.mergedFromId) throw new Error("cannot link a subject to itself");
  const tbl = table(args.subjectType);
  for (const id of [args.subjectId, args.mergedFromId]) {
    const normalized = ctx.db.normalizeId(tbl, id);
    const row = normalized ? await ctx.db.get(normalized) : null;
    if (!row || row.orgId !== orgId) throw new Error("subject not found");
  }
  return await ctx.db.insert("identityLinks", {
    orgId,
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    mergedFromId: args.mergedFromId,
    score: args.score,
    signals: args.signals,
    createdAt: Date.now(),
  });
}

/** Reverses a link by stamping `reversedAt`. The link row and both subjects are kept. */
export async function unlinkIdentity(
  ctx: MutationCtx,
  args: { linkId: Id<"identityLinks"> },
): Promise<void> {
  const { orgId } = await withOrg(ctx, args);
  const link = await ctx.db.get(args.linkId);
  if (!link || link.orgId !== orgId) throw new Error("link not found");
  if (link.reversedAt !== undefined) return;
  await ctx.db.patch(args.linkId, { reversedAt: Date.now() });
}

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { action, internalMutation, type MutationCtx } from "../_generated/server";
import { resolveOrg } from "../_shared/org";
import { CANDIDATE_CONTRACT_VERSION, checkContractVersion, candidatePersonKey, computeDedupeHash, validateCandidate } from "./contract";
import { candidateSuppressed } from "../privacy/suppress";
import { lawfulBasis, sourceKind } from "./schema";
import { requireRole } from "../_shared/authz";
import { writeAudit } from "../audit/log";
import { recordRefusals } from "../observability/refusals";

/**
 * Registers a source. Role: `admin`. A public ACTION so that an authorization refusal can be recorded
 * (observability/refusals.ts); the work and the role check run in `registerSourceTxn` with the caller's identity.
 */
export const registerSource = action({
  args: { key: v.string(), kind: sourceKind, trustWeight: v.number(), lawfulBasis },
  handler: async (ctx, args): Promise<Id<"sources">> => await recordRefusals(ctx, "registerSource", () => ctx.runMutation(internal.sources.mutations.registerSourceTxn, args)),
});

/** The work of `registerSource`, in one transaction. Internal: reachable only through the action above. */
export const registerSourceTxn = internalMutation({
  args: { key: v.string(), kind: sourceKind, trustWeight: v.number(), lawfulBasis },
  handler: async (ctx, args): Promise<Id<"sources">> => {
    const { orgId, actor } = await requireRole(ctx, "admin");
    const key = args.key.trim();
    // Negated conjunction on purpose: every comparison with NaN is false, so NaN fails closed.
    // Claim resolution orders by trustWeight; a NaN would break its total order.
    if (!(args.trustWeight >= 0 && args.trustWeight <= 1)) {
      throw new Error("trustWeight must be a finite number between 0 and 1");
    }
    if (key.length === 0) throw new Error("key must not be empty");
    const existing = await ctx.db
      .query("sources")
      .withIndex("by_org_and_key", (q) => q.eq("orgId", orgId).eq("key", key))
      .first();
    if (existing) throw new Error("source key already registered");
    const id = await ctx.db.insert("sources", { ...args, key, orgId });
    await writeAudit(ctx, {
      actor,
      action: "source.registered",
      targetTable: "sources",
      targetId: id,
      after: { kind: args.kind, trustWeight: args.trustWeight, lawfulBasis: args.lawfulBasis },
    });
    return id;
  },
});

/**
 * Plain helper, deliberately NOT a registered endpoint: public entry points (import, manual entry,
 * the Collector HTTP endpoint) validate their own args and compose this. The server owns the dedupe
 * hash, derived from the validated candidate. Returns null when a PENDING candidate with that hash already exists: overlapping
 * sources make that routine, not a fault.
 *
 * SUPPRESSION (spec 7.3): a candidate whose person email (or that email's domain), phone, profile URL or company domain is on the
 * org's list is REFUSED with `SuppressedCandidateError` and nothing is stored, so an erased contact re-imported inserts
 * nothing. Fail closed: with no salt configured, or a salt that differs from the list's, this throws and nothing is stored.
 */
/**
 * Thrown by `insertCandidate` for a candidate that carries a suppressed identifier. A class, so a bulk caller can tell
 * "this row may not enter" (data: reject the row, carry on) from a real fault (let it propagate). The message names no
 * identifier: it ends up in rejection lists and logs.
 */
export class SuppressedCandidateError extends Error {
  constructor() {
    super("suppressed: an identifier on this candidate is on the suppression list");
    this.name = "SuppressedCandidateError";
  }
}

export async function insertCandidate(
  ctx: MutationCtx,
  args: {
    candidate: unknown;
    sourceId: Id<"sources">;
    runId?: Id<"discoveryRuns">;
    /** What the producer declared. Omit only for in-process sources, which speak Core's own version. */
    contractVersion?: string;
  },
): Promise<Id<"candidates"> | null> {
  const { orgId } = await resolveOrg(ctx);
  const contractVersion = args.contractVersion ?? CANDIDATE_CONTRACT_VERSION;
  const version = checkContractVersion(contractVersion);
  if (!version.ok) throw new Error(version.error);
  const checked = validateCandidate(args.candidate);
  if (!checked.ok) throw new Error(`invalid candidate: ${checked.errors.join("; ")}`);
  const dedupeHash = computeDedupeHash(checked.value);
  const source = await ctx.db.get(args.sourceId);
  if (!source || source.orgId !== orgId) throw new Error("source not found");
  if (args.runId) {
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== orgId) throw new Error("run not found");
  }
  if (await candidateSuppressed(ctx, checked.value)) throw new SuppressedCandidateError();
  const dup = await ctx.db
    .query("candidates")
    .withIndex("by_org_and_dedupe_hash_and_status", (q) =>
      q.eq("orgId", orgId).eq("dedupeHash", dedupeHash).eq("status", "pending"),
    )
    .first();
  if (dup) return null;
  return await ctx.db.insert("candidates", {
    orgId,
    sourceId: args.sourceId,
    runId: args.runId,
    dedupeHash,
    personKey: candidatePersonKey(checked.value) ?? undefined,
    status: "pending",
    contractVersion,
    candidate: checked.value,
  });
}

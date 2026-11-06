import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import { resolveOrg, withOrg } from "../_shared/org";
import { CANDIDATE_CONTRACT_VERSION, checkContractVersion, computeDedupeHash, validateCandidate } from "./contract";
import { lawfulBasis, sourceKind } from "./schema";

export const registerSource = mutation({
  args: { key: v.string(), kind: sourceKind, trustWeight: v.number(), lawfulBasis },
  handler: async (ctx, args) => {
    const { orgId } = await withOrg(ctx, args);
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
    return await ctx.db.insert("sources", { ...args, key, orgId });
  },
});

/**
 * Plain helper, deliberately NOT a registered endpoint: public entry points (import, manual entry,
 * the Collector HTTP endpoint) validate their own args and compose this. The server owns the dedupe
 * hash, derived from the validated candidate. Returns null when a PENDING candidate with that hash already exists: overlapping
 * sources make that routine, not a fault.
 */
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
    status: "pending",
    contractVersion,
    candidate: checked.value,
  });
}

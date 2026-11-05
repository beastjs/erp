import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import { withOrg } from "../_shared/org";
import { activeScoringConfig } from "../icp/queries";
import { claimMethod, subjectType, type ClaimMethod, type SubjectType } from "./schema";

export type AppendClaimArgs = {
  subjectType: SubjectType;
  subjectId: string;
  field: string;
  value: unknown;
  sourceId: Id<"sources">;
  method: ClaimMethod;
  confidence: number;
  observedAt: number;
  snapshotRef?: string;
  runId?: Id<"discoveryRuns">;
};

/**
 * The validating write, as a plain helper so ingest can append many claims in one transaction
 * without a nested function call per claim. Every check lives here; the endpoint below adds nothing.
 */
export async function appendClaimRecord(ctx: MutationCtx, args: AppendClaimArgs): Promise<Id<"claims">> {
  const { orgId } = await withOrg(ctx, args);
  if (!(args.confidence >= 0 && args.confidence <= 1)) {
    throw new Error("confidence must be between 0 and 1");
  }
  // subjectId is stored as a string, so canonicalize it here: a claim stored under any other
  // spelling would be invisible to its own subject's index reads and silently dropped.
  const subjectId = ctx.db.normalizeId(args.subjectType === "account" ? "accounts" : "contacts", args.subjectId);
  if (!subjectId) throw new Error("invalid subject id");
  // The ledger is append-only and uncleanable, so refuse claims about rows that do not exist
  // or belong to another org rather than leaving junk that can never project.
  const subject = await ctx.db.get(subjectId);
  if (!subject || subject.orgId !== orgId) throw new Error("subject not found");
  const source = await ctx.db.get(args.sourceId);
  if (!source || source.orgId !== orgId) throw new Error("source not found");
  if (args.runId) {
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== orgId) throw new Error("run not found");
  }
  // Ceilings are scoring-model config (spec 5.3). The clamped value is what is stored, so a later model
  // change never rewrites history; it only governs claims appended from then on.
  const ceiling = (await activeScoringConfig(ctx, args)).methodCeilings[args.method];
  if (!(ceiling > 0 && ceiling <= 1)) throw new Error("invalid method ceiling");
  return await ctx.db.insert("claims", {
    ...args,
    subjectId,
    orgId,
    confidence: Math.min(args.confidence, ceiling),
  });
}

export const appendClaim = mutation({
  args: {
    subjectType,
    subjectId: v.string(),
    field: v.string(),
    value: v.any(),
    sourceId: v.id("sources"),
    method: claimMethod,
    confidence: v.number(),
    observedAt: v.number(),
    snapshotRef: v.optional(v.string()),
    runId: v.optional(v.id("discoveryRuns")),
  },
  handler: async (ctx, args) => appendClaimRecord(ctx, args),
});

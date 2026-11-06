import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { withOrg } from "../_shared/org";
import { DEFAULT_SCORING_MODEL } from "./defaults";
import { latestIcp, latestScoringModel } from "./queries";
import type { IcpCriteria, ScoringConfig, ScoringModel } from "./schema";
import { validateIcpCriteria, validateScoringConfig } from "./validate";

async function creator(ctx: MutationCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("no identity");
  return identity.tokenIdentifier;
}

/**
 * History is one chain per org. A new version must name the current newest as `supersedesId` (and the
 * first must name none), so two editors working from the same base cannot both succeed and fork it:
 * the second finds a newer head and is refused. Plain helpers, not public functions: who may call
 * them (the `analyst` role, spec 8) is an authorization decision that does not exist yet.
 */
function checkChain(head: { _id: string; version: number } | null, supersedesId: string | undefined): number {
  if (head === null) {
    if (supersedesId !== undefined) throw new Error("supersedesId given but no earlier version exists");
    return 1;
  }
  if (supersedesId !== head._id) throw new Error("supersedesId must be the current latest version");
  return head.version + 1;
}

export async function createIcpVersion(
  ctx: MutationCtx,
  args: { name: string; criteria: IcpCriteria; supersedesId?: Id<"icpDefinitions"> },
): Promise<Id<"icpDefinitions">> {
  const { orgId } = await withOrg(ctx, args);
  if (typeof args.name !== "string" || args.name.trim() === "") throw new Error("name is required");
  validateIcpCriteria(args.criteria);
  const version = checkChain(await latestIcp(ctx, {}), args.supersedesId);
  return await ctx.db.insert("icpDefinitions", {
    orgId,
    version,
    name: args.name,
    criteria: args.criteria,
    supersedesId: args.supersedesId,
    createdBy: await creator(ctx),
    activeFrom: Date.now(),
  });
}

export async function createScoringModel(
  ctx: MutationCtx,
  args: ScoringConfig & { supersedesId?: Id<"scoringModels"> },
): Promise<Id<"scoringModels">> {
  const { orgId } = await withOrg(ctx, args);
  // Pick fields explicitly: never spread caller-shaped input into an insert that also carries orgId.
  const { supersedesId } = args;
  const config: ScoringConfig = {
    weights: args.weights,
    tierBands: args.tierBands,
    confidenceFloors: args.confidenceFloors,
    methodCeilings: args.methodCeilings,
    strengthWeights: args.strengthWeights,
    decayHalfLives: args.decayHalfLives,
    claimHalfLifeMs: args.claimHalfLifeMs,
    failedVerificationFactor: args.failedVerificationFactor,
    claimFreshnessFloor: args.claimFreshnessFloor,
    sizeOverlapCredit: args.sizeOverlapCredit,
  };
  validateScoringConfig(config);
  const version = checkChain(await latestScoringModel(ctx, {}), supersedesId);
  return await ctx.db.insert("scoringModels", {
    orgId,
    version,
    ...config,
    supersedesId,
    createdBy: await creator(ctx),
    activeFrom: Date.now(),
  });
}

/**
 * The only model source a score may use. Returns the org's newest model row, first creating version 1
 * from DEFAULT_SCORING_MODEL if there is none, so a score always cites a real immutable row.
 * Idempotent: it never creates a second version (the transaction serializes concurrent seeds via OCC).
 */
export async function ensureActiveScoringModel(ctx: MutationCtx): Promise<ScoringModel> {
  const existing = await latestScoringModel(ctx, {});
  if (existing) return existing;
  const id = await createScoringModel(ctx, structuredClone(DEFAULT_SCORING_MODEL));
  const row = await ctx.db.get(id);
  if (!row) throw new Error("scoring model seed failed");
  return row;
}

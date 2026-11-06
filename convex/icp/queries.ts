import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { resolveOrg } from "../_shared/org";
import { DEFAULT_SCORING_MODEL } from "./defaults";
import type { IcpDefinition, ScoringConfig, ScoringModel } from "./schema";

/** Reads exactly one version, in the caller's org. This is how a historical score resolves its config. */
export async function getIcpVersion(ctx: QueryCtx, args: { id: Id<"icpDefinitions"> }): Promise<IcpDefinition> {
  const { orgId } = await resolveOrg(ctx);
  const row = await ctx.db.get(args.id);
  if (!row || row.orgId !== orgId) throw new Error("icp version not found");
  return row;
}

export async function getScoringModel(ctx: QueryCtx, args: { id: Id<"scoringModels"> }): Promise<ScoringModel> {
  const { orgId } = await resolveOrg(ctx);
  const row = await ctx.db.get(args.id);
  if (!row || row.orgId !== orgId) throw new Error("scoring model not found");
  return row;
}

/** Newest version is the active one (activeFrom is stamped at creation). Index + first(): no bound to truncate at. */
export async function latestIcp(ctx: QueryCtx, args: object): Promise<IcpDefinition | null> {
  const { orgId } = await resolveOrg(ctx);
  return await ctx.db.query("icpDefinitions").withIndex("by_org_and_version", (q) => q.eq("orgId", orgId)).order("desc").first();
}

export async function latestScoringModel(ctx: QueryCtx, args: object): Promise<ScoringModel | null> {
  const { orgId } = await resolveOrg(ctx);
  return await ctx.db.query("scoringModels").withIndex("by_org_and_version", (q) => q.eq("orgId", orgId)).order("desc").first();
}

export async function activeIcp(ctx: QueryCtx, args: object): Promise<IcpDefinition> {
  const row = await latestIcp(ctx, args);
  if (!row) throw new Error("no active icp");
  return row;
}

/**
 * READ-ONLY convenience: the org's current model, or the built-in defaults when it has none. The
 * defaults have no row and therefore no id, so NOTHING DERIVED FROM THIS MAY BACK A scoreRun. Scoring
 * must use `ensureActiveScoringModel` (mutations.ts), which returns a real, citable row.
 */
export async function scoringConfigForRead(ctx: QueryCtx, args: object): Promise<ScoringConfig> {
  return (await latestScoringModel(ctx, args)) ?? DEFAULT_SCORING_MODEL;
}

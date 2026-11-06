import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { resolveOrg } from "../_shared/org";
import { DISPOSITIONS, type Disposition } from "./schema";

export const MAX_LEADS_PER_READ = 200;

export async function getLead(ctx: QueryCtx, args: { leadId: Id<"leads"> }): Promise<Doc<"leads">> {
  const { orgId } = await resolveOrg(ctx);
  const lead = await ctx.db.get(args.leadId);
  if (!lead || lead.orgId !== orgId) throw new Error("lead not found");
  return lead;
}

/** Newest first. `limit` is required and capped: a caller asks for a bounded page, never "all". */
export async function leadsByDisposition(ctx: QueryCtx, args: { disposition: Disposition; limit: number }): Promise<Doc<"leads">[]> {
  const { orgId } = await resolveOrg(ctx);
  if (!DISPOSITIONS.includes(args.disposition)) throw new Error("not a disposition");
  if (!(Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= MAX_LEADS_PER_READ)) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LEADS_PER_READ}`);
  }
  return await ctx.db.query("leads").withIndex("by_org_and_disposition", (q) => q.eq("orgId", orgId).eq("disposition", args.disposition)).order("desc").take(args.limit);
}

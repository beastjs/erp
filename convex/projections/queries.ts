import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireRole } from "../_shared/authz";


export type AccountProjection = Doc<"accounts">;
export type ContactProjection = Doc<"contacts">;

export const getAccount = query({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args): Promise<AccountProjection> => {
    const { orgId } = await requireRole(ctx, "operator");
    const row = await ctx.db.get(args.accountId);
    if (!row || row.orgId !== orgId) throw new Error("account not found");
    return row;
  },
});

export const getContact = query({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args): Promise<ContactProjection> => {
    const { orgId } = await requireRole(ctx, "operator");
    const row = await ctx.db.get(args.contactId);
    if (!row || row.orgId !== orgId) throw new Error("contact not found");
    return row;
  },
});

import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireRole } from "../_shared/authz";
import { writeAudit } from "../audit/log";
import { loadLead, setDisposition, setInventoryState } from "./mutations";
import { disposition, inventoryState } from "./schema";

/**
 * Spec 7.1: `operator` reviews leads and, with it, moves them through the inventory lifecycle. The plain setters
 * enforce the distributability and erasure rules; these wrappers add the role check and the audit entry (spec 7.2:
 * deliveries write before/after), in the same transaction as the change, so a delivery with no record cannot exist.
 */
export const markInventoryState = mutation({
  args: { leadId: v.id("leads"), state: inventoryState },
  handler: async (ctx, args): Promise<null> => {
    const { actor } = await requireRole(ctx, "operator");
    const before = await loadLead(ctx, args.leadId);
    await setInventoryState(ctx, { leadId: args.leadId, state: args.state });
    await writeAudit(ctx, {
      actor,
      action: "lead.inventory_state_set",
      targetTable: "leads",
      targetId: args.leadId,
      before: { inventoryState: before.inventoryState },
      after: { inventoryState: args.state },
    });
    return null;
  },
});

export const markDisposition = mutation({
  args: { leadId: v.id("leads"), disposition },
  handler: async (ctx, args): Promise<null> => {
    const { actor } = await requireRole(ctx, "operator");
    const before = await loadLead(ctx, args.leadId);
    await setDisposition(ctx, { leadId: args.leadId, disposition: args.disposition });
    await writeAudit(ctx, {
      actor,
      action: "lead.disposition_set",
      targetTable: "leads",
      targetId: args.leadId,
      before: { disposition: before.disposition },
      after: { disposition: args.disposition },
    });
    return null;
  },
});

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { SubjectType } from "../claims/schema";

/** `pipelineState.finishedReason` of a subject erasure has stopped. The pipeline treats it as terminal. */
export const ERASED_REASON = "erased";

/**
 * The erasure record for a subject, or null. An exact-key read (`.unique()` on the full key), so it neither truncates
 * nor guesses. A LEAF module on purpose: claims, signals, projections and the pipeline all ask this question, and
 * none of them may depend on the code that performs erasure.
 */
export async function findErasure(
  ctx: Pick<QueryCtx, "db">,
  orgId: Id<"orgs">,
  subjectType: SubjectType,
  subjectId: string,
): Promise<Doc<"erasures"> | null> {
  return await ctx.db
    .query("erasures")
    .withIndex("by_subject", (q) => q.eq("orgId", orgId).eq("subjectType", subjectType).eq("subjectId", subjectId))
    .unique();
}

/** Throws when the subject has been (or is being) erased. The message names no personal data. */
export async function assertNotErased(
  ctx: Pick<QueryCtx, "db">,
  orgId: Id<"orgs">,
  subjectType: SubjectType,
  subjectId: string,
): Promise<void> {
  if (await findErasure(ctx, orgId, subjectType, subjectId)) throw new Error(`${subjectType} ${subjectId} has been erased`);
}

/** A lead whose account or contact has been erased. Its snapshot is redacted on that side and it may not ship. */
export const leadIsErased = (lead: Pick<Doc<"leads">, "contactErasedAt" | "accountErasedAt">): boolean =>
  lead.contactErasedAt !== undefined || lead.accountErasedAt !== undefined;

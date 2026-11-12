import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, query, type ActionCtx, type MutationCtx } from "../_generated/server";
import { refusalReasonOf, requireRole, type RefusalReason } from "../_shared/authz";
import { resolveOrg } from "../_shared/org";
import { inDomain } from "../audit/log";
import { REFUSAL_SCAN_CAP, tally, type Count } from "./definitions";
import { REFUSAL_DOMAINS, refusableFunction, refusalReason, type CallerClass, type RefusableFunction } from "./schema";

/*
 * REFUSED-ACTION RECORDING (Task 16, "Option W", the user's ruling).
 *
 * A refusal cannot be recorded by the function that refuses: its throw rolls back every write it made and every call it
 * scheduled, and a query cannot write at all. So each admin-tier public function is a public ACTION that runs the
 * existing logic as an internal mutation or query (whose first statement is still `requireRole`, so authorization
 * happens inside the transaction that does the work, with the caller's identity, which Convex passes from an action to
 * the functions it runs). When that throws an AUTHORIZATION refusal, `recordRefusals` records it through `recordRefusal`,
 * a separate transaction, and rethrows the ORIGINAL error. A failure to record never changes the outcome.
 *
 * WHAT IS STORED: counter buckets keyed by (org, hour, function, reason, caller class, membershipId | null). Every field
 * has a closed domain (REFUSAL_DOMAINS). A member is stored as its membershipId, never its userId; anyone else only as the
 * class `non_member`, never a tokenIdentifier or a hash of one. A caller whose org claim names no existing org, or who has
 * no org claim, is not recorded at all, so a stranger cannot create rows. No error text is stored.
 *
 * BOUND. Per org per hour, at most
 *     7 functions x 2 member reasons (insufficient_role, malformed_membership) x M members
 *   + 7 functions x 2 non-member reasons (not_member, no_identity) x 1 class
 *   = 14 (M + 1) rows,  M = the org's memberships that hour.
 * The reason fixes the class: a member is never recorded with a non-member reason, nor the reverse.
 */

const HOUR_MS = 60 * 60 * 1000;
/** Longest window one read may cover (a week of hours). A wider ask is refused, never trimmed. */
export const MAX_REFUSAL_WINDOW_HOURS = 24 * 7;

/** Reasons that only a caller WITHOUT a usable membership can get, and so are recorded under the class `non_member`. */
const NON_MEMBER_REASONS: readonly RefusalReason[] = ["not_member", "no_identity"];

/**
 * Wraps the body of a refusal-recording action. Classifies by the error's typed DATA (`refusalReasonOf`), never by its
 * class or wording: across the action boundary Convex rebuilds the error, keeping only `ConvexError` data intact.
 * Passes the recorder nothing about the caller: no identity, org or role. The recorder derives those from `ctx.auth`.
 */
export async function recordRefusals<T>(ctx: Pick<ActionCtx, "runMutation">, fn: RefusableFunction, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const reason = refusalReasonOf(error);
    if (reason !== null) {
      try {
        await ctx.runMutation(internal.observability.refusals.recordRefusal, { fn, reason });
      } catch {
        // A failure to record must not change the outcome: the caller still gets the refusal, not this error.
      }
    }
    throw error;
  }
}

type Bucket = { orgId: Id<"orgs">; callerClass: CallerClass; membershipId: Id<"memberships"> | null };

/** Where a refusal is counted, from the recorder's OWN identity. Null when it must not be recorded at all. */
async function bucketOf(ctx: MutationCtx, reason: RefusalReason): Promise<Bucket | null> {
  let orgId: Id<"orgs">;
  try {
    ({ orgId } = await resolveOrg(ctx));
  } catch {
    return null; // no org claim: nobody to count it against
  }
  if ((await ctx.db.get(orgId)) === null) return null; // a well-formed id naming no org: a stranger creates no rows
  if (NON_MEMBER_REASONS.includes(reason)) return { orgId, callerClass: "non_member", membershipId: null };
  const userId = (await ctx.auth.getUserIdentity())?.tokenIdentifier;
  if (typeof userId !== "string" || userId === "") return null;
  const rows = await ctx.db
    .query("memberships")
    .withIndex("by_org_and_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
    .take(2);
  // Not exactly one row: the membership changed since the refusal, or is ambiguous. Not counted (counts are lower bounds).
  if (rows.length !== 1) return null;
  return { orgId, callerClass: "member", membershipId: rows[0]!._id };
}

/** Start of the hour containing `now`, refusing (not clamping) a clock that is not a finite non-negative time. */
export function hourOf(now: number): number {
  if (!(Number.isFinite(now) && now >= 0)) throw new Error("clock is not a finite, non-negative epoch-millisecond time");
  return Math.floor(now / HOUR_MS) * HOUR_MS;
}

/** THE ONE WRITER of refusalCounts. Inserts `count: 1` or increments; never sets, resets or deletes. */
export const recordRefusal = internalMutation({
  args: { fn: refusableFunction, reason: refusalReason },
  handler: async (ctx, args): Promise<null> => {
    const bucket = await bucketOf(ctx, args.reason);
    if (bucket === null) return null;
    const hour = hourOf(Date.now());
    const row = await ctx.db
      .query("refusalCounts")
      .withIndex("by_org_and_bucket", (q) =>
        q.eq("orgId", bucket.orgId).eq("hour", hour).eq("fn", args.fn).eq("reason", args.reason).eq("callerClass", bucket.callerClass).eq("membershipId", bucket.membershipId),
      )
      .unique();
    const fields = { hour, fn: args.fn, reason: args.reason, callerClass: bucket.callerClass, count: row ? row.count + 1 : 1 };
    for (const [key, value] of Object.entries(fields)) {
      if (!inDomain(REFUSAL_DOMAINS[key as keyof typeof REFUSAL_DOMAINS], value)) throw new Error(`refusal field "${key}" is outside its declared domain`);
    }
    if (row) await ctx.db.patch(row._id, { count: row.count + 1 });
    else await ctx.db.insert("refusalCounts", { orgId: bucket.orgId, hour, fn: args.fn, reason: args.reason, callerClass: bucket.callerClass, membershipId: bucket.membershipId, count: 1 });
    return null;
  },
});

export type RefusalCounts = {
  fromHour: number;
  toHour: number;
  buckets: Array<{ hour: number; fn: RefusableFunction; reason: RefusalReason; callerClass: CallerClass; membershipId: Id<"memberships"> | null; count: number }>;
  more: boolean;
  total: Count;
};

/** An hour boundary handed to the read. Validated, never rounded or clamped. */
function hourArg(name: string, value: number): number {
  if (!(Number.isFinite(value) && value >= 0 && value % HOUR_MS === 0)) throw new Error(`${name} must be a finite, non-negative epoch-millisecond hour boundary`);
  return value;
}

/**
 * Refused admin-tier calls in the caller's org, by bucket, for the hours [fromHour, toHour] (both hour starts, at most
 * MAX_REFUSAL_WINDOW_HOURS apart). Role: `admin`: it names members (by membershipId) who tried what they may not.
 */
export const refusalCounts = query({
  args: { fromHour: v.number(), toHour: v.number() },
  handler: async (ctx, args): Promise<RefusalCounts> => {
    const { orgId } = await requireRole(ctx, "admin");
    const fromHour = hourArg("fromHour", args.fromHour);
    const toHour = hourArg("toHour", args.toHour);
    if (toHour < fromHour) throw new Error("toHour must not be before fromHour");
    if ((toHour - fromHour) / HOUR_MS >= MAX_REFUSAL_WINDOW_HOURS) throw new Error(`a window may cover at most ${MAX_REFUSAL_WINDOW_HOURS} hours`);
    const rows = await ctx.db
      .query("refusalCounts")
      .withIndex("by_org_and_bucket", (q) => q.eq("orgId", orgId).gte("hour", fromHour).lte("hour", toHour))
      .take(REFUSAL_SCAN_CAP + 1);
    const more = rows.length > REFUSAL_SCAN_CAP;
    const buckets = rows.slice(0, REFUSAL_SCAN_CAP).map((r) => ({ hour: r.hour, fn: r.fn, reason: r.reason, callerClass: r.callerClass, membershipId: r.membershipId, count: r.count }));
    return { fromHour, toHour, buckets, more, total: tally(buckets.reduce((sum, b) => sum + b.count, 0), more) };
  },
});

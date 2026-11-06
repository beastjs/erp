import type { Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { SYSTEM_PROCESSES, ROLES, type Actor, type Role } from "../_shared/actor";
import { resolveOrg } from "../_shared/org";

/*
 * THE PII TRAP, AND WHY THIS FILE LOOKS THE WAY IT DOES.
 * The obvious `writeAudit(ctx, { action, targetTable, targetId, before, after })` logs whole documents. Audit a claim
 * redaction that way and `before` holds exactly the personal data being erased, in a table that is append-only and
 * must outlive the erasure: a permanent PII store, defeating erasure (spec 7.3) across every store Task 13 swept.
 *
 * Resolution: THE LOG NEVER STORES CONTENT. Every action is declared below with the exact fields it may carry, all of
 * them non-personal attributes (a version number, a lifecycle state, a budget, a count). `writeAudit` THROWS on a
 * field outside the declaration, on a value that is not a finite number, a boolean, null or a short token, and on an
 * action it does not know. Rejected in preference to alternatives:
 *   - storing hashes: a hash of an email is still the email's identity (it is how the suppression list works), and
 *     low-entropy values are reversible by guessing;
 *   - storing values but redacting audit rows on erasure: it makes the audit table mutable by the erasure path, which
 *     destroys the integrity guarantee, and it relies on the erasure sweep knowing every shape that ever went in;
 *   - field NAME plus a "changed" flag: sufficient for erasure, but spec 7.2 requires before/after for model edits,
 *     budget changes and deliveries, and those are configuration and lifecycle states, not personal data.
 * What a change CONTAINED is answered by the row it concerns (scoring models and ICPs are immutable versions, so a
 * version number IS the before/after), never by a copy in the log.
 * An unauditable change must not happen: callers write the entry in the SAME transaction as the change, and a rejected
 * entry throws and rolls the change back.
 *
 * REFUSALS ARE NOT AUDITED. A refused action throws, and a throw rolls back everything the transaction wrote, an
 * audit entry included (ledger: Task 12 M1, Task 13 H-1). Recording refusals would take a separate transaction that
 * observes the failure from outside; that is observability (Task 16), not this log.
 */

type Spec = { table: TableNames; fields: readonly string[] };

/** Every audited action and the only fields it may carry. Adding a field is a privacy decision: it must never hold content about a person. */
export const AUDIT_ACTIONS = {
  "icp.created": { table: "icpDefinitions", fields: ["version"] },
  "scoring_model.created": { table: "scoringModels", fields: ["version"] },
  "source.registered": { table: "sources", fields: ["kind", "trustWeight", "lawfulBasis"] },
  "run.started": { table: "discoveryRuns", fields: ["creditBudget"] },
  "lead.inventory_state_set": { table: "leads", fields: ["inventoryState"] },
  "lead.disposition_set": { table: "leads", fields: ["disposition"] },
  "erasure.requested": { table: "erasures", fields: ["legalBasis", "reasonCode"] },
  "erasure.completed": {
    table: "erasures",
    fields: ["claimsRedacted", "contactKeysDeleted", "candidatesRedacted", "signalsRedacted", "leadsRedacted", "suppressionsAdded"],
  },
  "suppression.added": { table: "suppressions", fields: ["kind", "reasonCode"] },
  "member.role_set": { table: "memberships", fields: ["role"] },
} as const satisfies Record<string, Spec>;
export type AuditAction = keyof typeof AUDIT_ACTIONS;

/** A value that can only be a token (an enum member, a short identifier): no spaces, no punctuation a name or address needs. */
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
export type AuditFields = Readonly<Record<string, string | number | boolean | null>>;

function checkFields(action: AuditAction, side: "before" | "after", fields: AuditFields | undefined): Record<string, string | number | boolean | null> | undefined {
  if (fields === undefined) return undefined;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) throw new Error(`audit ${side} must be a flat record`);
  const allowed = AUDIT_ACTIONS[action].fields as readonly string[];
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) throw new Error(`audit field "${key}" is not allowed for ${action}`);
    const ok =
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && TOKEN.test(value));
    if (!ok) throw new Error(`audit field "${key}" must be a finite number, a boolean, null or a short token`);
    out[key] = value;
  }
  return out;
}

function checkActor(actor: Actor): Actor {
  const a = actor as { kind?: unknown; userId?: unknown; role?: unknown; process?: unknown };
  if (a?.kind === "user" && typeof a.userId === "string" && a.userId !== "" && (ROLES as readonly unknown[]).includes(a.role)) {
    return { kind: "user", userId: a.userId, role: a.role as Role };
  }
  if (a?.kind === "system" && (SYSTEM_PROCESSES as readonly unknown[]).includes(a.process)) {
    return { kind: "system", process: a.process as never };
  }
  // Fails closed: an actor is never inferred, defaulted or left blank.
  throw new Error("audit requires an actor: a verified user or a named system process");
}

/**
 * Appends one audit entry. The actor is an explicit argument and is NEVER read from the ctx: a scheduled function
 * has no identity, and a log that guessed one would fabricate it. Pass the `actor` that `requireRole` returned, or
 * `systemActor(process)` for work no person started.
 */
export async function writeAudit(
  ctx: MutationCtx,
  args: { actor: Actor; action: AuditAction; targetTable: TableNames; targetId: string; before?: AuditFields; after?: AuditFields },
): Promise<Id<"auditLog">> {
  const { orgId } = await resolveOrg(ctx);
  const spec = (AUDIT_ACTIONS as Record<string, Spec>)[args.action];
  if (!Object.hasOwn(AUDIT_ACTIONS, args.action) || !spec) throw new Error("unknown audit action");
  if (args.targetTable !== spec.table) throw new Error(`${args.action} concerns ${spec.table}, not ${String(args.targetTable)}`);
  const targetId = ctx.db.normalizeId(spec.table, args.targetId);
  if (!targetId) throw new Error("audit target is not an id of that table");
  const actor = checkActor(args.actor);
  const before = checkFields(args.action, "before", args.before);
  const after = checkFields(args.action, "after", args.after);
  return await ctx.db.insert("auditLog", {
    orgId,
    actor,
    action: args.action,
    targetTable: spec.table,
    targetId,
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    createdAt: Date.now(),
  });
}

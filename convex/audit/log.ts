import type { Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { SYSTEM_PROCESSES, ROLES, type Actor, type Role } from "../_shared/actor";
import { MAX_CREDIT_BUDGET } from "../_shared/limits";
import { resolveOrg } from "../_shared/org";
import { DISPOSITIONS, INVENTORY_STATES } from "../leads/schema";
import { ERASURE_REASONS, LEGAL_BASES, suppressionReason } from "../privacy/schema";
import { lawfulBasis, sourceKind } from "../sources/schema";

/*
 * THE PII TRAP, AND WHY THIS FILE LOOKS THE WAY IT DOES.
 * The obvious `writeAudit(ctx, { action, targetTable, targetId, before, after })` logs whole documents. Audit a claim
 * redaction that way and `before` holds exactly the personal data being erased, in a table that is append-only and
 * must outlive the erasure: a permanent PII store, defeating erasure (spec 7.3) across every store Task 13 swept.
 *
 * Resolution: THE LOG NEVER STORES CONTENT. Every action is declared below with the exact fields it may carry, and
 * EACH FIELD DECLARES ITS OWN DOMAIN: a closed set of strings (`{ enum }`) or a bounded number (`{ int }` / `{ number }`).
 * `writeAudit` THROWS on a field outside the declaration, on a value outside that field's domain, and on an action it
 * does not know. There is deliberately NO generic "short token" domain: a token SHAPE admits `Bobby`, a domain name
 * and a phone number, so a shape is not a control. A field whose domain cannot be declared cannot be audited; to audit
 * a free-form value is to build a permanent PII store. Rejected in preference to alternatives:
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

/** A closed set of strings, or a number in [min, max]. The ONLY domains a field may declare. */
export type Domain = { readonly enum: readonly string[] } | { readonly int: readonly [number, number] } | { readonly number: readonly [number, number] };
type Spec = { table: TableNames; fields: Readonly<Record<string, Domain>> };

/** The literal members of a `v.union(v.literal(..), ..)`, so an enum domain is the SAME set the schema enforces and cannot drift from it. */
function literals(validator: { members: readonly unknown[] }): readonly string[] {
  return validator.members.map((m) => {
    const lit = m as { kind?: unknown; value?: unknown };
    if (lit.kind !== "literal" || typeof lit.value !== "string") throw new Error("audit enum domains are built from string literals only");
    return lit.value;
  });
}

const VERSION: Domain = { int: [1, 100_000] };
/** Counts of rows one erasure touched. Bounded well below any phone number or id, so a count cannot carry one. */
const COUNT: Domain = { int: [0, 1_000_000] };

/**
 * Every audited action and the only fields it may carry, each with its domain. Adding a field is a privacy decision:
 * it must never hold content about a person, and its domain must be small enough that it provably cannot.
 */
export const AUDIT_ACTIONS = {
  "icp.created": { table: "icpDefinitions", fields: { version: VERSION } },
  "scoring_model.created": { table: "scoringModels", fields: { version: VERSION } },
  "source.registered": { table: "sources", fields: { kind: { enum: literals(sourceKind) }, trustWeight: { number: [0, 1] }, lawfulBasis: { enum: literals(lawfulBasis) } } },
  "run.started": { table: "discoveryRuns", fields: { creditBudget: { number: [0, MAX_CREDIT_BUDGET] } } },
  "lead.inventory_state_set": { table: "leads", fields: { inventoryState: { enum: INVENTORY_STATES } } },
  "lead.disposition_set": { table: "leads", fields: { disposition: { enum: DISPOSITIONS } } },
  "erasure.requested": { table: "erasures", fields: { legalBasis: { enum: LEGAL_BASES }, reasonCode: { enum: ERASURE_REASONS } } },
  "erasure.completed": {
    table: "erasures",
    fields: { claimsRedacted: COUNT, contactKeysDeleted: COUNT, candidatesRedacted: COUNT, signalsRedacted: COUNT, leadsRedacted: COUNT, suppressionsAdded: COUNT },
  },
  "suppression.added": { table: "suppressions", fields: { kind: { enum: ["email", "domain", "phone", "profile"] }, reasonCode: { enum: literals(suppressionReason) } } },
  "member.role_set": { table: "memberships", fields: { role: { enum: ROLES } } },
} as const satisfies Record<string, Spec>;
export type AuditAction = keyof typeof AUDIT_ACTIONS;

export type AuditFields = Readonly<Record<string, string | number | boolean | null>>;

/** True when `value` is inside `domain`. A domain that is not one of the three shapes admits NOTHING (fails closed). */
function inDomain(domain: unknown, value: unknown): boolean {
  const d = domain as { enum?: unknown; int?: unknown; number?: unknown } | null | undefined;
  if (d && Array.isArray(d.enum)) return typeof value === "string" && d.enum.includes(value);
  const range = d && (Array.isArray(d.int) ? d.int : Array.isArray(d.number) ? d.number : undefined);
  if (!range || range.length !== 2 || !(Number.isFinite(range[0]) && Number.isFinite(range[1]))) return false;
  // Negated conjunction: NaN and Infinity fail every comparison, so they fail closed.
  if (!(typeof value === "number" && Number.isFinite(value) && value >= range[0] && value <= range[1])) return false;
  return Array.isArray(d.int) ? Number.isInteger(value) : true;
}

/** Validates `fields` against per-field domains. Exported so a test can prove a field with no or a loose domain is refused. */
export function checkFields(
  action: string,
  side: "before" | "after",
  domains: Readonly<Record<string, unknown>>,
  fields: AuditFields | undefined,
): Record<string, string | number> | undefined {
  if (fields === undefined) return undefined;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) throw new Error(`audit ${side} must be a flat record`);
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!Object.hasOwn(domains, key)) throw new Error(`audit field "${key}" is not allowed for ${action}`);
    if (!inDomain(domains[key], value)) throw new Error(`audit field "${key}" is outside its declared domain`);
    out[key] = value as string | number;
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
  const before = checkFields(args.action, "before", spec.fields, args.before);
  const after = checkFields(args.action, "after", spec.fields, args.after);
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

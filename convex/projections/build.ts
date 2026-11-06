import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { resolveOrg } from "../_shared/org";
import { loadClaimsForField, loadClaimsForSubject } from "../claims/queries";
import type { Claim, SubjectType } from "../claims/schema";
import { resolveField, type SourceTrust } from "./resolve";
import type { ProjectedField } from "./schema";

type SubjectArgs = { subjectType: SubjectType; subjectId: string };

const DISPLAY_FIELDS: Record<SubjectType, readonly string[]> = {
  account: ["name", "domain"],
  contact: ["name", "email", "title"],
};

function toProjectedField(claim: Claim): ProjectedField {
  return {
    field: claim.field,
    value: claim.value,
    claimId: claim._id,
    method: claim.method,
    confidence: claim.confidence,
    observedAt: claim.observedAt,
  };
}

/** Pure: display fields are copied from resolved values, string-valued only. */
function displayFor(subjectType: SubjectType, fields: ProjectedField[]): Record<string, string> {
  const display: Record<string, string> = {};
  for (const name of DISPLAY_FIELDS[subjectType]) {
    const hit = fields.find((f) => f.field === name);
    if (hit && typeof hit.value === "string") display[name] = hit.value;
  }
  return display;
}

/** Fail closed: the subject id must be a real id of the table implied by subjectType, in this org. */
async function loadSubject(ctx: MutationCtx, orgId: Id<"orgs">, args: SubjectArgs) {
  if (args.subjectType === "account") {
    const id = ctx.db.normalizeId("accounts", args.subjectId);
    const row = id && (await ctx.db.get(id));
    if (!id || !row || row.orgId !== orgId) throw new Error("subject not found");
    return { table: "accounts" as const, id, fields: row.fields };
  }
  const id = ctx.db.normalizeId("contacts", args.subjectId);
  const row = id && (await ctx.db.get(id));
  if (!id || !row || row.orgId !== orgId) throw new Error("subject not found");
  return { table: "contacts" as const, id, fields: row.fields };
}

async function store(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
  subject: Awaited<ReturnType<typeof loadSubject>>,
  type: SubjectType,
  fields: ProjectedField[],
) {
  const sorted = [...fields].sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  const display = displayFor(type, sorted);
  // replace, not patch: a rebuild must drop anything that no longer derives from claims.
  if (subject.table === "accounts") {
    await ctx.db.replace("accounts", subject.id, { orgId, fields: sorted, display });
  } else {
    await ctx.db.replace("contacts", subject.id, { orgId, fields: sorted, display });
  }
}

/**
 * Trust map for exactly the sources the claims cite. A source that is missing or
 * belongs to another org is left out, which `resolveField` treats as trust 0.
 */
async function trustFor(ctx: MutationCtx, orgId: Id<"orgs">, claims: Claim[]): Promise<SourceTrust> {
  const trust: SourceTrust = new Map();
  for (const sourceId of new Set(claims.map((c) => c.sourceId))) {
    const source = await ctx.db.get(sourceId);
    if (source && source.orgId === orgId) trust.set(sourceId, { trustWeight: source.trustWeight });
  }
  return trust;
}

/**
 * Incremental maintenance: re-resolve only the field the claim touches, from the
 * full ledger for that field (not from the one claim), so the result does not
 * depend on the order claims arrive in.
 */
export async function applyClaimToProjection(
  ctx: MutationCtx,
  args: SubjectArgs & { claimId: Id<"claims"> },
): Promise<void> {
  const { orgId } = await resolveOrg(ctx);
  const subject = await loadSubject(ctx, orgId, args);
  const claim = await ctx.db.get(args.claimId);
  if (
    !claim ||
    claim.orgId !== orgId ||
    claim.subjectType !== args.subjectType ||
    claim.subjectId !== subject.id
  ) {
    throw new Error("claim not found for subject");
  }
  // Deliberately not caught: claimsForField throws past MAX_CLAIMS rather than truncate.
  const claims: Claim[] = await loadClaimsForField(ctx, orgId, {
    subjectType: args.subjectType,
    subjectId: subject.id,
    field: claim.field,
  });
  const resolved = resolveField(claims, await trustFor(ctx, orgId, claims));
  const others = subject.fields.filter((f) => f.field !== claim.field);
  await store(ctx, orgId, subject, args.subjectType, resolved ? [...others, toProjectedField(resolved.winner)] : others);
}

/** Full recompute: every field re-resolved from the whole ledger for the subject. */
export async function rebuildProjection(ctx: MutationCtx, args: SubjectArgs): Promise<void> {
  const { orgId } = await resolveOrg(ctx);
  const subject = await loadSubject(ctx, orgId, args);
  // Deliberately not caught: claimsForSubject throws past MAX_CLAIMS rather than truncate.
  const claims: Claim[] = await loadClaimsForSubject(ctx, orgId, {
    subjectType: args.subjectType,
    subjectId: subject.id,
  });
  const trust = await trustFor(ctx, orgId, claims);
  const byField = new Map<string, Claim[]>();
  for (const c of claims) {
    const group = byField.get(c.field);
    if (group) group.push(c);
    else byField.set(c.field, [c]);
  }
  const fields: ProjectedField[] = [];
  for (const group of byField.values()) {
    const resolved = resolveField(group, trust);
    if (resolved) fields.push(toProjectedField(resolved.winner));
  }
  await store(ctx, orgId, subject, args.subjectType, fields);
}


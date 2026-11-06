import type { Id } from "../_generated/dataModel";
import { env } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { resolveOrg } from "../_shared/org";
import { emailDomain } from "../_shared/normalize";
import type { NormalizedCandidate } from "../sources/contract";
import { inferKind, normalizeIdentifier, tryNormalizeIdentifier, type IdentifierKind } from "./normalize";
import type { SuppressionReason } from "./schema";

/** Shorter than this is not a secret. 16 characters of a random token is already beyond brute force; the floor only rejects "x" and "test". */
export const MIN_SALT_LENGTH = 16;

/**
 * The deployment secret that keys the suppression hashes (Convex env var `SUPPRESSION_SALT`). FAILS CLOSED: unset,
 * blank or short is an error, never an empty salt. An empty salt would silently make the list an unkeyed hash of an
 * email, which anyone can precompute, and would make every deployment's hashes identical. Set it once and never
 * rotate it: every stored hash is under it (rotation is detected, see `assertSaltMatchesLedger`, not repaired).
 */
export function getSuppressionSalt(): string {
  const salt = (env as Record<string, string | undefined>).SUPPRESSION_SALT;
  if (typeof salt !== "string" || salt.trim().length < MIN_SALT_LENGTH) {
    throw new Error(`suppression salt is not configured: set the SUPPRESSION_SALT environment variable (at least ${MIN_SALT_LENGTH} characters)`);
  }
  return salt;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(key: string, message: string): Promise<string> {
  if (typeof key !== "string" || key.trim().length < MIN_SALT_LENGTH) throw new Error("suppression salt is missing or too short");
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
}

/**
 * HMAC-SHA-256 of `kind:normalized` under `salt`. The value is normalized HERE, so no caller can hash a raw spelling
 * and miss. The kind is part of the message so an email and a domain can never collide. Async: WebCrypto is the only
 * crypto the default Convex runtime has. Refuses a missing or short salt itself, not only via `getSuppressionSalt`.
 */
export async function suppressionHash(value: string, salt: string, kind?: IdentifierKind): Promise<string> {
  const normalized = normalizeIdentifier(value, kind);
  const k = kind ?? inferKind(value);
  return await hmac(salt, `${k}:${normalized}`);
}

/** Fingerprint of the key, stored on every row. Not the key, and not usable to recover it. */
async function saltFingerprint(salt: string): Promise<string> {
  return (await hmac(salt, "suppression-salt-fingerprint")).slice(0, 16);
}

/**
 * The list was written under a different key than the one now configured, so every lookup would miss and the list
 * would silently stop working. Detect it (one row, exact read) and refuse. Cheap, and it is the only defence against
 * a rotated or mismatched secret turning "suppressed" into "not suppressed".
 */
async function assertSaltMatchesLedger(ctx: Pick<QueryCtx, "db">, orgId: Id<"orgs">, saltId: string): Promise<void> {
  const any = await ctx.db.query("suppressions").withIndex("by_org_and_hash", (q) => q.eq("orgId", orgId)).first();
  if (any && any.saltId !== saltId) {
    throw new Error("the suppression salt differs from the one the list was built under; refusing to answer (every lookup would miss)");
  }
}

type Ident = { identifier: string; kind?: IdentifierKind };

/** Adds an identifier to the org's list. Idempotent: an identifier already on it returns the existing row. A plain helper; no role check (Task 14). */
export async function addSuppression(
  ctx: MutationCtx,
  args: Ident & { reason: SuppressionReason },
): Promise<{ id: Id<"suppressions">; created: boolean }> {
  const { orgId } = await resolveOrg(ctx);
  const salt = getSuppressionSalt();
  const kind = args.kind ?? inferKind(args.identifier);
  const hash = await suppressionHash(args.identifier, salt, kind);
  const saltId = await saltFingerprint(salt);
  await assertSaltMatchesLedger(ctx, orgId, saltId);
  const existing = await ctx.db.query("suppressions").withIndex("by_org_and_hash", (q) => q.eq("orgId", orgId).eq("hash", hash)).first();
  if (existing) return { id: existing._id, created: false };
  const id = await ctx.db.insert("suppressions", { orgId, hash, kind, reason: args.reason, saltId, createdAt: Date.now() });
  return { id, created: true };
}

/** An identifier the caller already normalized and typed. */
export type KindedIdentifier = { kind: IdentifierKind; value: string };

/**
 * Whether ANY of these identifiers is on the org's list. Fail closed: a missing or changed salt, or an identifier
 * that cannot be normalized, THROWS; nothing here ever answers "not suppressed" because it could not tell. An exact
 * indexed read per identifier, so there is no bound to truncate at.
 *
 * Two limits of that, stated plainly. The salt is verified against the ledger by sampling ONE row (see
 * `assertSaltMatchesLedger`), and that check runs even for an EMPTY list. An empty list answers `false` (vacuously:
 * there is nothing to match), having still required a configured salt; it does not mean "checked and clear". A caller
 * that expects identifiers must supply them, since a lead or candidate that yields none is not vouched for by this answer.
 */
export async function anySuppressed(ctx: Pick<QueryCtx, "db" | "auth"> & Parameters<typeof resolveOrg>[0], identifiers: KindedIdentifier[]): Promise<boolean> {
  const { orgId } = await resolveOrg(ctx);
  const salt = getSuppressionSalt();
  const saltId = await saltFingerprint(salt);
  await assertSaltMatchesLedger(ctx, orgId, saltId);
  for (const i of identifiers) {
    const hash = await suppressionHash(i.value, salt, i.kind);
    const hit = await ctx.db.query("suppressions").withIndex("by_org_and_hash", (q) => q.eq("orgId", orgId).eq("hash", hash)).first();
    if (hit) return true;
  }
  return false;
}

/** `isSuppressed(ctx, { identifier })`: the plan's public shape. See `anySuppressed` for the failure semantics. */
export async function isSuppressed(ctx: Pick<QueryCtx, "db" | "auth"> & Parameters<typeof resolveOrg>[0], args: Ident): Promise<boolean> {
  const kind = args.kind ?? inferKind(args.identifier);
  return await anySuppressed(ctx, [{ kind, value: args.identifier }]);
}

const push = (out: KindedIdentifier[], kind: IdentifierKind, raw: unknown) => {
  const value = tryNormalizeIdentifier(raw, kind);
  if (value !== null && !out.some((o) => o.kind === kind && o.value === value)) out.push({ kind, value });
};

/** The identifiers a candidate carries: its person's email, that email's domain, phone and profile, and its company's domain. */
export function candidateIdentifiers(c: NormalizedCandidate): KindedIdentifier[] {
  const out: KindedIdentifier[] = [];
  const p = c.person;
  if (p) {
    push(out, "email", p.email);
    if (p.email) push(out, "domain", emailDomain(p.email));
    push(out, "phone", p.phone);
    push(out, "profile", p.profileUrl);
  }
  push(out, "domain", c.company?.domain ?? c.company?.website);
  return out;
}

export async function candidateSuppressed(ctx: Parameters<typeof anySuppressed>[0], c: NormalizedCandidate): Promise<boolean> {
  return await anySuppressed(ctx, candidateIdentifiers(c));
}

type ProjectionLike = { fields: Array<{ field: string; value?: unknown }>; display: { email?: string; domain?: string } };

/**
 * The identifiers behind a lead: what a customer would use to reach the person or the company. Read from the
 * projection fields (every spelling the winning claim carries) and the display values.
 */
export function leadIdentifiers(account: ProjectionLike, contact: ProjectionLike): KindedIdentifier[] {
  const out: KindedIdentifier[] = [];
  const field = (p: ProjectionLike, name: string) => p.fields.find((f) => f.field === name)?.value;
  for (const email of [field(contact, "email"), contact.display.email]) {
    push(out, "email", email);
    if (typeof email === "string") push(out, "domain", emailDomain(email));
  }
  push(out, "phone", field(contact, "phone"));
  push(out, "profile", field(contact, "profileUrl"));
  push(out, "domain", field(account, "domain"));
  push(out, "domain", account.display.domain);
  return out;
}


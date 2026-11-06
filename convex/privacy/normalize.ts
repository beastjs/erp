import { normalizeDomain, normalizeEmail, normalizePhone, normalizeProfileUrl } from "../_shared/normalize";

/**
 * What an identifier IS decides how it is normalized and, later, how it is hashed. Four kinds because those are
 * the four things ingest can recognise a person or a company by (see contactKeys and planClaims).
 */
export const IDENTIFIER_KINDS = ["email", "domain", "phone", "profile"] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/** Guess the kind from the shape. Only used when the caller does not say; an ingest path always says. */
export function inferKind(value: string): IdentifierKind {
  const t = value.normalize("NFKC").trim();
  if (t.includes("@")) return "email";
  if (/^[+\d\s().-]+$/.test(t)) return "phone";
  // A path makes it a profile URL. "https://acme.com/pricing" is therefore a PROFILE by inference: say "domain" to mean the host.
  if (t.includes("/") && normalizeProfileUrl(t) !== null) return "profile";
  return "domain";
}

/**
 * Pure. The canonical spelling of an identifier: trim, lowercase, NFKC, and for an address the `+tag` suffix
 * stripped. It DELEGATES to the normalizers ingest uses (`_shared/normalize.ts`) rather than copying them: a
 * second copy that drifted would let an erased contact come back under a variant spelling. Throws when nothing
 * usable remains, so an empty or garbage value can never be hashed (every such value would collide on one hash).
 *
 * NFKC folds compatibility forms (full-width letters, the Kelvin sign, ligatures). It does NOT fold
 * cross-script homoglyphs (a Cyrillic "а" for a Latin "a"): those are different characters, and treating them as
 * equal is a policy decision, not a normalization.
 */
export function normalizeIdentifier(value: string, kind: IdentifierKind = inferKind(value)): string {
  const out =
    kind === "email" ? normalizeEmail(value)
    : kind === "domain" ? normalizeDomain(value)
    : kind === "phone" ? normalizePhone(value)
    : normalizeProfileUrl(value);
  if (out === null) throw new Error(`not a usable ${kind} identifier`);
  return out;
}

/** Like `normalizeIdentifier`, but null instead of a throw, for harvesting identifiers from data that may hold junk. */
export function tryNormalizeIdentifier(value: unknown, kind: IdentifierKind): string | null {
  if (typeof value !== "string") return null;
  try {
    return normalizeIdentifier(value, kind);
  } catch {
    return null;
  }
}

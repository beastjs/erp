/**
 * Identifier normalization shared by entity resolution and (later) the privacy
 * suppression list. Keep ONE copy: a divergent duplicate would let an erased
 * contact re-enter under a variant spelling.
 */

function base(raw: string): string {
  return raw.normalize("NFKC").trim().toLowerCase();
}

/** "  HTTPS://www.Acme.com:443/about?x=1 " -> "acme.com". Returns null when nothing usable remains. */
export function normalizeDomain(raw: string): string | null {
  let s = base(raw);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  s = s.replace(/^[^/@]*@/, ""); // userinfo
  s = s.split(/[/?#]/)[0] ?? "";
  s = s.replace(/:\d+$/, ""); // port
  s = s.replace(/\.+$/, ""); // trailing dot
  s = s.replace(/^www\./, "");
  return s.length > 0 && s.includes(".") ? s : null;
}

/** Lowercased, NFKC, with any `+tag` suffix stripped from the local part. Null if not an address. */
export function normalizeEmail(raw: string): string | null {
  const s = base(raw);
  const at = s.lastIndexOf("@");
  if (at <= 0) return null;
  const local = s.slice(0, at).split("+")[0] ?? "";
  const domain = normalizeDomain(s.slice(at + 1));
  if (!local || !domain) return null;
  return `${local}@${domain}`;
}

export function emailDomain(raw: string): string | null {
  const email = normalizeEmail(raw);
  return email ? email.slice(email.lastIndexOf("@") + 1) : null;
}

const LEGAL_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "gmbh", "plc", "pty", "sa", "ag",
]);

/** Case/punctuation/legal-suffix-insensitive company name key. Null when empty. */
export function normalizeCompanyName(raw: string): string | null {
  const words = base(raw)
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1]!)) words.pop();
  const key = words.join(" ");
  return key.length > 0 ? key : null;
}

/** Person-name key: NFKC, lowercase, punctuation folded to spaces. Unlike company names, no suffix stripping. */
export function normalizePersonName(raw: string): string | null {
  const key = base(raw).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return key.length > 0 ? key : null;
}

/** "https://www.LinkedIn.com/in/Jane/?x=1" -> "linkedin.com/in/jane". Null when no host and path remain. */
export function normalizeProfileUrl(raw: string): string | null {
  let s = base(raw).replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "");
  s = s.split(/[?#]/)[0] ?? "";
  s = s.replace(/\/+$/, "");
  return s.includes(".") ? s : null;
}

/** Digits only (leading "+" dropped); null when fewer than 5 digits remain. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.normalize("NFKC").replace(/\D+/g, "");
  return digits.length >= 5 ? digits : null;
}

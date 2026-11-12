import { cyrb128 } from "../pipeline/hash";
import type { VerificationResult } from "../scoring/score";
import { DISPOSABLE_DOMAINS, ROLE_LOCAL_PARTS } from "./lists";
import type { VerificationReason } from "./schema";

/*
 * STRUCTURE ONLY: no network, no paid provider (spec 6 lists none), so nothing here can say an address DELIVERS, only
 * that it is well-formed and not obviously throwaway. Pure: no ctx, no clock, never throws.
 *
 * NO REGULAR EXPRESSIONS, deliberately. These functions run over strings an attacker chose (an uploaded CSV cell, a
 * crawled page), and this plan has already shipped seven quadratic scanners in a parser (a 1,235-byte upload took
 * 61.7s). Each matcher below is ONE left-to-right pass that reads each character once and never rescans, so its cost
 * is proportional to the input by construction. The caps (`MAX_*`) are an ADDITIONAL bound, not the guarantee: a cap
 * can hide a quadratic scanner from a test that only feeds capped input, so `scanEmail`/`scanPhone` are exported and
 * pinned UNCAPPED, by counting the characters they read (a `Probe`), not by timing them.
 */

/** Counts the characters a scanner read. Passed only by tests; production calls leave it out. */
export type Probe = { steps: number };

/** What a structural check concludes. `checkedAt` is NOT here: a pure function has no clock, and the recorder stamps it. */
export type StructuralCheck = Omit<VerificationResult, "checkedAt"> & { reason: VerificationReason };

const MAX_EMAIL = 254;
const MAX_LOCAL = 64;
const MAX_DOMAIN = 253;
const MAX_LABEL = 63;
const MAX_PHONE_TEXT = 40;
const MAX_NATIONAL_DIGITS = 15;
const MAX_EXTENSION_DIGITS = 6;

const AT = 64;
const DOT = 46;
const HYPHEN = 45;
const PLUS = 43;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
/** RFC 5322 `atext` (the unquoted local part) other than letters and digits; the dot is a separator, handled apart. */
const ATEXT_PUNCT = new Set<number>([..."!#$%&'*+/=?^_`{|}~-"].map((ch) => ch.charCodeAt(0)));
const isAtext = (c: number) => isDigit(c) || isAlpha(c) || ATEXT_PUNCT.has(c);

export type EmailScan =
  | { ok: true; atIndex: number; plusIndex: number; dots: [number, number, number]; nonAscii: boolean }
  | { ok: false; reason: "syntax" | "domain_shape" };

const bad = (reason: "syntax" | "domain_shape"): EmailScan => ({ ok: false, reason });

/**
 * One pass over `s`, which must already be trimmed. Accepts `local@domain` where the local part is a dot-atom
 * (no leading, trailing or doubled dot, at most 64 chars) and the domain is two or more dot-separated labels of
 * letters, digits and inner hyphens (each at most 63 chars), whose last label is at least two characters and not all
 * digits (so an IP literal is not a domain). A character above U+007F is not judged: it is remembered in
 * `nonAscii` and the rest is still checked, because a well-formed internationalised address is not a bad one.
 * `dots` is the positions of the last three dots (-1 when absent), so the caller can take a suffix without a rescan.
 */
export function scanEmail(s: string, probe?: Probe): EmailScan {
  const n = s.length;
  let at = -1;
  let plus = -1;
  let nonAscii = false;
  let prev = -1;
  let labelLen = 0;
  let lastWasHyphen = false;
  let labelAllDigits = true;
  let dotA = -1;
  let dotB = -1;
  let dotC = -1;
  let dots = 0;
  for (let i = 0; i < n; i++) {
    if (probe) probe.steps++;
    const c = s.charCodeAt(i);
    if (at === -1) {
      if (c === AT) {
        // `i` is the local part's length here.
        if (i === 0 || prev === DOT || i > MAX_LOCAL) return bad("syntax");
        at = i;
      } else {
        if (i >= MAX_LOCAL) return bad("syntax"); // a 65th local character
        if (c === DOT) {
          if (i === 0 || prev === DOT) return bad("syntax");
        } else if (c > 127) {
          nonAscii = true;
        } else if (!isAtext(c)) {
          return bad("syntax");
        } else if (c === PLUS && plus === -1) {
          plus = i;
        }
      }
    } else if (c === AT) {
      return bad("syntax");
    } else if (c === DOT) {
      if (labelLen === 0 || lastWasHyphen) return bad("domain_shape");
      dotC = dotB;
      dotB = dotA;
      dotA = i;
      dots++;
      labelLen = 0;
      labelAllDigits = true;
    } else {
      if (c > 127) {
        nonAscii = true;
        labelAllDigits = false;
        lastWasHyphen = false;
      } else if (isDigit(c)) {
        lastWasHyphen = false;
      } else if (isAlpha(c)) {
        labelAllDigits = false;
        lastWasHyphen = false;
      } else if (c === HYPHEN) {
        if (labelLen === 0) return bad("domain_shape");
        labelAllDigits = false;
        lastWasHyphen = true;
      } else {
        return bad("domain_shape");
      }
      labelLen++;
      if (labelLen > MAX_LABEL || i - at > MAX_DOMAIN) return bad("domain_shape");
    }
    prev = c;
  }
  if (at === -1) return bad("syntax");
  // An empty domain, a trailing dot or hyphen, no dot at all, or a last label that is one character or all digits.
  if (labelLen < 2 || lastWasHyphen || dots < 1 || labelAllDigits) return bad("domain_shape");
  return { ok: true, atIndex: at, plusIndex: plus, dots: [dotA, dotB, dotC], nonAscii };
}

/** Bump by hand when the matching CODE changes (the lists fingerprint themselves). */
export const STRUCTURAL_RULES_REVISION = 2;

export type LogicLists = { revision: number; disposable: readonly string[]; roles: readonly string[] };
const currentLists = (): LogicLists => ({ revision: STRUCTURAL_RULES_REVISION, disposable: DISPOSABLE_DOMAINS, roles: ROLE_LOCAL_PARTS });

/**
 * A fingerprint of everything that decides a structural verdict: the code's revision and both lists, order-independent
 * and length-delimited (no two different list sets serialise alike). `hash` goes into the verify stage's input hash,
 * so a changed list is a changed input and a replay RE-RUNS instead of skipping on an unchanged hash and keeping a
 * stale verdict. `short` (32 bits) is stored on each verification row as provenance; the stage hash uses the full one.
 * Computed from the lists' CURRENT contents on every call, never cached at load.
 */
export function structuralLogic(lists: LogicLists = currentLists()): { hash: string; short: number } {
  const part = (label: string, xs: readonly string[]) => {
    const sorted = [...new Set(xs)].sort();
    return `${label}:${sorted.length}:${sorted.map((x) => `${x.length}=${x}`).join("|")}`;
  };
  const hash = cyrb128([`rev:${lists.revision}`, part("disposable", lists.disposable), part("roles", lists.roles)].join("\n"));
  return { hash, short: parseInt(hash.slice(0, 8), 16) };
}

const check = (kind: StructuralCheck["kind"], outcome: StructuralCheck["outcome"], reason: VerificationReason): StructuralCheck => ({ kind, outcome, reason });

/** Pure; never throws. `fail`: malformed or throwaway. `unknown`: nothing to judge, a shared mailbox, or a form we cannot assess. `pass`: well-formed. */
export function verifyEmailStructure(email: string): StructuralCheck {
  if (typeof email !== "string") return check("email", "unknown", "not_text");
  const s = email.trim();
  if (s.length === 0) return check("email", "unknown", "empty");
  if (s.length > MAX_EMAIL) return check("email", "fail", "too_long");
  const scan = scanEmail(s);
  if (!scan.ok) return check("email", "fail", scan.reason);
  const domain = s.slice(scan.atIndex + 1).toLowerCase();
  // The domain, then its last two and three labels, so `x.mailinator.com` matches the listed `mailinator.com`
  // without trying every suffix (which would rescan the domain once per label).
  const [, dotB, dotC] = scan.dots;
  const suffix = (dot: number) => (dot === -1 ? null : domain.slice(dot - scan.atIndex));
  const disposable = new Set(DISPOSABLE_DOMAINS);
  if ([domain, suffix(dotB), suffix(dotC)].some((d) => d !== null && disposable.has(d))) return check("email", "fail", "disposable");
  if (scan.nonAscii) return check("email", "unknown", "non_ascii");
  const local = s.slice(0, scan.plusIndex === -1 ? scan.atIndex : scan.plusIndex).toLowerCase();
  if (new Set(ROLE_LOCAL_PARTS).has(local)) return check("email", "unknown", "role");
  return check("email", "pass", "ok");
}

export type PhoneScan =
  | { ok: true; plus: boolean; digits: number; first: number[] }
  | { ok: false; reason: "syntax" | "bad_length" | "ambiguous_length" };

/**
 * One pass over a trimmed phone string: an optional leading `+`, then digits with the usual separators (space, `-`,
 * `.`, parentheses), then optionally an extension (`x` or `ext`, then 1 to 6 digits). `first` keeps at most the first 16 digits
 * however long the input; `digits` is the count excluding the extension.
 */
export function scanPhone(s: string, probe?: Probe): PhoneScan {
  const n = s.length;
  let plus = false;
  let digits = 0;
  const first: number[] = [];
  let ext = -1; // -1: not in an extension; otherwise the extension digits seen
  for (let i = 0; i < n; i++) {
    if (probe) probe.steps++;
    const c = s.charCodeAt(i);
    if (ext >= 0) {
      if (isDigit(c)) {
        if (++ext > MAX_EXTENSION_DIGITS) return { ok: false, reason: "syntax" };
      } else if (!(ext === 0 && (c === 32 || c === DOT || c === 58))) {
        return { ok: false, reason: "syntax" }; // only a space, `.` or `:` may sit between the marker and the first digit
      }
    } else if (isDigit(c)) {
      digits++;
      if (first.length < 16) first.push(c - 48);
    } else if (c === PLUS) {
      if (i !== 0) return { ok: false, reason: "syntax" };
      plus = true;
    } else if (c === 32 || c === HYPHEN || c === DOT || c === 40 || c === 41) {
      // a separator
    } else if ((c === 120 || c === 88) && digits > 0) {
      ext = 0; // x
    } else if ((c === 101 || c === 69) && digits > 0 && (s.charCodeAt(i + 1) | 32) === 120 && (s.charCodeAt(i + 2) | 32) === 116) {
      ext = 0; // ext: a constant two-character look-ahead, then the scan moves past it
      i += 2;
      if (probe) probe.steps += 2;
    } else {
      return { ok: false, reason: "syntax" };
    }
  }
  if (ext === 0 || digits === 0) return { ok: false, reason: "syntax" }; // a marker with nothing after it, or no digit at all
  if (digits > MAX_NATIONAL_DIGITS) {
    // A stored phone is bare digits: `normalizePhone` strips the `+`, the separators AND the extension marker (and
    // must keep doing so: suppression hashes are HMACs over its output). So with no `+` and no marker, up to
    // 15 + 6 digits cannot be told apart from a valid number with its extension merged in. Not judgeable.
    const mergedExtensionPossible = !plus && ext < 0 && digits <= MAX_NATIONAL_DIGITS + MAX_EXTENSION_DIGITS;
    return { ok: false, reason: mergedExtensionPossible ? "ambiguous_length" : "bad_length" };
  }
  return { ok: true, plus, digits, first };
}

/** Regions whose national numbers are 10 digits (11 with a leading trunk `1`): the North American Numbering Plan. */
const NANP = new Set(["US", "CA"]);

/**
 * Pure; never throws. Empty or whitespace is `unknown` (nothing to judge). International (`+`): 8 to 15 digits, no
 * leading 0. National: 7 to 15 digits, or for a NANP `region` exactly 10 (or 11 starting with 1). Other regions are
 * not judged beyond that: this is a shape check, not a numbering-plan lookup.
 */
export function verifyPhoneStructure(phone: string, region?: string): StructuralCheck {
  if (typeof phone !== "string") return check("phone", "unknown", "not_text");
  const s = phone.trim();
  if (s.length === 0) return check("phone", "unknown", "empty");
  if (s.length > MAX_PHONE_TEXT) return check("phone", "fail", "too_long");
  const scan = scanPhone(s);
  // `unknown`, not `fail`: a false failure halves confidence (failedVerificationFactor) on a number that may be good.
  if (!scan.ok) return check("phone", scan.reason === "ambiguous_length" ? "unknown" : "fail", scan.reason);
  if (scan.plus) {
    if (scan.first[0] === 0) return check("phone", "fail", "syntax");
    return scan.digits >= 8 ? check("phone", "pass", "ok") : check("phone", "fail", "bad_length");
  }
  const r = typeof region === "string" ? region.trim().toUpperCase() : "";
  if (NANP.has(r)) {
    const ok = scan.digits === 10 || (scan.digits === 11 && scan.first[0] === 1);
    return check("phone", ok ? "pass" : "fail", ok ? "ok" : "bad_length");
  }
  return scan.digits >= 7 ? check("phone", "pass", "ok") : check("phone", "fail", "bad_length");
}

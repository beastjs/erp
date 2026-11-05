import { normalizeCompanyName, normalizeDomain, normalizeEmail } from "../_shared/normalize";

/**
 * The normalized candidate contract. Every source (CSV, manual entry, CRM export and the
 * Firecrawl Collector Worker) converges here; nothing writes accounts or contacts directly.
 *
 * This is a CROSS-DEPLOY interface: the Collector is deployed separately and validates against
 * it. Bump the version on any change and deploy both sides in order.
 *   - MAJOR: a field is removed/renamed or becomes stricter (breaks existing producers).
 *   - MINOR: a new optional field (older producers keep working, newer ones need Core first).
 *   - PATCH: no shape change.
 */
export const CANDIDATE_CONTRACT_VERSION = "1.0.0";

export type NormalizedCandidate = {
  person?: {
    fullName?: string;
    firstName?: string;
    lastName?: string;
    jobTitle?: string;
    department?: string;
    seniority?: string;
    email?: string;
    phone?: string;
    profileUrl?: string;
  };
  company?: {
    name?: string;
    website?: string;
    domain?: string;
    industry?: string;
    size?: string;
    revenueRange?: string;
    location?: string;
    country?: string;
    techStack?: string[];
    description?: string;
  };
  acquisition: {
    /** Epoch ms at which the source observed the lead. */
    acquiredAt: number;
    campaign?: string;
    channel?: string;
    queryContext?: string;
    landingPage?: string;
    referral?: string;
  };
};

const PERSON_STRING_FIELDS = [
  "fullName", "firstName", "lastName", "jobTitle", "department", "seniority", "email", "phone", "profileUrl",
] as const;
const COMPANY_STRING_FIELDS = [
  "name", "website", "domain", "industry", "size", "revenueRange", "location", "country", "description",
] as const;
const ACQUISITION_STRING_FIELDS = ["campaign", "channel", "queryContext", "landingPage", "referral"] as const;

const MAX_STRING = 2048;
const MAX_TECH_STACK = 100;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

/** Checks one block: only known keys, strings non-empty/bounded. Returns the cleaned block or null. */
function checkBlock(
  path: string,
  raw: unknown,
  strings: readonly string[],
  extra: readonly string[],
  errors: string[],
): Obj | null {
  if (!isObj(raw)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  const known = new Set<string>([...strings, ...extra]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) errors.push(`${path}.${key} is not a known field`);
  }
  for (const key of strings) {
    const val = raw[key];
    if (val === undefined) continue;
    if (typeof val !== "string" || val.trim().length === 0 || val.length > MAX_STRING) {
      errors.push(`${path}.${key} must be a non-empty string of at most ${MAX_STRING} characters`);
    }
  }
  return raw;
}

/**
 * Validates untrusted input against the contract. Unknown fields are REJECTED, not dropped: a
 * contract that silently discards what it does not recognize lets producer and consumer drift apart.
 * A candidate must carry `company.domain` or `person.email` — the identifiers dedupe depends on.
 */
export function validateCandidate(
  input: unknown,
): { ok: true; value: NormalizedCandidate } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ["candidate must be an object"] };

  for (const key of Object.keys(input)) {
    if (key !== "person" && key !== "company" && key !== "acquisition") {
      errors.push(`${key} is not a known field`);
    }
  }

  const person = input.person === undefined ? null : checkBlock("person", input.person, PERSON_STRING_FIELDS, [], errors);
  const company =
    input.company === undefined
      ? null
      : checkBlock("company", input.company, COMPANY_STRING_FIELDS, ["techStack"], errors);

  if (company && company.techStack !== undefined) {
    const t = company.techStack;
    if (
      !Array.isArray(t) ||
      t.length > MAX_TECH_STACK ||
      t.some((s) => typeof s !== "string" || s.trim().length === 0 || s.length > MAX_STRING)
    ) {
      errors.push(`company.techStack must be an array of at most ${MAX_TECH_STACK} non-empty strings`);
    }
  }

  if (input.acquisition === undefined) {
    errors.push("acquisition is required");
  } else {
    const acq = checkBlock("acquisition", input.acquisition, ACQUISITION_STRING_FIELDS, ["acquiredAt"], errors);
    if (acq) {
      const at = acq.acquiredAt;
      if (typeof at !== "number" || !Number.isFinite(at) || at < 0) {
        errors.push("acquisition.acquiredAt must be a finite, non-negative number (epoch ms)");
      }
    }
  }

  const domainRaw = company?.domain;
  const emailRaw = person?.email;
  if (typeof domainRaw === "string" && domainRaw.trim() && !normalizeDomain(domainRaw)) {
    errors.push("company.domain is not a valid domain");
  }
  if (typeof emailRaw === "string" && emailRaw.trim() && !normalizeEmail(emailRaw)) {
    errors.push("person.email is not a valid email address");
  }
  const hasDomain = typeof domainRaw === "string" && normalizeDomain(domainRaw) !== null;
  const hasEmail = typeof emailRaw === "string" && normalizeEmail(emailRaw) !== null;
  if (!hasDomain && !hasEmail && domainRaw === undefined && emailRaw === undefined) {
    errors.push("candidate needs company.domain or person.email");
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as NormalizedCandidate };
}

/**
 * Deterministic dedupe key from NORMALIZED identifiers, so the same lead from two sources collides.
 * - With an email: `email:<normalized email>` (the strongest person-level identifier; +tags stripped).
 * - Otherwise: `domain:<normalized domain>|name:<normalized person name or company name>`, so two
 *   different people found on the same company site do not collapse into one candidate.
 * Campaign, channel, title, phone etc. are deliberately excluded: they vary by source for the same lead.
 * It is a canonical string rather than a digest: the default Convex runtime has no sync crypto, and a
 * lossy hash could silently drop a distinct lead on collision.
 */
export function computeDedupeHash(candidate: NormalizedCandidate): string {
  const email = candidate.person?.email ? normalizeEmail(candidate.person.email) : null;
  if (email) return `email:${email}`;
  const domain = candidate.company?.domain ? normalizeDomain(candidate.company.domain) : null;
  if (!domain) throw new Error("candidate has no usable identifier");
  const p = candidate.person;
  const personName = p?.fullName ?? ([p?.firstName, p?.lastName].filter(Boolean).join(" ") || undefined);
  const name = personName ? normalizeCompanyName(personName) : null;
  return `domain:${domain}|name:${name ?? ""}`;
}

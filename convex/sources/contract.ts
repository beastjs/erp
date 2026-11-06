import {
  normalizeDomain,
  normalizeEmail,
  normalizePersonName,
  normalizePhone,
  normalizeProfileUrl,
} from "../_shared/normalize";

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

export const PERSON_STRING_FIELDS = [
  "fullName", "firstName", "lastName", "jobTitle", "department", "seniority", "email", "phone", "profileUrl",
] as const;
export const COMPANY_STRING_FIELDS = [
  "name", "website", "domain", "industry", "size", "revenueRange", "location", "country", "description",
] as const;
export const ACQUISITION_STRING_FIELDS = ["campaign", "channel", "queryContext", "landingPage", "referral"] as const;

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

  if (person && errors.length === 0 && !personKey(person as NormalizedCandidate["person"])) {
    errors.push(
      "person must carry at least one of email, profileUrl, phone or a name (fullName, firstName, lastName); send a company-only candidate otherwise",
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as NormalizedCandidate };
}

type Person = NonNullable<NormalizedCandidate["person"]>;

/** Strongest normalized person identifier, as `kind:value`; null when the person has none. */
function personKey(p: Person | undefined): string | null {
  if (!p) return null;
  const email = p.email ? normalizeEmail(p.email) : null;
  if (email) return `email:${email}`;
  const profile = p.profileUrl ? normalizeProfileUrl(p.profileUrl) : null;
  if (profile) return `profile:${profile}`;
  const phone = p.phone ? normalizePhone(p.phone) : null;
  if (phone) return `phone:${phone}`;
  const fullName = p.fullName ?? ([p.firstName, p.lastName].filter(Boolean).join(" ") || undefined);
  const name = fullName ? normalizePersonName(fullName) : null;
  return name ? `name:${name}` : null;
}

/**
 * The strong person identifier a candidate is keyed by (`email:`, `profile:` or `phone:` + the normalized value), or
 * null. A name is not an identifier (two people share one), so it is never returned. Stored on the candidate row so
 * erasure can find a pending candidate by an exact index read: `dedupeHash` carries the company domain in front of
 * a phone or profile and so cannot be looked up from the identifier alone.
 */
export function candidatePersonKey(candidate: NormalizedCandidate): string | null {
  const key = personKey(candidate.person);
  return key !== null && !key.startsWith("name:") ? key : null;
}

/**
 * Deterministic dedupe key from NORMALIZED identifiers, so the same lead from two sources collides.
 * - A person with an email: `email:<normalized email>` (+tags stripped).
 * - Otherwise `domain:<normalized company domain>|<person key>`, where the person key is the first
 *   available of profileUrl, phone, person name (all normalized), or empty for a company-only candidate.
 *   Validation guarantees a person block has at least one of these, so distinct people never share a key.
 * Campaign, channel, title etc. are excluded: they vary by source for the same lead.
 * Known limit, deliberate: a lead seen with an email at one source and without at another hashes
 * differently and is inserted twice. Cross-form merging is deferred; company-level convergence
 * happens at entity resolution (matchCandidate resolves accounts), but contact-level cross-form
 * duplicates remain possible and are not yet owned by anything.
 * It is a canonical string rather than a digest: the default Convex runtime has no sync crypto, and a
 * lossy hash could silently drop a distinct lead on collision.
 */
export function computeDedupeHash(candidate: NormalizedCandidate): string {
  const key = personKey(candidate.person);
  if (key?.startsWith("email:")) return key;
  const domain = candidate.company?.domain ? normalizeDomain(candidate.company.domain) : null;
  if (!domain) throw new Error("candidate has no usable identifier");
  return `domain:${domain}|${key ?? ""}`;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Compares a PRODUCER-declared contract version with Core's. Compatible only when
 *   - MAJOR is equal (a different MAJOR means fields were removed/renamed/tightened: guessing would
 *     silently mis-read data, so refuse), and
 *   - the producer's MINOR is not ahead of Core's (it may send optional fields Core has not shipped
 *     yet; the contract says Core deploys first), and
 *   - PATCH is ignored (no shape change).
 * Anything that is not plain `MAJOR.MINOR.PATCH` is refused rather than coerced: a pre-release tag or
 * a missing part is exactly the case where a producer does not know what it is sending.
 */
export function checkContractVersion(declared: unknown): { ok: true } | { ok: false; error: string } {
  const parse = (x: unknown) => {
    const m = typeof x === "string" ? SEMVER.exec(x) : null;
    return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
  };
  const core = parse(CANDIDATE_CONTRACT_VERSION)!;
  const theirs = parse(declared);
  if (!theirs) return { ok: false, error: `contract_version_unsupported: "${String(declared)}" is not MAJOR.MINOR.PATCH` };
  if (theirs.major !== core.major) {
    return {
      ok: false,
      error: `contract_version_unsupported: producer declares ${String(declared)}, Core speaks ${CANDIDATE_CONTRACT_VERSION} (MAJOR differs)`,
    };
  }
  if (theirs.minor > core.minor) {
    return {
      ok: false,
      error: `contract_version_unsupported: producer declares ${String(declared)}, ahead of Core ${CANDIDATE_CONTRACT_VERSION}; deploy Core first`,
    };
  }
  return { ok: true };
}

import type { Tier } from "../icp/schema";

/**
 * The six conditions of Spec §5.5, in the order they are reported. Tier states commercial worth; this
 * gate states permission to ship. They are different questions, so a failure here never touches the tier.
 */
export const DISTRIBUTABILITY_CRITERIA = [
  "required_fields",
  "source_recorded",
  "provenance_available",
  "within_freshness_window",
  "duplicate_checked",
  "permissions_documented",
] as const;
export type DistributabilityCriterion = (typeof DISTRIBUTABILITY_CRITERIA)[number];

export const DEFAULT_FRESHNESS_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const METHODS = new Set(["observed", "extracted", "inferred"]);

type GateField = { field: string; value?: unknown; claimId?: unknown; method?: unknown; confidence?: unknown; observedAt?: unknown };
type Projection = { fields: GateField[] };

export type DistributabilityInput = {
  account: Projection;
  contact: Projection;
  scoreRun: { contributions: unknown[] };
  /** Epoch ms, explicit so the gate stays pure. */
  now: number;
  freshnessWindowDays: number;
  /** Task 13 owns the suppression list; the live call site passes `isSuppressed(...)`. This function never looks it up. */
  suppressed: boolean;
  /**
   * Caller-supplied facts the projections cannot carry (they live in other tables), computed by packageLead.
   * Required, not optional: an omitted fact must be a compile error, never a silent pass.
   *  - duplicateChecked: the identifiers were looked up and resolve to exactly this subject.
   *  - permissionsDocumented: every cited claim's source exists and records a lawful basis.
   */
  duplicateChecked: boolean;
  permissionsDocumented: boolean;
};

const field = (p: Projection, name: string) => p.fields.find((f) => f.field === name);
const text = (f: GateField | undefined) => (typeof f?.value === "string" && f.value.trim() !== "" ? f.value : undefined);
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** The fields a shippable lead cannot do without: the company, the person, and a way to reach them. */
function requiredFields(i: DistributabilityInput): GateField[] {
  const found = [field(i.account, "name"), field(i.contact, "name"), field(i.contact, "email")];
  return found.filter((f): f is GateField => f !== undefined);
}

/**
 * Pure. Returns every failing criterion, not a boolean: a Held lead needs a reason a human can act on.
 * Every unusable input (missing, NaN, wrong type) fails its criterion; nothing passes by default.
 */
export function checkDistributability(i: DistributabilityInput): { ok: boolean; failed: DistributabilityCriterion[] } {
  const all = [...i.account.fields, ...i.contact.fields];
  const failed = new Set<DistributabilityCriterion>();

  const emailValue = text(field(i.contact, "email"));
  if (!text(field(i.account, "name")) || !text(field(i.contact, "name")) || !emailValue || !EMAIL.test(emailValue)) {
    failed.add("required_fields");
  }

  // Where it came from (the winning claim) and when we acquired it.
  if (all.length === 0 || !all.every((f) => typeof f.claimId === "string" && f.claimId !== "" && finite(f.observedAt) && f.observedAt > 0)) {
    failed.add("source_recorded");
  }

  // How it was learned and how sure we are, plus the per-factor evidence behind the score.
  const evidence = Array.isArray(i.scoreRun.contributions) && i.scoreRun.contributions.length > 0;
  if (!evidence || all.length === 0 || !all.every((f) => typeof f.method === "string" && METHODS.has(f.method) && finite(f.confidence) && f.confidence > 0 && f.confidence <= 1)) {
    failed.add("provenance_available");
  }

  // Judged on the required fields: a stale note nobody ships must not hold a lead. A future-dated field has no
  // trustworthy age, so it fails rather than counting as brand new.
  const required = requiredFields(i);
  const windowMs = i.freshnessWindowDays * DAY_MS;
  if (
    !(finite(i.now) && finite(i.freshnessWindowDays) && i.freshnessWindowDays > 0) ||
    required.length === 0 ||
    !required.every((f) => finite(f.observedAt) && f.observedAt <= i.now && i.now - f.observedAt <= windowMs)
  ) {
    failed.add("within_freshness_window");
  }

  // "Duplicate, suppression and risk checks complete": a suppressed identifier means the checks did not clear.
  if (i.duplicateChecked !== true || i.suppressed !== false) failed.add("duplicate_checked");
  if (i.permissionsDocumented !== true) failed.add("permissions_documented");

  const ordered = DISTRIBUTABILITY_CRITERIA.filter((c) => failed.has(c));
  return { ok: ordered.length === 0, failed: ordered };
}

/**
 * The lifecycle disposition a packaged lead starts in. The tier is never an input to a downgrade: a Tier S
 * lead failing the gate is `Held` (valuable, not shippable yet), and keeps its tier. Reject-tier leads are
 * not packaged at all (packageLead refuses them); `Rejected` is listed for completeness of the mapping.
 */
export function dispositionFor(tier: Tier, gate: { ok: boolean }): "Rejected" | "Held" | "ReadyForDistribution" {
  if (tier === "Reject") return "Rejected";
  return gate.ok ? "ReadyForDistribution" : "Held";
}

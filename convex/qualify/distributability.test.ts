import { expect, test } from "vitest";
import { DISTRIBUTABILITY_CRITERIA, checkDistributability, dispositionFor, type DistributabilityInput } from "./distributability";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY;

const f = (field: string, value: unknown, over: Record<string, unknown> = {}) => ({
  field,
  value,
  claimId: `claim-${field}`,
  method: "observed",
  confidence: 0.9,
  observedAt: NOW - DAY,
  ...over,
});
const good = (over: Partial<DistributabilityInput> = {}): DistributabilityInput => ({
  account: { fields: [f("domain", "acme.com"), f("name", "Acme")] },
  contact: { fields: [f("email", "jo@acme.com"), f("name", "Jo Doe")] },
  scoreRun: { contributions: [{ factor: "intent" }] },
  now: NOW,
  freshnessWindowDays: 90,
  suppressed: false,
  duplicateChecked: true,
  permissionsDocumented: true,
  ...over,
});
const failed = (over: Partial<DistributabilityInput>) => checkDistributability(good(over)).failed;

test("all six criteria met returns ok", () => {
  expect(checkDistributability(good())).toEqual({ ok: true, failed: [] });
  expect(DISTRIBUTABILITY_CRITERIA).toHaveLength(6);
});

test("a missing acquisition timestamp fails distributability", () => {
  const withField = (observedAt: unknown) => good({ contact: { fields: [f("email", "jo@acme.com"), f("name", "Jo Doe", { observedAt })] } });
  // Exact lists: a timestamp-less field is not "fresh" either, but it must not drag unrelated criteria down.
  expect(checkDistributability(withField(undefined)).failed).toEqual(["source_recorded", "within_freshness_window"]);
  expect(checkDistributability(withField(NaN)).failed).toEqual(["source_recorded", "within_freshness_window"]);
  expect(checkDistributability(withField(0)).failed).toEqual(["source_recorded", "within_freshness_window"]);
  expect(failed({ account: { fields: [f("name", "Acme", { claimId: undefined })] } })).toEqual(["source_recorded"]);
  expect(failed({ account: { fields: [], }, contact: { fields: [] } })).toEqual(["required_fields", "source_recorded", "provenance_available", "within_freshness_window"]);
});

test("a lead past the freshness window fails distributability", () => {
  const aged = (days: number) => good({ contact: { fields: [f("email", "jo@acme.com", { observedAt: NOW - days * DAY }), f("name", "Jo Doe")] } });
  expect(checkDistributability(aged(90)).failed).toEqual([]); // the boundary day is inside the window
  expect(checkDistributability(aged(90.001)).failed).toEqual(["within_freshness_window"]);
  // A future-dated field has no trustworthy age: it fails rather than counting as brand new.
  expect(checkDistributability(aged(-1)).failed).toEqual(["within_freshness_window"]);
  // The window is the caller's and must be usable.
  for (const days of [0, -5, NaN, Infinity]) expect(failed({ freshnessWindowDays: days })).toEqual(["within_freshness_window"]);
  expect(failed({ now: NaN })).toEqual(["within_freshness_window"]);
  // A stale field the gate does not require does not hold the lead.
  expect(failed({ contact: { fields: [f("email", "jo@acme.com"), f("name", "Jo Doe"), f("phone", "1", { observedAt: NOW - 500 * DAY })] } })).toEqual([]);
});

test("a suppressed identifier fails distributability", () => {
  expect(failed({ suppressed: true })).toEqual(["duplicate_checked"]);
  expect(failed({ suppressed: undefined as never })).toEqual(["duplicate_checked"]); // fail closed on an omitted fact
});

test("each remaining criterion fails on its own, and fails closed", () => {
  expect(failed({ duplicateChecked: false })).toEqual(["duplicate_checked"]);
  expect(failed({ duplicateChecked: undefined as never })).toEqual(["duplicate_checked"]);
  expect(failed({ permissionsDocumented: false })).toEqual(["permissions_documented"]);
  expect(failed({ permissionsDocumented: undefined as never })).toEqual(["permissions_documented"]);
  expect(failed({ scoreRun: { contributions: [] } })).toEqual(["provenance_available"]);
  expect(failed({ contact: { fields: [f("email", "jo@acme.com"), f("name", "Jo Doe", { method: "guessed" })] } })).toEqual(["provenance_available"]);
  expect(failed({ contact: { fields: [f("email", "jo@acme.com"), f("name", "Jo Doe", { confidence: 0 })] } })).toEqual(["provenance_available"]);
  expect(failed({ contact: { fields: [f("email", "jo@acme.com"), f("name", "Jo Doe", { confidence: NaN })] } })).toEqual(["provenance_available"]);
});

test("required fields must be present and structurally valid", () => {
  expect(failed({ contact: { fields: [f("email", "not-an-email"), f("name", "Jo")] } })).toEqual(["required_fields"]);
  expect(failed({ contact: { fields: [f("email", "jo@acme.com"), f("name", "   ")] } })).toEqual(["required_fields"]);
  expect(failed({ contact: { fields: [f("email", 42), f("name", "Jo")] } })).toEqual(["required_fields"]);
  expect(failed({ account: { fields: [f("domain", "acme.com")] } })).toEqual(["required_fields"]);
});

test("failures are reported together, in the spec's order", () => {
  expect(failed({ suppressed: true, permissionsDocumented: false, scoreRun: { contributions: [] } })).toEqual([
    "provenance_available",
    "duplicate_checked",
    "permissions_documented",
  ]);
});

test("a tier S lead failing a criterion is Held, not downgraded", () => {
  const gate = checkDistributability(good({ suppressed: true }));
  expect(gate.ok).toBe(false);
  expect(dispositionFor("S", gate)).toBe("Held");
  expect(dispositionFor("S", { ok: true })).toBe("ReadyForDistribution");
  // Every non-reject tier holds the same way; only Reject maps to Rejected, and that comes from the tier, not the gate.
  for (const tier of ["S", "A", "B", "C"] as const) expect(dispositionFor(tier, { ok: false })).toBe("Held");
  expect(dispositionFor("Reject", { ok: true })).toBe("Rejected");
});

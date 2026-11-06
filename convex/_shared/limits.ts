/**
 * The largest credit budget a run may be started with. A declared bound, not a clamp: `startRun` REFUSES a budget past
 * it. It exists because the budget is written to `discoveryRuns` and to the append-only audit log, neither of which
 * erasure can redact, so an unbounded admin-supplied number could carry a phone number into both. Seven digits, so a
 * full phone number cannot be typed into it; raise it deliberately, with the audit domain (audit/log.ts) following.
 */
export const MAX_CREDIT_BUDGET = 1_000_000;

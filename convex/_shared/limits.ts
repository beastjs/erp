/**
 * The largest credit budget a run may be started with. A declared bound, not a clamp: `startRun` REFUSES a budget past
 * it. It exists because the budget is written to `discoveryRuns` and to the append-only audit log, neither of which
 * erasure can redact, so an unbounded admin-supplied number could carry a phone number into both. Seven digits, so a
 * full phone number cannot be typed into it; raise it deliberately, with the audit domain (audit/log.ts) following.
 */
export const MAX_CREDIT_BUDGET = 1_000_000;

/*
 * CLAIM SIZE (Task 16 M2). `claims` is read whole by the data-quality sample, and a Convex query may read at most
 * CONVEX_READ_LIMIT_BYTES, so an unbounded claim lets a handful of rows break that query for the whole org. The bounds
 * are REFUSALS at the one validating write (`appendClaimRecord`), never truncation: a claim is stored whole or not at all.
 *
 * The value bound is chosen so the largest claim legitimate ingest can produce still fits. That is a full `techStack`:
 * MAX_TECH_STACK (100) strings of MAX_STRING (2048) UTF-16 units, each unit at most 3 UTF-8 bytes, measured as Convex
 * measures a value (`getConvexSize`: 2 per string or array, plus the UTF-8 bytes):
 *     2 + 100 x (2 + 3 x 2048) = 614,602 bytes  <=  MAX_CLAIM_VALUE_BYTES = 640 KiB = 655,360 bytes.
 * `field` and `snapshotRef` are bounded to MAX_CLAIM_TEXT_CHARS (MAX_STRING) each, at most 2 + 3 x 2048 = 6,146 bytes.
 * Every other field of a claim is an id, a closed-set label or a number; 1,024 bytes covers all of them and their keys.
 *     MAX_CLAIM_DOC_BYTES = 655,360 + 2 x 6,146 + 1,024 = 668,676 bytes per claim document.
 * Pinned by observability/quality.test.ts with Convex's own size functions. Rows written before these bounds existed
 * are not re-checked: none can exist on the disposable development deployment, which predates any real data.
 */
/** Convex's per-function limit on bytes read (a query or a mutation). */
export const CONVEX_READ_LIMIT_BYTES = 16 * 1024 * 1024;
/** Largest claim value, in Convex-encoded bytes (`getConvexSize`). */
export const MAX_CLAIM_VALUE_BYTES = 640 * 1024;
/** Longest claim `field` and `snapshotRef`, in UTF-16 units (the candidate contract's MAX_STRING). */
export const MAX_CLAIM_TEXT_CHARS = 2048;
/** Largest claim DOCUMENT the bounds above admit. Readers that take claims whole budget with this. */
export const MAX_CLAIM_DOC_BYTES = MAX_CLAIM_VALUE_BYTES + 2 * (2 + 3 * MAX_CLAIM_TEXT_CHARS) + 1024;

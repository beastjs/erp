# Lead Intelligence Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Convex core of the lead intelligence pipeline — an append-only claims ledger, rebuildable projections, versioned scoring, qualification and packaging — fed by CSV/Excel/manual/CRM import.

**Architecture:** Claims are the system of record; `accounts` and `contacts` are materialized projections computed from claims by pure resolution rules, and are disposable. Scoring is a pure function of projections, signals and a versioned ICP/model pair, storing per-factor contributions. Pipeline stages chain through the Convex scheduler and are idempotent on `(subjectId, stage, inputHash)`.

**Tech Stack:** Convex (schema, queries, mutations, actions, scheduler, file storage), TypeScript strict, Bun, Vitest + `convex-test`. Frontend (existing Octane/rsbuild app) and the Firecrawl Collector Worker are out of scope — see Plans 2 and 3.

**Spec:** `docs/superpowers/specs/2026-11-05-lead-intelligence-pipeline-design.md`

## Global Constraints

- Every domain document carries `orgId`; every query filters on it. (Spec §7.1)
- A module's tables are written only by that module's mutations. (Spec §2)
- Per-claim confidence ceilings by method: `observed` ≤ 1.0, `extracted` ≤ 0.7, `inferred` ≤ 0.5. Stored as `scoringModels` config, not constants. (Spec §5.3)
- Scoring weights: company fit 35, contact fit 20, intent 45. Sum is 100. (Spec §5.2)
- Tier bands: S 90–100, A 80–89, B 70–79, C 60–69, Reject < 60, each gated by a per-tier confidence floor from `scoringModels`. (Spec §5.4)
- Claim resolution order: method precedence → source trust weight → `observedAt` recency → confidence → claim id. (Spec §4.2)
- `claims`, `signals`, `scoreRuns` and `leads` are append-only. No mutation in the codebase may update or delete a row in them, except the erasure redaction in Task 13. (Spec §3.1)
- Convex actions cannot write; they hand results to mutations. (Spec §2, §4.4)
- TypeScript `strict`. **The commit gate is `bun run check:core`** — `tsc --noEmit -p convex && vitest run && rsbuild build` — which must pass before every commit. Task 1 adds that script.
- **Do not use `bun run check`, and do not try to fix what it reports.** `src/` carries 40 pre-existing type errors: `src/hooks/` imports seven `src/lib/` modules that do not exist (`iconify`, `svg-optimizer`, `image-converter`, `custom-icon-set`, `icon-favorites`, `svg-symbol`, `favorite-icon-import`), plus implicit-`any` fallout and a bad `IconName` import in `src/lib/navs.ts`. They predate this plan, the user has chosen to leave them, and they are out of scope for every task here. `convex/tsconfig.json` already sets `strict: true` and excludes `_generated`, so the new code is still fully checked.
- Touch nothing under `src/` in any task. This plan adds `convex/` and `package.json` scripts only.
- Pin the existing toolchain: `octane@0.16.0`, Bun as the runner. Do not upgrade existing dependencies. `convex@^1.49.0` and a scaffolded `convex/_generated/` are already present from a vendor install; Task 1 verifies and keeps them rather than reinstalling.
- Read `convex/_generated/ai/guidelines.md` before writing any Convex code — the repo's `CLAUDE.md` requires it, and it overrides training-data assumptions about Convex APIs.

## Review Focus

- **Malformed and oversized imports** (Task 7): an empty file, duplicate or missing headers, and a 100k-row file. A person expects a named error or streamed progress, not a crash or a half-imported dataset.
- **`observedAt` absent or in the future** (Task 3): a source that reports tomorrow's date must not win recency ordering and silently outrank verified data.
- **Identifier normalization** (Task 13): `Bob@ACME.com `, `bob@acme.com` and unicode-homoglyph variants must hash to the same suppression entry, or an erased contact walks back in on the next import.
- **Scoring with nothing to score** (Task 10): zero signals, zero claims, or a subject with only `inferred` claims must produce a defined score and confidence — never `NaN`, never a divide-by-zero.
- **Concurrent claims in one tick** (Task 4): two claims for the same subject and field written in the same scheduler tick must produce a deterministic projection regardless of write order.

---

### Task 1: Convex project and test harness

**Files:**
- Create: `convex/schema.ts`, `convex/_shared/org.ts`, `vitest.config.ts`
- Modify: `package.json` (`convex` is already present; add `convex-test`, `vitest`, `@edge-runtime/vm`; add `test`, `test:watch` and `check:core` scripts)
- Test: `convex/_shared/org.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `withOrg<T>(ctx, args) => { orgId: Id<"orgs"> }` guard used by every later module; `schema.ts` exporting `defineSchema` with `orgs`, plus minimal `sources` and `discoveryRuns` tables so later tasks can reference `Id<"sources">` and `Id<"discoveryRuns">` in type positions before those modules exist.

- [ ] **Step 1: Write the failing test**

```ts
// convex/_shared/org.test.ts
test("withOrg rejects a request with no org context", async () => {
  await expect(withOrg(ctxWithoutIdentity, {})).rejects.toThrow("no org context");
});
test("withOrg returns the caller's orgId", async () => {
  expect(await withOrg(ctxForOrg("org_1"), {})).toEqual({ orgId: "org_1" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test convex/_shared/org.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Add dependencies and scripts, create `vitest.config.ts`**

`vitest.config.ts` uses the `edge-runtime` environment, which `convex-test` requires. Add to `package.json` scripts: `"test": "vitest run"`, `"test:watch": "vitest"`, and `"check:core": "tsc --noEmit -p convex && vitest run && rsbuild build"`. Keep the existing `convex` dependency and the scaffolded `convex/_generated/` as they are.

- [ ] **Step 4: Implement `withOrg(ctx, args): Promise<{ orgId: Id<"orgs"> }>` in `convex/_shared/org.ts` and the `orgs` table in `convex/schema.ts`**

`orgs`: `{ name: string, createdAt: number }`. `sources`: `{ orgId, key: string, trustWeight: number }`. `discoveryRuns`: `{ orgId, sourceId, status: string }`. Tasks 6 and 7 extend these two with their remaining fields and own all their mutations; this task adds no functions for them.

- [ ] **Step 5: Run test and typecheck**

Run: `bun run test convex/_shared/org.test.ts && bun run typecheck`
Expected: PASS, no type errors

- [ ] **Step 6: Commit**

```bash
git add convex vitest.config.ts package.json bun.lock
git commit -m "feat(convex): project setup, org guard, test harness"
```

---

### Task 2: Claims ledger

**Files:**
- Create: `convex/claims/schema.ts`, `convex/claims/mutations.ts`, `convex/claims/queries.ts`
- Modify: `convex/schema.ts` (register `claims`)
- Test: `convex/claims/claims.test.ts`

**Interfaces:**
- Consumes: `withOrg` (Task 1).
- Produces:
  - `type ClaimMethod = "observed" | "extracted" | "inferred"`
  - `type SubjectType = "account" | "contact"`
  - `appendClaim(args: { subjectType, subjectId, field: string, value: unknown, sourceId, method: ClaimMethod, confidence: number, observedAt: number, snapshotRef?: string, runId?: Id<"discoveryRuns"> }) => Id<"claims">`
  - `claimsForSubject(args: { subjectType, subjectId }) => Claim[]`
  - `claimsForField(args: { subjectType, subjectId, field }) => Claim[]`

- [ ] **Step 1: Write the failing test**

```ts
test("appendClaim stores a claim with its orgId", async () => {
  const id = await t.mutation(api.claims.mutations.appendClaim, observedDomainClaim);
  expect(await t.query(api.claims.queries.claimsForSubject, subject)).toHaveLength(1);
});
test("appendClaim clamps confidence to the method ceiling", async () => {
  const id = await t.mutation(api.claims.mutations.appendClaim, { ...inferredClaim, confidence: 0.9 });
  expect((await claim(id)).confidence).toBe(0.5);
});
test("appendClaim rejects confidence outside 0..1", async () => {
  await expect(t.mutation(api.claims.mutations.appendClaim, { ...observedDomainClaim, confidence: 1.4 }))
    .rejects.toThrow("confidence");
});
test("claimsForField returns only that field's claims", async () => { /* two fields, assert 1 */ });
test("claims are never updated: a second claim for the same field appends", async () => {
  // append twice, assert claimsForField length 2
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test convex/claims`
Expected: FAIL — `api.claims` undefined

- [ ] **Step 3: Implement the `claims` table and the three functions**

Indexes: `by_subject` on `["orgId", "subjectType", "subjectId"]` and `by_subject_field` on `["orgId", "subjectType", "subjectId", "field"]`. Method ceilings come from a `METHOD_CEILINGS` constant in this task and move to `scoringModels` config in Task 9.

- [ ] **Step 4: Run tests**

Run: `bun run test convex/claims`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add convex
git commit -m "feat(claims): append-only claims ledger"
```

---

### Task 3: Claim resolution rules

**Files:**
- Create: `convex/projections/resolve.ts`
- Test: `convex/projections/resolve.test.ts`

**Interfaces:**
- Consumes: `Claim`, `ClaimMethod` (Task 2).
- Produces: `resolveField(claims: Claim[], sources: Map<Id<"sources">, { trustWeight: number }>, now: number) => { winner: Claim; contenders: Claim[] } | null` — pure, no ctx.

- [ ] **Step 1: Write the failing test**

```ts
test("observed beats extracted beats inferred", ...)        // assert winner.method === "observed"
test("same method: higher source trust weight wins", ...)
test("same method and trust: more recent observedAt wins", ...)
test("same method, trust and recency: higher confidence wins", ...)
test("full tie resolves by claim id, deterministically", ...) // run twice, same winner
test("a future observedAt does not win recency", ...)        // observedAt > now is clamped to now
test("a missing observedAt sorts oldest, never newest", ...)
test("returns null for an empty claim list", ...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test convex/projections/resolve.test.ts`
Expected: FAIL — `resolveField` not exported

- [ ] **Step 3: Implement `resolveField` in `convex/projections/resolve.ts`**

Apply the Global Constraints resolution order as a comparator. Clamp `observedAt > now` to `now` before comparing; treat a missing `observedAt` as `0`.

- [ ] **Step 4: Run tests**

Run: `bun run test convex/projections/resolve.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add convex/projections
git commit -m "feat(projections): pure claim resolution rules"
```

---

### Task 4: Projections and the rebuild property test

**Files:**
- Create: `convex/projections/schema.ts`, `convex/projections/build.ts`, `convex/projections/queries.ts`
- Modify: `convex/schema.ts` (register `accounts`, `contacts`)
- Test: `convex/projections/build.test.ts`

**Interfaces:**
- Consumes: `resolveField` (Task 3), `claimsForSubject` (Task 2).
- Produces:
  - `applyClaimToProjection(ctx, { subjectType, subjectId, claimId }) => void` — incremental maintenance, called by Task 12.
  - `rebuildProjection(ctx, { subjectType, subjectId }) => void` — full recompute from claims.
  - `getAccount(args: { accountId }) => AccountProjection`, `getContact(args: { contactId }) => ContactProjection`
  - `AccountProjection` / `ContactProjection` carry, per field, `{ value, claimId, method, confidence, observedAt }`.

- [ ] **Step 1: Write the failing test**

```ts
test("a single observed claim appears in the projection with its provenance", ...)
test("a superseding claim replaces the projected value and its provenance pointer", ...)
test("PROPERTY: rebuild equals incremental", async () => {
  // append 50 pseudo-random claims across 5 fields via applyClaimToProjection
  const incremental = await getAccount(id);
  await rebuildProjection(ctx, { subjectType: "account", subjectId: id });
  expect(await getAccount(id)).toEqual(incremental);
});
test("PROPERTY: projection is order-independent", async () => {
  // same claim set applied in two different orders yields equal projections
});
test("rebuild of a subject with no claims yields an empty projection, not an error", ...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test convex/projections/build.test.ts`
Expected: FAIL — `rebuildProjection` not exported

- [ ] **Step 3: Implement the two tables and three functions**

`accounts` and `contacts` each hold `orgId`, the per-field provenance map, and denormalized display fields for the leads table (Spec §3.3). `applyClaimToProjection` re-resolves only the affected field; `rebuildProjection` re-resolves every field from `claimsForSubject`.

- [ ] **Step 4: Run tests**

Run: `bun run test convex/projections/build.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add convex/projections convex/schema.ts
git commit -m "feat(projections): materialized accounts and contacts with rebuild property test"
```

---

### Task 5: Entity resolution

**Files:**
- Create: `convex/projections/identity.ts`
- Modify: `convex/schema.ts` (register `identityLinks`)
- Test: `convex/projections/identity.test.ts`

**Interfaces:**
- Consumes: `AccountProjection`, `ContactProjection` (Task 4).
- Produces:
  - `matchCandidate(input: { domain?: string; companyName?: string; email?: string }, existing: AccountProjection[]) => { subjectId: Id<"accounts">; score: number; signals: string[] } | null` — pure. It takes loose identifier fields rather than `NormalizedCandidate` on purpose, so entity resolution carries no dependency on the candidate contract.
  - `linkIdentity(ctx, { subjectType, subjectId, mergedFromId, score, signals }) => Id<"identityLinks">`
  - `unlinkIdentity(ctx, { linkId }) => void`

- [ ] **Step 1: Write the failing test**

```ts
test("exact domain match resolves to the existing account", ...)
test("same company name, different domain does not auto-match", ...)   // score below threshold → null
test("linkIdentity records the match signals and score", ...)
test("unlinkIdentity reverses the link without destroying either subject", ...)
test("match is case- and whitespace-insensitive on domain", ...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test convex/projections/identity.test.ts`
Expected: FAIL — `matchCandidate` not exported

- [ ] **Step 3: Implement `matchCandidate`, `linkIdentity`, `unlinkIdentity`**

Match signals per Spec §3.3: normalized domain equality is decisive; name similarity alone is not. Links are reversible records, never destructive merges.

- [ ] **Step 4: Run tests**

Run: `bun run test convex/projections/identity.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add convex/projections convex/schema.ts
git commit -m "feat(projections): reversible entity resolution"
```

---

### Task 6: Candidate contract and sources registry

**Files:**
- Create: `convex/sources/contract.ts`, `convex/sources/schema.ts`, `convex/sources/mutations.ts`
- Modify: `convex/schema.ts` (register `sources`, `candidates`)
- Test: `convex/sources/contract.test.ts`

**Interfaces:**
- Consumes: `withOrg` (Task 1).
- Produces:
  - `NormalizedCandidate` type and `validateCandidate(input: unknown) => { ok: true; value: NormalizedCandidate } | { ok: false; errors: string[] }` — the cross-deploy contract Plan 2's Collector validates against.
  - `CANDIDATE_CONTRACT_VERSION: string`
  - `registerSource(ctx, { key, kind, trustWeight, lawfulBasis }) => Id<"sources">`
  - `insertCandidate(ctx, { candidate, sourceId, runId, dedupeHash }) => Id<"candidates"> | null` (null when the dedupe hash already exists)

- [ ] **Step 1: Write the failing test**

```ts
test("a minimal valid candidate passes validation", ...)
test("a candidate with neither domain nor email is rejected", ...)     // errors names both fields
test("unknown extra fields are rejected, not silently dropped", ...)
test("insertCandidate returns null for a repeat dedupeHash", ...)
test("registerSource requires a lawfulBasis", ...)                      // Spec §7.4
test("CANDIDATE_CONTRACT_VERSION is exported and semver-shaped", ...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test convex/sources/contract.test.ts`
Expected: FAIL — `validateCandidate` not exported

- [ ] **Step 3: Implement the contract, the two tables and the two mutations**

`NormalizedCandidate` carries person, company, and acquisition blocks per Spec §6 and `LEAD_GEN/PLAN.md §3.2`. `candidates` has a unique index on `["orgId", "dedupeHash"]`.

- [ ] **Step 4: Run tests**

Run: `bun run test convex/sources/contract.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add convex/sources convex/schema.ts
git commit -m "feat(sources): versioned candidate contract and source registry"
```

---

### Task 7: Import sources and run accounting

**Files:**
- Create: `convex/sources/import.ts`, `convex/sources/mapping.ts`, `convex/runs/schema.ts`, `convex/runs/mutations.ts`
- Modify: `convex/schema.ts` (register `discoveryRuns`, `columnMappings`)
- Test: `convex/sources/import.test.ts`, `convex/runs/budget.test.ts`

**Interfaces:**
- Consumes: `validateCandidate`, `insertCandidate` (Task 6).
- Produces:
  - `startRun(ctx, { sourceId, icpVersionId, creditBudget }) => Id<"discoveryRuns">`
  - `consumeCredits(ctx, { runId, credits }) => { remaining: number }` — throws `"budget_exhausted"` when the budget would be exceeded.
  - `importRows(ctx, { runId, rows: Record<string, string>[], mappingId }) => { inserted: number; rejected: Array<{ row: number; errors: string[] }> }`
  - `saveMapping(ctx, { name, columns: Record<string, string> }) => Id<"columnMappings">`
  - `addManualLead(ctx, { candidate }) => Id<"candidates">` — writes claims with `method: "observed"`, source = the operator.

- [ ] **Step 1: Write the failing test**

```ts
test("importRows maps columns and inserts candidates", ...)
test("importRows reports per-row errors without aborting the batch", ...)
test("importRows on an empty row set returns inserted 0 and no error", ...)
test("importRows rejects a mapping with duplicate target fields", ...)
test("importRows is chunked: a 100k-row import reports progress per chunk", ...)
test("a repeated import of the same file inserts nothing the second time", ...)
test("consumeCredits throws budget_exhausted rather than going negative", ...)
test("addManualLead records claims with method observed", ...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test convex/sources/import.test.ts convex/runs/budget.test.ts`
Expected: FAIL — `importRows` not exported

- [ ] **Step 3: Implement the four modules**

`importRows` processes in chunks of 500 rows per mutation, scheduling the next chunk, so a large file cannot exceed a single mutation's budget. Parsing of the uploaded file to rows happens in an action (IO); row insertion happens in mutations (Spec §4.4).

- [ ] **Step 4: Run tests**

Run: `bun run test convex/sources convex/runs`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add convex
git commit -m "feat(sources): chunked CSV/Excel import, manual entry, run budgets"
```

---

### Task 8: Signals and decay

**Files:**
- Create: `convex/signals/schema.ts`, `convex/signals/decay.ts`, `convex/signals/mutations.ts`
- Modify: `convex/schema.ts` (register `signals`)
- Test: `convex/signals/decay.test.ts`

**Interfaces:**
- Consumes: `withOrg` (Task 1).
- Produces:
  - `type SignalStrength = "high" | "medium" | "low"`
  - `type Signal = { _id: Id<"signals">; orgId; subjectType; subjectId; kind: string; strength: SignalStrength; confidence: number; observedAt: number; expiresAt?: number }`
  - `STRENGTH_WEIGHTS: Record<SignalStrength, number>`
  - `decayedWeight(signal: Signal, now: number) => number` — pure.
  - `appendSignal(ctx, { subjectType, subjectId, kind, strength, confidence, observedAt, expiresAt? }) => Id<"signals">`
  - `activeSignals(ctx, { subjectType, subjectId, now }) => Array<Signal & { weight: number }>`

- [ ] **Step 1: Write the failing test**

```ts
test("a signal observed today keeps its full strength weight", ...)
test("a six-month-old high signal decays below a fresh medium signal", ...)  // Spec §5.3
test("an expired signal has weight 0", ...)
test("decayedWeight never returns NaN or a negative number", ...)
test("strength weights order high > medium > low", ...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test convex/signals`
Expected: FAIL — `decayedWeight` not exported

- [ ] **Step 3: Implement the table, `decayedWeight`, `appendSignal`, `activeSignals`**

Decay is exponential on age with a half-life per strength; the half-lives are `scoringModels` config in Task 9 and a constant here. Strength defaults per Spec §5.3: funding/exec-hire/expansion high, relevant-hiring/tech-detected medium, generic activity low.

- [ ] **Step 4: Run tests**

Run: `bun run test convex/signals`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add convex/signals convex/schema.ts
git commit -m "feat(signals): dated signals with strength and decay"
```

---

### Task 9: Versioned ICP and scoring model config

**Files:**
- Create: `convex/icp/schema.ts`, `convex/icp/mutations.ts`, `convex/icp/queries.ts`, `convex/icp/defaults.ts`
- Modify: `convex/schema.ts` (register `icpDefinitions`, `scoringModels`)
- Test: `convex/icp/versioning.test.ts`

**Interfaces:**
- Consumes: `withOrg` (Task 1).
- Produces:
  - `createIcpVersion(ctx, { name, criteria, supersedesId? }) => Id<"icpDefinitions">`
  - `createScoringModel(ctx, { weights, tierBands, confidenceFloors, methodCeilings, decayHalfLives, supersedesId? }) => Id<"scoringModels">`
  - `getIcpVersion`, `getScoringModel`, `activeIcp(ctx, {}) => IcpDefinition`
  - `DEFAULT_SCORING_MODEL` — weights 35/20/45, the five tier bands, per-tier confidence floors, method ceilings 1.0/0.7/0.5.

- [ ] **Step 1: Write the failing test**

```ts
test("createScoringModel rejects weights that do not sum to 100", ...)
test("editing a model creates a new version and leaves the old row byte-identical", ...)
test("an existing scoreRun still resolves its original model version after a new one is created", ...)
test("DEFAULT_SCORING_MODEL matches the spec: 35/20/45, ceilings 1.0/0.7/0.5", ...)
test("createIcpVersion records supersedesId and createdBy", ...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test convex/icp`
Expected: FAIL — `createScoringModel` not exported

- [ ] **Step 3: Implement the two tables and the functions; move Task 2's `METHOD_CEILINGS` to read from the active model**

Rows are append-only and carry `version`, `supersedesId`, `createdBy`, `activeFrom` (Spec §3.2).

- [ ] **Step 4: Run tests**

Run: `bun run test convex/icp convex/claims`
Expected: PASS — including Task 2's ceiling test, now sourced from config

- [ ] **Step 5: Commit**

```bash
git add convex
git commit -m "feat(icp): versioned ICP definitions and scoring models"
```

---

### Task 10: Scoring engine

**Files:**
- Create: `convex/scoring/score.ts`, `convex/scoring/schema.ts`, `convex/scoring/mutations.ts`
- Modify: `convex/schema.ts` (register `scoreRuns`)
- Test: `convex/scoring/score.test.ts`

**Interfaces:**
- Consumes: projections (Task 4), `activeSignals`/`decayedWeight` (Task 8), `getIcpVersion`/`getScoringModel` (Task 9).
- Produces:
  - `computeScore(input: { account: AccountProjection; contact: ContactProjection; signals: Array<Signal & { weight: number }>; verifications: VerificationResult[]; icp: IcpDefinition; model: ScoringModel }) => ScoreResult` — pure. `verifications` defaults to `[]` until Task 15 populates it.
  - `type ScoreResult = { fit: number; intent: number; score: number; confidence: number; priority: number; tier: Tier; contributions: Contribution[] }`
  - `type Contribution = { factor: string; input: number; weight: number; contributed: number }`
  - `type VerificationResult = { kind: "email" | "phone"; outcome: "pass" | "fail" | "unknown"; checkedAt: number }`
  - `type Tier = "S" | "A" | "B" | "C" | "Reject"`
  - `recordScoreRun(ctx, { subjectType, subjectId, icpVersionId, scoringModelId, result }) => Id<"scoreRuns">`

- [ ] **Step 1: Write the failing test**

```ts
test("a perfect-fit, high-intent, fully-observed subject scores 100 and tiers S", ...)
test("inferred-only claims cap confidence at 0.5", ...)
test("a 92 score below the tier S confidence floor does not tier S", ...)
test("excellent fit with zero intent does not reach tier S", ...)        // Spec §5.3
test("priority is fit × intent, not a sum", ...)
test("zero signals yields intent 0, not NaN", ...)
test("a subject with no claims yields score 0, confidence 0, tier Reject", ...)
test("contributions list every weighted factor and its input value", ...)
test("data quality is absent from contributions", ...)                   // Spec §5.1
test("a failed email verification lowers confidence", ...)
test("an empty verifications array scores the same as before Task 15", ...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test convex/scoring`
Expected: FAIL — `computeScore` not exported

- [ ] **Step 3: Implement `computeScore` and `recordScoreRun`**

Confidence is the method/verification/age mix of the claims behind the projection, capped by the model's method ceilings. Guard every division by a zero denominator.

- [ ] **Step 4: Run tests**

Run: `bun run test convex/scoring`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add convex/scoring convex/schema.ts
git commit -m "feat(scoring): pure scoring engine with tiers and confidence floors"
```

---

### Task 11: Qualification gate and lead packaging

**Files:**
- Create: `convex/qualify/distributability.ts`, `convex/leads/schema.ts`, `convex/leads/mutations.ts`, `convex/leads/queries.ts`
- Modify: `convex/schema.ts` (register `leads`)
- Test: `convex/qualify/distributability.test.ts`, `convex/leads/package.test.ts`

**Interfaces:**
- Consumes: projections (Task 4), `ScoreResult` (Task 10).
- Produces:
  - `type DistributabilityCriterion = "required_fields" | "source_recorded" | "provenance_available" | "within_freshness_window" | "duplicate_checked" | "permissions_documented"` — the six criteria of Spec §5.5.
  - `checkDistributability(input: { account, contact, scoreRun, now, freshnessWindowDays, suppressed: boolean }) => { ok: boolean; failed: DistributabilityCriterion[] }` — pure.
  - `type InventoryState = "Available" | "Reserved" | "Sold" | "Delivered" | "Expired" | "Replaced"`
  - `type Disposition = "Captured" | "PendingValidation" | "Validated" | "Qualified" | "Held" | "Rejected" | "ReadyForDistribution" | "Delivered" | "Accepted" | "Converted" | "Closed"`
  - `packageLead(ctx, { accountId, contactId, scoreRunId }) => Id<"leads">`
  - `setInventoryState`, `setDisposition`

- [ ] **Step 1: Write the failing test**

```ts
test("all six criteria met returns ok", ...)                              // Spec §5.5
test("a missing acquisition timestamp fails distributability", ...)
test("a lead past the freshness window fails distributability", ...)
test("a suppressed identifier fails distributability", ...)
test("a tier S lead failing a criterion is Held, not downgraded", ...)
test("packageLead snapshots the projections: later claims do not alter the lead", ...)
test("inventory state and disposition are independent fields", ...)       // Delivered inventory + Accepted disposition
test("packageLead refuses a stale scoreRun", ...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test convex/qualify convex/leads`
Expected: FAIL — `checkDistributability` not exported

- [ ] **Step 3: Implement the gate, the `leads` table and the three mutations**

`packageLead` deep-copies the projections into the lead row; `leads` is append-only apart from the two state fields.

- [ ] **Step 4: Run tests**

Run: `bun run test convex/qualify convex/leads`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add convex
git commit -m "feat(leads): distributability gate and immutable lead packaging"
```

---

### Task 12: Pipeline orchestration

**Files:**
- Create: `convex/pipeline/schema.ts`, `convex/pipeline/stages.ts`, `convex/pipeline/hash.ts`, `convex/pipeline/deadletter.ts`
- Modify: `convex/schema.ts` (register `pipelineState`)
- Test: `convex/pipeline/idempotency.test.ts`, `convex/pipeline/chain.test.ts`

**Interfaces:**
- Consumes: every prior task's mutations.
- Produces:
  - `type Stage = "ingest" | "resolve" | "enrich" | "verify" | "signals" | "score" | "qualify" | "package"`
  - `stageInputHash(inputs: { claimIds: Id<"claims">[]; icpVersionId; scoringModelId }) => string`
  - `runStage(ctx, { subjectId, subjectType, stage }) => { status: "done" | "skipped" | "deadlettered"; reasonCode?: string }`
  - `advance(ctx, { subjectId, subjectType }) => void` — schedules the next stage.
  - `markScoreStale(ctx, { subjectType, subjectId }) => void`
  - `deadLetterQueue(ctx, { reasonCode? }) => DeadLetterRow[]`

- [ ] **Step 1: Write the failing test**

```ts
test("running a stage twice with the same inputHash produces one effect", ...)
test("a changed claim set changes the inputHash and re-runs the stage", ...)
test("a transient reason code schedules a retry with backoff", ...)
test("attempts past the cap dead-letter the subject", ...)
test("a terminal reason code dead-letters immediately, no retry", ...)
test("budget_exhausted dead-letters without consuming an attempt", ...)
test("a stage writes claims and advances state atomically", ...)          // failed stage leaves no partial claims
test("a new claim marks an existing scoreRun stale and schedules a rescore", ...)
test("ingest → package runs a candidate through to a packaged lead", ...)  // end-to-end
test("deadLetterQueue filters by reason code", ...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test convex/pipeline`
Expected: FAIL — `runStage` not exported

- [ ] **Step 3: Implement `pipelineState`, the stage runner, hashing and the dead-letter queue**

`pipelineState` holds the current stage, attempt count, last error and a per-stage `inputHash` map. `runStage` short-circuits when the stage's hash is unchanged. Reason codes: transient `timeout`, `rate_limited`, `provider_error`; terminal `invalid_domain`, `no_such_record`, `budget_exhausted`, `policy_refused`.

- [ ] **Step 4: Run tests**

Run: `bun run test convex/pipeline`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add convex/pipeline convex/schema.ts
git commit -m "feat(pipeline): idempotent stage chaining with dead-letter queue"
```

---

### Task 13: Erasure and suppression

**Files:**
- Create: `convex/privacy/redact.ts`, `convex/privacy/suppress.ts`, `convex/privacy/normalize.ts`
- Modify: `convex/schema.ts` (register `suppressions`), `convex/sources/mutations.ts` (check suppression in `insertCandidate`)
- Test: `convex/privacy/redact.test.ts`, `convex/privacy/normalize.test.ts`

**Interfaces:**
- Consumes: `claims` (Task 2), `rebuildProjection` (Task 4), `insertCandidate` (Task 6).
- Produces:
  - `normalizeIdentifier(value: string) => string` — pure: trim, lowercase, NFKC, strip tagged-address suffixes.
  - `suppressionHash(value: string, salt: string) => string`
  - `addSuppression(ctx, { identifier, reason }) => Id<"suppressions">`
  - `isSuppressed(ctx, { identifier }) => boolean`
  - `eraseSubject(ctx, { subjectType, subjectId }) => { claimsRedacted: number }`

- [ ] **Step 1: Write the failing test**

```ts
test("' Bob@ACME.com ' and 'bob@acme.com' normalize identically", ...)
test("unicode-homoglyph and full-width variants normalize identically", ...)
test("eraseSubject deletes claim values but keeps source, method and observedAt", ...)
test("after eraseSubject the projection rebuilds empty", ...)
test("eraseSubject leaves the auditLog count intact", ...)
test("insertCandidate refuses a suppressed identifier", ...)
test("re-importing an erased contact inserts nothing", ...)               // Spec §7.3
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test convex/privacy`
Expected: FAIL — `normalizeIdentifier` not exported

- [ ] **Step 3: Implement normalization, hashing, suppression and redaction**

Redaction overwrites `claims.value` with `null` and sets `redactedAt`; it never deletes the row. The salt comes from a Convex environment variable.

- [ ] **Step 4: Run tests**

Run: `bun run test convex/privacy convex/sources`
Expected: PASS (7 new tests, Task 6's still green)

- [ ] **Step 5: Commit**

```bash
git add convex
git commit -m "feat(privacy): erasure by redaction and suppression list"
```

---

### Task 14: Authorization and audit log

**Files:**
- Create: `convex/audit/schema.ts`, `convex/audit/log.ts`, `convex/_shared/authz.ts`
- Modify: `convex/schema.ts` (register `auditLog`); wrap mutations in `convex/icp/`, `convex/runs/`, `convex/leads/`, `convex/sources/`, `convex/privacy/`
- Test: `convex/_shared/authz.test.ts`, `convex/audit/log.test.ts`

**Interfaces:**
- Consumes: `withOrg` (Task 1).
- Produces:
  - `type Role = "operator" | "analyst" | "admin"`
  - `requireRole(ctx, role: Role) => Promise<{ orgId; userId; role }>`
  - `writeAudit(ctx, { action, targetTable, targetId, before, after }) => Id<"auditLog">`

- [ ] **Step 1: Write the failing test**

```ts
test("operator cannot create a scoring model version", ...)       // analyst+
test("analyst cannot register a source", ...)                      // admin only
test("admin can set a run budget", ...)
test("operator can work the dead-letter queue", ...)
test("createScoringModel writes an auditLog entry with before and after", ...)
test("eraseSubject writes an auditLog entry naming the actor", ...)
test("setInventoryState to Delivered writes an auditLog entry", ...)
test("a query for another org's data returns nothing", ...)        // Spec §7.1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test convex/_shared/authz.test.ts convex/audit`
Expected: FAIL — `requireRole` not exported

- [ ] **Step 3: Implement `requireRole`, `writeAudit`, the `auditLog` table, and wrap the named mutations**

Role matrix per Spec §7.1: `operator` runs discovery and reviews leads; `analyst` edits ICP and scoring models; `admin` manages sources, budgets, users and retention.

- [ ] **Step 4: Run the whole suite and the project check**

Run: `bun run check:core`
Expected: PASS, no type errors

- [ ] **Step 5: Commit**

```bash
git add convex
git commit -m "feat(audit): role enforcement and audit logging"
```

---

### Task 15: Structural verification

**Files:**
- Create: `convex/verify/schema.ts`, `convex/verify/structural.ts`, `convex/verify/mutations.ts`
- Modify: `convex/schema.ts` (register `verifications`), `convex/pipeline/stages.ts` (wire the `verify` stage)
- Test: `convex/verify/structural.test.ts`

**Interfaces:**
- Consumes: projections (Task 4), `VerificationResult` (Task 10), `runStage` (Task 12).
- Produces:
  - `verifyEmailStructure(email: string) => VerificationResult` — pure.
  - `verifyPhoneStructure(phone: string, region?: string) => VerificationResult` — pure.
  - `recordVerification(ctx, { subjectType, subjectId, result, provider }) => Id<"verifications">`
  - `verificationsForSubject(ctx, { subjectType, subjectId }) => VerificationResult[]`

v1 verifies structure only. No paid verification providers are in scope (Spec §6 lists none), so every result carries `provider: "structural"`. A provider-backed verifier is a later plan and plugs in behind the same `VerificationResult` type.

- [ ] **Step 1: Write the failing test**

```ts
test("a syntactically valid address passes", ...)
test("a role address (info@, sales@) returns unknown, not pass", ...)
test("a disposable-domain address fails", ...)
test("an address with no MX-capable shape (no dot in domain) fails", ...)
test("an empty or whitespace phone returns unknown, never throws", ...)
test("recordVerification stores the provider as 'structural'", ...)
test("the verify stage records a verification and advances the pipeline", ...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test convex/verify`
Expected: FAIL — `verifyEmailStructure` not exported

- [ ] **Step 3: Implement the two pure verifiers, the table, the two functions, and the `verify` stage body**

Structural checks only: syntax, role-address and disposable-domain lists, domain shape. No network calls, so this stays a mutation rather than an action.

- [ ] **Step 4: Run tests**

Run: `bun run test convex/verify convex/pipeline convex/scoring`
Expected: PASS — Task 10's and Task 12's suites stay green

- [ ] **Step 5: Commit**

```bash
git add convex
git commit -m "feat(verify): structural email and phone verification"
```

---

### Task 16: Observability queries

**Files:**
- Create: `convex/observability/runs.ts`, `convex/observability/quality.ts`, `convex/observability/definitions.ts`
- Test: `convex/observability/quality.test.ts`

**Interfaces:**
- Consumes: `discoveryRuns` (Task 7), `pipelineState` (Task 12), `claims` (Task 2), `leads` (Task 11).
- Produces:
  - `runSummary(ctx, { runId }) => { countsByStage: Record<Stage, number>; countsByOutcome: Record<string, number>; creditsConsumed: number; durationMs: number }`
  - `pipelineHealth(ctx, {}) => { inFlight: number; retrying: number; deadLettered: Record<string, number> }`
  - `dataQuality(ctx, {}) => { methodMix: Record<ClaimMethod, number>; verificationPassRate: number; medianClaimAgeDays: number }`
  - `costPerQualifiedLead(ctx, { runId }) => { credits: number; qualified: number; costPerLead: number | null }`
  - `METRIC_DEFINITIONS: Record<string, { definition: string; basis: "observed" | "modelled" }>`

Spec §10 requires metric definitions to travel with the metrics and observed values to be distinguishable from modelled ones; `METRIC_DEFINITIONS` is that record, and every query above returns a key into it.

- [ ] **Step 1: Write the failing test**

```ts
test("runSummary counts candidates by stage and outcome", ...)
test("costPerQualifiedLead returns null, not Infinity, when zero leads qualified", ...)
test("dataQuality methodMix sums to the claim count", ...)
test("medianClaimAgeDays on an empty ledger returns 0, not NaN", ...)
test("pipelineHealth groups dead letters by reason code", ...)
test("every metric returned has an entry in METRIC_DEFINITIONS", ...)
test("each definition declares observed or modelled basis", ...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test convex/observability`
Expected: FAIL — `runSummary` not exported

- [ ] **Step 3: Implement the four queries and the definitions record**

All four are read-only queries over existing tables; add no new tables.

- [ ] **Step 4: Run the whole suite and the project check**

Run: `bun run check:core`
Expected: PASS, no type errors

- [ ] **Step 5: Commit**

```bash
git add convex
git commit -m "feat(observability): run, health, quality and cost metrics"
```

# Lead Intelligence Pipeline — Design Spec

Date: 2026-11-05
Status: Approved for planning
Scope: First slice of the ERP program — the lead intelligence pipeline

---

## 1. Purpose and scope

### What this builds

The lead intelligence pipeline, end to end:

```
Discover → Resolve → Enrich → Verify → Signals → Score → Qualify → Package
```

Operated internally by a small team. Produces leads that can be defended field
by field: every value carries its source, the method by which it was obtained,
a confidence figure, and an age.

### Why this slice first

`docs/LEAD_GEN/INTEL.md` describes a two-sided marketplace and
`docs/PLAN-PROFESSIONAL.md` describes a full ERP foundation. Both sit on top of
lead supply that can be trusted. Nothing in either can be built first without
inventing the pipeline anyway. This slice is therefore the foundation, and it is
the only program committed by this spec.

### Explicitly out of scope

- Customer-facing catalog, lead requests, credits, packs, exclusivity tiers,
  replacement guarantees, public API (`INTEL.md`).
- Billing, invoicing, rate cards, reconciliation (`TECH.md`).
- Outreach and sequencing (`PLAN.md §13`).
- CRM write-back (`PLAN.md §12`). The CRM export is an input in v1, not a sync.
- ERP finance, procurement, inventory modules.
- Supplier onboarding and buyer management.

These are deliberately deferred, not rejected. The design must not make them
harder to add; see §12.

### Success criteria

1. A lead record whose every field resolves to a claim with source, method,
   confidence and observation timestamp.
2. Score and confidence are independent numbers, each explainable from stored
   per-factor contributions.
3. ICP definitions and scoring models are versioned; any historical score
   remains explainable after weights change.
4. Deleting all materialized projections and rebuilding from claims produces an
   identical result (property-tested).
5. Cost per qualified lead is computable from stored credit consumption, not
   reconstructed.
6. A replayed Firecrawl webhook, a re-run stage, and a post-fix replay all
   produce no duplicate effects.

---

## 2. Architecture

Three deployables, one-way dependencies:

```
Firecrawl ──► Collector (Cloudflare Worker) ──► Core (Convex) ◄── App (Cloudflare Worker)
```

### App — Cloudflare Worker

Serves the existing Octane/rsbuild frontend. No business logic and no data
access beyond the Convex client. Auth is a session boundary here;
authorization is enforced in Core.

### Core — Convex

The entire domain: claims, projections, identity resolution, ICP definitions,
scoring, qualification, packaging. A modular monolith per
`PLAN-PROFESSIONAL.md §4.1`, where module boundaries are directories under
`convex/` and the rule is: **a module's tables are written only by that
module's mutations.**

- Queries are reactive, so the leads table and jobs monitor
  (`APP_DESIGN.md §6`, `§13`) stay live without polling.
- Mutations are the only writers to the ledger and are transactional.
- Actions perform outbound IO (provider APIs, verification) and cannot write;
  they hand results to mutations.
- Scheduled functions drive stage chaining.

### Collector — Cloudflare Worker + R2

Crawling only. Isolated from Core on two grounds, which this design is to be
held to:

1. The Firecrawl API key never reaches Convex.
2. A crawl storm, Firecrawl outage, or webhook retry flood cannot consume the
   domain core's execution budget.

Responsibilities: Firecrawl `/scrape`, `/crawl`, `/map` calls; webhook
signature verification; raw snapshot storage in R2 with a retention TTL;
credit budget enforcement; backoff; dead-letter path; normalization to the
candidate shape; authenticated POST to a Convex HTTP endpoint.

Accepted costs: two deploys, two auth boundaries, and a versioned candidate
contract whose breaking changes require ordered deployment of both sides.

### The central seam

**Every source produces a `candidate`. No source writes accounts or contacts
directly.** CSV/Excel import, manual entry, the CRM export, and Firecrawl all
converge on one normalized candidate shape (`PLAN.md §3.1`). A fifth source is
then a connector, not a refactor.

---

## 3. Data model

Convex has no ad-hoc joins. The shape is append-only truth plus materialized
reads.

### 3.1 Immutable, append-only

**`claims`** — one field assertion.

| Field | Notes |
|---|---|
| `orgId` | present on every domain doc from day one |
| `subjectType` | `account` \| `contact` |
| `subjectId` | |
| `field` | dotted path, e.g. `company.domain` |
| `value` | |
| `sourceId` | → `sources` |
| `method` | `observed` \| `extracted` \| `inferred` |
| `confidence` | 0–1, capped by `method` (§5.3) |
| `observedAt` | when the world showed this, not when we wrote it |
| `snapshotRef` | R2 key or Convex storage id for the raw artifact |
| `runId` | → `discoveryRuns` |

Never updated. A newer claim supersedes an older one by resolution order
(§4.2), not by mutation.

**`signals`** — dated events with `strength` (`high` \| `medium` \| `low`), a
`confidence`, a decay function reference, and an expiry. Freshness is computed
at read time, never stored stale.

**`scoreRuns`** — one row per scoring: subject, `icpVersionId`,
`scoringModelId`, `fit`, `intent`, `score`, `confidence`, `priority`, `tier`,
and a `contributions[]` array of per-factor inputs and weights. This row is
what the Scoring screen renders; the UI never recomputes a score.

**`leads`** — an immutable package: snapshots of the account and contact
projections, the `scoreRunId`, the evidence bundle, and a freshness timestamp.
A delivered lead must never change retroactively.

### 3.2 Versioned configuration

**`icpDefinitions`**, **`scoringModels`** — a new version is a new row. Old
rows are never edited, so every historical score stays explainable. Rows carry
`version`, `supersedesId`, `createdBy`, `activeFrom`.

### 3.3 Materialized projections

Derived, rebuildable, never hand-edited.

**`accounts`**, **`contacts`** — current resolved values, plus per field a
pointer to the winning claim and that claim's method/confidence/age. Carry
denormalized display fields for the leads table, since there are no joins.

**`identityLinks`** — entity-resolution decisions with their match signals and
score. Reversible, not destructive merges (`PLAYBOOK.md §6`).

### 3.4 Operational

| Table | Purpose |
|---|---|
| `candidates` | normalized pending input, dedupe-hashed |
| `sources` | connector registry, trust weight, credential reference |
| `verifications` | per-contact email/phone verification results by provider |
| `discoveryRuns` | ICP version, source, budget, credits used, counts, status |
| `pipelineState` | per-subject stage, attempt, last error, per-stage `inputHash` |
| `suppressions` | salted hashes of erased/opted-out identifiers |
| `auditLog` | actor, action, before/after for config and delivery events |

### 3.5 The governing invariant

**Projections are a pure function of `claims` + resolution rules +
`icpVersion`.** Delete every projection and the system rebuilds identically.
This is what makes a resolver fix a replay instead of a migration, and it is
property-tested (§8).

---

## 4. Pipeline execution

### 4.1 No global queue

Discovery is a *run*, not a per-subject stage: a `discoveryRun` queries a
source and emits `candidates`. Per-subject work begins at `ingest`, which is
where a candidate lands. Each subject then carries a `pipelineState` document:
current stage, attempt count, last error, and an `inputHash` per completed
stage. Stages:

```
ingest → resolve → enrich → verify → signals → score → qualify → package
```

### 4.2 Idempotency is per stage

A stage is keyed on `(subjectId, stage, inputHash)`, where the hash covers the
stage's actual inputs: the claim ids it read, the ICP version, the model
version. Same inputs and already complete means no-op returning the prior
result. This makes a Firecrawl webhook retry, a manual re-run, and a replay
after a resolver fix all safe without case-by-case reasoning.

Resolution order for competing claims, applied in sequence:

1. Method precedence: `observed` > `extracted` > `inferred`.
2. Source trust weight (`sources.trustWeight`).
3. Recency of `observedAt`.
4. Confidence.

Ties are resolved deterministically by claim id so rebuilds are stable.

### 4.3 Chaining is explicit

A stage's mutation writes its claims and schedules the next stage via the
Convex scheduler. No stage polls. Because mutations are transactional, "write
claims and advance state" is atomic — there is no window in which a stage's
output exists but its state disagrees.

### 4.4 IO and writes are separated

Enrichment and verification call providers from actions, which cannot write,
and hand results to mutations. An in-flight provider call therefore cannot
leave a half-written ledger; a provider timeout costs a retry, not a corrupt
record.

### 4.5 Failures carry reason codes

Every failure writes `{stage, reasonCode, providerRef, attempt}`.

- Transient codes (timeout, rate limited, provider 5xx): retry with
  exponential backoff, capped attempts.
- Terminal codes (invalid domain, no such record, budget exhausted, policy
  refusal): immediate dead-letter.

Dead-lettered subjects appear in the Jobs screen (`APP_DESIGN.md §13`) as a
reviewable queue with the reason visible, satisfying `TECH.md`'s requirement
that rejected records route for review with reason codes retained.

### 4.6 Rescoring is event-driven

A new claim or signal touching a scored subject marks its `scoreRun` stale and
schedules a rescore. Scores drift visibly because the world changed, rather
than silently aging.

### 4.7 Backpressure is the budget

The mutation that enqueues discovery work checks the run's remaining credits
and refuses rather than queues. A runaway crawl fails closed. Credit
consumption is recorded on `discoveryRuns`, making cost per qualified lead
(`LEARN_REFINED.md §8`) computable directly.

---

## 5. Scoring, confidence, qualification

### 5.1 Resolved contradiction in the source docs

`PLAYBOOK.md §13` makes Data Quality 20% of the 100-point lead score. `§14`
says, correctly, not to confuse lead score with data confidence. Both cannot
hold: quality would be double-counted, and the pathology is specific — a
perfectly verified mediocre prospect would outscore a weakly verified excellent
one.

**Decision: Data Quality is dropped from the score.** Confidence stands alone.

### 5.2 Weights

| Dimension | Weight |
|---|---:|
| Company fit | 35 |
| Contact fit | 20 |
| Intent | 45 |

These are the v1 defaults of `scoringModels` version 1, not constants in code.

### 5.3 Four independent numbers

**Fit** — company and contact fit against the ICP version. Deterministic given
projections.

**Intent** — from `signals`, each weighted by strength and multiplied by its
decay. Strength defaults (`PLAYBOOK.md §11`): funding announcement, relevant
executive hired, major expansion = high; relevant hiring, technology detected =
medium; generic website activity = low. A six-month-old hiring event
contributes a fraction of yesterday's.

**Confidence** — evidence quality: the mix of observed/extracted/inferred
claims behind the projection, verification results, and claim age. **Capped by
method**, with v1 ceilings on a per-claim basis: `observed` ≤ 1.0, `extracted`
≤ 0.7, `inferred` ≤ 0.5. A projection built only from `inferred` claims
therefore cannot exceed 0.5 confidence, regardless of how confident a model
reported itself to be. The ceilings are `scoringModels` configuration, not
constants.

**Priority** — `fit × intent`, kept as its own axis because `PLAYBOOK.md §12`
is right that excellent-fit/low-intent and poor-fit/high-intent are both bad
leads, and a sum would promote them.

### 5.4 Tiers

Bands on the score, **gated by a confidence floor**:

| Tier | Score |
|---|---|
| S | 90–100 |
| A | 80–89 |
| B | 70–79 |
| C | 60–69 |
| Reject | < 60 |

A score of 92 at 40% confidence is not Tier S. It is a 92 that needs
verification, and it displays as such. The floor per tier is configuration on
`scoringModels`, not a constant.

### 5.5 Distributability is a separate gate

Tier states commercial worth. Distributability states permission. Per
`LEARN_REFINED.md §5`, a lead is distributable only when all hold:

- Required fields present and structurally valid.
- Source and acquisition timestamp recorded.
- Provenance evidence available.
- Within the applicable freshness window.
- Duplicate, suppression and risk checks complete.
- Applicable disclosures and permissions documented.

A Tier S lead failing any of them becomes `Held`, never quietly downgraded.

### 5.6 Two state axes, kept apart

- **Inventory state** on `leads`: `Available`, `Reserved`, `Sold`,
  `Delivered`, `Expired`, `Replaced`.
- **Lifecycle disposition**, its own field: `Captured`, `PendingValidation`,
  `Validated`, `Qualified`, `Held`, `Rejected`, `ReadyForDistribution`,
  `Delivered`, `Accepted`, `Converted`, `Closed`.

Technical delivery and commercial acceptance stay separate: delivered ≠
accepted ≠ converted. Collapsing them is how a marketplace loses the ability to
compute real conversion.

### 5.7 Scoring is pure

`(projections, signals, icpVersion, scoringModel) → scoreRun`, with per-factor
contributions stored. The Scoring screen (`APP_DESIGN.md §8`) explains a number
rather than restating it.

---

## 6. Sources in v1

| Source | Mechanism | Notes |
|---|---|---|
| CSV/Excel import | Upload → parse → candidates | Column mapping UI; mapping saved as a reusable profile |
| Manual entry | Form → candidate | Claims recorded with `method: observed`, source = the operator |
| CRM export | Parse → candidates | Also scoring ground truth (§8) |
| Firecrawl | Collector Worker | `/map` for discovery, `/scrape` and `/crawl` for pages, `/extract` for structured fields |

### Firecrawl specifics

- `/extract` and JSON mode return LLM-structured fields. These are written as
  `method: extracted` or `inferred`, never `observed`. This is the single most
  important consequence of using Firecrawl: without it the ledger fills with
  model guesses wearing the same badge as facts.
- Credits are billed per page. Budget caps per ICP, per discovery run and per
  account are enforced in the enqueueing mutation, not the UI.
- Webhooks retry and arrive out of order. The ingestion mutation is keyed on
  `(firecrawlJobId, url)`, so a replayed delivery is a no-op.
- Raw snapshots go to R2 with a retention TTL (§7.3).

---

## 7. Security, privacy, compliance

### 7.1 Identity, tenancy, authorization

v1 serves internal operators only, but **every domain document carries `orgId`
from day one** and every query filters on it. Adding it now is a field; adding
it later is a migration across an append-only ledger.

Roles:

| Role | Can |
|---|---|
| `operator` | Run discovery, review leads, work the dead-letter queue |
| `analyst` | Edit ICP definitions and scoring models (creates new versions) |
| `admin` | Manage sources, budgets, users, retention |

Authorization is enforced inside Convex functions. The UI hides things for
comfort, not for safety.

### 7.2 Trust boundaries

- Firecrawl API key exists only as a Collector Worker secret.
- Firecrawl webhook signatures are verified in the Collector.
- Collector → Core posts carry a service credential, so the ingestion endpoint
  cannot be driven by anyone who learns its URL.
- ICP and scoring-model edits, budget changes and lead deliveries write
  `auditLog` entries with actor and before/after.

### 7.3 Erasure in an append-only ledger

Append-only storage and "delete my data" are in direct conflict. The
resolution is **redaction, not row deletion**:

1. On an erasure request, claim *values* for that subject are hard-deleted in
   place. Claim *metadata* survives — source, method, `observedAt`, and the
   fact that a claim existed.
2. Audit trails and counts stay intact; the personal data is gone; projections
   rebuild to an empty subject.
3. A **suppression list keyed by a salted hash** of email and domain is checked
   at candidate ingestion, so an erased contact is not re-crawled next week.
4. Raw Firecrawl snapshots in R2 are the other copy of that PII and carry a
   retention TTL rather than living indefinitely.

### 7.4 Crawling posture

Firecrawl performs fetching and politeness. This system still owns: a
per-domain allow/deny list, respect for recorded opt-outs, and a documented
lawful basis per source recorded on the `sources` row. Public web crawling is
configured per source and can be disabled per source without code changes.

---

## 8. Testing strategy

In rough order of payoff.

### 8.1 Pure-function unit tests

Scoring, decay, confidence and resolution rules are pure. Table-driven
fixtures, including the adversarial cases:

- Inferred-only claims cannot reach high confidence.
- A stale high-strength signal decays below a fresh medium-strength one.
- Excellent fit with zero intent does not reach Tier S.
- A 92 score below the confidence floor is not Tier S.
- Claim resolution order is deterministic under ties.

### 8.2 Idempotency tests per stage

Run a stage twice with the same `inputHash`; assert exactly one effect. Replay
a Firecrawl webhook; assert no duplicate claim.

### 8.3 The projection property test

The test that protects the whole design: rebuild `accounts` and `contacts` from
`claims` and assert equality with the incrementally maintained version. If this
fails, "projections are disposable" is a slogan rather than a fact.

### 8.4 Candidate contract test

Run against both Collector and Core, since the candidate shape is now a
cross-deploy interface.

### 8.5 Ground-truth tests from the CRM export

Known-won accounts should score high under a sane ICP. This is a test, not a
judgement call. Known-lost accounts provide the negative cases.

Development follows TDD: a failing test before implementation, per
`superpowers:test-driven-development`.

---

## 9. Error handling summary

| Situation | Behaviour |
|---|---|
| Provider timeout / 5xx / rate limit | Retry, exponential backoff, capped attempts |
| Invalid domain, no such record | Terminal; dead-letter with reason code |
| Budget exhausted | Enqueue refused; run marked `budget_exhausted` |
| Webhook replay | No-op via `(firecrawlJobId, url)` key |
| Conflicting claims | Both stored; resolution order decides the projection |
| Resolver bug found | Fix, then replay claims; projections rebuild |
| Erasure request | Redact values, retain metadata, add suppression hash |
| Failed distributability check | Lead set to `Held` with the failing criterion recorded |

---

## 10. Observability

- `discoveryRuns` carries counts by stage and outcome, credits consumed, and
  duration — the acquisition velocity view in `APP_DESIGN.md §2`.
- `pipelineState` aggregates feed the Jobs screen: in-flight, retrying,
  dead-lettered, by reason code.
- Data-quality metrics derived from claims: share of fields observed vs
  extracted vs inferred, verification pass rates, median claim age.
- Metric definitions are recorded alongside the dashboards that use them, per
  `TECH.md` — observed values are distinguished from modelled ones.

---

## 11. Repository structure

```
src/                    existing Octane frontend (App Worker)
convex/
  schema.ts
  claims/               append-only ledger writes + queries
  projections/          resolution rules, rebuild, identityLinks
  icp/                  icpDefinitions, scoringModels (versioned)
  scoring/              pure scoring, confidence, tiers
  qualify/              distributability gate, dispositions
  leads/                packaging, inventory states
  sources/              connector registry, import, manual entry
  pipeline/             stage chaining, pipelineState, dead-letter
  http/                 Collector ingestion endpoint
  audit/
collector/              Cloudflare Worker: Firecrawl, webhooks, R2, budgets
docs/
  LEAD_GEN/             existing strategy docs (inputs to this spec)
  superpowers/specs/    this spec
```

Module rule: a module's tables are written only by that module's mutations.

---

## 12. Not making the deferred work harder

| Deferred thing | What this design already provides |
|---|---|
| Marketplace catalog | `leads` is already a frozen, priced-ready package with tier, confidence and freshness |
| Exclusivity | Inventory states already include `Reserved` and `Sold` |
| Replacement guarantee | `Replaced` state plus immutable snapshots make a replacement auditable |
| Public API | Core is already the only writer; an API is a new entry point, not a new model |
| Buyer feedback loop | `scoreRuns` store contributions, so outcome data can retrain weights as a new `scoringModel` version |
| ERP modules | `orgId`, `auditLog` and the module-boundary rule are the foundation `PLAN-PROFESSIONAL.md` asks for |
| Billing | Credit consumption is already recorded per run |

---

## 13. Decisions recorded

| # | Decision | Rationale |
|---|---|---|
| 1 | Intel pipeline is the first slice | Everything else depends on trustworthy supply |
| 2 | Cloudflare Workers for app, Convex for backend | User's choice; Convex supplies scheduling, reactivity, storage without a separate queue |
| 3 | Evidence ledger, not mutable records | Per-field confidence, freshness and contradiction handling become structural; replay instead of migration |
| 4 | Collector isolated in its own Worker | Key isolation and failure-domain isolation, accepted at the cost of a versioned cross-deploy contract |
| 5 | `claims.method` with confidence capped by method | LLM-extracted fields must not masquerade as observed facts |
| 6 | Data Quality dropped from the lead score | Resolves the `PLAYBOOK.md §13`/`§14` contradiction; prevents double-counting |
| 7 | ICP and scoring models versioned from day one | Historical scores must stay explainable |
| 8 | `orgId` on every document from day one | Retrofitting tenancy across an append-only ledger is a migration |
| 9 | Erasure by redaction plus suppression hashing | Reconciles append-only storage with deletion rights |
| 10 | Distributability is a gate, not a tier | Commercial worth and permission to ship are different questions |

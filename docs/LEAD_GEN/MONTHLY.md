## 9. Twice-Monthly Operational Checklist and Task Schedule

### 9.1 Purpose and cadence

The twice-monthly review is a structured management control designed to ensure that operational performance, lead quality, supplier conduct, commercial results, and governance obligations are reviewed consistently.

Use two fixed review cycles each month:

- **Cycle A — Mid-month review:** Conduct on the 1st–15th operating period, with the review held on or around the 15th.
- **Cycle B — Month-end review:** Conduct on the 16th–final calendar day, with the review held on the final business day of the month.

If a review date falls on a non-business day, move the meeting to the nearest preceding business day. The reporting period must remain explicit so that results are not accidentally double-counted or omitted.

This cadence supplements, rather than replaces, continuous monitoring and the daily, weekly, monthly, and quarterly controls described elsewhere in this playbook.

### 9.2 Review ownership

Each review must have a named coordinator and accountable owners for the relevant workstreams.

| Role                         | Responsibility                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------- |
| Review coordinator           | Publishes the agenda, gathers evidence, records decisions, and tracks actions    |
| Campaign owner               | Reports campaign delivery, spend, targeting, and optimization                    |
| Supplier manager             | Reviews supplier quality, compliance, capacity, and corrective actions           |
| Data operations lead         | Reports validation, enrichment, duplicates, and data-quality exceptions          |
| Sales / buyer operations     | Supplies acceptance, contact, conversion, and rejection feedback                 |
| Engineering / platform owner | Reports availability, integration health, security issues, and technical debt    |
| Finance owner                | Reconciles spend, revenue, commissions, credits, and contribution margin         |
| Privacy / compliance owner   | Reviews provenance, disclosures, data requests, retention, and policy exceptions |
| Executive sponsor            | Approves material commercial, operational, and risk decisions                    |

Where the organization is small, one person may perform multiple roles. The person responsible for a control should not be the sole approver of a high-impact exception to that same control.

### 9.3 Priority and status definitions

Use a consistent classification across the checklist and task register.

**Priority**

- **P0 — Critical:** Immediate threat to legal compliance, data security, material financial exposure, or platform integrity. Contain and escalate immediately; do not wait for the scheduled review.
- **P1 — High:** Material impact on lead quality, buyer commitments, campaign economics, or service levels. Assign an owner and near-term due date.
- **P2 — Medium:** Important improvement or recurring operational weakness. Schedule within the current or next review cycle.
- **P3 — Low:** Optimization, documentation, or convenience improvement with limited immediate impact.

**Task status**

- Not started
- In progress
- Blocked
- Pending approval
- Completed
- Deferred with approved rationale

A task is not complete merely because someone has performed the activity. Completion requires the specified evidence or acceptance criterion.

---

## 10. Cycle A — Mid-Month Checklist (1st–15th)

**Review date:** On or around the 15th  
**Primary purpose:** Detect drift early, correct operational issues, and adjust the second-half execution plan.

### 10.1 Campaign and acquisition health

- [ ] Review spend against approved budget and pacing.
- [ ] Compare lead volume with campaign targets and forecast.
- [ ] Review CPL, cost per accepted lead, and cost per qualified lead.
- [ ] Identify campaigns with material performance deterioration.
- [ ] Check active campaign targeting, creative, landing pages, and form versions.
- [ ] Confirm tracking parameters and attribution identifiers are being captured.
- [ ] Review channel mix and dependency on individual acquisition sources.
- [ ] Check that campaign changes have approvals and version history.
- [ ] Identify experiments that have reached their planned review point.
- [ ] Confirm that underperforming campaigns have an owner and documented action.

**Evidence required:** Campaign scorecard, spend report, tracking QA results, experiment register, and change log.

### 10.2 Lead quality and data integrity

- [ ] Review validity, completeness, and contactability rates.
- [ ] Compare duplicate and suspected-fraud rates with approved thresholds.
- [ ] Review buyer rejection rates and standardized rejection reasons.
- [ ] Sample leads from each active supplier and material acquisition channel.
- [ ] Verify that sampled leads have source, timestamp, and provenance records.
- [ ] Confirm applicable disclosures and permission records are retrievable.
- [ ] Review enrichment source quality, freshness, and permitted-use restrictions.
- [ ] Check that suppression and opt-out records are being enforced.
- [ ] Review held and quarantined leads for timely resolution.
- [ ] Identify recurring validation failures and assign corrective actions.

**Evidence required:** Data-quality report, sampled-record audit, rejection analysis, provenance exceptions, and remediation register.

### 10.3 Supplier and buyer oversight

- [ ] Review supplier-level volume, acceptance, rejection, and conversion.
- [ ] Compare supplier performance with contractual quality requirements.
- [ ] Check for unexplained volume spikes or unusual traffic patterns.
- [ ] Review new suppliers and suppliers with changed acquisition methods.
- [ ] Confirm supplier restrictions, approval status, and documentation remain current.
- [ ] Review buyer capacity, delivery requirements, and feedback timeliness.
- [ ] Investigate repeated delivery failures or disputed lead dispositions.
- [ ] Check whether any supplier or buyer concentration creates material dependency.
- [ ] Confirm that corrective actions from the previous cycle are closed or formally escalated.

**Evidence required:** Supplier and buyer scorecards, onboarding records, exception history, and action closure evidence.

### 10.4 Routing, delivery, and platform reliability

- [ ] Review capture-to-validation and validation-to-delivery latency.
- [ ] Review API failures, retry volume, queue depth, and dead-letter events.
- [ ] Confirm idempotency controls prevent duplicate fulfillment.
- [ ] Reconcile platform delivery acknowledgements with recipient records.
- [ ] Check routing eligibility, exclusivity, distribution limits, and capacity rules.
- [ ] Review manual routing or pricing overrides.
- [ ] Confirm that high-risk and provenance-incomplete leads are blocked from distribution.
- [ ] Review open incidents and service-level breaches.
- [ ] Confirm monitoring and alert delivery are functioning.

**Evidence required:** Integration health report, delivery reconciliation, routing exception log, and incident register.

### 10.5 Commercial and financial controls

- [ ] Reconcile acquisition spend with campaign and supplier records.
- [ ] Review accepted, rejected, billable, and payable lead counts.
- [ ] Check supplier payout and buyer billing exceptions.
- [ ] Review credits, refunds, disputes, and rejection adjustments.
- [ ] Compare realized contribution margin with forecast.
- [ ] Investigate campaigns with positive volume but negative or deteriorating economics.
- [ ] Confirm that pricing overrides have an authorized approval trail.
- [ ] Update the second-half forecast where material assumptions have changed.

**Evidence required:** Finance reconciliation, billing exception report, margin analysis, and updated forecast.

### 10.6 Privacy, security, and governance

- [ ] Review new data sources, collection purposes, and sharing arrangements.
- [ ] Confirm that campaign disclosures and consent or other legal-basis records are available where required.
- [ ] Review access changes for privileged or sensitive systems.
- [ ] Check outstanding data access, correction, deletion, objection, and opt-out requests.
- [ ] Review retention or deletion exceptions.
- [ ] Check vendor or supplier security and privacy issues.
- [ ] Review security alerts, incidents, and unresolved vulnerabilities.
- [ ] Confirm that material policy exceptions have an owner, approval, and expiry or review date.

**Evidence required:** Privacy exception register, access review, request log, security report, and policy-change record.

### 10.7 Mid-month decisions and outputs

At the end of Cycle A, record:

- Campaigns to scale, maintain, throttle, or pause.
- Suppliers requiring investigation or corrective action.
- Lead-quality issues requiring rule or process changes.
- Buyers requiring capacity or feedback intervention.
- Pricing or allocation changes requiring approval.
- Platform incidents requiring engineering action.
- Compliance or security matters requiring escalation.
- Revised forecasts and second-half priorities.

**Cycle A exit criteria:** Every material exception has a severity, owner, due date, and next action. Any critical issue is escalated immediately rather than deferred to month-end.

---

## 11. Cycle B — Month-End Checklist (16th–Month-End)

**Review date:** Final business day of the month  
**Primary purpose:** Close the reporting period, validate commercial outcomes, assess control effectiveness, and establish the next month's operating plan.

### 11.1 Monthly performance close

- [ ] Freeze or identify the reporting cut-off and cohort definitions.
- [ ] Reconcile total leads captured, validated, qualified, held, rejected, and distributed.
- [ ] Reconcile campaign spend against finance records.
- [ ] Reconcile buyer deliveries, acknowledgements, acceptances, and rejections.
- [ ] Reconcile supplier payable volumes and buyer billable volumes.
- [ ] Review credits, refunds, commissions, and disputed transactions.
- [ ] Calculate CPL, cost per accepted lead, cost per qualified lead, and CAC where measurable.
- [ ] Calculate revenue and contribution margin by campaign, channel, and supplier.
- [ ] Identify immature conversion cohorts and clearly label incomplete outcomes.
- [ ] Document material variances against budget, forecast, and prior periods.

**Evidence required:** Approved month-end scorecard, financial reconciliation, cohort report, and variance commentary.

### 11.2 Supplier performance assessment

- [ ] Rank suppliers using quality, acceptance, conversion, reliability, and commercial contribution.
- [ ] Review suppliers below minimum contractual or internal standards.
- [ ] Identify suppliers suitable for controlled volume expansion.
- [ ] Review supplier concentration and single-source dependency.
- [ ] Confirm supplier documentation and approvals are current.
- [ ] Review unresolved disputes, quality claims, and corrective actions.
- [ ] Decide whether to continue, restrict, remediate, or suspend suppliers under approved procedures.
- [ ] Document decisions and communicate changes to authorized stakeholders.

**Evidence required:** Monthly supplier scorecard, supplier decision log, and remediation status.

### 11.3 Buyer and fulfillment assessment

- [ ] Review buyer acceptance and rejection performance.
- [ ] Assess time to first contact and downstream conversion feedback.
- [ ] Review buyer capacity and forecast demand.
- [ ] Confirm fulfillment SLAs and escalation contacts.
- [ ] Investigate buyers with delayed or missing outcome feedback.
- [ ] Review disputes involving exclusivity, duplication, freshness, or qualification.
- [ ] Confirm recipient eligibility and distribution restrictions for the next period.
- [ ] Identify opportunities to improve lead-to-fulfillment continuity.

**Evidence required:** Buyer scorecard, feedback completeness report, capacity forecast, and dispute register.

### 11.4 Data governance and quality review

- [ ] Review lead provenance completeness by source.
- [ ] Review consent, disclosure, and permitted-use evidence where applicable.
- [ ] Review duplicate resolution and identity-matching exceptions.
- [ ] Assess validation accuracy and recurring false-positive or false-negative patterns.
- [ ] Review enrichment provider performance and data freshness.
- [ ] Verify retention and deletion actions due during the period.
- [ ] Confirm suppression lists and opt-out controls are synchronized.
- [ ] Review access to lead exports and bulk data operations.
- [ ] Review data incidents, complaints, and remediation.
- [ ] Confirm that scoring and routing rule changes are versioned and approved.

**Evidence required:** Data governance report, retention evidence, QA sample results, access report, and model or ruleset change log.

### 11.5 Platform, security, and resilience review

- [ ] Review uptime, latency, processing throughput, and delivery success.
- [ ] Review unresolved incidents and root-cause analyses.
- [ ] Check backup completion and restoration-test status.
- [ ] Review privileged access and stale accounts.
- [ ] Review outstanding vulnerabilities and patch status.
- [ ] Check API credential and secret rotation schedules.
- [ ] Review integration contract or schema changes.
- [ ] Review queue recovery, retry behavior, and dead-letter processing.
- [ ] Confirm capacity for expected next-month demand.
- [ ] Prioritize reliability and security improvements.

**Evidence required:** Platform service report, incident postmortems, access review, vulnerability register, and recovery-test record.

### 11.6 Commercial planning and next-month readiness

- [ ] Set next-month campaign objectives and budget allocations.
- [ ] Confirm target audiences, channels, and qualification criteria.
- [ ] Review pricing and supplier payout assumptions.
- [ ] Confirm buyer demand, capacity, and delivery requirements.
- [ ] Approve planned experiments and define guardrails.
- [ ] Review forecast assumptions and expected contribution margin.
- [ ] Identify operational dependencies and resource constraints.
- [ ] Confirm campaign briefs, supplier instructions, and tracking plans are ready.
- [ ] Assign owners and dates for all next-month initiatives.

**Evidence required:** Next-month operating plan, approved budget, campaign calendar, capacity plan, and task register.

### 11.7 Month-end management sign-off

The review coordinator should circulate a concise management pack containing:

1. Executive performance summary.
2. Campaign and channel scorecards.
3. Supplier and buyer scorecards.
4. Lead-quality and provenance report.
5. Commercial reconciliation and margin analysis.
6. Platform reliability and incident summary.
7. Privacy, security, and compliance exceptions.
8. Decisions, approvals, and unresolved risks.
9. Next-month priorities and resource requirements.
10. Action register with owners and due dates.

**Cycle B exit criteria:** Financial and operational reporting is reconciled or explicitly qualified; material risks are escalated; next-month objectives and budgets are approved; and all actions are assigned.

---

## 12. Task Suggestions and Continuous Improvement Backlog

The following tasks are recommended initiatives. They are not all mandatory for every operation. Select them according to business maturity, risk, available resources, and expected return.

### 12.1 Priority task backlog

| ID     | Priority | Task                                                         | Suggested owner                | Completion evidence                            |
| ------ | -------- | ------------------------------------------------------------ | ------------------------------ | ---------------------------------------------- |
| GOV-01 | P1       | Establish a canonical lead schema and data dictionary        | Data operations                | Approved schema and field definitions          |
| GOV-02 | P1       | Define provenance and disclosure evidence requirements       | Privacy / compliance           | Approved provenance standard                   |
| GOV-03 | P1       | Standardize lead statuses and rejection reason codes         | Operations                     | Published lifecycle and reason-code registry   |
| OPS-01 | P1       | Create campaign launch and change-control templates          | Campaign operations            | Approved templates and completed launch record |
| SUP-01 | P1       | Introduce supplier onboarding and periodic review scorecards | Supplier manager               | Approved supplier register and scorecards      |
| QA-01  | P1       | Implement source-level lead sampling and QA reviews          | Data operations                | Sampling policy and QA results                 |
| FIN-01 | P1       | Reconcile delivered, accepted, billable, and payable records | Finance                        | Reconciliation report and exception log        |
| SEC-01 | P1       | Review privileged access and bulk export permissions         | Security / engineering         | Signed access review                           |
| RTG-01 | P2       | Implement routing eligibility and buyer-capacity rules       | Engineering / operations       | Tested routing policy                          |
| RTG-02 | P2       | Add idempotency and delivery reconciliation to integrations  | Engineering                    | Integration tests and delivery ledger          |
| ANA-01 | P2       | Build campaign, channel, supplier, and buyer scorecards      | Analytics                      | Published scorecards with metric definitions   |
| ANA-02 | P2       | Introduce lead-quality scoring with documented rules         | Data / analytics               | Versioned scoring model and calibration report |
| FRA-01 | P2       | Establish a fraud and abuse signal review process            | Risk / data operations         | Risk rules, review queue, and outcomes         |
| LIF-01 | P2       | Connect buyer outcomes to original lead records              | Sales operations / engineering | Verified feedback events                       |
| EXP-01 | P2       | Establish controlled acquisition experiments                 | Growth                         | Experiment register and evaluation reports     |
| REL-01 | P2       | Test backup restoration and delivery recovery                | Engineering                    | Recorded test results and remediation          |
| MOD-01 | P3       | Introduce cohort-based LTV and payback analysis              | Finance / analytics            | Cohort model with documented assumptions       |
| MOD-02 | P3       | Develop supplier and channel concentration monitoring        | Finance / analytics            | Dependency report and thresholds               |
| MOD-03 | P3       | Introduce forecasting for lead volume and buyer capacity     | Analytics / operations         | Forecast and variance report                   |
| MOD-04 | P3       | Automate recurring management reporting                      | Analytics / engineering        | Reconciled scheduled report                    |

### 12.2 Suggested task schedule

The following schedule provides a practical starting point. Dates should be assigned relative to the next Cycle A or Cycle B review.

| Timing                     | Suggested tasks                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| First review of the month  | Confirm campaign pacing, supplier quality, provenance, delivery health, and open exceptions                             |
| Between reviews            | Complete P1 remediation, investigate quality drift, and implement approved operational changes                          |
| Second review of the month | Reconcile monthly results, assess suppliers and buyers, review governance, and approve next-month priorities            |
| Following month            | Validate the impact of prior actions, close completed tasks, and carry forward approved work                            |
| Quarterly                  | Review control effectiveness, access, supplier concentration, resilience, scoring performance, and strategic priorities |

### 12.3 Recommended recurring tasks

**Every review cycle**

- [ ] Publish the review agenda and reporting cut-off.
- [ ] Collect scorecards from accountable owners.
- [ ] Review P0 and P1 incidents and exceptions.
- [ ] Sample lead records and verify provenance.
- [ ] Review supplier and buyer performance.
- [ ] Reconcile material delivery and commercial exceptions.
- [ ] Record decisions and approvals.
- [ ] Assign owners and due dates.
- [ ] Review overdue actions from the prior cycle.
- [ ] Publish the approved action register.

**Monthly**

- [ ] Complete financial reconciliation.
- [ ] Review supplier and buyer scorecards.
- [ ] Review retention and deletion obligations.
- [ ] Review access and security exceptions.
- [ ] Update forecasts and campaign plans.
- [ ] Review scoring, validation, and routing changes.
- [ ] Confirm next-month capacity and budget.

**Quarterly**

- [ ] Conduct a formal supplier risk review.
- [ ] Test incident response and recovery procedures.
- [ ] Review privileged access and role assignments.
- [ ] Assess data retention and deletion effectiveness.
- [ ] Evaluate lead scoring and fraud-control performance.
- [ ] Review market, channel, and buyer concentration.
- [ ] Reassess operational risk thresholds and service objectives.
- [ ] Present control effectiveness and strategic recommendations to leadership.

---

## 13. Task Register and Completion Standard

Maintain a single task register as the authoritative record of operational work. Avoid distributing actions across meeting notes, email threads, and informal chat messages without a central record.

### 13.1 Required task fields

| Field               | Description                                                                 |
| ------------------- | --------------------------------------------------------------------------- |
| Task ID             | Unique reference, such as QA-014                                            |
| Title               | Clear action-oriented task name                                             |
| Workstream          | Campaign, supplier, data, routing, finance, security, or governance         |
| Priority            | P0, P1, P2, or P3                                                           |
| Owner               | One accountable individual                                                  |
| Approver            | Required decision-maker, where applicable                                   |
| Created date        | Date the task was recorded                                                  |
| Due date            | Agreed completion date                                                      |
| Status              | Not started, in progress, blocked, pending approval, completed, or deferred |
| Dependencies        | Other tasks or decisions required                                           |
| Expected output     | Concrete deliverable                                                        |
| Acceptance criteria | Conditions that demonstrate completion                                      |
| Evidence reference  | Link to report, ticket, test, approval, or audit record                     |
| Completion date     | Actual completion date                                                      |
| Review outcome      | Accepted, rejected, or returned for remediation                             |

### 13.2 Definition of done

A task may be marked **Completed** only when:

1. The assigned work has been performed.
2. The expected output exists and is accessible.
3. Acceptance criteria have been checked.
4. Required approvals have been recorded.
5. Relevant evidence is linked to the task.
6. Any resulting operational or policy change is documented.
7. The task owner has recorded the completion date.

Tasks that cannot be completed by the due date must be marked **Blocked** or **Deferred**, with a reason, revised due date, accountable owner, and risk assessment. Critical controls must not be silently deferred.

### 13.3 Review meeting agenda

A standard 45–60 minute review can follow this agenda:

| Agenda item                                   | Suggested duration |
| --------------------------------------------- | -----------------: |
| Previous actions and overdue items            |       5–10 minutes |
| Campaign and acquisition performance          |         10 minutes |
| Lead quality, supplier, and buyer performance |         10 minutes |
| Delivery, platform, and incident review       |       5–10 minutes |
| Finance, margin, and reconciliation           |       5–10 minutes |
| Privacy, security, and governance exceptions  |          5 minutes |
| Decisions, owners, and deadlines              |          5 minutes |

Material incidents, unresolved compliance issues, and significant financial discrepancies should be handled through the relevant escalation process rather than compressed into a routine meeting.

---

## 14. Management Scorecard and Review Outcomes

Use a compact scorecard to establish whether the operation is improving. Every target must have an owner, a definition, a reporting window, and an approved threshold. The values below are not universal benchmarks and should be set from business requirements and observed baselines.

| Dimension            | Core measure                                      | Management question                                                |
| -------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| Acquisition          | CPL and qualified-lead cost                       | Are we acquiring demand economically?                              |
| Quality              | Validity and acceptance rates                     | Are the leads usable and relevant?                                 |
| Provenance           | Complete provenance rate                          | Can we demonstrate where leads came from and how they may be used? |
| Distribution         | Delivery success and latency                      | Are eligible leads reaching the right recipients reliably?         |
| Buyer outcomes       | Contact and conversion rates                      | Are recipients realizing value?                                    |
| Supplier performance | Acceptance and contribution margin by supplier    | Which sources create sustainable value?                            |
| Finance              | Reconciled revenue, costs, and margin             | Are reported results commercially accurate?                        |
| Reliability          | Availability and incident frequency               | Can the operation meet its service commitments?                    |
| Governance           | Open high-risk exceptions and overdue remediation | Are material risks being controlled?                               |
| Execution            | On-time task closure rate                         | Are review decisions producing completed improvements?             |

### Management decision record

For each review, record:

- Reporting period and data cut-off.
- Attendees and accountable owners.
- Material performance changes.
- Significant risks and control exceptions.
- Decisions made and supporting evidence.
- Approvals and rejected proposals.
- Tasks created, updated, or closed.
- Escalations and unresolved dependencies.
- Next review date.

The purpose of the twice-monthly cycle is not to create more meetings. It is to create a reliable management rhythm in which evidence leads to decisions, decisions lead to accountable tasks, and completed tasks lead to measurable operational improvement.

**Operating standard: Review twice monthly. Monitor continuously. Escalate critical issues immediately. Close every action with evidence.**
"""

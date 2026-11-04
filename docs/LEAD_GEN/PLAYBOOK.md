# Lead Intelligence Playbook

## 1. Purpose

The Lead Intelligence system exists to answer one question:

> **Who is most likely to become a valuable customer, and why?**

The objective is not to collect the largest possible number of contacts.

The objective is to produce **accurate, fresh, qualified, actionable, and commercially relevant leads** that buyers are willing to pay for.

### Core pipeline

```text
DISCOVER
   ↓
IDENTIFY
   ↓
NORMALIZE
   ↓
ENRICH
   ↓
VERIFY
   ↓
RESOLVE
   ↓
QUALIFY
   ↓
SCORE
   ↓
PACKAGE
   ↓
SELL
   ↓
FEEDBACK
   ↓
IMPROVE
```

---

# 2. Lead Intelligence Principles

### 2.1 Quality over volume

A lead is valuable because it has a high probability of being useful, not because it exists.

```text
10,000 contacts × 5% useful = 500 useful leads

1,000 contacts × 70% useful = 700 useful leads
```

The second dataset is the better product.

---

### 2.2 Every claim needs evidence

Don't allow the system to simply say:

> "High intent."

It should be able to answer:

> **Why?**

For example:

```text
Intent: HIGH

Evidence:
✓ Company recently expanded
✓ Hiring relevant positions
✓ Technology stack matches product
✓ Target decision maker identified
✓ Relevant website activity
✓ Recent funding event
```

---

### 2.3 Freshness is a product feature

Lead data decays.

Every important attribute should have:

```text
value
source
confidence
observed_at
verified_at
expires_at
```

Example:

```text
Job Title
VP Engineering

Source:
Company website

Verified:
2026-11-02

Confidence:
98%
```

---

### 2.4 Don't confuse data with intelligence

Data:

> Acme has 180 employees.

Intelligence:

> Acme is a 180-person SaaS company that recently expanded its engineering organization and therefore fits the target profile for an engineering automation product.

The second is what customers pay for.

---

# 3. Define the Ideal Customer Profile

Every intelligence operation starts with an ICP.

The ICP should contain five dimensions.

## Firmographic

- Industry
- Geography
- Employee count
- Revenue
- Growth
- Company age
- Funding

## Technographic

- Technologies
- Cloud providers
- Frameworks
- Infrastructure
- SaaS dependencies

## Organizational

- Decision-maker roles
- Department
- Seniority
- Team size
- Hiring activity

## Behavioral

- Website activity
- Product research
- Hiring
- Expansion
- Technology changes
- Engagement

## Commercial

- Potential contract value
- Buying capacity
- Existing vendor
- Likely use case
- Estimated urgency

---

# 4. Build the Target Market

Do not begin with individual people.

Start with **companies**.

```text
Market
  ↓
Industry
  ↓
Segment
  ↓
Company
  ↓
Department
  ↓
Decision Maker
  ↓
Contact
```

Example:

```text
US
└── SaaS
    └── 50–500 employees
        └── Engineering-heavy
            └── AWS
                └── CTO / VP Engineering
```

This creates a much stronger foundation for lead intelligence.

---

# 5. Account Discovery

The first objective is identifying companies that fit the ICP.

### Sources

Use multiple independent sources where possible:

- Company websites
- Public business directories
- Industry databases
- Search results
- Government/public registries
- Professional sources
- Event/exhibitor lists
- Job postings
- Technology detection
- Public company announcements
- Approved third-party data providers

Every discovered company should receive a provenance record.

```text
Company
  ↓
Source A
Source B
Source C
  ↓
Confidence
```

---

# 6. Entity Resolution

This is one of the most important parts of the system.

Different sources may describe the same company differently:

```text
Acme Inc.
Acme Incorporated
Acme.io
ACME Technologies
```

The system should resolve them into:

```text
Organization ID: ORG_84721
Canonical Name: Acme Technologies
Domain: acme.io
```

### Resolution signals

- Domain
- Website
- Company name
- Address
- Phone
- Registration information
- Social/profile identifiers

Do not automatically merge ambiguous entities.

Use:

```text
EXACT
PROBABLE
POSSIBLE
UNKNOWN
```

---

# 7. Company Intelligence

Once the company exists, build its intelligence profile.

### Company profile

```text
Acme Technologies

Industry        SaaS
Location        San Francisco
Employees       180
Revenue         $10M–$25M
Founded         2018

Technology
AWS
React
Stripe
PostgreSQL

Growth
+22% employee growth
18 open positions

Signals
Recent expansion
Hiring engineers
New product launch
```

This becomes the **account intelligence record**.

---

# 8. Contact Intelligence

Only after identifying the right companies should you identify the right people.

Target:

- Decision makers
- Budget owners
- Technical evaluators
- Influencers
- Procurement
- Relevant department heads

Don't simply collect every employee.

The objective is:

> **The right person at the right company.**

---

# 9. Contact Verification

Each contact should be evaluated independently.

### Identity

- Name
- Role
- Company
- Department
- Seniority

### Contactability

- Email
- Phone
- Professional profile
- Contact status

### Validation

```text
Email
 ↓
Syntax
 ↓
Domain
 ↓
Mailbox
 ↓
Risk
 ↓
Confidence
```

Never represent an unverified email as verified.

---

# 10. Signal Collection

This is where lead intelligence becomes substantially more valuable.

Build a **signal engine**.

### Growth signals

- Hiring surge
- Funding
- New offices
- Expansion
- Revenue growth
- Headcount growth

### Technology signals

- New technology adoption
- Technology migration
- New infrastructure
- Product launches
- Platform changes

### Organizational signals

- New executive
- New department
- Leadership change
- Team expansion

### Commercial signals

- New market
- New product
- Partnership
- Acquisition
- Pricing changes

### Intent signals

- Relevant content consumption
- Product research
- Website behavior where lawfully available
- Job postings related to the buyer's product
- Repeated relevant activity

---

# 11. Signal Strength

Not every signal should have equal weight.

Example:

| Signal                   | Strength |
| ------------------------ | -------: |
| Funding announcement     |     High |
| Relevant executive hired |     High |
| Major expansion          |     High |
| Relevant hiring          |   Medium |
| Technology detected      |   Medium |
| Generic website update   |      Low |

Each signal should have:

```text
signal
source
observed_at
strength
confidence
expiration
```

Signals should decay over time.

A six-month-old hiring event should not have the same weight as yesterday's announcement.

---

# 12. Lead Qualification

Separate **fit** from **intent**.

This is critical.

A company can be:

```text
Excellent fit
Low intent
```

or:

```text
Poor fit
High intent
```

Neither should automatically become a high-quality lead.

Use two independent dimensions:

```text
FIT
+
INTENT
=
PRIORITY
```

---

# 13. Lead Scoring Model

I'd use four major dimensions.

```text
                LEAD SCORE

       ┌───────────────┐
       │   COMPANY FIT │  30%
       └───────────────┘
               +
       ┌───────────────┐
       │ CONTACT FIT   │  20%
       └───────────────┘
               +
       ┌───────────────┐
       │ INTENT        │  30%
       └───────────────┘
               +
       ┌───────────────┐
       │ DATA QUALITY  │  20%
       └───────────────┘
```

Example:

```text
Company Fit       29/30
Contact Fit       19/20
Intent            27/30
Data Quality      20/20
────────────────────────
Total             95/100
```

---

# 14. Confidence Score

Do not confuse **lead score** with **data confidence**.

A lead can be highly relevant but poorly verified.

Use both:

```text
Lead Score       94
Data Confidence  97%
```

This is a powerful distinction.

### Lead Score

> How commercially valuable is this prospect?

### Confidence

> How confident are we that our information is correct?

---

# 15. Lead Tiers

Create clear commercial tiers.

### Tier S

```text
90–100
Excellent fit
Strong intent
Highly verified
```

### Tier A

```text
80–89
Strong fit
Good signals
Verified
```

### Tier B

```text
70–79
Good fit
Moderate signals
```

### Tier C

```text
60–69
Potential fit
Weak signals
```

### Reject

```text
<60
```

You can then price the inventory accordingly.

---

# 16. Lead Packaging

The intelligence system should turn raw leads into **products**.

For example:

### Product

**US SaaS Engineering Leaders**

```text
2,500 leads

ICP Match          94%
Email Verified     97%
Company Verified   99%
Fresh <30 days     91%
Average Score      87
High Intent        64%

$2,500
```

This is much easier to sell than:

> "Here's a CSV with 2,500 emails."

---

# 17. Lead Inventory

Your internal system should treat leads like inventory.

Each lead has:

```text
AVAILABLE
RESERVED
SOLD
DELIVERED
REJECTED
REPLACED
EXPIRED
```

This becomes especially important if you offer exclusivity.

Example:

```text
Lead #184721

Status:
AVAILABLE

Allowed sales:
3

Sold:
1

Remaining:
2
```

Or:

```text
EXCLUSIVE

Available:
NO
```

---

# 18. Quality Assurance

Before a lead enters the marketplace:

```text
              LEAD QA
                 │
        ┌────────┴────────┐
        ↓                 ↓
   Company Check      Contact Check
        │                 │
        ↓                 ↓
   Identity          Identity
   Industry          Role
   Domain            Email
   Location          Phone
        │                 │
        └────────┬────────┘
                 ↓
          Signal Validation
                 ↓
          Score Validation
                 ↓
            QA Decision
                 ↓
        ┌────────┴────────┐
        ↓                 ↓
      ACCEPT             REJECT
```

---

# 19. Buyer Feedback

This is the most strategically important feedback loop.

After a customer buys a lead, collect:

```text
Was this lead accurate?
Was the contact correct?
Was the company relevant?
Was the contact reachable?
Was the lead useful?
Did you contact them?
Did they respond?
Did this become an opportunity?
Did this become a customer?
```

Don't merely ask for a star rating.

Capture structured outcomes.

---

# 20. Intelligence Feedback Loop

Your system should learn from actual outcomes.

```text
                LEAD
                  ↓
                SOLD
                  ↓
               USED
                  ↓
             SALES RESULT
                  ↓
        ┌─────────┴─────────┐
        ↓                   ↓
     SUCCESS              FAILURE
        ↓                   ↓
Increase score       Reduce score
Increase source      Reduce source
weight               weight
        └─────────┬─────────┘
                  ↓
            BETTER MODEL
```

Eventually you can discover:

> "Leads with these five characteristics convert 3.7× better."

That becomes proprietary intelligence.

---

# 21. Marketplace Metrics

Don't optimize for lead count.

Track:

### Supply

- Leads discovered
- Leads qualified
- Leads available
- Leads sold

### Quality

- Verification rate
- Rejection rate
- Replacement rate
- Buyer acceptance rate

### Commercial

- Revenue per lead
- Revenue per customer
- Average order value
- Repeat purchase rate
- Subscription retention

### Intelligence

- Score → conversion correlation
- Signal → conversion correlation
- Source → conversion correlation
- Freshness → conversion correlation

The last group is where your moat starts forming.

---

# 22. The Lead Intelligence Flywheel

Your entire business should eventually look like this:

```text
          MORE DATA
             ↓
       BETTER RESOLUTION
             ↓
       BETTER ENRICHMENT
             ↓
        BETTER SIGNALS
             ↓
       BETTER QUALIFICATION
             ↓
        BETTER LEADS
             ↓
       MORE CUSTOMER SALES
             ↓
        MORE FEEDBACK
             ↓
       BETTER INTELLIGENCE
             │
             └──────────────→ MORE DATA
```

That flywheel is the business.

---

# 23. Operational Playbook

For every new market or lead product:

### Step 1

Define ICP.

### Step 2

Define target companies.

### Step 3

Identify acquisition sources.

### Step 4

Collect company candidates.

### Step 5

Resolve company identities.

### Step 6

Enrich companies.

### Step 7

Identify relevant contacts.

### Step 8

Verify contact information.

### Step 9

Collect intent and business signals.

### Step 10

Calculate fit.

### Step 11

Calculate intent.

### Step 12

Calculate data confidence.

### Step 13

Calculate final lead score.

### Step 14

Run QA.

### Step 15

Assign commercial tier.

### Step 16

Add to inventory.

### Step 17

Package into lead products.

### Step 18

Sell.

### Step 19

Collect buyer feedback.

### Step 20

Feed outcomes back into scoring.

---

# 24. The North Star

I'd make your internal definition of a **high-quality lead** extremely explicit:

> **A high-quality lead is a recently verified person who has an appropriate role at a company that strongly matches the target customer profile, supported by credible evidence of business relevance or buying intent.**

That definition gives you something much more valuable than a database.

It gives you a **quality standard you can operationalize, measure, price, and eventually defend as proprietary intelligence.**

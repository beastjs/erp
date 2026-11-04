For this project, I would **not** design it like a conventional CRM. That would bury the interesting part of the product under contacts, forms, and tables.

I’d design it as an **operations cockpit for lead acquisition**, with the campaign as the primary unit of work.

## Recommended product structure

```text
┌─────────────────────────────────────────────────────────────┐
│  LeadForge                                      🔔  ◎ User  │
├──────────────┬──────────────────────────────────────────────┤
│              │                                              │
│  Overview    │   Campaign: US SaaS CTOs                     │
│              │                                              │
│  Campaigns   │   ┌────────┐ ┌────────┐ ┌────────┐ ┌──────┐ │
│              │   │ 12,482 │ │ 4,218  │ │ 1,284  │ │ 187  │ │
│  Leads       │   │Found   │ │Enriched│ │Qualified│ │Ready │ │
│              │   └────────┘ └────────┘ └────────┘ └──────┘ │
│  Companies   │                                              │
│              │   ┌──────────────────────────────────────┐   │
│  Contacts    │   │ Acquisition Pipeline                  │   │
│              │   │                                      │   │
│  Sources     │   │ Discover → Enrich → Validate → Score │   │
│              │   │   █████    ██████     █████     ████ │   │
│  Enrichment  │   └──────────────────────────────────────┘   │
│              │                                              │
│  Automations │   ┌──────────────────┐ ┌──────────────────┐  │
│              │   │ Lead Quality      │ │ Source Performance│ │
│  Analytics   │   │                  │ │                  │  │
│              │   │  ████████  87%   │ │ Google     42%   │  │
│              │   │                  │ │ Directory  31%   │  │
│  ──────────  │   │                  │ │ Referral   18%   │  │
│              │   └──────────────────┘ └──────────────────┘  │
│  Settings    │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

The key idea is:

> **Campaigns are the command center. Leads are the resulting assets.**

---

# 1. The primary navigation

I'd keep the navigation relatively small.

### Main

- **Overview**
- **Campaigns**
- **Leads**
- **Companies**
- **Contacts**

### Intelligence

- **Sources**
- **Enrichment**
- **Scoring**
- **Automations**

### Operations

- **Analytics**
- **Jobs**
- **Integrations**

### Administration

- **Settings**

Don't make 20 different top-level sections. Most functionality should live inside the campaign and lead contexts.

---

# 2. Overview

The overview should answer one question:

> **"What's happening with our acquisition system right now?"**

Not generic CRM metrics.

I'd use five primary metrics:

```text
Leads discovered
Leads qualified
Sales-ready leads
Conversion rate
Pipeline value
```

Then:

### Acquisition velocity

```text
Leads
│
│                    ╭──────
│               ╭────╯
│          ╭────╯
│     ╭────╯
│─────╯
└──────────────────────────
   Mon Tue Wed Thu Fri
```

### Campaign performance

| Campaign       |  Leads | Qualified | Ready | Conversion |
| -------------- | -----: | --------: | ----: | ---------: |
| US SaaS CTOs   | 12,482 |     1,284 |   187 |      14.5% |
| Fintech PH     |  8,241 |       912 |   104 |      11.4% |
| Singapore SaaS |  4,892 |       621 |    96 |      15.5% |

### System health

This is important for your architecture:

```text
Discovery       ● Healthy
Enrichment      ● Healthy
Validation      ● Healthy
Scoring         ● Healthy
CRM Sync        ● Degraded
```

The dashboard should expose operational problems before they become mysterious sales problems.

---

# 3. Campaigns should be the heart of the application

This is where I'd make the UI distinctive.

Instead of:

> Campaign → settings → leads → analytics

I'd make the campaign itself an **interactive workspace**.

### Campaign header

```text
US SaaS CTOs

Active · Running for 3d 14h

[ Pause ] [ Run Now ] [ Edit ]

12,482 discovered
4,218 enriched
1,284 qualified
187 sales-ready
```

Then tabs:

```text
Overview | Leads | Discovery | Enrichment | Scoring | Activity | Settings
```

---

# 4. Campaign Overview

The campaign overview should look like a mission-control screen.

```text
US SaaS CTOs
────────────────────────────────────────────────────────

Campaign Health                 Acquisition Funnel

● Running                       Discovered     12,482
                                 ↓
                                 Enriched       4,218
                                 ↓
                                 Validated      3,892
                                 ↓
                                 Qualified      1,284
                                 ↓
                                 Sales Ready      187


Performance                     Sources

Qualified Rate     30.4%        Search          48%
Sales Ready         4.4%        Directory       27%
Cost / Qualified   $2.84        Referral        15%
                                 Other           10%
```

This is much more useful than a traditional CRM dashboard.

---

# 5. Discovery should feel like a query builder

This is another major UI.

Instead of asking users to configure dozens of fields, let them define a target.

### Target definition

```text
Find companies where:

Industry       [ SaaS                  ]
Location       [ United States         ]
Employees      [ 50 ] ─────── [ 500    ]
Revenue        [ $5M+                  ]

Technologies   [ React ] [ AWS ] [ + ]

Contacts

Title          [ CTO                   ]
Seniority      [ C-Level ] [ VP        ]

                    [ Preview 1,000 ]
```

Then show:

```text
Estimated Results

~18,400 companies
~31,200 contacts
~8,200 likely matches

[ Start Campaign ]
```

This gives the user immediate feedback before spending resources.

---

# 6. Leads should be an extremely powerful table

This will probably be the most-used screen.

But don't make it a boring CRM table.

### Left side

Filters:

```text
LEADS

Status
☐ New
☐ Qualified
☐ Sales Ready
☐ Contacted

Score
[ 70 ───────── 100 ]

Industry
☐ SaaS
☐ Fintech
☐ Healthcare

Company size
☐ 50–100
☐ 100–500
☐ 500+

Source
☐ Search
☐ Directory
☐ Referral
```

### Main table

```text
☐  Lead                    Company       Score   Intent   Status

☐  Sarah Chen              Acme.io        94      High     READY
☐  Michael Wong            Cloudbase      91      High     READY
☐  David Smith             Finstack       86      Med      QUALIFIED
☐  Anna Garcia             Flowstack      78      Med      QUALIFIED
```

Use subtle score visualization rather than giant colorful badges.

---

# 7. The Lead Detail page is extremely important

I'd make this almost like an intelligence dossier.

```text
Sarah Chen
VP Engineering · Acme.io

94  SALES READY

────────────────────────────────────────────────────

CONTACT
Sarah Chen
VP Engineering
sarah@acme.io
San Francisco, CA

COMPANY
Acme.io
SaaS
180 employees
$20M–$50M revenue

────────────────────────────────────────────────────

WHY THIS LEAD?

✓ ICP industry
✓ ICP company size
✓ Decision maker
✓ Target geography
✓ Relevant technology
✓ High buying intent

Score: 94

────────────────────────────────────────────────────

ACTIVITY

Oct 31   Company discovered
Nov 01   Contact enriched
Nov 01   Email verified
Nov 02   Intent signal detected
Nov 03   Score increased 82 → 94
```

And critically:

### Evidence

```text
SIGNALS

Technology
AWS
React
Stripe

Intent
Hiring 4 engineers
Recently expanded US operations
Visited pricing page

Sources
Source A
Source B
Source C
```

This creates **trust in the data**.

---

# 8. Don't hide the scoring logic

I'd make the score clickable.

```text
94 / 100

Company Fit                         30/30
████████████████████████████

Contact Fit                         20/20
████████████████████████████

Business Need                       18/20
███████████████████████

Intent                              15/15
████████████████████████

Engagement                           6/10
██████████████
```

Then:

> **Why 94?**

That is an excellent product differentiator.

---

# 9. Sources

Sources should be treated as infrastructure rather than merely marketing channels.

```text
Sources

┌──────────────────────────────────────────────────┐
│ Google Search                     ● Connected    │
│ 12,420 discovered · 42% qualified               │
│                                                  │
│ Directory API                     ● Connected    │
│ 8,214 discovered · 31% qualified                │
│                                                  │
│ CSV Import                        ● Available    │
│                                                  │
│ Custom API                        + Connect      │
└──────────────────────────────────────────────────┘
```

Clicking a source should show:

- Requests
- Leads discovered
- Success rate
- Cost
- Rate limits
- Errors
- Last execution
- Campaign usage

---

# 10. Enrichment should have a provider matrix

This is especially useful operationally.

```text
Enrichment Providers

                  Requests    Success    Cost       Status

Company Data       12,482      97.2%      $42.18     ●
Contact Data        8,214      91.4%      $61.40     ●
Email Validation   18,420      99.1%      $12.21     ●
Intent Provider     4,102      84.3%      $28.90     ⚠
```

You immediately see which provider is causing problems.

---

# 11. Automations

I would use a visual workflow builder, but keep it restrained.

```text
WHEN

Lead score becomes ≥ 80

        ↓

AND

Company is in United States

        ↓

THEN

Assign to Sales Team

        ↓

AND

Create CRM Lead

        ↓

AND

Send Slack notification
```

Eventually:

```text
[Trigger]
    ↓
[Condition]
    ↓
[Enrich]
    ↓
[Score]
    ↓
[Route]
    ↓
[CRM]
```

This could become one of the strongest parts of the product.

---

# 12. Analytics

Analytics should answer business questions rather than just display charts.

I'd organize it into:

### Acquisition

> Which sources produce the most leads?

### Quality

> Which sources produce the best leads?

### Conversion

> Which leads actually become customers?

### Economics

> Which campaigns make money?

For example:

```text
SOURCE PERFORMANCE

                 Leads   Qualified   Opps   Customers

Search            12K      1,840      182       31
Directories        8K      1,420      143       28
Referrals          2K        810      112       34
```

Suddenly the "best source" isn't necessarily the one producing the most leads.

---

# 13. Jobs deserves its own operational screen

Because this is an automation-heavy application, I'd absolutely expose the job system.

```text
JOBS

● Running      14
✓ Completed   8,421
⚠ Failed         23
↻ Retrying        8

────────────────────────────────────────────

enrich_company       2,412    ✓
validate_email       1,921    ✓
discover_contacts    1,284    ●
calculate_score        812    ●
crm_sync               23    ⚠
```

Click a failed job:

```text
Job #84721

Type       enrich_company
Status     Failed
Attempts   3

Error
Provider timeout

Retry policy
3 / 5 attempts

[ Retry ]
[ View Logs ]
```

This will save someone's sanity at 2:17 AM.

---

# 14. Visual design

Given the type of application, I'd go with a **dark, restrained, data-dense interface**.

Think:

- Black / near-black background
- Very subtle borders
- White/gray typography
- One primary accent
- Green only for healthy/success
- Amber for warnings
- Red for actual problems
- Small radius
- Dense tables
- Minimal gradients
- Strong typography hierarchy
- Lots of whitespace around important metrics

Something between:

**Linear + Vercel + modern data operations console**

rather than:

**Salesforce + HubSpot + enterprise-dashboard soup.**

---

# 15. The most important UX decision

I'd make the **campaign page the center of gravity**.

The mental model becomes:

```text
                    CAMPAIGN
                       │
          ┌────────────┼────────────┐
          ↓            ↓            ↓
      DISCOVERY    ENRICHMENT    SCORING
          │            │            │
          └────────────┼────────────┘
                       ↓
                     LEADS
                       ↓
                   QUALIFIED
                       ↓
                    SALES
                       ↓
                   CONVERSION
                       │
                       └──────→ FEEDBACK
```

That gives the application a coherent identity.

It isn't:

> "Here's another CRM where you can store contacts."

It's:

> **"Tell us who you want to find. We'll build, qualify, and operate the pipeline."**

That's the product I'd build.

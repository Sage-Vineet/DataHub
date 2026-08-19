## Purpose

The SDE/EBITDA bridge: how ingested general-ledger data becomes a Reported EBITDA, how add-backs are
sourced and applied to it, and how the result is presented as Adjusted EBITDA or SDE. Covers
`QE - 0004` only. Everything else in the `qoe` product capability — tax reconciliation, proof of cash,
working capital, concentration, aging, export — remains unbuilt and is specified in
`openspec/product/specs/qoe/spec.md` as intent.

Requirements are traced to `QE - 0004` (Josh Tonnesen, 14 Aug 2026) and asserted against the
engagement workbook (`Data walkthrough 05.05.2026.xlsx`).

## ADDED Requirements

### Requirement: The income statement is derived from the ledger with an explicit sign convention

The system SHALL compute revenue, expenses and net income from general-ledger rows joined to the
chart of accounts, applying the income/expense sign from the account's classification rather than
from the ledger amount. Where a profit-and-loss account carries no income/expense classification the
system SHALL fail the calculation rather than treat the account as zero. (`QE - 0004`, `DB - 0002`)

#### Scenario: Revenue and expenses both arrive positive
- **WHEN** a ledger export presents revenue and expense amounts as positive figures
- **THEN** net income is revenue less expenses, not their sum

#### Scenario: An unclassified account stops the calculation
- **WHEN** a profit-and-loss account has no income/expense classification
- **THEN** the calculation fails naming that account, rather than returning a figure

### Requirement: EBIT add-backs are sourced from account-level classification, never from account names

The system SHALL identify Interest Income, Interest Expense, Income Tax Expense, Depreciation and
Amortization from a classification stored on the chart-of-accounts record, and SHALL NOT infer any of
them from the account's name. An account carrying no classification SHALL contribute nothing to
Reported EBITDA. (`QE - 0004`)

#### Scenario: An operating tax is not an income tax
- **WHEN** accounts named "Meals Tax", "Real estate taxes" and "Taxes & Licenses" exist and none is
  classified as income tax
- **THEN** none of them contributes to the income tax line, and Reported EBITDA excludes all three

#### Scenario: Classification is what moves the total
- **WHEN** an account is classified as income tax
- **THEN** Reported EBITDA increases by exactly that account's ledger amount

### Requirement: Unclassified profit-and-loss accounts are disclosed

The system SHALL report, alongside the bridge, every profit-and-loss account carrying no EBITDA
classification, so a reviewer can see what was omitted rather than discover it later. (`QE - 0004`)

#### Scenario: Omissions are visible on the bridge
- **WHEN** the bridge renders with unclassified accounts present
- **THEN** those accounts are listed with the calculation

### Requirement: Reported EBITDA is built from itemized add-backs

The system SHALL calculate Reported EBITDA as net income plus interest expense, less interest income,
plus depreciation, amortization and income tax expense; and SHALL display each of those as its own
line, never pre-aggregated. A line SHALL be absent rather than shown as zero when no account carries
its classification. (`QE - 0004`)

#### Scenario: Each EBIT add-back is its own line
- **WHEN** Reported EBITDA renders
- **THEN** interest expense, interest income, depreciation, amortization and income tax each appear
  separately, and any with no classified account is absent

### Requirement: Adjusted EBITDA and SDE differ only in owner compensation

The system SHALL present a bottom-line figure labelled per the company's configured earnings metric,
and SHALL apply an owner-compensation rule differing only by convention: Adjusted EBITDA adds back
owner compensation net of one market-rate replacement salary, SDE adds back the full amount. This
SHALL be the only structural difference. The system SHALL also present the figure as a percentage of
revenue. (`QE - 0004`, `CP - 0001`)

#### Scenario: Only the replacement salary changes
- **WHEN** the metric convention is switched between Adjusted EBITDA and SDE
- **THEN** the two results differ by exactly one market-rate replacement salary, and every line above
  owner compensation is identical

#### Scenario: No replacement salary configured
- **WHEN** no market-rate replacement salary is set
- **THEN** Adjusted EBITDA adds back the full owner compensation

### Requirement: Add-backs are created through a typed wizard that gates on sourcing

The system SHALL require the user to select a sourcing type — P&L Account/Vendor, Balance Sheet
Change, Manual Adjustment, or Recast — before collecting any other field, and SHALL apply per-type
rules:

- **P&L Account/Vendor** SHALL require a linked GL account, SHALL take its amount from the ledger, and
  SHALL reject a manually supplied amount.
- **Manual Adjustment** SHALL require a written explanation before saving.
- **Recast** SHALL require a linked account and a normalized post-close value, and SHALL calculate the
  add-back as the difference between the actual ledger amount and that value.

(`QE - 0004`)

#### Scenario: A ledger-sourced amount cannot be typed in
- **WHEN** a P&L Account/Vendor add-back is submitted with an amount
- **THEN** the request is refused

#### Scenario: An unexplained manual adjustment is refused
- **WHEN** a Manual Adjustment is submitted with no written explanation
- **THEN** the request is refused

#### Scenario: A recast measures against its normalized value
- **WHEN** an account with a ledger amount of 240,741.20 is recast to 180,000
- **THEN** the add-back is 60,741.20

### Requirement: Add-back scope, granularity and grouping

The system SHALL allow an add-back to be scoped to specific vendors within an account, with an empty
scope meaning the whole account; SHALL allow its amount to be entered at period-level detail or
smoothed evenly across the displayed periods; and SHALL allow add-backs to be grouped under a
user-defined subtotal header that can be collapsed without losing the underlying detail.
(`QE - 0004`)

#### Scenario: A smoothed add-back spreads evenly
- **WHEN** a smoothed add-back of 12,000 is displayed across twelve monthly columns
- **THEN** each column shows 1,000

### Requirement: One data source at a time, with records retained across the toggle

The system SHALL provide a data-source selection of Company Financials or Tax Return, defaulting to
Company Financials, SHALL recalculate every row from the selected source alone, and SHALL NEVER mix
the two in one view. An add-back entered under one source SHALL be retained when the other is
selected. (`QE - 0004`)

#### Scenario: Sources never mix
- **WHEN** the data source is toggled
- **THEN** only add-backs belonging to the selected source contribute, and the others are retained
  rather than deleted

#### Scenario: The net income note follows the source
- **WHEN** the data source changes
- **THEN** the net income line's note states which source it came from

### Requirement: Periods are selected discretely and aggregated by toggle

The system SHALL let the user include or exclude individual fiscal years rather than choose a
continuous date range, SHALL allow column aggregation to be toggled between annual and monthly, and
SHALL default to annual columns covering every fiscal year present in the ingested data.
(`QE - 0004`)

#### Scenario: Non-adjacent years can be shown together
- **WHEN** the user selects FY2023 and FY2025 only
- **THEN** exactly those two columns are displayed

#### Scenario: Monthly columns reconcile to the annual figure
- **WHEN** a year is displayed monthly
- **THEN** its monthly figures sum to the annual figure

### Requirement: Commentary accompanies every bridge line and is never auto-saved

The system SHALL provide commentary against every bridge line, SHALL pre-populate each EBIT line with
standard non-deal-specific rationale, and SHALL allow a generated draft to be requested. A generated
draft SHALL be returned for review and SHALL NOT be persisted until the user explicitly confirms it.
(`QE - 0004`)

#### Scenario: A draft is not a save
- **WHEN** a commentary draft is generated
- **THEN** the stored record is unchanged until the user confirms

### Requirement: Add-backs are one shared library across modules

The system SHALL persist add-backs as records scoped to a company and report version, and downstream
consumers — including the CIM's Adjusted EBITDA exhibit — SHALL read those same records rather than
maintaining a separate calculation. (`QE - 0004`)

#### Scenario: The CIM cannot disagree with the QoE tab
- **WHEN** the CIM's Adjusted EBITDA exhibit renders
- **THEN** it reflects the same add-back records and the same computed figures as the bridge

### Requirement: The bridge is tenant-scoped

The system SHALL deny access to a report version belonging to a company the requesting user cannot
access, and SHALL reject an add-back whose company does not match its report version. (`SY - 0002`)

#### Scenario: Cross-tenant access is denied
- **WHEN** a user requests a bridge for a company they cannot access
- **THEN** the request is denied

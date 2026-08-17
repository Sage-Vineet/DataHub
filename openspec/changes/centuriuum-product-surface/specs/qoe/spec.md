## Purpose

The quality-of-earnings engagement surface — the platform's analytical core and its largest single
module (15 features). Covers tax reconciliation (`QE - 0001`), full tax return mapping (`QE - 0002`),
proof of cash (`QE - 0003`), the SDE/EBITDA bridge (`QE - 0004`), executive summary and tracker
(`QE - 0005`), working capital (`QE - 0006`), risks and opportunities (`QE - 0007`), CIM comparison
(`QE - 0008`), customer concentration (`QE - 0009`), vendor concentration (`QE - 0010`), AR aging
(`QE - 0011`), AP aging (`QE - 0012`), workbook export (`QE - 0013`), PowerPoint creation
(`QE - 0014`), and the Q&A generator (`QE - 0015`).

**Fidelity: sketch.** Reads from `financial-data` throughout; `QE - 0004`'s add-back substantiation
depends on the payroll integration in `external-integrations` (`DR - 0007`).

## ADDED Requirements

### Requirement: Tax to book reconciliation

The system SHALL produce a bridge from tax return net income to net income per the financial statements.
(`QE - 0001`)

#### Scenario: Bridge produced
- **WHEN** both tax return data and financial data are loaded for a period
- **THEN** the bridge presents the reconciling items between tax and book net income

#### Scenario: Unexplained difference is surfaced
- **WHEN** the bridge does not fully reconcile
- **THEN** the residual is shown as an open item rather than absorbed into a plug

### Requirement: Chart of accounts mapped to the tax return

The system SHALL support mapping the generated COA into the tax return table. This is a
nice-to-have rather than a launch requirement, is not solvable on every engagement, and generally
requires the tax reconciliation to be complete first. (`QE - 0002`)

#### Scenario: Mapping where solvable
- **WHEN** a user maps COA accounts to tax return lines
- **THEN** the mapping is stored and used in the reconciliation

### Requirement: Proof of cash

The system SHALL compare balance sheet cash balances against bank statements, and bank statement
activity against the financial data. (`QE - 0003`)

#### Scenario: Balance comparison
- **WHEN** bank statement and financial data are loaded for a period
- **THEN** ending balances are compared and differences itemized

#### Scenario: Activity comparison
- **WHEN** statement activity is compared against recorded activity
- **THEN** unmatched deposits and withdrawals are listed

### Requirement: SDE / EBITDA bridge with a convention toggle

The system SHALL let the user calculate adjusted EBITDA or SDE with the convention toggled per deal, and
SHALL apply guardrails that keep adjustments supported rather than free-form. (`QE - 0004`)

#### Scenario: Convention set per deal
- **WHEN** a deal's convention is set to SDE or EBITDA
- **THEN** the bridge and every downstream consumer use that convention consistently

#### Scenario: Adjustment requires support
- **WHEN** an add-back is entered
- **THEN** the system prompts for its basis and links the supporting data or document

#### Scenario: Bridge output feeds downstream features
- **WHEN** the bridge is complete
- **THEN** adjusted earnings are available to the teaser, CIM, valuation, and offer comparison features

### Requirement: Executive summary and engagement tracker

The system SHALL present an engagement overview showing whether each component — bank reconciliation,
tax return, and the other workstreams — is complete, drawing summary information from completed tasks.
(`QE - 0005`)

#### Scenario: Status at a glance
- **WHEN** a reviewer opens the engagement
- **THEN** each workstream's completion status is visible without opening each tab

### Requirement: Working capital analysis

The system SHALL provide a working capital analysis presenting reported figures alongside commentary
drawn from Q&A. (`QE - 0006`)

#### Scenario: Analysis with commentary
- **WHEN** working capital is reviewed
- **THEN** the reported figures and the related Q&A commentary appear together

### Requirement: Risks and opportunities register

The system SHALL store risks and opportunities identified from Q&A, the financials, and elsewhere in the
engagement, as a register available to downstream deliverables. (`QE - 0007`)

#### Scenario: Item captured from Q&A
- **WHEN** a risk or opportunity is identified during Q&A
- **THEN** it can be captured into the register with its source

#### Scenario: Register feeds the valuation narrative
- **WHEN** the valuation summary is produced
- **THEN** register items are available for its commentary

### Requirement: CIM comparison

The system SHALL compare the CIM against the recalculated SDE/EBITDA bridge and highlight variances.
(`QE - 0008`)

#### Scenario: Variance highlighted
- **WHEN** the CIM's stated earnings differ from the recalculated bridge
- **THEN** the difference is presented per line with its magnitude

### Requirement: Customer concentration analysis

The system SHALL present customer concentration through graphs and tables over the loaded data.
(`QE - 0009`)

#### Scenario: Concentration presented
- **WHEN** revenue detail by customer is available
- **THEN** concentration is shown with the largest customers and their share by period

### Requirement: Vendor and expense concentration analysis

The system SHALL present vendor concentration, optionally toggled by account or across all expenses.
This is lower priority than customer concentration and harder to systematize. (`QE - 0010`)

#### Scenario: Vendor concentration by account
- **WHEN** a user toggles to a specific expense account
- **THEN** concentration is presented for that account

### Requirement: AR and AP aging analysis

The system SHALL present AR and AP aging reports with the supporting detail and the analysis around
them. (`QE - 0011`, `QE - 0012`)

#### Scenario: Aging with detail
- **WHEN** aging data is loaded
- **THEN** the aging buckets and their underlying detail are presented

### Requirement: Workbook export

The system SHALL export the full QoE — with per-tab selection — into a workbook, including the reports
module output. (`QE - 0013`)

#### Scenario: Selective export
- **WHEN** a user selects a subset of tabs to export
- **THEN** the workbook contains those tabs and the corresponding report output

### Requirement: PowerPoint generation with firm templates

The system SHALL generate a slide deck from the underlying engagement information, configurable with a
firm's template so layout and design preferences are applied. (`QE - 0014`, shares the generator with
`CM - 0001`)

#### Scenario: Deck generated from engagement data
- **WHEN** a user generates a deck
- **THEN** its content is populated from the engagement's data rather than re-entered

#### Scenario: Firm template applied
- **WHEN** a firm template is configured
- **THEN** generated decks follow that firm's layout and design

### Requirement: Q&A generator driven by materiality

The system SHALL prepopulate questions for reconciling issues and for business questions where an
account moves beyond a materiality threshold — as a working definition, a change exceeding 1% of
expected SDE/EBITDA **and** 5% of the account balance. (`QE - 0015`)

#### Scenario: Question generated on a material movement
- **WHEN** an account movement exceeds both thresholds
- **THEN** a question is generated against that account for the company to answer

#### Scenario: Thresholds are configurable
- **WHEN** an engagement sets different thresholds
- **THEN** generation follows the engagement's thresholds

### Requirement: Questions and answers presented alongside the financials

The system SHALL present the P&L with its generated questions adjacent, and SHALL show the company's
answers in the same view once provided, so the reviewer sees the data and the explanation together and
can follow up in place. (`QE - 0015`)

#### Scenario: Answer appears beside the data
- **WHEN** the company answers a generated question
- **THEN** the answer appears alongside the account it relates to, available to the reviewer for
  follow-up

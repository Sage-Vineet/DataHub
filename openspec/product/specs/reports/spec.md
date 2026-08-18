## Purpose

The standard financial statements generated from the financial-data spine and delivered to a user or a
counterparty: `RP - 0001` (Profit & Loss), `RP - 0002` (Balance Sheet), and `RP - 0003` (Cash Flow).
These are the reports the product presents; they are not the QoE analysis built on top of them, which is
`qoe`.

**Fidelity: specified** for `RP - 0001` and `RP - 0002`, drawn from their feature specifications (Josh
Tonnesen, 14 Aug 2026). `RP - 0003` has no specification document, is marked lower priority in the
product list, and remains at sketch fidelity.

**Overlap note.** This capability describes the *product* reports surface. The in-flight `reports-domain`
change describes the key-report **version lifecycle** in the re-architecture. They converge on one
capability; see `design.md` §D6. `RP - 0001`'s functional requirements still refer to the permission
model as `SE - 0002`; it is now `SY - 0002`.

## ADDED Requirements

### Requirement: The P&L is generated from GL detail through the COA hierarchy

The system SHALL generate a Profit & Loss report by aggregating GL transaction detail (`DB - 0002`) up
through the Chart of Accounts rollup hierarchy (`DB - 0003`), SHALL allow the user to select which Key
Reports version the report is generated from, and SHALL regenerate the report entirely from the selected
version's underlying GL data. (`RP - 0001`)

#### Scenario: Version selection regenerates the report
- **WHEN** a user selects a Key Reports version and a date range
- **THEN** the P&L regenerates from that version's GL data

### Requirement: P&L period, granularity, and comparison controls

The system SHALL allow the user to specify a start and end date scoping the P&L period, to toggle the
view between Monthly and Annual, and to enable a side-by-side comparison showing a selected comparison
period — prior period or prior year — alongside the primary period, including variance columns in both
dollars and percent. Accounts with zero activity for the selected period SHALL be hidden by default,
consistent with standard QuickBooks P&L behavior. (`RP - 0001`)

#### Scenario: Comparison computes variance
- **WHEN** a user enables a comparison period
- **THEN** the comparison column and its dollar and percent variance are calculated correctly

#### Scenario: Dormant accounts are hidden
- **WHEN** an account has no activity in the selected period
- **THEN** it is hidden by default

### Requirement: Three-level P&L drill-down

The system SHALL allow the user to drill down from any P&L rollup line into its constituent detail
accounts following the `DB - 0003` / `DB - 0006` hierarchy; from a detail account into vendor/customer
subtotals where that name data exists on the underlying GL transactions; and from a vendor/customer
subtotal into individual transaction detail — date, memo, amount, reference number. (`RP - 0001`)

#### Scenario: Drill down and back without losing context
- **WHEN** a user drills rollup → detail account → vendor/customer → transaction and returns
- **THEN** each level renders correctly and report context is preserved

### Requirement: Restricted columns are suppressed at the query level

The system SHALL suppress vendor/customer name and any other column the permission model marks
restricted **at the query level**, so a restricted user never receives that column in the report
response, rather than hiding it only in the UI. (`RP - 0001`, depends on `SY - 0002`)

#### Scenario: Restriction survives the export path
- **WHEN** a user restricted from vendor/customer data views or exports the P&L
- **THEN** that column and drill-down level are absent from the response, the UI, and every export

### Requirement: P&L presentation and export are self-describing

The system SHALL keep row and column headers — account rollup labels and period headers — frozen in
place when the user scrolls vertically or horizontally, and SHALL allow export of the currently
displayed report, including the selected period, comparison, and monthly/annual configuration, to PDF,
Excel (.xlsx), and CSV. Every export SHALL reflect the current Key Reports version and selected date
range and comparison period, so an exported file is self-describing without reference to the live
report. (`RP - 0001`)

#### Scenario: Headers stay pinned
- **WHEN** a user scrolls the report in either direction
- **THEN** the account label column and period header row remain visible

#### Scenario: Export carries its own configuration
- **WHEN** the displayed report is exported to PDF, Excel, or CSV
- **THEN** each export reflects the exact version, period, and comparison configuration on screen

### Requirement: Open validation issues are flagged, not blocking

The system SHALL visually flag any account or period affected by an open validation or reconciliation
issue surfaced by `DB - 0005`, without blocking the user from viewing the report. (`RP - 0001`)

#### Scenario: Flag without a block
- **WHEN** an account or period carries an open validation issue
- **THEN** the report displays a visible flag and remains viewable

### Requirement: The Balance Sheet is a filtered view of the trial balance

The system SHALL generate the Balance Sheet by filtering the stored Trial Balance (`DB - 0004`) to the
accounts flagged as balance-sheet accounts in the Chart of Accounts (`DB - 0003`), and SHALL render
account rows and subtotals according to the COA hierarchy and rollup structure including any user-driven
reclassifications made in `DB - 0006`. The system SHALL visually reconcile the report — total assets
equal total liabilities plus equity — and SHALL flag on screen where the underlying stored data does not
balance. (`RP - 0002`)

#### Scenario: Only balance-sheet accounts, correctly rolled up
- **WHEN** the Balance Sheet is generated for a company with a stored Trial Balance
- **THEN** only balance-sheet-classified accounts appear, rolled up per the COA hierarchy, with assets
  equal to liabilities plus equity

### Requirement: Balance Sheet is point-in-time, with an optional comparison axis

The system SHALL require a single "As Of" date defining the reporting point in time, consistent with
standard balance sheet convention, and SHALL default to a single balance column reflecting it. The
system SHALL also accept a "Compare From" date used only to enable period-over-period comparison columns
and change analysis, which SHALL NOT alter the point-in-time balances themselves. The user SHALL be able
to switch to a multi-column comparison view across a user-defined date range, with a monthly/yearly
interval toggle controlling comparison-column granularity. (`RP - 0002`)

#### Scenario: As Of alone is sufficient
- **WHEN** a user changes the As Of date in the default single-column view
- **THEN** balances update to that date's stored Trial Balance with no Compare From date required

#### Scenario: Multi-column view honours the interval
- **WHEN** comparison view is enabled with a date range and a monthly or yearly interval
- **THEN** one column per period renders with correct balances

### Requirement: Version selection binds the drill-down to the same snapshot

The system SHALL provide a version selector offering any prior stored Trial Balance version per the
pull/re-pull history maintained by `DR - 0003`, defaulting to the most recent version. GL drill-down
SHALL be scoped to the GL data snapshot associated with the selected Trial Balance version; selecting a
prior version SHALL NEVER drill into current or live GL data. The user SHALL be able to click any
balance sheet line item to drill into the GL transaction detail composing that balance, for the selected
version and, in comparison view, the selected column and period. (`RP - 0002`)

#### Scenario: Prior version drills into its own GL
- **WHEN** a user selects a prior Trial Balance version and drills into a line item
- **THEN** the GL detail returned is tied to that version, never to live GL data

#### Scenario: Drill-down sums to the displayed balance
- **WHEN** a user clicks a balance sheet line item
- **THEN** the underlying GL transactions shown sum to the displayed balance for the correct version and
  period

### Requirement: Balance Sheet display controls and presentation

The system SHALL support standard report filters and toggles including at minimum: show/hide
zero-balance rows, collapse/expand account subtotals, and whole-dollar versus decimal display; and SHALL
support frozen header rows and a frozen leftmost account/label column so labels and period headers
remain visible while scrolling a wide multi-column comparison view. The report SHALL be exportable to
PDF and/or Excel consistent with the export approach used elsewhere in Reports and QoE. (`RP - 0002`)

#### Scenario: Hiding zero balances preserves subtotals
- **WHEN** the zero-balance toggle is switched off
- **THEN** zero-balance accounts are hidden without affecting subtotal accuracy

#### Scenario: Wide comparison stays readable
- **WHEN** a user scrolls right through a multi-column comparison
- **THEN** the account label column and period header row remain frozen

### Requirement: Balance Sheet access and activity are logged

The system SHALL write an entry to the Activity & Audit Log whenever a user views, drills into, or
exports the Balance Sheet, and SHALL deny and log any access attempt by a user without balance-sheet
permission. (`RP - 0002`, feeds `SY - 0003`)

#### Scenario: Denied access is recorded
- **WHEN** a user without balance-sheet permission attempts to open the report
- **THEN** access is denied and the attempt is logged

#### Scenario: Every interaction is logged
- **WHEN** a user views, drills into, or exports the Balance Sheet
- **THEN** an entry is written to the Activity & Audit Log

### Requirement: Statement of cash flows

The system SHALL generate a statement of cash flows for a company/deal from the financial-data spine.

**Fidelity: sketch** — `RP - 0003` has no feature specification document. The product list marks it
lower priority and more complicated, to be dealt with later; the derivation method (direct vs. indirect,
and which anchors it reads) is undecided.

#### Scenario: Cash flow statement is produced
- **WHEN** a user requests the statement of cash flows for a period
- **THEN** a statement of cash flows is generated from the deal's financial data

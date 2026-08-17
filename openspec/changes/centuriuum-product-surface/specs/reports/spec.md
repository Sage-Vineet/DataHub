## Purpose

Financial statements generated from the loaded GL data: Profit & Loss (`RP - 0001`), Balance Sheet
(`RP - 0002`), and Cash Flow (`RP - 0003`). The product expectation is parity with what a user already
knows from QuickBooks — standard filters and toggles, drill-down to customer and vendor detail at the
lowest level — over the platform's own reconciled data structure.

**Fidelity: sketch.** This capability has two authors: these requirements describe the *product*
reports surface, while the in-flight `reports-domain` change describes the key-report **version
lifecycle** and the seam over the legacy 9,088-line GL engine. They converge on one capability
deliberately — see `design.md` §D6. The source list also references an `RP - 0004` (firm-level
analytics) that has no row; see Register A.

## ADDED Requirements

### Requirement: Profit & Loss generated from GL data

The system SHALL generate a P&L from the loaded GL data by running the COA hierarchy, with customer and
vendor detail available as the lowest drill-down level. (`RP - 0001`)

#### Scenario: P&L follows the configured hierarchy
- **WHEN** a user generates a P&L
- **THEN** it presents accounts per the current COA hierarchy, including any user-created roll-ups

#### Scenario: Drill-down reaches transaction detail
- **WHEN** a user drills into a P&L line
- **THEN** the underlying accounts and then the customer/vendor transaction detail resolve

### Requirement: Balance Sheet generated from stored balances

The system SHALL produce a Balance Sheet for a selected period from the stored trial balance and balance
data. (`RP - 0002`)

#### Scenario: Balance sheet for a period
- **WHEN** a user selects a period
- **THEN** the balance sheet for that period is produced from the stored data

### Requirement: Statement of Cash Flow

The system SHALL generate a statement of cash flows. This is explicitly lower priority than the P&L and
Balance Sheet and may follow them. (`RP - 0003`)

#### Scenario: Cash flow statement produced
- **WHEN** a user requests a cash flow statement for a period with sufficient loaded data
- **THEN** the statement is produced

#### Scenario: Insufficient data is stated plainly
- **WHEN** the loaded data cannot support a cash flow statement
- **THEN** the system says what is missing rather than producing an unsupported statement

### Requirement: Standard filters and toggles

Reports SHALL support the filters and toggles users expect from their accounting package — period and
comparative period selection, accrual versus cash basis, and level of detail. (`RP - 0001`,
`RP - 0002`)

#### Scenario: Comparative periods
- **WHEN** a user selects a comparative period
- **THEN** the report presents both periods side by side

#### Scenario: Basis toggle
- **WHEN** a user switches between accrual and cash basis
- **THEN** the report recomputes on the selected basis

### Requirement: Reports are reproducible from a version

A generated report SHALL be reproducible from the report version and data state it was generated
against, so a figure presented to a counterparty can be reconstructed later. (`RP - 0001` … `RP - 0003`,
ties to the key-report version lifecycle)

#### Scenario: Report reproduced from its version
- **WHEN** a report generated earlier is re-opened
- **THEN** it resolves against the same version and data state, producing the same figures

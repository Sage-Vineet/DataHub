## Purpose

The reconciled financial data structure every analytical feature reads from: table structure
(`DB - 0001`), GL data (`DB - 0002`), chart of accounts (`DB - 0003`), trial balance (`DB - 0004`),
validations (`DB - 0005`), configurable COA (`DB - 0006`), COA suggestions (`DB - 0007`), tax return
table (`DB - 0008`), bank statement table (`DB - 0009`), and table sharing across modules
(`DB - 0010`). Thirty-nine features across `reports`, `qoe`, `projection-model`, and `valuations` read
from this capability; nothing above it is correct if this is wrong.

**Fidelity: sketch.** Two unresolved items sit directly under this capability and are the
highest-leverage open questions on the whole list: `DB - 0001`'s actual table structure, and
`DB - 0010`'s cross-module sharing model — see `design.md` Register B §4 and §5. The write path is the
`data-retrieve-wizard` capability.

## ADDED Requirements

### Requirement: A defined table structure underlies the financial data

The system SHALL define an explicit table structure for financial data, with the source documents a
user links to it, such that downstream features read from that structure rather than from documents.
(`DB - 0001`)

#### Scenario: Downstream features read the structure, not files
- **WHEN** a report, QoE artifact, projection, or valuation needs financial data
- **THEN** it reads the defined tables, not a source file

#### Scenario: Source document is traceable from the data
- **WHEN** a user inspects a figure in the structure
- **THEN** the document it was loaded from is identifiable

### Requirement: GL data is loaded and used platform-wide

The system SHALL load general ledger data from the key reports and SHALL make it the transaction-level
source used throughout the platform. (`DB - 0002`)

#### Scenario: GL loaded from a key-report pull
- **WHEN** a completed pull includes the General Ledger
- **THEN** its transactions populate the GL structure for that company and period

#### Scenario: GL supports drill-down
- **WHEN** a user drills into a reported figure
- **THEN** the underlying GL transactions resolve

### Requirement: Chart of accounts is derived from GL activity and report structure

The system SHALL generate the chart of accounts from the GL data — the accounts where transactions have
actually been recorded — and SHALL take hierarchy from the linked P&L and Balance Sheet. (`DB - 0003`)

#### Scenario: COA reflects accounts in use
- **WHEN** GL data is loaded
- **THEN** the generated COA contains the accounts carrying transactions

#### Scenario: Hierarchy comes from the linked statements
- **WHEN** the P&L and Balance Sheet are linked
- **THEN** the COA hierarchy follows their structure

### Requirement: Trial balance and balance-sheet data are stored

The system SHALL store trial balance data, covering the balance-sheet positions the GL alone does not
supply for reporting. (`DB - 0004`)

#### Scenario: Balance sheet resolves from stored balances
- **WHEN** a balance sheet is produced for a period
- **THEN** it resolves from the stored trial balance / balance data for that period

### Requirement: Cross-validation with user notification

The system SHALL cross-validate loaded data and SHALL notify the user when items do not reconcile or
when errors are identified in the GL, P&L, or Balance Sheet data. (`DB - 0005`)

#### Scenario: Non-reconciling data is flagged
- **WHEN** loaded data fails a reconciliation check
- **THEN** the user is notified with the specific accounts and periods involved

#### Scenario: Validation does not silently correct
- **WHEN** a validation failure is detected
- **THEN** the system reports it rather than adjusting the data

### Requirement: Configurable COA with drag-and-drop roll-ups

The system SHALL present the generated P&L and Balance Sheet chart of accounts in a UI where the user
can drag and drop accounts and create new roll-ups, so the company's reported hierarchy can be improved
without editing source data. (`DB - 0006`)

#### Scenario: Roll-up created
- **WHEN** a user groups accounts into a new roll-up
- **THEN** reports reflect the new hierarchy while the underlying accounts and transactions are
  unchanged

#### Scenario: Reclassification is reversible
- **WHEN** a user reverts a hierarchy change
- **THEN** the prior presentation is restored

### Requirement: Reclassification suggestions

The system SHALL prompt users with suggested reclassifications of COA data where reporting would be
improved. (`DB - 0007`)

#### Scenario: Suggestion offered, not applied
- **WHEN** the system identifies a candidate reclassification
- **THEN** it is presented for the user to accept or dismiss, and nothing changes until accepted

### Requirement: Tax return table

The system SHALL populate a tax return table from uploaded tax returns, handling the return types that
occur in this market — 1065, 1120-S, 1120, Schedule C — into one structure used throughout the platform.
(`DB - 0008`)

#### Scenario: Multiple return types populate one structure
- **WHEN** returns of different types are uploaded across engagements
- **THEN** each populates the same table structure with its type recorded

### Requirement: Bank statement table

The system SHALL store, per bank statement, at minimum the starting balance, ending balance, deposits,
and withdrawals, in a structure the proof-of-cash analysis reads. (`DB - 0009`)

#### Scenario: Statement figures available to proof of cash
- **WHEN** statements are loaded for a period
- **THEN** `QE - 0003` can compare them against the financial data without re-reading the document

### Requirement: Table sharing across modules

The system SHALL let different modules and different parties link their own document sets to equivalent
table structures — for example the QoE provider linking different files than the broker — so that Key
Reports can sit under the QoE and under CIM prep separately, each party controlling their own process,
without duplicating the underlying data model. (`DB - 0010`)

#### Scenario: Two parties link different sources to the same structure
- **WHEN** the broker and the QoE provider each link their own documents
- **THEN** each sees their own linked set, and both resolve into the same table structure

#### Scenario: One party's linking does not disturb the other's
- **WHEN** one party relinks or replaces their source documents
- **THEN** the other party's linked view is unaffected

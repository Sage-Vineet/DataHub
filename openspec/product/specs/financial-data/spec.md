## Purpose

The structured financial spine every analytical capability reads from: how a source document becomes a
queryable table, and what those tables are. Covers `DB - 0001` (Table Structure), `DB - 0002` (GL Data),
`DB - 0003` (Chart of Accounts), `DB - 0004` (Trial Balance), `DB - 0005` (Validations), `DB - 0006`
(Configurable COA), `DB - 0007` (Suggestions on COA), `DB - 0008` (Tax Return Table), `DB - 0009` (Bank
Statement Table), and `DB - 0010` (Table Blocks). Reports, QoE, projections, and valuations are all
downstream of this capability; nothing above it is buildable until `DB - 0001` lands.

**Fidelity: specified**, except `DB - 0010` (Table Blocks), which the product list marks "more
conceptual than spec doc" and which remains at sketch fidelity. Requirements are drawn from the nine
`DB` feature specifications (Josh Tonnesen, 14 Aug 2026).

## ADDED Requirements

### Requirement: Key Reports links a data room file to a report slot

The system SHALL provide a Key Reports section, scoped to a single company/deal, in which a user links a
source file from the data room to a defined report slot — P&L, Balance Sheet, GL Export, Tax Return,
Bank Statement. The system SHALL restrict which roles may create a link, ingest, or overwrite a version
per `SY - 0001` / `SY - 0002`, and SHALL scope every link so no other deal can see or access it.
(`DB - 0001`)

#### Scenario: Link is deal-scoped
- **WHEN** a user links a data room file to a Key Reports slot
- **THEN** the link is visible only within that company/deal

### Requirement: Report slots carry explicit, user-created versions

The system SHALL allow one report slot to hold multiple named versions, created explicitly by the user
rather than automatically, and SHALL clearly indicate which version of each slot is currently active —
that is, the version driving downstream modules. At the point of re-linking or re-ingesting, the user
SHALL choose whether to overwrite the active version's stored data or create a new version alongside it.
An overwrite SHALL NEVER occur without an explicit confirmation step, since it destroys previously
stored values for that version. All prior versions SHALL be retained indefinitely, so a deal's ingestion
history is not lost through normal use. (`DB - 0001`)

#### Scenario: A second version does not displace the first
- **WHEN** a user creates a second version of a previously linked report
- **THEN** data stored under the first version remains accessible

#### Scenario: Overwrite requires confirmation
- **WHEN** a user attempts to overwrite an active version
- **THEN** an explicit confirmation is required before the prior stored data is replaced

#### Scenario: The active version is identifiable
- **WHEN** a user views a report slot with several versions
- **THEN** the version currently driving downstream modules is clearly indicated

### Requirement: Ingestion produces a generic table independent of downstream shape

The system SHALL parse a linked source file into a generic, structured table format at ingestion time,
independent of the specific downstream table shape (GL, COA, Tax Return, Bank Statement) that will later
consume it, and SHALL record an ingestion run entry — timestamp, acting user, source file reference,
version, resulting status — every time a link is created, re-ingested, or overwritten. (`DB - 0001`,
feeds `SY - 0003`)

#### Scenario: Downstream consumers read the generic structure
- **WHEN** ingestion completes
- **THEN** the parsed generic table is queryable by a downstream consumer

#### Scenario: Every ingestion action is logged
- **WHEN** a link is created, a version created, or an overwrite performed
- **THEN** a corresponding ingestion run entry records timestamp and acting user

### Requirement: Validation status is a field on the version, not logic here

The system SHALL expose a validation status field — pending, passed, failed — on each ingested version,
settable, without implementing the validation rule logic itself; that logic is defined by `DB - 0005`.
(`DB - 0001`)

#### Scenario: Status field exists before the rules do
- **WHEN** a version is ingested
- **THEN** a validation status field is present and settable even with no rule logic populating it

### Requirement: GL files are linked from the data room, never retrieved from the link step

The system SHALL allow a user, from Key Reports, to select one or more GL report files already uploaded
to or retrieved into the data room via `DR - 0001` / `DR - 0003` and link them for ingestion, and SHALL
NOT allow a new GL retrieval to be triggered from the linking step itself — retrieval or upload must
happen first. The system SHALL support ingestion from QBO-sourced exports, QB Desktop-derived GL
reports, and generic CSV/Excel GL exports at launch. (`DB - 0002`)

#### Scenario: Linking does not retrieve
- **WHEN** a user is in the GL linking step
- **THEN** no new retrieval can be initiated from there

#### Scenario: Three source formats at launch
- **WHEN** a QBO export, a QB Desktop-derived GL report, or a generic CSV/Excel GL export is linked
- **THEN** ingestion parses it into GL rows

### Requirement: GL rows carry a standard field set and traceable origin

Ingested GL rows SHALL store at minimum: transaction date, account, entry/transaction number,
transaction type, debit amount, credit amount, description/memo, customer, and a reference to the source
file. Each row SHALL retain a reference to its source file ID and the ingestion batch/timestamp that
created it, so origin is traceable. (`DB - 0002`)

#### Scenario: Fields are sourced correctly
- **WHEN** a GL file is ingested
- **THEN** every standard field is populated from the source file and the source reference is retained

### Requirement: Additional GL files append rather than overwrite

When a user links an additional or corrected GL file covering a period already ingested, the system
SHALL append new rows rather than overwrite or delete previously ingested rows. (`DB - 0002`)

#### Scenario: Overlapping period appends
- **WHEN** a GL file for an already-ingested or overlapping period is linked
- **THEN** new rows are appended and prior rows are neither deleted nor overwritten

### Requirement: Validation runs after GL ingestion but never blocks it

Immediately following ingestion, the system SHALL run the `DB - 0005` cross-validation ruleset against
the newly ingested rows and surface reconciliation errors or anomalies to the user. Ingestion SHALL NOT
be blocked by validation failures — data lands in the GL table and exceptions are surfaced separately for
review and correction. (`DB - 0002`, `DB - 0005`)

#### Scenario: Failures surface without blocking
- **WHEN** ingested GL rows fail validation
- **THEN** the rows are saved and the discrepancies are surfaced separately for review

### Requirement: GL data is the source for downstream modules and is logged

The system SHALL make ingested GL data available to the Trial Balance (`DB - 0004`), Profit & Loss
(`RP - 0001`), Tax Reconciliation (`QE - 0001`), and SDE/EBITDA (`QE - 0004`), and SHALL log every
ingestion event — files linked, user, timestamp, and row count — to the Activity & Audit Log.
(`DB - 0002`, feeds `SY - 0003`)

#### Scenario: Ingestion events reach the audit log
- **WHEN** a GL ingestion completes
- **THEN** the audit log records user, timestamp, source file, and row count

#### Scenario: GL data is deal-isolated
- **WHEN** a user without assigned role or deal access requests GL data for that deal
- **THEN** access is refused under all circumstances

### Requirement: The chart of accounts is generated from GL activity

The system SHALL create one COA record per unique external GL account code per company/deal, sourced
from `DB - 0002`, including an account for every GL account with at least one recorded transaction.
Accounts with zero activity are not required to appear until a transaction posts. No two accounts within
the same company/deal SHALL share the same External Account Code, and no COA record, field, or lookup
SHALL span more than one company/deal. (`DB - 0003`)

#### Scenario: Every active account gets a record
- **WHEN** GL data is ingested
- **THEN** a COA record exists for each account with activity, scoped to that company/deal

#### Scenario: Account codes are unique within a deal
- **WHEN** COA records are generated
- **THEN** no External Account Code repeats within the same company/deal

### Requirement: COA record fields

Each COA record SHALL store at minimum: internal Account ID, Company/Deal ID, External Account Code,
Account Name, Account Type (Asset, Liability, Equity, Income, Cost of Goods Sold, Expense, Other Income,
Other Expense), Normal Balance (Debit/Credit), Statement Type (Balance Sheet or Profit & Loss), and an
Active/Inactive flag. (`DB - 0003`)

#### Scenario: Record carries type and statement classification
- **WHEN** a COA record is created
- **THEN** account type, normal balance, statement type, and active flag are populated

### Requirement: Fifteen hierarchy levels with a fixed P&L spine

Each COA record SHALL carry 15 discrete Hierarchy Level fields (Level 1 through Level 15) representing
that account's roll-up path from top-level summary line down to itself. For Profit & Loss accounts,
Levels 1 through 5 SHALL be a fixed, system-assigned, non-editable spine in this order: Level 1 = Net
Income, Level 2 = Pretax Income, Level 3 = Operating Income, Level 4 = Gross Profit, Level 5 = Total
Revenue — every P&L account resolving up through this spine regardless of company. Levels 6 through 15,
and any P&L sub-levels below the fixed spine, SHALL be open, company-specific subtotal and account
levels, editable only through the `DB - 0006` configuration UI. (`DB - 0003`)

#### Scenario: The spine is universal
- **WHEN** any P&L account is inspected
- **THEN** Hierarchy Levels 1–5 equal Net Income, Pretax Income, Operating Income, Gross Profit, Total
  Revenue

#### Scenario: The spine is not editable
- **WHEN** a user attempts to change a Level 1–5 assignment on a P&L account
- **THEN** the change is refused

### Requirement: Estimated tax return line is a placeholder field

Each account SHALL carry an "Estimated Tax Return Line" field for a user-entered estimate of the tax
return line it is expected to map to. This SHALL be a placeholder only; confirmed mapping logic and the
tax return table live in `DB - 0008` and `QE - 0002`. (`DB - 0003`)

#### Scenario: Estimate does not drive mapping
- **WHEN** a user populates the estimated tax return line
- **THEN** no confirmed mapping is created and downstream tax features continue to read `DB - 0008` /
  `QE - 0002`

### Requirement: COA edits are in place and audited; new accounts are flagged, not defaulted

Edits to an account's hierarchy assignment via `DB - 0006`, or an accepted reclassification suggestion
via `DB - 0007`, SHALL update the COA record in place, and each SHALL write an audit entry capturing
prior value, new value, editing user, and timestamp. When a re-pull of GL data introduces an account not
previously present, the system SHALL add it with no hierarchy assignment below the fixed spine and SHALL
flag it for reclassification rather than defaulting it silently into an existing rollup. (`DB - 0003`,
feeds `SY - 0003`)

#### Scenario: New accounts land unclassified and visible
- **WHEN** a GL re-pull introduces a previously unseen account
- **THEN** it is added without a hierarchy assignment below the spine and flagged for reclassification

#### Scenario: Hierarchy edits are attributable
- **WHEN** a hierarchy assignment changes
- **THEN** prior value, new value, user, and timestamp are recorded

### Requirement: A daily trial balance is calculated for every account and date

The system SHALL calculate and store a daily trial balance record for every account in the chart of
accounts, for every calendar date within the range covered by the uploaded GL. For each balance sheet
account it SHALL store the ending balance as of each date; for each profit & loss account it SHALL store
the accumulated year-to-date balance as of each date, resetting at the start of each fiscal year.
(`DB - 0004`)

#### Scenario: Two storage semantics by statement type
- **WHEN** a daily trial balance is generated across the GL range
- **THEN** balance sheet accounts hold an ending balance and P&L accounts hold a year-to-date balance
  that resets each fiscal year

### Requirement: Balances roll from whichever anchors exist

The system SHALL calculate daily balances by rolling a starting balance sheet forward through GL
activity, an ending balance sheet backward through GL activity, or both, depending on which anchors are
present in that company's key reports. Where only one anchor is provided, the system SHALL roll as far
as the available GL data allows and SHALL mark the resulting trial balance date range "Unvalidated"
until an opposing anchor is supplied. Where both anchors are provided, the system SHALL validate per
account that starting balance plus net GL activity equals the provided ending balance and SHALL flag any
account that does not foot, surfacing the variance amount rather than a pass/fail flag alone.
(`DB - 0004`, `DB - 0005`)

#### Scenario: One anchor yields an unvalidated range
- **WHEN** only a starting balance sheet is available
- **THEN** balances roll forward as far as GL data allows and the range is marked Unvalidated

#### Scenario: Non-footing accounts are named with their variance
- **WHEN** both anchors are present and an account does not foot
- **THEN** that account is flagged and its variance amount displayed

### Requirement: Trial balance values are version-bound and recalculated destructively

The system SHALL associate every calculated trial balance value with the specific GL and key report
version used to produce it. On upload of a new GL or key report version, the system SHALL recalculate
the trial balance for the affected date range and overwrite the previously calculated values under that
version, and SHALL NOT automatically retain a copy of what it overwrites. The system SHALL allow a user
to manually export or duplicate a trial balance version as a backup before triggering a recalculation.
(`DB - 0004`)

#### Scenario: Recalculation overwrites without an automatic backup
- **WHEN** a new GL version is uploaded
- **THEN** the trial balance for the affected range recalculates under the current version and prior
  calculated values are replaced with no automatic system backup

#### Scenario: Manual backup is available first
- **WHEN** a user exports or duplicates a trial balance version before recalculating
- **THEN** that copy survives the recalculation

### Requirement: Trial balance is queryable and carries a data-quality tag

The system SHALL make the daily trial balance queryable by a single date or a date range, per account or
in aggregate, for downstream consumption by `RP - 0002` and `QE - 0003`, and SHALL tag every trial
balance date range with a validation status of Validated, Unvalidated, or Foot Exception so downstream
features can surface data-quality context rather than presenting calculated figures as unconditionally
reliable. (`DB - 0004`)

#### Scenario: As-of query returns every account
- **WHEN** the trial balance is requested as of a specific date
- **THEN** the balance for every account as of that date is returned, usable by downstream reporting

#### Scenario: Quality context travels with the data
- **WHEN** a downstream feature reads a trial balance range
- **THEN** its Validated / Unvalidated / Foot Exception status is available

### Requirement: Validation runs automatically on ingest and on demand

The system SHALL run the validation check automatically every time General Ledger, Balance Sheet, or P&L
data is uploaded or re-pulled, without a manual trigger, and SHALL also allow the user to re-trigger it
on demand from Key Reports. (`DB - 0005`)

#### Scenario: Automatic and manual paths both work
- **WHEN** financial data is uploaded or re-pulled, or the user re-triggers validation from Key Reports
- **THEN** the validation check runs

### Requirement: Roll-forward comparison stores its result regardless of outcome

The system SHALL calculate the ending Balance Sheet by rolling the starting Balance Sheet forward or
backward using GL activity, store the result in the Trial Balance table, and compare it against the
uploaded ending Balance Sheet where one exists for that period. The calculated ending Balance Sheet
SHALL be stored even when a variance is identified; a failed validation SHALL NOT block the data from
being saved. (`DB - 0005`)

#### Scenario: A material failure still saves the data
- **WHEN** a validation identifies a material variance
- **THEN** the underlying data is still saved to the Trial Balance table

### Requirement: Variances are quantified, tiered against configurable thresholds, and named per account

The system SHALL calculate a variance amount and variance percentage for each Balance Sheet account by
comparing calculated to uploaded ending balance, and SHALL classify each account-level variance as Pass
(no meaningful variance), Minor (below materiality threshold), or Material (at or above it). A variance
SHALL be treated as Material where it exceeds a configurable fixed-dollar floor or a configurable
percentage-of-account-balance threshold, whichever is met first; thresholds SHALL be configurable rather
than hardcoded. The system SHALL identify and list the specific accounts that do not roll forward
correctly, not only an aggregate Balance Sheet-level variance. (`DB - 0005`)

#### Scenario: Tiering follows configured thresholds
- **WHEN** an account-level variance is computed
- **THEN** it is classified Pass, Minor, or Material against the configured dollar floor and percentage
  thresholds

#### Scenario: Offending accounts are named
- **WHEN** a roll-forward comparison fails
- **THEN** the specific accounts responsible are listed

### Requirement: Source-document sanity, basis inference, and coverage-gap checks

The system SHALL confirm the uploaded Balance Sheet is itself in balance — total assets equal total
liabilities plus equity — as a precondition, flagging an out-of-balance source document separately from
the roll-forward comparison. The system SHALL infer the accounting basis of each uploaded document by
analyzing GL/P&L/BS behavior, such as the presence and movement of AR/AP or accrual-related accounts,
rather than relying on a user-entered designation, and SHALL flag a basis inconsistency where the
inferred basis of the GL does not match that of the uploaded P&L or Balance Sheet for the same period.
The system SHALL compare the GL detail's date range against the Balance Sheet date and flag a coverage
gap where the GL does not extend through the full Balance Sheet date. (`DB - 0005`)

#### Scenario: Out-of-balance source is flagged distinctly
- **WHEN** an uploaded Balance Sheet does not itself balance
- **THEN** it is flagged as an out-of-balance source document, separately from the roll-forward result

#### Scenario: Basis mismatch needs no user input
- **WHEN** GL and Balance Sheet data are on different accounting bases
- **THEN** a basis inconsistency is flagged with no user-entered basis field required

#### Scenario: Coverage gap identifies the missing range
- **WHEN** GL detail ends before the Balance Sheet date
- **THEN** a coverage gap is flagged identifying the missing date range

### Requirement: Validation results present as a drillable matrix with plain-language causes

The system SHALL present validation results in a matrix with document type (GL, P&L, Balance Sheet) as
rows and period/year as columns, each cell showing pass, fail, or coverage-gap status, and SHALL support
drilling from a cell into the account-level variances and their severity for that document/period. The
system SHALL surface, alongside any Material flag, a plain-language explanation of the likely cause
where determinable — for example "GL coverage ends 1 day before Balance Sheet date" or "Basis mismatch:
GL appears cash basis, uploaded Balance Sheet appears accrual basis". (`DB - 0005`)

#### Scenario: Matrix drills to account detail
- **WHEN** a user opens a matrix cell
- **THEN** the account-level variances and severities for that document and period are shown

#### Scenario: Material flags explain themselves
- **WHEN** a Material flag is raised and the cause is determinable
- **THEN** a plain-language explanation accompanies it

### Requirement: Validation scope excludes bank and tax reconciliation, and records period-level risk

The system SHALL exclude bank statement and tax return reconciliation from this validation — those are
covered by `QE - 0003` and `DB - 0008` — and SHALL record that a Material or unresolved validation flag
exists at the period/company level so it can be surfaced as a validation-risk indicator elsewhere, the
design of that downstream indicator being out of scope here. (`DB - 0005`)

#### Scenario: Period-level risk is recorded for downstream use
- **WHEN** a Material or unresolved flag remains
- **THEN** the period/company carries a validation-risk record readable by other features

### Requirement: COA hierarchy is configured through an interactive tree

The system SHALL render the COA as an interactive tree view, separately for P&L and Balance Sheet
accounts, each node showing the account or group name and its annual total, and SHALL display the
trailing annual total next to each account and subtotal group so materiality is visible while
reorganizing. Subtotal and top-level bucket totals SHALL recalculate and display live as accounts are
dragged between groups. (`DB - 0006`)

#### Scenario: Totals update live during reorganization
- **WHEN** a user drags an account into a different group
- **THEN** the affected subtotal and bucket totals update immediately

### Requirement: Accounts and user-created groups are movable; platform buckets are not

The system SHALL support drag-and-drop reassignment of a base-level (leaf) account from one top-level
bucket to another, and between existing mid-level subtotal groups within the same or a different bucket.
The system SHALL allow a user to create a new mid-level subtotal group under a top-level bucket, and to
rename or delete a group they created — deletion prompting the user to reassign its child accounts
rather than silently discarding them. A top-level bucket SHALL be permitted to have zero mid-level
groups (a flat list of base accounts) as well as multiple levels of grouping. The system SHALL prevent
creating, renaming, moving, or deleting the platform-fixed top-level buckets (Revenue, COGS, SG&A, Other
Income/Expense); only base accounts and user-created mid-level groups are editable. (`DB - 0006`)

#### Scenario: Leaf accounts move between buckets
- **WHEN** a user with edit access drags a base account from COGS to SG&A
- **THEN** the change is saved to that firm's COA configuration

#### Scenario: Deleting a group rehomes its children
- **WHEN** a user deletes a mid-level group they created
- **THEN** they are prompted to reassign its child accounts

#### Scenario: Fixed buckets resist edits
- **WHEN** a user attempts to rename, move, or delete a platform-fixed top-level bucket
- **THEN** the attempt is refused

### Requirement: Hierarchy configuration is the firm's classification of record and is per-firm

The system SHALL persist hierarchy configuration changes to the `DB - 0003` chart of accounts data,
scoped per firm — the change updating that firm's classification of record for the company, not a local
display setting — and SHALL NOT let one firm's configuration affect another firm's configuration for the
same company. A user without edit access to the company SHALL NOT view or modify any firm's hierarchy
configuration for that company. P&L and Balance Sheet reports generated for a firm SHALL reflect that
firm's active hierarchy configuration. (`DB - 0006`, feeds `RP - 0001` / `RP - 0002`)

#### Scenario: Firms configure independently
- **WHEN** one firm reorganizes the hierarchy for a company
- **THEN** another firm's configuration for the same company is unaffected

#### Scenario: Reports follow the viewing firm's configuration
- **WHEN** a firm generates a P&L or Balance Sheet
- **THEN** it reflects that firm's active hierarchy configuration

### Requirement: New GL pulls carry hierarchy forward and quarantine unknown accounts

When a new GL pull or version is ingested for the same company, the system SHALL automatically carry
forward each firm's existing hierarchy configuration by matching on account name/number, applying that
firm's saved grouping rules only to newly introduced accounts rather than resetting the full hierarchy,
and SHALL flag newly introduced accounts not yet placed into a subtotal group by the current firm so the
user can confirm or reclassify them rather than have them silently default. (`DB - 0006`)

#### Scenario: Existing configuration survives a re-pull
- **WHEN** a new GL pull lands for a company
- **THEN** the firm's saved hierarchy is intact for all previously known accounts

#### Scenario: New accounts wait in an unclassified tray
- **WHEN** a re-pull introduces brand-new accounts
- **THEN** they appear unclassified for confirmation rather than being auto-placed

### Requirement: COA suggestions run once, at initial generation, using AI classification

The system SHALL run the COA suggestion process automatically once, at the point the chart of accounts is
first generated from GL data, requiring no manual trigger, and SHALL NOT re-run it automatically on
subsequent GL reloads or version updates — re-running SHALL be available only as an explicit,
user-initiated action. The system SHALL use an AI/LLM-based classification approach rather than a fixed
lookup table, since account naming conventions vary widely across companies and cannot be exhaustively
enumerated. (`DB - 0007`)

#### Scenario: Suggestions appear without being asked for
- **WHEN** the chart of accounts is first generated
- **THEN** a set of suggested reclassifications is produced automatically

#### Scenario: Reloads do not re-run suggestions
- **WHEN** a subsequent GL version is loaded
- **THEN** the suggestion process does not re-run unless a user initiates it

### Requirement: Each suggestion carries current placement, proposal, and rationale

The system SHALL generate, for each flagged account, a suggested reclassification consisting of the
current placement (parent/sub-parent), the suggested placement, and a short plain-language rationale.
The system SHALL be able to suggest creating a new parent or sub-parent grouping, not only moving an
account under an existing parent, where several related accounts would be more useful grouped together.
The system SHALL target roughly 5–12 sub-parent groupings under each major roll-up when generating
grouping suggestions, allowing exceptions where accounts do not logically relate. (`DB - 0007`)

#### Scenario: Rationale accompanies each suggestion
- **WHEN** a suggestion is presented
- **THEN** it shows current placement, suggested placement, and a plain-language rationale

#### Scenario: Grouping proposals are supported
- **WHEN** several related sub-accounts would be better consolidated
- **THEN** the system can propose a new parent grouping rather than only a move

### Requirement: Suggestions are per-account, opt-in, and non-learning

The system SHALL present suggestions inside the `DB - 0006` Configurable COA UI as a reviewable,
summarized list rather than a standalone wizard, and SHALL allow the user to approve or deny each
suggestion individually per account — there is no bulk-only accept/deny. Only approved suggestions SHALL
be applied to the live chart of accounts; denied suggestions SHALL NOT alter the COA and SHALL NOT be
reissued or re-surfaced automatically. The system SHALL NOT persist or learn from a user's approve/deny
decisions across deals or companies, and no suggestion logic SHALL reference data from any company/deal
other than the one being worked. All suggested changes SHALL be clearly labeled as pending user action,
and no reclassification SHALL occur without explicit approval. Dollar amounts and transaction-level GL
detail SHALL be unaffected by any suggestion — suggestions change only where an account sits in the
reporting hierarchy. (`DB - 0007`)

#### Scenario: Denial is final and silent
- **WHEN** a user denies a suggestion
- **THEN** the COA is unchanged and the suggestion does not resurface automatically

#### Scenario: No cross-deal learning
- **WHEN** suggestions are generated for a company
- **THEN** no data or prior decision from another company/deal informs them

#### Scenario: Transaction data is untouched
- **WHEN** a reclassification suggestion is approved
- **THEN** only the hierarchy placement changes and no GL transaction value is altered

### Requirement: Tax returns are uploaded, OCR'd, and typed from a controlled list

The system SHALL allow a user to upload a tax return document (PDF or image) into the data room
associated with a single company/deal, SHALL run OCR extraction as part of the standard ingestion
pipeline, and SHALL require the user to confirm the return type at upload or post-extraction from a
controlled list: 1120, 1120S, 1065, or 1040 (Schedule C only). Schedule C handling SHALL be restricted
to the business-related lines of the individual return; other personal 1040 lines and schedules are out
of scope for extraction. (`DB - 0008`)

#### Scenario: Return type is confirmed, not guessed
- **WHEN** a tax return is uploaded
- **THEN** the user confirms its type from the controlled list before the return is treated as typed

### Requirement: A fixed line-item taxonomy populates one normalized table

The system SHALL maintain a fixed, predefined line-item taxonomy per return type, mapping each line on
the physical form to a return-type-specific Line Item Code and Label, and SHALL populate a single
normalized Tax Return Table with one row per extracted line item containing at minimum: Company/Deal ID,
Source Document ID, Return Type, Tax Year, Fiscal Period Start Date, Fiscal Period End Date, Line Item
Code, Line Item Label, Extracted Value, Extraction Confidence, Validation Status, and Version/Upload
Timestamp. The fiscal period covered SHALL be captured independently of calendar year, to correctly
represent non-calendar fiscal years and short-period returns. (`DB - 0008`)

#### Scenario: Non-calendar and short years are represented
- **WHEN** a return covering a non-calendar fiscal year or a short period is extracted
- **THEN** the fiscal period start and end dates are captured correctly, independent of tax year

### Requirement: Footing and confidence checks gate validation

The system SHALL run an automated footing/cross-validation check on each extracted return immediately
after extraction — for example confirming total income less total deductions equals the reported net
income or ordinary business income line for that return type — and SHALL set Validation Status to "Needs
Review" rather than "Validated" for any return failing its footing check, applying the same status to
any individual line item extracted below a defined OCR confidence threshold. When in doubt the system
SHALL flag rather than silently accept. A return SHALL NOT be markable "Validated" while any line item
on it remains in "Needs Review". (`DB - 0008`)

#### Scenario: Low-confidence lines block validation
- **WHEN** any line item falls below the confidence threshold or the return fails its footing check
- **THEN** the item or return is flagged Needs Review and the return cannot be marked Validated

### Requirement: Corrections preserve the original extraction, and re-uploads version

The system SHALL allow an authorized user to review, correct, and confirm flagged line items, storing
the corrected value alongside — not in place of — the original OCR-extracted value for audit purposes.
The system SHALL support multiple tax returns per company/deal, each as its own set of rows tied to its
own Source Document ID and Tax Year, and SHALL treat a re-uploaded or re-extracted version of a given
tax year's return as a new version rather than overwriting prior extracted data. Validated Tax Return
Table data SHALL be available to `QE - 0001` and `QE - 0002`. (`DB - 0008`)

#### Scenario: Original extraction survives correction
- **WHEN** a user corrects a flagged line item
- **THEN** the corrected value is stored alongside the original OCR value

#### Scenario: Re-upload versions a tax year
- **WHEN** a return is re-uploaded for a tax year already on file
- **THEN** a new version is created and prior extracted data is retained

#### Scenario: Tax data is deal-isolated
- **WHEN** a user outside the confirmed access roles for a deal requests its tax return data
- **THEN** access is refused

### Requirement: Bank accounts and statements are recorded per deal

The system SHALL allow a user to create and maintain a Bank Account record for a company/deal capturing
institution name, account nickname, account type (checking, savings, money market, line of credit), and
account number with only the last four digits displayed, and SHALL allow upload of a bank statement file
(PDF or scanned image) into the data room associated with a specific Bank Account and statement period.
Every Bank Statement record SHALL retain a link back to its source uploaded file. (`DB - 0009`)

#### Scenario: Statement is bound to an account and period
- **WHEN** a user uploads a statement
- **THEN** it is associated with a specific Bank Account and statement period and links back to the
  source file

### Requirement: Statement header and transaction lines are OCR-extracted and reviewable

The system SHALL extract via OCR, from each uploaded statement, the header fields: statement period
start date, period end date, starting balance, ending balance, total deposits, and total withdrawals;
and every individual transaction line, capturing at minimum transaction date, description as printed,
amount, and direction (deposit or withdrawal). All extracted header and transaction-line fields SHALL be
presented to the user for review and manual correction before the statement can be marked Confirmed.
(`DB - 0009`)

#### Scenario: Every line is an editable row
- **WHEN** a statement is extracted
- **THEN** each transaction line appears as an individual editable row with date, description, amount,
  and direction

### Requirement: Statements reconcile against themselves before being confirmed

The system SHALL validate, for each statement, that starting balance plus total deposits minus total
withdrawals equals ending balance, and SHALL flag the statement where it does not. The system SHALL
validate that the sum of extracted deposit lines equals the extracted Total Deposits header value and
that the sum of extracted withdrawal lines equals Total Withdrawals, flagging any variance for review.
(`DB - 0009`)

#### Scenario: Header arithmetic is checked
- **WHEN** starting balance plus deposits minus withdrawals does not equal ending balance
- **THEN** the statement is flagged

#### Scenario: Lines are checked against headers
- **WHEN** the sum of transaction lines does not match the corresponding header total
- **THEN** the variance is flagged for review

### Requirement: Statement processing status and versioning

The system SHALL track a processing status for each statement — Pending, Extracted – Needs Review,
Confirmed, or Failed — and SHALL allow re-upload of a statement for a period that already has a record,
creating a new version rather than overwriting the prior record or its transaction lines. (`DB - 0009`)

#### Scenario: Re-upload of a confirmed period versions
- **WHEN** a statement is re-uploaded for an already-Confirmed period
- **THEN** a new version is created and the prior version and its lines are retained

#### Scenario: Statement data is deal-isolated
- **WHEN** a user without access to the deal attempts to view, search, or retrieve its statement or
  transaction data
- **THEN** access is refused

### Requirement: One stored table, several module contexts

The system SHALL support the same underlying report/table structure being scoped to more than one
downstream module context — QoE, CIM prep, broker-facing — without duplicating the stored data for each
context, so a QoE provider and a broker can link different files and control their own process against a
shared store. (`DB - 0010`, assumed by `DB - 0001`)

**Fidelity: sketch** — the product list marks `DB - 0010` as "more conceptual than spec doc"; `DB - 0001`
assumes this scoping exists but does not design it. Resolving it shapes the `financial-data` data model.

#### Scenario: Contexts diverge without duplicating storage
- **WHEN** a QoE provider and a broker each link their own set of files on the same deal
- **THEN** both resolve against the same stored table structure without a duplicated copy per context

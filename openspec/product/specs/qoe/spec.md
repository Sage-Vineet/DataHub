## Purpose

The Quality of Earnings engagement: everything that turns ingested financial data into a defensible
normalized earnings figure and the workpapers supporting it. Covers `QE - 0001` … `QE - 0015` — tax
reconciliation, full tax return mapping, proof of cash, the SDE/EBITDA bridge, executive summary,
working capital, risks and opportunities, CIM comparison, customer and vendor concentration, AR and AP
aging, workbook and PowerPoint export, and the Q&A generator.

**Fidelity: specified.** Requirements are drawn from the fifteen `QE` feature specifications (Josh
Tonnesen, 14 Aug 2026). This is the deepest analytical capability in the surface and sits entirely
downstream of `financial-data`.

**ID note.** `QE - 0005` and `QE - 0007` refer to the permission model as `SE - 0002` and to AI metering
as `SY - 0001`; those are now `SY - 0002` and `SY - 0004`. `QE - 0004` refers to the earnings-metric
convention as configured in `CP - 0001`.

**Narrative guidance is now a concrete artifact.** `QE - 0005`, `QE - 0006` and `QE - 0007` each defer
narrative tone and structure to "the firm's established narrative approach, maintained as internal
guidance/reference material, not a live external integration". That material now exists as four
documents delivered with the feature set — a working capital guide, an SDE / Adjusted EBITDA narrative
guide, a risks and opportunities guide, and a general authoring instruction file (Tonnesen Accounting
Services, revised 8 Aug 2026). They impose testable constraints on narrative output, and the ones that
are behaviour rather than style are stated as requirements at the end of this spec. A fifth document, a
quality control guide defining a seven-step workbook review, describes a workflow **no `QE` feature
covers** — see `design.md` Register B.

## ADDED Requirements

### Requirement: Tax reconciliation records, one per fiscal year

The system SHALL create one reconciliation record per fiscal year for each of the trailing three fiscal
years, scoped to a single company/deal, supporting return types Form 1120, Form 1120-S, Form 1065, and
Schedule C in v1. For each year it SHALL pull tax return net/ordinary income from the Tax Return Table
(`DB - 0008`) and GL-based net income for the same period from `DB - 0002` / `RP - 0001`, using the
unadjusted reported figure rather than the adjusted EBITDA/SDE figure from `QE - 0004`. The
reconciliation page SHALL be interactive, allowing the assigned accountant to review, adjust, and
finalize within the module rather than offline. (`QE - 0001`)

#### Scenario: Book and tax income are drawn from their own sources
- **WHEN** a fiscal year's reconciliation is opened
- **THEN** tax return net income comes from the Tax Return Table and financial net income from the
  unadjusted GL/P&L figure

### Requirement: Schedule M-1 items are matched as suggestions with explanations

The system SHALL pull all Schedule M-1 line items present on the loaded return from `DB - 0008` and
attempt to match each to a corresponding P&L account using AI-assisted matching, displaying for each
match an explanatory note describing the basis for it. Matched M-1 items SHALL be presented as
suggestions only, and SHALL NOT count toward the reconciled total until the accountant explicitly
accepts them. (`QE - 0001`)

#### Scenario: Nothing counts until accepted
- **WHEN** an M-1 item is matched
- **THEN** it is shown with its explanatory note and contributes nothing to the reconciled total until
  accepted

### Requirement: Officer compensation and book-versus-tax depreciation always appear

The system SHALL always display an officer compensation reconciling line for every reconciliation,
populated from the tax return officer compensation field and, where available, payroll data
(`DR - 0007`), defaulting to $0 when not applicable; and SHALL always display a book-versus-tax
depreciation reconciling line, populated from GL depreciation expense and the return's reported
depreciation figure, defaulting to $0 difference when not applicable. (`QE - 0001`)

#### Scenario: Both lines are present even at zero
- **WHEN** neither officer compensation nor a depreciation difference applies
- **THEN** both lines still display, at $0

### Requirement: Basis adjustments are computed exactly, never estimated

The system SHALL compute a fixed, defined set of candidate cash/accrual basis adjustments for each
fiscal year, including at minimum change in accounts receivable, change in customer deposits/deferred
revenue, change in inventory, and change in accounts payable, each calculated as the exact
beginning-to-ending balance delta for that account from the Trial Balance (`DB - 0004`) — never as an
AI-estimated or approximated value. The system SHALL also stage additional deterministic candidates
commonly relevant to closing a residual gap, including non-taxable income and book-recorded
federal/state income tax expense, computed directly from GL data. (`QE - 0001`)

#### Scenario: Deltas come from the trial balance
- **WHEN** a basis adjustment candidate is computed
- **THEN** its value is the exact beginning-to-ending trial balance delta, not an estimate

### Requirement: Candidate combinations are tested against the residual variance

The system SHALL test combinations of the staged candidate adjustments against the remaining variance —
tax return net income less financial net income, after accepted M-1 items — and present the best-fit
combination(s) closing the gap within the engagement's configured threshold. Each staged candidate SHALL
be individually toggleable and SHALL NOT count toward the reconciled total until included by the
accountant. The accountant SHALL be able to manually add a reconciling item with a description and
amount, and to edit or remove any system-proposed or manually added item. (`QE - 0001`)

#### Scenario: Best-fit combinations are proposed, not applied
- **WHEN** a residual variance remains after accepted M-1 items
- **THEN** best-fit candidate combinations are presented and each contributes only once included

### Requirement: Reconciliation threshold, running totals, and status

The system SHALL support an engagement-level configurable reconciliation threshold expressed as a
percentage of adjusted EBITDA/SDE (`QE - 0004`) where available, falling back to a percentage of tax
return net income or a user-entered dollar amount. The system SHALL display the running total of
confirmed reconciling items and the remaining variance in real time as items are accepted, rejected,
edited, or added, and SHALL mark a fiscal year "Reconciled" when the remaining variance falls within the
threshold and "Open" otherwise. A per-year summary SHALL show tax return net income, financial net
income, confirmed reconciling items, remaining variance, and status. (`QE - 0001`)

#### Scenario: Status follows the threshold
- **WHEN** the remaining variance falls within the configured threshold
- **THEN** the fiscal year is marked Reconciled, and Open otherwise

### Requirement: Open reconciliations raise targeted questions

When a fiscal year's reconciliation is marked Open, the system SHALL generate prepopulated clarifying
questions tied to the specific unexplained accounts or amounts and route them to the Q&A module
(`QA - 0001` / `QA - 0002`) for the company to answer. (`QE - 0001`)

#### Scenario: Unexplained amounts become questions
- **WHEN** a reconciliation remains Open
- **THEN** questions naming the specific unexplained accounts or amounts are routed to Q&A

### Requirement: Reconciliation edits are audited with before and after values

The system SHALL log every manual addition, edit, acceptance, or rejection of a reconciling item to the
Activity & Audit Log, capturing user, timestamp, and before/after values. (`QE - 0001`, feeds
`SY - 0003`)

#### Scenario: Item changes carry their prior value
- **WHEN** a reconciling item is added, edited, accepted, or rejected
- **THEN** the log records the user, timestamp, and before and after values

### Requirement: Full tax return mapping is manually triggered and gated on a loaded return

The system SHALL allow a user to manually trigger a full tax return mapping analysis for a
company/engagement, and the mapping SHALL NOT run automatically on GL upload or COA generation. A tax
return SHALL have been loaded into `DB - 0008` for the relevant form type before the analysis can run.
The run SHALL be scoped at engagement level, a single pass covering the return years and forms loaded
for that engagement rather than one run per return year. (`QE - 0002`)

#### Scenario: No return, no mapping
- **WHEN** no tax return is loaded for the relevant form type
- **THEN** the mapping analysis cannot be run

### Requirement: Account-level, many-to-many mapping with confidence

The system SHALL use AI to propose a mapping from each individual COA account (`DB - 0003` /
`DB - 0006`) to a specific line on the loaded return, at account level rather than rolled-up category
level, and SHALL support many-to-many relationships — one account mapping to several lines, several
accounts mapping to one line — reflecting that tax preparers do not map book accounts one-to-one. Each
proposal SHALL carry a confidence level of High, Medium, or Low, or the account SHALL be explicitly
marked Unmapped where no confident association can be made. All Low-confidence and Unmapped accounts
SHALL be surfaced as a distinct reviewable list, preferring a short residual list over forcing a
low-confidence guess on every account. (`QE - 0002`)

#### Scenario: Residual list beats forced guesses
- **WHEN** mapping completes
- **THEN** Low-confidence and Unmapped accounts appear as their own reviewable list rather than being
  assigned a low-confidence line

### Requirement: Mappings are overridable, persisted, and re-runnable without silent loss

The system SHALL allow the user to accept, reject, or override any proposed mapping and to manually
assign a return line to an account left unmapped, and SHALL persist the resulting classification and
confidence level on the COA account record — the field blank at initial GL load and populated only once
this analysis has run. The user SHALL be able to re-run the analysis on demand, for example after an
additional return year is loaded or after COA reclassification, creating an updated mapping result
rather than silently overwriting prior manual overrides without confirmation. (`QE - 0002`)

#### Scenario: Re-running does not silently discard overrides
- **WHEN** the mapping is re-run after manual overrides exist
- **THEN** an updated result is created and prior overrides are not overwritten without confirmation

### Requirement: Mapping runs are metered and surfaced downstream

The system SHALL log each mapping run — date, triggering user, and a reference to AI usage — for
metering consistent with `SY - 0004`, and SHALL make the mapped tax return line visible in context
wherever an add-back is displayed or referenced downstream, such as `QE - 0004`, so a reviewer sees the
supporting return line alongside the add-back. (`QE - 0002`)

#### Scenario: Add-backs show their supporting return line
- **WHEN** an add-back sourced from a mapped account is displayed
- **THEN** its mapped tax return line is visible alongside it

### Requirement: Proof of Cash workspace, scoped and autosaving

The system SHALL provide a Proof of Cash workspace scoped to a single deal, listing every bank account
identified for the company from `DB - 0009`, and SHALL allow the user to toggle which months and years
are included, applying that selection to both the Balance Review and the Activity Review. The system
SHALL run the Balance Review independently for every bank account in scope and a single consolidated
Activity Review across all accounts in scope. Reconciliation work — uncleared item entries,
reclassifications, manual reconciling items, notes — SHALL autosave continuously without an explicit
save action and persist across navigation. Each saved reconciliation state SHALL be versioned so a prior
state is distinguishable from the current one. (`QE - 0003`)

#### Scenario: Work is never lost on navigation
- **WHEN** a user enters reconciliation work and navigates away
- **THEN** the work is autosaved and present on return

### Requirement: Refreshed source data triggers recalculation and a re-review flag

The system SHALL recalculate the reconciliation automatically whenever the underlying trial balance or
bank statement data is refreshed, and SHALL flag to the user that previously entered uncleared items or
reclassifications may need re-review against the refreshed data. (`QE - 0003`)

#### Scenario: Refresh warns rather than silently invalidating
- **WHEN** a new data pull refreshes the underlying data
- **THEN** the reconciliation recalculates and prior manual entries are flagged for re-review

### Requirement: Balance Review reconciles bank to book per account and period

For each bank account and period in scope the system SHALL display, from `DB - 0009`: beginning
statement balance, total statement deposits, total statement withdrawals, and ending statement balance;
SHALL calculate a footing check of beginning + deposits − withdrawals and flag any period where it does
not equal the stated ending balance, indicating a source data quality issue; SHALL display the
corresponding ending cash balance recorded on the company's balance sheet; and SHALL calculate the
variance between the two. Where a variance exists the system SHALL provide dedicated reconciling lines
for uncleared deposits and uncleared withdrawals/checks, allowing manual entry with a required short
description against the specific account and period. The system SHALL calculate a residual "unreconciled
outage" per account/period as balance sheet ending balance − statement ending balance − uncleared
deposits + uncleared withdrawals, and SHALL visually flag any non-zero outage. Periods SHALL run across
the columns and bank accounts with their sub-lines down the rows, and the user SHALL be able to add a
free-text note to any uncleared item or outage. (`QE - 0003`)

#### Scenario: Statement that does not foot is flagged as a source issue
- **WHEN** beginning + deposits − withdrawals does not equal the stated ending balance
- **THEN** the period is flagged as a bank statement data quality issue

#### Scenario: Residual outage is visible
- **WHEN** an unreconciled outage is non-zero after uncleared items
- **THEN** it is visually flagged

### Requirement: Activity Review nets intercompany transfers to external activity

The system SHALL calculate total deposits across all bank accounts in scope for each period from
`DB - 0009`, SHALL identify intercompany transactions — transfers between the company's own in-scope
accounts — using GL detail showing both the outbound and inbound side of the same movement, and SHALL
net these out of total deposits and withdrawals to arrive at total external deposits and total external
withdrawals. (`QE - 0003`)

#### Scenario: Internal transfers do not inflate activity
- **WHEN** a transfer occurs between two of the company's own in-scope accounts
- **THEN** both sides are netted out of total deposits and withdrawals

### Requirement: Deposits and withdrawals reconcile through five ordered buckets

The system SHALL reconcile total external deposits against total recorded sales from `RP - 0001` /
`DB - 0003`, producing a subtotal variance, and SHALL reconcile that variance down through ordered,
sub-totaled buckets using changes in balance sheet account balances derived from the trial balance
(this period vs. prior, per `DB - 0003` / `DB - 0005`) or summed GL detail where more efficient:

- **Change in Assets** — accounts receivable, retentions receivable, and any other asset account matched
  against a sale or deposit.
- **Change in Liabilities** — customer deposits, change in over-billings, change in under-billings.
- **Change in Equity** — owner/shareholder contributions on the deposit side; owner/shareholder
  withdrawals on the withdrawal side, not the deposit side.
- **P&L Adjustments** — P&L accounts representing a deposit/withdrawal difference from a sale or expense,
  such as a customer refund account that is a negative sale on the P&L but a cash withdrawal. Candidates
  SHALL be flagged by AI-assisted review, with the user confirming, remapping, or rejecting each.
- **Other Adjustments** — balance sheet items whose deposit side is not a sale and whose withdrawal side
  is not an expense, such as sales tax payable and line of credit draws and paydowns. The system SHALL
  disaggregate these using GL detail: credits to the account map to the deposit-side item, debits to the
  withdrawal-side item.

Each bucket SHALL be presented as a visually distinct block. The system SHALL calculate a deposits-side
reconciling subtotal and compare it against the external deposits versus sales variance, and SHALL
perform the parallel reconciliation on the withdrawal side — total external withdrawals against total
recorded expenses, using the same balance sheet change logic and bucket structure — with any residual
withdrawal-side difference treated by default as an outstanding-check-type timing item unless remapped.
(`QE - 0003`)

#### Scenario: Buckets render as distinct blocks
- **WHEN** the Activity Review renders
- **THEN** Change in Assets, Change in Liabilities, Change in Equity, P&L Adjustments, and Other
  Adjustments each appear as their own block

#### Scenario: Sales tax payable splits by direction
- **WHEN** an Other Adjustments account carries both credits and debits
- **THEN** credits map to the deposit-side item and debits to the withdrawal-side item

### Requirement: Net unreconciled outage gates completion, with drill-down and manual control

The system SHALL calculate a net unreconciled outage as the difference between the withdrawal-side and
deposit-side reconciling totals and SHALL flag it as the primary indicator of whether the Activity
Review is complete — a non-zero outage indicating a missing mapping, a miscategorized item, or a data
quality issue to resolve before the reconciliation can be marked complete. The user SHALL be able to
drill from any bucket line to the contributing GL accounts and transaction detail; to manually reclassify
any account into a different bucket, with all affected subtotals and the outage recalculating
immediately; and to manually add a custom reconciling item with account reference, bucket assignment,
and description for scenarios automated mapping cannot resolve, without engineering changes. Moving an
account between buckets SHALL be supported by drag-and-drop or equivalent direct manipulation.
(`QE - 0003`)

#### Scenario: Reclassification recalculates immediately
- **WHEN** a user moves an account into a different bucket
- **THEN** affected subtotals and the net unreconciled outage recalculate immediately

#### Scenario: One-off cases need no code change
- **WHEN** a scenario the automated mapping cannot resolve arises
- **THEN** the user adds a custom reconciling item with account, bucket, and description

### Requirement: Proof of Cash bucket suggestions are system logic, confirmed per reconciliation

The system SHALL use AI to generate an initial suggested bucket assignment for each relevant GL account
based on account name, type, and historical mapping patterns, consistent with the `DB - 0007` precedent.
Suggestions SHALL always require confirmation; the system SHALL NEVER post a reconciling item to a
bucket without it having been confirmed by the user or previously accepted for that account within the
current reconciliation, and SHALL visually distinguish unconfirmed suggestions from confirmed mappings.
Mapping logic is system-defined financial logic based on standard accounting treatment, not a
firm-scoped or deal-scoped saved configuration: no persistent cross-deal or cross-period mapping profile
SHALL be created or reused. (`QE - 0003`)

#### Scenario: No mapping profile carries between deals
- **WHEN** a new reconciliation begins
- **THEN** account mappings are suggested fresh from built-in classification logic and confirmed within
  that reconciliation

### Requirement: The SDE/EBITDA tab has one data source at a time

The system SHALL provide a data source toggle selecting either Company Financials or Tax Return as the
source for the entire tab, defaulting to Company Financials when first opened. Switching SHALL
recalculate all rows using the newly selected source, and the two data sets SHALL NEVER be mixed in a
single view. When Tax Return is selected the system SHALL source net income and all applicable line
items from the tax return data. Each add-back record SHALL be retained independently of the toggle state
with source-appropriate account mapping applied, so an add-back entered under one source is not lost
when the user toggles to the other. (`QE - 0004`)

#### Scenario: Sources never mix
- **WHEN** the data source is toggled
- **THEN** every row recalculates from the selected source alone

#### Scenario: Add-backs survive toggling
- **WHEN** an add-back entered under one source is viewed after toggling to the other
- **THEN** the record is retained with source-appropriate mapping applied

### Requirement: Reported EBITDA is built from itemized, mapped add-backs

The system SHALL calculate and display a Reported EBITDA subtotal as Net Income + Interest Expense −
Interest Income + Depreciation Expense + Amortization Expense + Income Tax Expense, pulling Interest
Income, Interest Expense, and Income Tax Expense from predefined mapped GL account groupings, and
identifying Depreciation and Amortization using a centralized account-level flag maintained at the
Chart of Accounts / ingestion layer and shared with `QE - 0001`. Each EBIT add-back SHALL display as its
own line item and SHALL NEVER be pre-aggregated. (`QE - 0004`)

#### Scenario: EBIT add-backs are itemized
- **WHEN** Reported EBITDA renders
- **THEN** Interest Income, Interest Expense, Depreciation, Amortization, and Income Taxes each appear as
  their own line

### Requirement: Adjusted EBITDA and SDE differ only in owner compensation treatment

The system SHALL display an Add-Backs section below Reported EBITDA listing all discretionary and
normalizing adjustments, and a final bottom-line row labeled Adjusted EBITDA or SDE according to the
metric convention configured on the company profile. The system SHALL apply an Owner Compensation
add-back rule differing only by convention: Adjusted EBITDA adds back owner compensation net of one
market-rate replacement salary; SDE adds back full owner compensation with no market-rate replacement.
This SHALL be the only structural difference between the two calculations. The system SHALL calculate
and display an Adjusted EBITDA/SDE Margin as that figure divided by revenue. (`QE - 0004`)

#### Scenario: The only difference is the replacement salary
- **WHEN** the metric convention is switched between Adjusted EBITDA and SDE
- **THEN** only the owner compensation treatment changes

### Requirement: Period columns are selected discretely and aggregated by toggle

The system SHALL allow the user to include or exclude individual fiscal years or periods as displayed
columns via a selection control rather than a continuous date-range picker, SHALL allow toggling column
aggregation between Annual and Monthly, and SHALL default to Annual columns for all fiscal years
available in the ingested data. (`QE - 0004`)

#### Scenario: Column selection is discrete
- **WHEN** a user chooses which periods to display
- **THEN** periods are selected individually rather than through a continuous range picker

### Requirement: Add-backs are created through a typed wizard

The system SHALL provide an "Add New Add-Back" action launching a guided wizard requiring the user to
select a type before proceeding: PNL Account/Vendor, Balance Sheet Change, Manual Adjustment, or Recast
(post-close normalization). For **PNL Account/Vendor**, the system SHALL require selection of the
specific GL account and vendor-level detail where applicable and SHALL pull the dollar amount directly
from the GL, which SHALL NOT be manually overridden under any circumstance. For **Manual Adjustment**,
the system SHALL allow a free-form dollar amount and SHALL require a written explanation before saving.
For **Recast**, the system SHALL allow selection of an existing P&L account and entry of a normalized
post-close value, calculating the add-back as the delta between the normalized value and the actual GL
value. (`QE - 0004`)

#### Scenario: GL-sourced amounts are not editable
- **WHEN** a PNL Account/Vendor add-back is created
- **THEN** its amount is pulled from the GL and cannot be manually overridden

#### Scenario: Manual adjustments require an explanation
- **WHEN** a Manual Adjustment add-back is saved without a written explanation
- **THEN** the save is refused

### Requirement: Add-back granularity, sub-account support, and grouping

The system SHALL allow the user to specify per add-back whether the amount is entered at GL/monthly
account-level detail or as a single smoothed amount applied evenly across all displayed periods, and
SHALL support sub-account-level add-backs — such as officer health insurance as a subset of a broader
health insurance account — by allowing a manually entered partial dollar amount tied to the parent GL
account with a required supporting note. The system SHALL allow grouping multiple add-back lines under a
user-defined subtotal header to manage visual density, and SHALL allow those groups to be collapsed or
expanded without loss of underlying account-level detail. (`QE - 0004`)

#### Scenario: Collapsing preserves detail
- **WHEN** a user collapses an add-back category
- **THEN** the underlying account-level detail is retained

### Requirement: Add-backs persist to a shared cross-module library

The system SHALL persist every add-back as a record in a shared, cross-module Add-Back Library tagged to
the company/deal, so it can be referenced by the CIM/SIM builder's Adjusted EBITDA build and the future
projection model. Each stored record SHALL retain at minimum: add-back type, linked GL accounts and
vendors, amounts by period, supporting notes, and any linked Q&A references. (`QE - 0004`)

#### Scenario: The CIM reads the same add-backs
- **WHEN** the CIM's Adjusted EBITDA exhibit renders
- **THEN** it references the same Add-Back Library records rather than a separate copy

### Requirement: Commentary accompanies every bridge line

The system SHALL display a Commentary/Notes field adjacent to every bridge line item, EBIT add-backs and
discretionary add-backs alike; SHALL pre-populate a standard, non-deal-specific default note for each
EBIT add-back line explaining the general accounting rationale, editable per deal; SHALL pre-populate the
Net Income line's note with "Sourced from Company Financials" or "Sourced from Tax Return" per the
active toggle; and SHALL allow the user to enter or edit commentary on any add-back line. (`QE - 0004`)

#### Scenario: Net income note follows the toggle
- **WHEN** the data source toggle changes
- **THEN** the Net Income line's note reflects the active source

### Requirement: Owner compensation is cross-checked between return and books

Where tax-return-sourced owner compensation data is available, the system SHALL auto-populate a
suggested Owner Compensation add-back drawn from the return, SHALL check whether that figure also
appears as an identifiable line item in the company financials or GL, and SHALL visually flag any
discrepancy between the two for review. (`QE - 0004`)

#### Scenario: Discrepancy is surfaced
- **WHEN** the return's owner compensation figure differs from the identifiable GL line item
- **THEN** the discrepancy is visually flagged

### Requirement: Add-backs carry supporting documents and Q&A citations

The system SHALL allow the user to upload supporting documents against an add-back record, SHALL store
those documents in and make them accessible from the data room tagged to the source deal, and SHALL
auto-attach the ingested tax return as supporting documentation for tax-return-sourced add-backs. The
system SHALL allow linking an add-back to one or more existing Q&A entries using the `QA - 0002`
citation architecture, displaying the linked reference inline. The system SHALL allow the user to request
an auto-generated suggested commentary draft based on linked Q&A content; this SHALL always be presented
as an editable draft requiring explicit review and confirmation, and the system SHALL NEVER auto-post or
auto-finalize commentary without human confirmation. (`QE - 0004`)

#### Scenario: Drafted commentary requires confirmation
- **WHEN** a suggested commentary draft is generated from linked Q&A
- **THEN** it is presented as an editable draft and is not saved until explicitly confirmed

### Requirement: Executive Summary shows engagement metadata and sub-module completion

The system SHALL display engagement-level metadata at the top of the Executive Summary — industry,
location, and client name from the company/deal profile — and a completion tracker showing the status of
each QoE sub-module: `QE - 0001`, `QE - 0003`, `QE - 0004`, `QE - 0006`, and `QE - 0007`. Each
sub-module's status SHALL use at minimum the states Not Started, In Progress, and Complete, and the user
SHALL be able to navigate directly from a tracker item to the corresponding tab. (`QE - 0005`)

#### Scenario: Tracker is a navigation surface
- **WHEN** a user clicks a tracker item
- **THEN** the corresponding QoE sub-module tab opens

### Requirement: The Executive Summary narrative describes, and never recalculates

The system SHALL display an AI-generated narrative describing the change in revenue, margin, and
Adjusted EBITDA/SDE over the reviewed period, sourced from stored flux analysis figures and the adjusted
P&L maintained in `QE - 0004`; the AI SHALL NOT recalculate any financial figure. The narrative SHALL be
able to cite specific Q&A entries using the `QA - 0002` citation pattern where a response explains a
financial change. The system SHALL provide a control to request the narrative be expanded or condensed
on demand, SHALL allow the user to edit any generated text and save it as the authoritative version, and
SHALL persist the most recent saved version — AI-drafted or user-edited — as the default displayed.
(`QE - 0005`)

#### Scenario: Figures come from stored analysis
- **WHEN** the narrative is generated
- **THEN** it describes stored figures and computes none of its own

#### Scenario: User edits become authoritative
- **WHEN** a user edits the narrative and saves
- **THEN** that version is displayed by default thereafter

### Requirement: Mirrored summaries share one underlying record

The system SHALL display mirrored summaries for the Bank Statement Review, the Tax Return
Reconciliation, and Working Capital, each sourced from and kept in sync with the summary maintained on
its own tab, and SHALL ensure editing a mirrored summary from the Executive Summary updates the same
underlying record shown on the source tab, and vice versa — a single source of truth per summary, not a
duplicated copy. The system SHALL also display a Risks & Opportunities section reflecting entries stored
in `QE - 0007`, including both AI-drafted and user-authored entries. (`QE - 0005`)

#### Scenario: Editing either surface edits the same record
- **WHEN** a mirrored summary is edited from the Executive Summary
- **THEN** the source tab shows the same change, and the reverse also holds

### Requirement: Narrative style is informed by uploaded context and house terminology

The system SHALL allow the user to upload one or more context files — firm narrative style guide, prior
engagement examples — informing AI narrative tone and framework at the QoE module level. The system
SHALL exclude non-EBITDA/SDE-relevant add-back detail, such as officer wage add-backs, from narrative
discussion, since commentary discusses the business at a normalized net Adjusted EBITDA or SDE basis
rather than individual add-back lines. All AI-generated and template narrative language SHALL use the
term "the company" and never "the seller". (`QE - 0005`)

#### Scenario: House terminology is enforced
- **WHEN** any narrative is generated from a template or by AI
- **THEN** it refers to "the company" and never "the seller"

### Requirement: Executive Summary viewing and editing are separately governed

The system SHALL allow the Executive Summary to be viewed by any user granted access per `SY - 0002`,
independent of whether that user has edit rights to the underlying QoE tabs, and SHALL restrict narrative
editing — AI wizard actions, manual edits, context file uploads — to users with edit-level access to the
QoE module. (`QE - 0005`)

#### Scenario: Read access does not imply edit access
- **WHEN** a user with view-only QoE access opens the Executive Summary
- **THEN** they can read it and cannot edit the narrative or upload context files

### Requirement: Working capital shows current accounts in COA hierarchy over a selected range

The system SHALL allow the user to select a date range via a slider or equivalent input, and SHALL
display cash, other current asset, and other current liability accounts for that range from validated GL
data (`DB - 0005`), presented in the `DB - 0003` parent/child hierarchy with parents expandable into
constituent children, showing the actual account balance as of the selected range. The system SHALL
calculate and display a Net Position at the bottom of the account list, defined as total current assets
including cash minus total current liabilities. (`QE - 0006`)

#### Scenario: Hierarchy expands to child accounts
- **WHEN** a user expands a parent account
- **THEN** its constituent child accounts and balances are shown

### Requirement: Working capital inclusion is classified per account and overridable

The system SHALL provide a toggle per account marking whether it is included in working capital,
independent of how the account is classified as a current asset or liability elsewhere. The system SHALL
generate a suggested include/exclude classification per account using the `DB - 0007` AI-assisted
approach without requiring acceptance, SHALL default accounts identified as clearly non-working-capital
in nature — such as loans to shareholder or related party — to excluded while allowing override, and
SHALL persist the user's final selection distinctly from the system's original suggestion for audit.
(`QE - 0006`)

#### Scenario: Suggestion and decision are stored separately
- **WHEN** a user overrides a suggested classification
- **THEN** both the original suggestion and the user's final selection are retained

### Requirement: Trailing averages display only where history supports them

The system SHALL calculate trailing average balances for each account or hierarchy roll-up at 3-, 6-,
12-, and 24-month intervals ending at the user-selected date, and SHALL display only the intervals
applicable given available GL history — a 24-month average SHALL NOT display where fewer than 24 months
exist, and the system SHALL indicate the shortfall rather than silently omitting it. (`QE - 0006`)

#### Scenario: Insufficient history is stated, not hidden
- **WHEN** fewer than 24 months of GL history exist
- **THEN** the 24-month average is not displayed and the shortfall is indicated

### Requirement: Working capital peg, variance, and true-up

The system SHALL allow the user to select which trailing average interval serves as the Working Capital
Peg, defaulting to the 12-month average; SHALL display a Closing Balance Sheet column reflecting balances
as of the deal's closing balance sheet date; SHALL calculate a Variance column equal to the Closing
Balance Sheet value minus the Peg value for working-capital-included accounts and in total; and SHALL
calculate a True-Up amount with a labeled direction — "Seller owes Buyer" or "Buyer owes Seller" —
according to whether the closing position is above or below the Peg. A "Show Working Capital Peg
Analysis" toggle SHALL show or hide the Peg, Variance, and True-Up columns without deleting or
recalculating underlying data. The system SHALL calculate and display the net working capital position
both including and excluding cash without requiring a separate report. (`QE - 0006`)

#### Scenario: True-up direction is explicit
- **WHEN** the closing working capital position differs from the Peg
- **THEN** the True-Up amount is displayed with an explicit "Seller owes Buyer" or "Buyer owes Seller"
  label

### Requirement: Recommended cash balance is computed independently of the peg

The system SHALL provide a "Show Recommended Cash Balance" toggle independent of the Peg Analysis
toggle. It SHALL calculate a base monthly adjusted expense figure from the trailing twelve months of
expense data ending at the closing balance sheet date, excluding depreciation, amortization, and other
non-cash or non-operating add-back items already identified in `QE - 0004`. An "Include Debt Service"
toggle SHALL add a monthly debt service amount, sourced from or manually entered against the projection
model; an "Include Capital Expenditure Estimate" toggle SHALL add an estimated monthly CapEx amount with
an overridable default. An Uncertainty Multiplier input, expressed in months and supporting fractional
values, SHALL multiply against the fully loaded monthly expense figure to produce the Recommended Cash
Balance. That figure SHALL be displayed as a distinct, separately labeled value from the Peg and SHALL
NOT be included in the working capital Net Position unless the user explicitly includes cash.
(`QE - 0006`)

#### Scenario: Recommended cash stays out of the net position
- **WHEN** the Recommended Cash Balance is displayed
- **THEN** it does not enter the working capital Net Position unless cash is explicitly included

### Requirement: Working capital narrative is generated, cited, and fully versioned

The system SHALL provide a "Generate Working Capital Narrative" action producing a draft referencing only
accounts currently toggled included, following the firm's established narrative approach and structure
maintained as internal guidance rather than a live external integration, and referring to "the company"
never "the seller". The narrative SHALL incorporate relevant Q&A citations using the `QA - 0001` /
`QA - 0002` citation and click-through approach. The user SHALL be able to edit the text directly. The
system SHALL save a new version each time the user saves, retaining full version history rather than only
the most recent prior version, and SHALL allow viewing prior versions and reverting to any of them.
(`QE - 0006`)

#### Scenario: Excluded accounts stay out of the narrative
- **WHEN** the narrative is generated
- **THEN** it references only accounts currently toggled included

#### Scenario: Full history is revertible
- **WHEN** a user views prior narrative versions
- **THEN** any prior version can be restored as the current narrative

### Requirement: Risks and opportunities are cited narrative blocks

The system SHALL display a Risk and Opportunities section within the Executive Summary organized as two
lists, Risks and Opportunities, storing each item as a free-form narrative text block rather than a
structured record of severity and category fields, with support for one or more inline citation links
embedded in the text. Citations SHALL be able to reference a specific Q&A item (`QA - 0001` /
`QA - 0002`) or a specific financial data point, account, or period (`DB - 0002` … `DB - 0004`, or a QE
tab such as `QE - 0009`), and SHALL render as clickable links navigating to the underlying source.
(`QE - 0007`)

#### Scenario: Citations click through to their source
- **WHEN** a reader clicks an inline citation in a risk or opportunity
- **THEN** the underlying Q&A thread or financial schedule opens

### Requirement: Generation is scoped, deduplicated, and always pending

The system SHALL provide a Generate action invoking AI to draft new risk and opportunity items from a
scoped context window comprising at minimum Q&A responses with their `QA - 0002` Module/Section/Account
tags, the `QE - 0004` adjustment detail, and relevant quantitative flags from `DB - 0002` … `DB - 0004`
— and SHALL NOT run generation against the full data room or an unscoped document set. The system SHALL
only generate items not already substantively represented on the current list, whether previously
approved, rejected, or still pending, avoiding duplicate suggestions on repeated runs. All generated
items SHALL be treated as Pending, and a pending item SHALL NOT appear in any exported or client-facing
deliverable until explicitly approved. (`QE - 0007`)

#### Scenario: Generation does not read the whole data room
- **WHEN** the Generate action runs
- **THEN** only the scoped context window is used

#### Scenario: Repeated runs do not duplicate
- **WHEN** Generate is run again
- **THEN** items already represented on the list, including rejected ones, are not re-suggested

### Requirement: Items are reviewed individually and rejections are retained

The system SHALL allow the reviewer to Approve, Reject, or Edit-then-Approve each pending item
individually, to manually add a new item directly with the same citation support, and to edit or delete
any item at any time prior to final report lock. Rejected items SHALL be retained in a hidden or
collapsed state rather than deleted, so a future generation run does not re-suggest them and the
reviewer retains an audit trail of what was considered and dismissed. (`QE - 0007`)

#### Scenario: Rejections are remembered
- **WHEN** an item is rejected
- **THEN** it is retained hidden and is not re-suggested on a later run

### Requirement: Narrative tone is configurable with a defined fallback chain

The system SHALL support a configurable tone, style, and verbosity setting — concise versus wordy,
casual versus formal — with a firm-level default and an optional user-level override, applying the user
override when present, falling back to the firm default otherwise, and applying a documented
system-defined baseline when neither is configured. All generated and template text SHALL use "the
company" and never "the seller". (`QE - 0007`)

#### Scenario: Fallback chain resolves in order
- **WHEN** no user override and no firm default are configured
- **THEN** the platform's documented baseline style is applied

### Requirement: Risk and opportunity activity is logged, metered, and gated on approval

The system SHALL log every generation event — who initiated it, when, and which items were produced —
and every approval, rejection, and edit to the Activity & Audit Log; SHALL meter each AI generation call
against `SY - 0004`; and SHALL include only Approved items in any exported workbook (`QE - 0013`),
PowerPoint deck (`QE - 0014` / `CM - 0001`), or valuation summary commentary pull (`VL - 0005`).
(`QE - 0007`)

#### Scenario: Pending items never reach a deliverable
- **WHEN** a workbook, deck, or valuation summary is produced
- **THEN** only Approved items are included

### Requirement: CIM comparison sources advertised figures, keeping one current set

The system SHALL provide a CIM Comparison tab within the QoE module scoped to a single deal. On load it
SHALL check whether a CIM/SIM was built for the deal in the CM module and auto-populate advertised
figures from it. Where no CM-module CIM/SIM exists, the system SHALL allow manual entry of advertised
P&L and add-back figures or upload of a CIM/SIM document for AI/OCR-assisted extraction. The system
SHALL maintain only a single current advertised data set per deal; a new manual entry or upload SHALL
replace the prior set rather than retaining multiple versions. (`QE - 0008`)

#### Scenario: New advertised data replaces the old
- **WHEN** advertised figures are re-entered or re-uploaded
- **THEN** the prior advertised data set is replaced rather than versioned alongside

### Requirement: Line-item comparison of advertised against recalculated figures

The system SHALL display a full line-item comparison of Sales, Cost of Goods Sold / Gross Profit,
Operating Expenses to GL account level, EBITDA Adjustments, and Net Income — advertised versus
recalculated — following the structural pattern of the Tax Reconciliation tab, and SHALL calculate and
display dollar and percentage variance for each line. (`QE - 0008`)

#### Scenario: Variance is shown both ways
- **WHEN** the comparison renders
- **THEN** each line shows both a dollar and a percentage variance

### Requirement: Add-back populations are matched, overridable, and fully accounted for

Below Net Income the system SHALL separately list the full population of add-backs advertised in the
CIM/SIM and the full population from the QoE SDE/EBITDA workpaper (`QE - 0004`), each carrying its
Accepted/Denied status as determined there. The system SHALL auto-match CIM add-back lines to QoE
add-back lines using fuzzy/AI text matching, SHALL allow the reviewer to manually override, re-map,
split, or unmatch any pair, and SHALL persist manual mapping overrides for the life of the deal,
re-applying them if the same labels recur after a re-upload or re-entry. Any advertised add-back with no
matched QoE add-back SHALL display unmatched, tagged "Not Recognized", and be included in the variance
total at full value; any QoE add-back with no matched advertised add-back SHALL display unmatched,
tagged "Not Advertised", and likewise be included at full value. The system SHALL calculate line-by-line
dollar and percentage variance for all matched pairs and a summary total comparing total advertised
add-backs to total QoE-accepted add-backs with net variance. (`QE - 0008`)

#### Scenario: Unmatched add-backs are tagged and counted
- **WHEN** an add-back exists on only one side
- **THEN** it is tagged Not Recognized or Not Advertised and included in the variance total at full value

#### Scenario: Overrides survive a re-upload
- **WHEN** advertised data is re-uploaded with the same add-back labels
- **THEN** prior manual mapping overrides are re-applied

### Requirement: CIM comparison narrative, citations, and question generation

The system SHALL generate an AI-drafted narrative summary of the P&L and add-back comparison, editable
by the reviewer prior to finalizing, referring to "the company" and never "the seller". The system SHALL
support inline citation links from any variance line to related Q&A entries, SHALL support triggering a
new question via the Q&A Generator (`QE - 0015`) directly from an unexplained variance line, and SHALL
support inclusion of this tab in the Workbook Export (`QE - 0013`). (`QE - 0008`)

#### Scenario: A variance can raise its own question
- **WHEN** a reviewer triggers question generation from an unexplained variance line
- **THEN** a question is created through the Q&A Generator carrying that line's context

### Requirement: Customer concentration is ranked from GL sales by customer

The system SHALL generate a customer concentration table from GL sales transactions filtered to revenue
accounts and grouped by customer, ranking customers by total sales largest to smallest for each
selectable period, and displaying per customer: total sales for the period, percentage of total revenue,
and rank. Sales transactions lacking a customer identifier SHALL be grouped into an "Unidentified /
Other" bucket displayed separately. The system SHALL provide a time-period toggle supporting a
multi-period trend view showing concentration per customer side by side or as a trend across periods.
(`QE - 0009`)

#### Scenario: Untagged sales are visible, not hidden
- **WHEN** sales transactions carry no customer identifier
- **THEN** they appear in a separate Unidentified / Other bucket

### Requirement: Supplemental customer data is accepted and visibly distinguished

The system SHALL allow the user to upload supplemental customer-level sales data to fill gaps where GL
customer tagging is incomplete, tagging it as user-supplied in the underlying record and visually
distinguishing it wherever it is blended into the table or charts. (`QE - 0009`)

#### Scenario: Blended data is labelled
- **WHEN** supplemental data is blended into the concentration table or chart
- **THEN** it is visually distinguished as user-supplied

### Requirement: Duplicate customer merges are proposed and never auto-applied

The system SHALL run AI-based fuzzy name matching to identify likely duplicate customer names — typos,
punctuation or abbreviation variants — and present suggested merges in a review queue. The system SHALL
NOT auto-apply a merge; the user SHALL explicitly approve each before it affects the table or charts, and
SHALL be able to reject one, leaving the customers separate. Once approved, the system SHALL combine the
merged customers' sales for calculation and display while retaining the ability to view the original
unmerged detail. (`QE - 0009`)

#### Scenario: Original detail survives a merge
- **WHEN** a merge is approved
- **THEN** concentration combines the customers and the original unmerged detail remains viewable

### Requirement: Related-party customers are flagged for acknowledgement, not merged

The system SHALL run AI-based fuzzy matching comparing customer names against the business owner's name
as captured in tax return add-back data (`QE - 0001`) and flag any high-similarity name as a potential
related party, presenting these in a review queue distinct from the duplicate-merge queue and requiring
acknowledgement or dismissal rather than a merge action. (`QE - 0009`)

#### Scenario: Related-party queue is separate
- **WHEN** a customer name closely matches the owner's name
- **THEN** it appears in the related-party queue for acknowledgement or dismissal, not the merge queue

### Requirement: Customer concentration visualization, metrics, and versioning

The system SHALL display top-customer concentration via at minimum a ranked table, a bar or pie chart of
the top N customers, and a trend view across periods, allowing the user to configure the top N shown in
the chart independently of the full customer count in the table. The system SHALL calculate and display
percentage of revenue from the top 1, top 5, and top 10 customers, SHALL support export through
`QE - 0013` and `QE - 0014`, and SHALL recalculate concentration automatically whenever underlying GL
data is re-pulled as a new version, with historical views built on prior GL versions remaining viewable.
(`QE - 0009`)

#### Scenario: Prior-version views remain available
- **WHEN** GL data is re-pulled as a new version
- **THEN** concentration recalculates and views built on prior versions remain viewable

### Requirement: Vendor concentration offers all-expenses and by-account views

The system SHALL generate a vendor concentration table from GL transaction detail (`DB - 0002`) filtered
to expense-classified accounts and aggregated by vendor, ranking vendors largest to smallest by total
spend for the selected period and view. It SHALL provide a toggle between "All Expenses" — vendor spend
across all expense accounts — and "By Account/Category" — vendor spend scoped to a single account or
rollup node selected ad hoc from the COA hierarchy (`DB - 0003` / `DB - 0006`), with any account or
rollup node selectable rather than a fixed set of predefined categories. A default materiality
threshold, configurable at firm level, SHALL determine which accounts are surfaced as selectable so
immaterial accounts do not clutter the list, and the user SHALL be able to override the threshold or
view unfiltered. (`QE - 0010`)

#### Scenario: Any rollup node is selectable
- **WHEN** a user picks a scope in the By Account/Category view
- **THEN** any account or rollup node in the hierarchy can be chosen

### Requirement: Vendor concentration table, chart, and period movement

The system SHALL display for the selected view a ranked table showing vendor name, total spend,
percentage of total (of all expenses or of the selected account, per view), and transaction count; SHALL
provide at least one chart visualization reflecting the same ranked data and updating dynamically with
the table; and SHALL provide a period toggle moving across fiscal periods and years with table and chart
updating accordingly. (`QE - 0010`)

#### Scenario: Chart tracks the table
- **WHEN** the view or period changes
- **THEN** the chart updates to reflect the same ranked data as the table

### Requirement: Vendor duplicates and related parties are user-confirmed

The system SHALL run AI-based duplicate vendor name detection flagging name pairs or groups likely
representing the same underlying vendor — typos, abbreviations, punctuation variants, DBA differences —
and SHALL allow the user to confirm or reject each grouping, confirmed groupings consolidating spend
under a single entry going forward. The system SHALL flag vendors as potential related parties using the
same detection logic and data sources established in `QE - 0009`, visually distinguish flagged vendors
in table and chart, and allow the user to confirm or dismiss a flag with that status persisting for that
vendor within the engagement. Concentration percentages SHALL recalculate after any user-confirmed
consolidation without altering underlying GL transaction data. (`QE - 0010`)

#### Scenario: Consolidation recalculates without touching the GL
- **WHEN** a duplicate vendor grouping is confirmed
- **THEN** spend consolidates and percentages recalculate while GL transaction data is unchanged

### Requirement: AR aging reads the source document's own bucket structure

The system SHALL allow a user to designate an uploaded data room document (PDF or Excel) as an AR aging
report for a specified period end date, and SHALL extract via OCR or parsing the customer name, aging
bucket labels as they appear in the source, and the corresponding balance per customer/bucket
combination. The system SHALL NOT assume a fixed standard bucket structure; bucket labels and count
SHALL be read from the source document on a per-upload basis. Each extraction SHALL be stored as a new
version tied to its source file and period end date, without overwriting prior period extractions or
prior versions of the same period. (`QE - 0011`)

#### Scenario: Non-standard buckets are preserved
- **WHEN** a source AR aging report uses non-standard bucket labels
- **THEN** those labels are read from the document rather than mapped to an assumed structure

### Requirement: AR aging summary, detail, trend, and population changes

The system SHALL display a summary view showing total AR balance and balance by bucket for the selected
period, and a customer-level detail view showing each customer's balance by bucket. It SHALL support
side-by-side or trended comparison of the same customer's position across two or more uploaded periods,
and SHALL identify and flag customers present in a prior period's extraction but absent from the
current, and customers present in the current but not in any prior period. (`QE - 0011`)

#### Scenario: Appearing and disappearing customers are flagged
- **WHEN** the customer population changes between uploaded periods
- **THEN** both newly present and newly absent customers are flagged

### Requirement: Low-confidence AR extractions are reviewed before being treated as final

The system SHALL flag a low-confidence extraction — an unparseable bucket header, an unrecognized
layout, or amounts that do not sum to the document's stated total — for manual review before the record
is treated as final, SHALL allow a user to manually correct an extracted value and log the correction as
a change to that version rather than a silent overwrite, SHALL allow linking a specific customer/period
line to a Q&A item for follow-up, and SHALL make AR aging data available for inclusion in `QE - 0013`.
(`QE - 0011`)

#### Scenario: Corrections are recorded as changes
- **WHEN** a user corrects an extracted AR value
- **THEN** the correction is logged against that version rather than silently overwriting it

### Requirement: AP aging is extracted into standardized buckets

The system SHALL allow a user to upload an AP aging report as part of the standard data upload process
via `DR - 0001`, SHALL extract vendor, invoice/bill number, invoice date, and invoice amount or balance
due into a structured AP Aging Table, and SHALL calculate an aging bucket for each line using
standardized buckets — Current, 1-30, 31-60, 61-90, and 90+ days — based on invoice date relative to the
report's as-of date. Re-upload of a new or corrected report SHALL create a new version per the standard
versioning convention rather than overwriting prior data. (`QE - 0012`)

#### Scenario: Buckets are computed from invoice dates
- **WHEN** an AP aging report is extracted
- **THEN** each line is bucketed by invoice date relative to the as-of date

### Requirement: AP aging summary, vendor detail, and threshold flags

The system SHALL display a summary view of total AP by aging bucket and a vendor detail view of total AP
by vendor with drill-down to bucket-level detail per vendor; SHALL calculate and display a vendor
concentration flag showing the top vendor and top 5 vendors as a percentage of total AP; SHALL calculate
and display the percentage of total AP balance aged over 90 days; and SHALL visually flag any vendor
concentration or aged-balance percentage exceeding a configurable threshold. (`QE - 0012`)

#### Scenario: Threshold breaches are visible
- **WHEN** vendor concentration or the over-90-day percentage exceeds the configured threshold
- **THEN** it is visually flagged

### Requirement: The AP aging tab is per-engagement optional

The system SHALL allow an authorized user to toggle the AP Aging tab on or off for a given engagement;
when off, the tab SHALL NOT appear in the QoE module navigation for that engagement. When on and no
report has been uploaded, the tab SHALL display an empty state prompting upload. (`QE - 0012`)

#### Scenario: Disabled tab is absent from navigation
- **WHEN** AP Aging is toggled off for an engagement
- **THEN** the tab does not appear in that engagement's QoE navigation

### Requirement: Workbook export offers a registry-driven page selection

The system SHALL present an "Export QoE Report" action opening a page listing every QoE page currently
registered in the Exportable Page Registry for the active deal, rendering each entry as a checkbox
reflecting a standard default selection defined by that page's own spec (included by default if
unspecified), and SHALL reset to this standard default set every time the menu is opened — selections
are not remembered per user or company. (`QE - 0013`)

#### Scenario: Defaults reset every time
- **WHEN** the export menu is reopened after a prior export with a customized selection
- **THEN** the standard default set is restored

### Requirement: Fixed tabs are built from summarized data in COA order

The system SHALL always include a Title Page tab and, when included, an Account Summary tab, a P&L tab,
and a Balance Sheet tab, using the fixed and company-configured COA hierarchy (`DB - 0003`, `DB - 0006`)
to order rows from top-level rollup down to lowest account level. The Account Summary tab SHALL be built
from GL data already summarized by account and by month — and where available by vendor or customer
within an account — not from raw transaction-level detail. Each selected QoE narrative or workpaper page
SHALL be assembled as its own tab in a fixed tab order defined by the registry. (`QE - 0013`)

#### Scenario: Account Summary reads summarized data
- **WHEN** the Account Summary tab is built
- **THEN** it is assembled from account- and month-summarized GL data, not raw transactions

### Requirement: The workbook uses native Excel structure, not visual formatting tricks

The system SHALL implement account/vendor row drill-down and month column drill-down using native Excel
row and column grouping and outline controls, with plain unmerged cells beneath each grouping level, and
SHALL permit cell merging only on title and header cells, never within a data grid. The system SHALL
link values across tabs using native Excel formulas wherever the referenced figure has a direct,
unambiguous source cell, in preference to a static pasted value; where a cross-tab formula's source
account or row does not exist for the company — no separate COGS breakout, for example — the destination
cell SHALL render as $0 or blank without displaying an error value. Inline Q&A citation tags appearing in
exported narrative text SHALL render as plain, non-interactive text labels, since a static file cannot
click through. (`QE - 0013`)

#### Scenario: Missing source renders clean
- **WHEN** a cross-tab formula's source row does not exist for the company
- **THEN** the destination cell shows $0 or blank rather than an error value

#### Scenario: Data grids stay unmerged
- **WHEN** the workbook is inspected
- **THEN** merged cells appear only on title and header cells

### Requirement: Workbook generation is asynchronous, logged, and not a system of record

The system SHALL generate the workbook asynchronously for exports above a defined page or size threshold
and notify the user when the file is ready, SHALL log every export event — user, deal, pages included,
timestamp — to the Activity & Audit Log, and SHALL NOT persist a rendered copy as the system of record.
The workbook is generated fresh from live underlying data at export time and is not a versioned document
unless the user separately uploads it back into the data room. (`QE - 0013`, feeds `SY - 0003`)

#### Scenario: Exports are not stored as the record
- **WHEN** a workbook is exported
- **THEN** no rendered copy is retained as the system of record

### Requirement: PowerPoint generation selects sections and renders native objects

The system SHALL allow a user to initiate PowerPoint generation from within the QoE module for a
specific deal, presenting a checkbox list of available sections — Executive Summary, SDE/EBITDA Tab,
Working Capital, Risk & Opportunities, CIM Comparison, Customer Concentration, Vendor Concentration, AR
Aging, AP Aging — and SHALL generate one or more slides per selected section using a predefined layout
mapped to that section's data shape: a bridge or waterfall layout for SDE/EBITDA, a table layout for
aging analyses, a chart layout for concentration data. Charts and tables SHALL render as native,
editable PowerPoint objects rather than flattened images wherever the type supports native rendering,
with images embedded natively where no native chart or table equivalent applies. (`QE - 0014`)

#### Scenario: Charts arrive editable
- **WHEN** a deck containing concentration charts is generated
- **THEN** those charts are native PowerPoint chart objects, not images

### Requirement: Firm PowerPoint template with a branded fallback

The system SHALL allow a firm administrator to upload a PowerPoint template (.potx) at firm level and
SHALL apply its slide master, colour palette, and fonts to all decks generated by users at that firm,
falling back to a default Centuriuum-branded template where no firm template has been uploaded.
(`QE - 0014`)

#### Scenario: Firm branding applies automatically
- **WHEN** a user at a firm with an uploaded template generates a deck
- **THEN** that template's master, palette, and fonts are applied

### Requirement: Decks are generated from live data, versioned, and logged

The system SHALL pull slide content directly from live QoE module data at generation time so figures
match the current state of the workpapers, SHALL generate a new timestamped version each time the user
regenerates without overwriting a prior export, SHALL allow the user to download the .pptx, SHALL log
each generation event — user, deal, timestamp, sections included, template used — to the audit trail,
and SHALL display a generation-in-progress indicator and notify the user when the deck is ready.
(`QE - 0014`, feeds `SY - 0003`)

#### Scenario: Regeneration does not overwrite
- **WHEN** a user regenerates the deck
- **THEN** a new timestamped version is produced and the prior export is retained

### Requirement: Q&A generation requires a real materiality threshold

The system SHALL allow the user to set a deal-level dollar materiality threshold, pre-filled with a
default of 1% of expected SDE/EBITDA from `QE - 0004` where available, and a deal-level percentage
threshold pre-filled with a default of 5% of the account's prior-period balance. Where expected
SDE/EBITDA is not yet available, the system SHALL prompt the user to enter a dollar threshold manually
before generating any questions and SHALL NOT generate questions using a zero or blank threshold. Either
threshold SHALL be editable at any time, applying to the next generation run and SHALL NOT retroactively
alter previously generated or published questions. (`QE - 0015`)

#### Scenario: No generation on a blank threshold
- **WHEN** expected SDE/EBITDA is unavailable and no dollar threshold has been entered
- **THEN** the user is prompted and no questions are generated

### Requirement: P&L questions are annual, dual-threshold, and operationally framed

The system SHALL generate P&L questions only on an annual, full-year basis, comparing account totals
across the selected annual review periods, and SHALL flag an account for a question only where the
change between periods meets or exceeds **both** the dollar and the percentage materiality threshold. It
SHALL support comparison across more than two periods within a single question where relevant, SHALL
analyze whether an account behaves as fixed or variable relative to revenue and phrase the question as a
percentage-of-sales change instead of or in addition to a dollar and percent change where that framing
is more meaningful, and SHALL phrase each question to elicit an operational explanation of the
underlying business change rather than solely a financial description of the variance. Where vendor- or
customer-level detail is available, the system SHALL identify the largest contributors to a flagged
variance and reference them by name in the question text. Every generated question SHALL retain a
reference to its source accounts including account name and number. (`QE - 0015`)

#### Scenario: Both thresholds must be met
- **WHEN** a change exceeds the dollar threshold but not the percentage threshold
- **THEN** no question is generated for that account

#### Scenario: Largest contributors are named
- **WHEN** vendor or customer detail exists for a flagged variance
- **THEN** the largest contributors are referenced by name in the question

### Requirement: Offsetting reclassifications are suppressed, overridably

The system SHALL detect likely offsetting reclassifications — two or more accounts within the same
grouping per the COA hierarchy whose changes in the same period substantially net to zero within a
configurable tolerance — and SHALL suppress the auto-generated question for those accounts, flagging the
suppression as a system decision the reviewer can override. The system SHALL flag unnatural balances on
the P&L, such as a negative expense account, as a question candidate unless already suppressed as a
detected reclassification. (`QE - 0015`)

#### Scenario: Suppression is visible and reversible
- **WHEN** offsetting changes net to zero within tolerance
- **THEN** the question is suppressed, the suppression is flagged, and the reviewer can re-include it

### Requirement: Balance sheet questions include a retained earnings roll-forward check

The system SHALL apply the same dollar and percentage materiality comparison logic to Balance Sheet
accounts across annual periods, SHALL flag unnatural balances such as a negative balance in an account
that should not carry one, and SHALL generate a check confirming that retained earnings roll forward
correctly — beginning retained earnings + net income − distributions = ending retained earnings — for
each annual period, generating a question automatically where the roll-forward does not tie out.
(`QE - 0015`)

#### Scenario: A broken roll-forward raises a question
- **WHEN** retained earnings do not roll forward correctly for a period
- **THEN** a question is generated automatically

### Requirement: Generated questions are reviewed alongside the report and published to Q&A

The system SHALL display all generated questions for the current review periods in a column adjacent to
the P&L or Balance Sheet display without altering how `RP - 0001` / `RP - 0002` render the underlying
report. The reviewer SHALL be able to edit any question's text before publishing, delete or discard a
question without publishing, manually re-include a suppressed question, publish an edited or unedited
question directly into the Q&A module per `QA - 0001` / `QA - 0002` structure and tagging while
preserving the account reference as the citation tag, and export the full list of generated questions —
published or not — to Excel. The system SHALL retain a record of which questions were generated, edited,
discarded, suppressed, or published, and by whom. (`QE - 0015`)

#### Scenario: Reports render unchanged
- **WHEN** generated questions are displayed alongside the P&L
- **THEN** the underlying report rendering is unaltered

#### Scenario: Publication carries the citation
- **WHEN** a question is published into the Q&A module
- **THEN** its source account reference is preserved as the citation tag

### Requirement: Narratives are sourced from the workbook and never fill gaps with assumption

Generated narrative SHALL include only information supported by the underlying workbook data. Where
data is missing, incomplete, or unclear, the system SHALL NOT fill the gap with an assumption; it SHALL
flag the gap to the reviewer instead. Sourced information SHALL carry a citation so the reviewer can
verify it before the report is finalized. (Narrative authoring guidance; `QE - 0005` … `QE - 0007`)

#### Scenario: A missing driver is flagged, not invented
- **WHEN** a material change has no supporting explanation in the workbook
- **THEN** the narrative omits it or notes only that commentary was limited, and the gap is flagged to
  the reviewer

### Requirement: Gap flags are separated from client-facing narrative text

Where a material change exists and the company could not satisfactorily explain it, the system SHALL
surface that to the reviewer **outside** the narrative body. The narrative intended for client delivery
SHALL NEVER contain language indicating that it is incomplete, requires confirmation, or is pending
follow-up. Flags SHALL identify the category, the change, the period, and whether a question was asked
and left unanswered or never asked at all. (Narrative authoring guidance; `QE - 0005` … `QE - 0007`)

#### Scenario: Client-facing text carries no open-item language
- **WHEN** a narrative is generated with unresolved items
- **THEN** the copy-paste narrative contains no "pending", "to be confirmed", or equivalent language,
  and the flags appear separately to the reviewer

#### Scenario: Flags distinguish asked-but-unexplained from never-asked
- **WHEN** a gap is flagged
- **THEN** it states whether the company was asked and could not explain, or no question was asked

### Requirement: Q&A citations are read, never derived by position

Where a narrative cites a Q&A item, the system SHALL read the question's identifier from its own record
rather than deriving it from row position or ordinal count, so that a change in ordering cannot shift
every citation in a narrative. (Narrative authoring guidance; depends on `QA - 0002`'s permanent
citation IDs)

#### Scenario: Reordering does not break citations
- **WHEN** the ordering of Q&A items changes
- **THEN** every existing citation continues to resolve to the same response

### Requirement: Engagement isolation applies to narrative generation

The system SHALL treat each engagement's workbook as the only source for that engagement's narratives,
and SHALL NOT reference, cite, or draw on figures, narrative language, reviewer flags, or any other
content from another company's engagement — including through any retained context or memory — unless a
cross-engagement comparison is explicitly requested. (Narrative authoring guidance; consistent with the
deal isolation rule throughout this capability)

#### Scenario: No cross-engagement bleed
- **WHEN** a narrative is generated for one engagement
- **THEN** no figure or language from any other engagement appears in it

### Requirement: The working capital narrative has a fixed three-section structure

The generated working capital narrative SHALL follow a fixed structure: an introduction of one to two
sentences naming the company and the number of components identified; one concise paragraph per
component; and a summary of two to four sentences followed by the working capital math display and a
standard closing disclosure. Components SHALL be ordered current assets first, then current
liabilities, then omitted items, and each SHALL be rendered as "[number]. [Component Name] - [paragraph
text]" on a single line rather than as a standalone header with the paragraph beneath. Only components
that are present and material, or that should be present given the business's operations, SHALL be
included. (Narrative authoring guidance; `QE - 0006`)

#### Scenario: Section structure is invariant
- **WHEN** a working capital narrative is generated
- **THEN** it contains the introduction, the per-component paragraphs in the prescribed order, and the
  summary with math display and closing disclosure

#### Scenario: Irrelevant components are omitted
- **WHEN** a component does not exist and is not relevant to the business type
- **THEN** no section is generated for it

### Requirement: The working capital math display always shows the total liquidity need

The summary SHALL always show the working capital calculation, always including the recommended cash
reserve as the first term, so the total liquidity need at close appears in one place. The formula SHALL
follow the same order as the components discussed, SHALL include only components relevant to the
engagement, and where omitted items are present SHALL include them with an unknown-amount placeholder,
compute the total from quantified components only, and close by stating that the total is subject to
adjustment for those omitted items. The cash reserve figure in the formula SHALL match the
recommendation made in the cash reserves discussion. (Narrative authoring guidance; `QE - 0006`)

#### Scenario: Omitted items do not silently vanish from the formula
- **WHEN** an omitted item exists
- **THEN** it appears in the formula with an unknown-amount placeholder and the total is stated as
  subject to adjustment

#### Scenario: Cash reserve is internally consistent
- **WHEN** the math display renders
- **THEN** its cash reserve term equals the figure recommended in the cash reserves discussion

### Requirement: Firm policies constrain working capital narrative content

The system SHALL apply the firm's working capital policies to generated narrative: credit card balances
excluded from working capital and treated as a financing item, flagged to the reviewer where unusually
large relative to business size; no days-payable-outstanding calculation, accounts payable discussed
conceptually given the cash-basis nature of most financials reviewed; work in progress included at the
most recent available balance rather than an average, with volatility across the review period noted and
a closing true-up recommended; and no reference to whether the transaction is an asset or stock sale,
all language kept generic. (Narrative authoring guidance; `QE - 0006`)

#### Scenario: Transaction form is never assumed
- **WHEN** a working capital narrative is generated
- **THEN** it contains no asset-sale or stock-sale specific language

#### Scenario: WIP is stated at the latest balance with a true-up note
- **WHEN** work in progress is included
- **THEN** the most recent balance is used, volatility is noted, and a closing true-up is recommended

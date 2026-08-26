CENTURIUUM
Feature Specification

| Feature ID | QE - 0003 |
|---|---|
| Feature Name | Bank Statement Review (Proof of Cash) |
| Module | QE - Quality of Earnings |
| Status | Draft |
| Related / Recycled IDs | Depends on DB-0009 (Bank Statement Table), DR-0003 (Data Retrieve Wizard); references DB-0003/DB-0005/DB-0006 (COA and GL); feeds QE-0005 (Executive Summary/Tracker) and QE-0015 (Q&A Generator) |
| Author | Josh Tonnesen |
| Date | August 15, 2026 |

# 1. Purpose & Business Context
Proof of Cash is a bookkeeping-integrity check performed as part of Quality of Earnings review. It reconciles the company's reported financials against independent bank statement data in two linked passes: a Balance Review, which confirms that each bank account's reported balance sheet balance ties to the actual bank statement balance for every period in scope, and an Activity Review, which confirms that the cash actually moving through the bank accounts is explained by the P&L and balance sheet activity the company has recorded (deposits reconciled to sales, withdrawals reconciled to expenses). A business with clean bookkeeping will show this reconciliation collapsing to zero, or to a small number of identifiable, well-understood reconciling items (uncleared deposits/withdrawals, timing differences, misclassified accounts). A business where it does not reconcile is flagging either a bookkeeping quality issue, a fraud/completeness risk, or accounts that need to be reclassified before EBITDA/SDE adjustments in QE-0004 can be trusted.
This feature does not need to fully automate correct classification of every account. Its job is to do as much of the mechanical mapping and math as the data supports, surface a clear unreconciled outage, and give the QoE reviewer a fast, structured way to identify and correct the remaining differences — replacing what the team currently does by hand in Excel.
# 2. User Stories
- As a QoE reviewer / accountant, I want the system to automatically compare each bank account's ending balance sheet balance against the bank statement ending balance for every period in scope, so that I can immediately see whether the company's cash accounting ties out.
- As a QoE reviewer, I want unreconciled variances broken into uncleared deposits, uncleared withdrawals, and a residual unreconciled outage, so that I can record the specific reason for a variance instead of leaving an unexplained gap.
- As a QoE reviewer, I want the system to pre-map GL activity into the deposit-side reconciling buckets (change in AR, change in customer deposits, change in owner contributions, P&L adjustments, other balance sheet items) so that most of the mechanical reconciliation work is done for me and I only need to review and correct exceptions.
- As a QoE reviewer, I want to manually reclassify an account into the correct bucket (or add a custom reconciling line) when the company's chart of accounts puts something in an unexpected spot, so that the reconciliation can still reach zero without me building a one-off workaround in Excel.
- As a QoE reviewer, I want my work saved automatically as I build out the reconciliation (including any reclassifications and manual reconciling items I add), so that I don't lose my analysis if I navigate away or come back to it later.
- As a QoE reviewer, I want to toggle which months/years are shown in the reconciliation grid, so that I can scope the analysis to the periods relevant to the engagement.
- As a QoE reviewer, I want a single net unreconciled outage figure across both the Balance Review and the Activity Review, so that I have one number that tells me whether the full reconciliation is complete.
# 3. Functional Requirements
Requirements are grouped by the two sub-modules described by the business logic: Balance Review and Activity Review, plus shared/system-level requirements.
3.1 General / Setup
- The system shall provide a Proof of Cash workspace scoped to a single deal, listing every bank account identified for the company (sourced from DB-0009 Bank Statement Table).
- The system shall allow the user to toggle which months and/or years are included in the reconciliation view; toggled periods shall apply to both the Balance Review and Activity Review.
- The system shall run the Balance Review independently for every bank account in scope, and shall run a single consolidated Activity Review across all bank accounts in scope.
- The system shall autosave reconciliation work (uncleared item entries, reclassifications, manual reconciling items, notes) continuously as the user works, without requiring an explicit save action, and shall persist this data so it is not lost on navigation away from the page.
- The system shall version each saved reconciliation state so that a prior saved state can be distinguished from the current one, consistent with the platform-wide convention that re-running a pull creates a new version rather than overwriting history.
- The system shall recalculate the reconciliation automatically whenever the underlying trial balance or bank statement data is refreshed (e.g., a new Data Retrieve Wizard pull), and shall flag to the user that previously entered uncleared items or reclassifications may need to be re-reviewed against the refreshed data.
3.2 Balance Review (per bank account)
- For each bank account and each period in scope, the system shall display, sourced from the DB-0009 Bank Statement Table: beginning bank statement balance, total bank statement deposits, total bank statement withdrawals, and ending bank statement balance.
- The system shall calculate and display a footing check per bank account per period: beginning balance + total deposits - total withdrawals, and shall flag any period where this does not equal the stated ending balance (indicating a data quality issue in the source bank statement data itself).
- The system shall display, for the same bank account and period, the corresponding ending cash balance recorded on the company's balance sheet (sourced from the GL/trial balance per DB-0003/DB-0005).
- The system shall calculate and display the variance between the bank statement ending balance and the balance sheet ending balance for each bank account/period.
- Where a variance exists, the system shall provide dedicated reconciling lines for: uncleared deposits (bank statement deposits not yet reflected on the books) and uncleared withdrawals/checks (book withdrawals not yet cleared on the bank statement).
- The system shall allow the user to manually enter uncleared deposit and uncleared withdrawal amounts (with a required short description per entry) against the specific bank account/period they apply to.
- The system shall calculate a residual 'unreconciled outage' per bank account/period as: balance sheet ending balance - bank statement ending balance - uncleared deposits + uncleared withdrawals, and shall visually flag any non-zero outage.
- The system shall display months/periods across the columns and bank accounts (with their Balance Review sub-lines) down the rows, consistent with how the toggled period selection in 3.1 controls the columns shown.
- The system shall allow the user to add a free-text note to any uncleared item or unreconciled outage explaining the cause.
3.3 Activity Review (consolidated across bank accounts)
- The system shall calculate total deposits across all bank accounts in scope for each period, sourced from DB-0009 Bank Statement Table activity.
- The system shall identify intercompany transactions — transfers between the company's own bank accounts in scope — using GL detail (per DB-0005/DB-0006) that shows both the outbound and inbound side of the same movement, and shall net these out of total deposits and total withdrawals to arrive at total external deposits and total external withdrawals.
- The system shall display total external deposits, and shall reconcile that figure against total recorded sales (from the P&L per RP-0001/DB-0003), producing a subtotal variance.
- The system shall reconcile the deposits-side variance down through the following ordered, sub-totaled buckets, using changes in balance sheet account balances derived from the trial balance table (this period vs. prior period, per DB-0003/DB-0005) or summed GL detail where more efficient:
- Change in Assets — e.g., accounts receivable, retentions receivable, and any other asset account that would be matched against a sale or a deposit (visually/logically grouped as its own block).
- Change in Liabilities — e.g., customer deposits, change in over-billings, change in under-billings (grouped as its own block, distinct from the Change in Assets block).
- Change in Equity — e.g., owner/shareholder contributions are a deposit-side reconciling item; owner/shareholder withdrawals are a withdrawal-side reconciling item, not a deposit-side one.
- P&L Adjustments — specific P&L accounts that represent a deposit/withdrawal difference from a sale/expense (e.g., a customer refund account, which is a negative sale on the P&L but a cash withdrawal). The system shall flag P&L accounts that are candidates for this bucket using AI-assisted review (see 3.5) and shall allow the user to confirm, remap, or reject each suggestion.
- Other Adjustments — balance sheet items with a deposit side that is not a sale and a withdrawal side that is not an expense, e.g., sales tax payable (collected as a deposit, remitted as a withdrawal) and line of credit draws/paydowns. The system shall disaggregate these using GL detail: credits to the account map to the deposit-side reconciling item; debits map to the withdrawal-side reconciling item.
- The system shall present each bucket (Change in Assets, Change in Liabilities, Change in Equity, P&L Adjustments, Other Adjustments) as a visually distinct block, both for reviewer readability and to mirror how the reconciliation would be organized on a statement-format (rather than debit/credit-format) presentation.
- The system shall calculate a deposits-side reconciling subtotal (sum of the bucket totals in item 3.3.4) and compare it against the total external deposits vs. sales variance calculated in item 3.3.3.
- The system shall perform the parallel reconciliation on the withdrawal side: total external withdrawals reconciled against total recorded expenses, using the same balance sheet change logic and the same bucket structure, with any residual withdrawal-side difference treated by default as an outstanding-check-type timing item unless remapped by the user.
- The system shall calculate a net unreconciled outage as the difference between the withdrawal-side reconciling total and the deposit-side reconciling total, and shall flag this figure as the primary indicator of whether the Activity Review is complete; a non-zero outage indicates a missing account mapping, a miscategorized item, or a data quality issue that must be resolved before the reconciliation can be marked complete.
- The system shall allow the user to drill from any bucket line down to the contributing GL account(s) and underlying transaction detail.
- The system shall allow the user to manually reclassify any account from its system-suggested bucket into a different bucket (e.g., an asset account the company miscategorized), and shall recalculate all affected subtotals and the net unreconciled outage immediately.
- The system shall allow the user to manually add a custom reconciling item (with account reference, bucket assignment, and description) for scenarios the automated mapping cannot resolve (e.g., a fixed asset disposal with an offsetting gain and a related loan/trade-in), without requiring engineering changes to support the one-off case.
- The system shall support a drag-and-drop or equivalent direct-manipulation interaction for moving an account/line between buckets.
3.5 AI-Assisted Account Mapping
- The system shall use AI to generate an initial suggested bucket assignment for each GL account relevant to the Activity Review, based on account name, account type, and historical mapping patterns, consistent with the platform's existing AI-assisted mapping precedent (DB-0007 COA Suggestions).
- AI-suggested mappings shall always be presented to the user as suggestions requiring confirmation; the system shall never post a reconciling item to a bucket without it having been either confirmed by the user or previously accepted for that account within the current reconciliation.
- The system shall visually distinguish AI-suggested/unconfirmed mappings from user-confirmed mappings.
- Per the house convention in this document's governing conventions record, mapping logic (which accounts default to which bucket) is system-defined financial logic based on standard accounting treatment, not a firm-scoped or deal-scoped saved configuration; no persistent, cross-deal or cross-period 'mapping profile' is created or reused by this feature. Each reconciliation's account mappings are suggested fresh from the system's built-in classification logic and confirmed within that reconciliation.
# 4. Data Requirements
This feature reads from existing Database module structures and introduces a new persistence layer for the reconciliation work product itself (uncleared items, reclassifications, manual reconciling items, notes, and save-state versioning), since none of the existing table blocks are designed to store reviewer-entered reconciliation data.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Bank account list (per company) | Read | DB-0009 Bank Statement Table |
| Beginning balance, total deposits, total withdrawals, ending balance (per bank account, per period) | Read | DB-0009 Bank Statement Table (via DR-0003 Data Retrieve Wizard) |
| GL transaction detail (for intercompany identification, account disaggregation, drill-down) | Read | DB-0005 / DB-0006 GL detail |
| Trial balance (period-over-period account balances for Change in Assets/Liabilities/Equity calculations) | Read | DB-0003 Trial Balance table |
| Chart of Accounts / account type metadata (for AI-suggested bucket mapping) | Read | DB-0003 / DB-0006 COA |
| Recorded sales / P&L totals (Activity Review deposit-side comparison) | Read | RP-0001 P&L (sourced from DB-0003) |
| Recorded expenses / P&L totals (Activity Review withdrawal-side comparison) | Read | RP-0001 P&L (sourced from DB-0003) |
| Uncleared deposit / uncleared withdrawal entries (Balance Review) | Write | New Proof of Cash reconciliation table (this feature) |
| Account-to-bucket reclassifications and manual reconciling items (Activity Review) | Write | New Proof of Cash reconciliation table (this feature) |
| Reconciliation notes / commentary | Write | New Proof of Cash reconciliation table (this feature) |
| Reconciliation version/save state | Write | New Proof of Cash reconciliation table (this feature) |
| Reconciliation completion status (per bank account and overall) | Write | New Proof of Cash reconciliation table (this feature); surfaced to QE-0005 Executive Summary/Tracker |

# 5. Access & Security
- Roles with access: Accountant / QoE reviewer (full edit access to build and save the reconciliation).
- Roles with view-only access: Broker (for engagement status visibility, consistent with QE-0005), pending confirmation of whether brokers should see underlying reconciliation detail or only completion status.
- Roles explicitly excluded: Bank, Buyer, and Company/Seller users — Proof of Cash working detail is internal QoE work product and is not a company-facing or buyer-facing deliverable.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web only. This is a dense analytical workspace with drag-and-drop reclassification and drill-down; it is not a candidate for the Web + Mobile (light) companion experience.
- Wireframe reference: N/A — team has an established Excel-based working format for this analysis today; recommend a short design review session before build to translate the Excel layout (periods across columns, bank accounts and buckets down rows) into the platform's UI patterns.
Balance Review layout
Grid format: bank accounts (with sub-lines: beginning balance, deposits, withdrawals, ending balance, footing check, balance sheet balance, variance, uncleared deposits, uncleared withdrawals, unreconciled outage) down the rows; toggled months/years across the columns. Non-zero footing check failures and non-zero unreconciled outages should be visually flagged (e.g., color highlight) so exceptions are scannable at a glance across many periods.
Activity Review layout
Recommend a segmented block layout matching the bucket structure in Functional Requirements 3.3–3.4: a Deposits panel (Total Deposits → less Intercompany → External Deposits → vs. Sales → Variance → reconciling blocks for Change in Assets / Change in Liabilities / Change in Equity / P&L Adjustments / Other Adjustments) and a mirrored Withdrawals panel, with the Net Unreconciled Outage surfaced prominently above or below both panels. Each bucket block should be collapsible, expandable to show contributing GL accounts, and support drag-and-drop (or an equivalent explicit reassignment action) to move an account between buckets. AI-suggested mappings should be visually distinct (e.g., a badge or muted styling) from user-confirmed mappings until confirmed.
Save/status behavior
Reconciliation state should autosave continuously; the workspace should show a persistent completion indicator per bank account (Balance Review) and for the overall Activity Review, so a reviewer can see engagement-wide status at a glance and so this status can feed QE-0005.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DB-0009 | Depends on | Bank Statement Table is the source of starting/ending balances and total deposits/withdrawals per bank account/period. Current spec for DB-0009 does not yet commit to storing full transaction-level activity — see Open Questions. |
| DR-0003 | Depends on | Data Retrieve Wizard is the pull mechanism populating DB-0009 bank statement data. |
| DB-0003 | Depends on | Trial balance table is the source for period-over-period balance sheet account changes driving the Activity Review buckets. |
| DB-0005 | Depends on | GL detail and validation layer; also the source for intercompany transaction identification via GL detail. |
| DB-0006 | Depends on | COA hierarchy structure referenced for account type/classification context feeding AI-suggested bucket mapping. |
| DB-0007 | Related | Establishes the platform's AI-assisted mapping precedent (COA Suggestions) that this feature's AI-suggested bucket mapping follows. |
| RP-0001 | Depends on | P&L reporting output used for the sales and expense comparisons in the Activity Review. |
| QE-0004 | Blocks (informs) | SDE/EBITDA adjustments rely on clean, reconciled financials; a completed Proof of Cash gives the QoE reviewer confidence in the underlying data feeding QE-0004. |
| QE-0005 | Blocks | Executive Summary/Tracker surfaces Proof of Cash completion status as one of its engagement status indicators. |
| QE-0015 | Related | Q&A Generator logic (accounts changing beyond threshold) is conceptually related and may eventually reference unresolved Proof of Cash outages as a question-generation trigger. |
| Document Versioning (cross-cutting gap) | Depends on | Reconciliation save-state versioning described in 3.1 should use the platform's general document/data versioning capability once specced, rather than a one-off versioning mechanism local to this feature. |

# 8. Out of Scope / Deferred
- Full transaction-level bank activity storage/parsing is not committed as part of this feature; DB-0009 currently scopes only starting balance, ending balance, total deposits, and total withdrawals. If full activity is later added to DB-0009, this feature should be revisited to determine whether it can improve intercompany matching or uncleared-item detection automation.
- Automated (non-AI-assisted-suggestion) detection of uncleared deposits/withdrawals is out of scope; these are user-entered based on their review, not system-detected from bank activity.
- QB Desktop (.qbb) parsing engine dependency is out of scope for this feature and tracked as its own cross-cutting gap; this feature assumes bank statement and GL data have already landed in DB-0009/DB-0003 regardless of source system.
- Fixed asset disposal / trade-in / offsetting-loan scenarios are explicitly called out as edge cases this feature does not attempt to auto-resolve; these are handled via the manual custom-reconciling-item capability (3.4) rather than dedicated logic.
- Firm-level or cross-deal reusable account mapping profiles are explicitly out of scope per the clarified answer in this spec's design discussion — mapping is system-defined financial logic re-derived each reconciliation, not a saved, portable configuration.
- Notifications (e.g., alerting a reviewer that a refreshed data pull invalidated prior reconciliation work) belong to the Notifications Hub cross-cutting gap, not a local notification mechanism built for this feature.
# 9. Open Questions
- DB-0009 currently does not commit to storing full bank transaction-level activity. Intercompany transaction identification and the underlying Activity Review math in this spec are described as relying on GL detail (DB-0005/DB-0006) rather than bank-side transaction detail — confirm this is sufficient, or whether full bank activity in DB-0009 becomes a hard dependency for this feature.
- Should Broker users see Proof of Cash completion status only (per QE-0005), or also have read access to the underlying reconciliation detail? Currently assumed status-only.
- What is the default period granularity/toggle behavior — monthly only, or should quarterly/annual roll-ups also be supported in the same grid?
- Should the system enforce that the Activity Review cannot be marked complete while the net unreconciled outage is non-zero, or should the user be able to mark it complete with a documented, accepted outage (e.g., an immaterial residual)?
- Is there a materiality threshold (dollar amount or % of adjusted EBITDA/SDE, consistent with the DB-0005 and QE-0015 threshold conventions) below which an unreconciled outage does not need to be flagged or resolved?
- Should AI-suggested bucket mappings improve/adapt within a single reconciliation as the user confirms/corrects similar accounts (session-level learning), even though no cross-deal or cross-period mapping profile is persisted?
# 10. Acceptance Criteria
- For a selected deal and a selected set of periods, the Balance Review displays, per bank account and period, beginning balance, deposits, withdrawals, ending balance, footing check, balance sheet ending balance, variance, uncleared deposits, uncleared withdrawals, and unreconciled outage — all correctly calculated per the formulas in Section 3.2.
- A user can enter an uncleared deposit or uncleared withdrawal against a specific bank account/period, and the unreconciled outage recalculates immediately and correctly.
- The Activity Review displays total deposits, intercompany eliminations, external deposits, and the variance against total sales, correctly broken into the Change in Assets / Liabilities / Equity, P&L Adjustments, and Other Adjustments buckets, with each bucket populated by system logic and reviewable/editable by the user.
- A user can reclassify an account from one bucket to another and see all dependent subtotals and the net unreconciled outage recalculate correctly.
- A user can add a manual/custom reconciling item and see it reflected in the appropriate subtotal and the net unreconciled outage.
- The net unreconciled outage (deposits-side reconciling total vs. withdrawals-side reconciling total) calculates correctly and is prominently flagged when non-zero.
- All reconciliation entries (uncleared items, reclassifications, manual items, notes) persist automatically and are still present after navigating away from and back to the workspace.
- AI-suggested bucket mappings are visually distinguishable from user-confirmed mappings, and no suggestion is treated as final without user confirmation.
- Access is correctly restricted per Section 5, with deal isolation confirmed.

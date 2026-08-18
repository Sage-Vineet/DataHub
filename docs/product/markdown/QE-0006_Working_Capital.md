CENTURIUUM
Feature Specification

| Feature ID | QE - 0006 |
|---|---|
| Feature Name | Working Capital |
| Module | QE - Quality of Earnings |
| Status | Draft |
| Related / Recycled IDs | Reuses DB - 0007 AI-assisted classification approach; introduces new dependency US - 0006 (not yet specced) |
| Author | Josh Tonnesen |
| Date | August 15, 2026 |

# 1. Purpose & Business Context
Every M&A transaction requires the parties to agree on how much working capital stays in the business at close, and this feature gives the QoE reviewer a dedicated workspace to build that analysis instead of doing it in a side spreadsheet disconnected from the reconciled GL data. It presents current-asset and current-liability account balances (with cash) over a user-selected date range, lets the reviewer decide account-by-account whether a balance actually belongs in working capital (the system suggests, but never decides, since items like a loan to shareholder are often classified as a current asset/liability on the books but should not count), calculates trailing averages the parties can select as the working capital peg, compares that peg to the balance sheet at close to produce a true-up amount, and optionally estimates a recommended minimum cash balance for the business post-close. A generated narrative, grounded in the firm's established way of explaining working capital and in relevant Q&A citations, documents the reviewer's reasoning for the report.
# 2. User Stories
- As a QoE reviewer, I want to select a date range and see cash, other current asset, and other current liability balances broken out by the Chart of Accounts hierarchy, so that I can evaluate working capital using data I already trust from the GL.
- As a QoE reviewer, I want the system to suggest whether each account should be included in working capital, so that I don't have to manually flag every obvious exclusion (e.g., loans to shareholder) myself, while still controlling the final call.
- As a QoE reviewer, I want to see 3/6/12/24-month trailing averages and select which one serves as the working capital peg, so that I can compare it against the closing balance sheet and quantify a true-up.
- As a QoE reviewer, I want an optional Recommended Cash Balance calculation based on adjusted monthly expenses, debt service, CapEx, and an uncertainty multiplier, so that I can offer buyers, banks, and other stakeholders a defensible view of cash needs even though most QoE reports omit this.
- As a QoE reviewer, I want to generate a working capital narrative from the accounts I've toggled in, grounded in my firm's established narrative approach and relevant Q&A answers, so that I don't have to write the commentary from scratch every engagement.
- As a QoE reviewer, I want to edit and save the generated narrative with full version history, so that I can safely revert if an edit turns out to be wrong without losing prior work.
- As a broker or buyer with report access, I want to view the finalized working capital peg, true-up, and narrative, so that I can incorporate the terms into deal negotiation.
# 3. Functional Requirements
## Date Range, Balances & Chart of Accounts Hierarchy
- The system shall allow the user to select a date range via a slider control (or equivalent date-range input) to display period balances.
- The system shall display cash, other current asset, and other current liability accounts for the selected date range, sourced from validated GL data (DB - 0005).
- The system shall display these accounts in the Chart of Accounts parent/child hierarchy (DB - 0003), allowing the user to expand a parent account into its constituent child accounts.
- The system shall display the actual account balance as of the selected date range for each account/sub-account.
- The system shall calculate and display a Net Position at the bottom of the account list, defined as total current assets (including cash) minus total current liabilities, for the selected date range.
## Working Capital Inclusion Classification
- The system shall provide a toggle per account allowing the user to mark whether that account is included in working capital, independent of how the account is classified as a current asset or current liability elsewhere in the platform.
- The system shall generate a suggested include/exclude classification per account using the AI-assisted suggestion approach established in DB - 0007, without requiring the user to accept the suggestion.
- The system shall default accounts identified by the classification suggestion as clearly non-working-capital in nature (e.g., loans to shareholder/related party) to "excluded," while allowing the user to override this default.
- The system shall persist the user's final include/exclude selection per account, distinguishing it from the system's original suggestion, for audit purposes.
## Trailing Averages
- The system shall calculate trailing average balances for each account (or hierarchy roll-up) at 3-month, 6-month, 12-month, and 24-month intervals, ending at the user-selected date.
- The system shall display the relevant trailing averages alongside the account balances, limited to whichever intervals are applicable given available GL history (e.g., a 24-month average shall not display if fewer than 24 months of data exist, and the system shall indicate the shortfall rather than silently omitting it).
## Working Capital Peg & Variance
- The system shall allow the user to select which trailing average interval (3/6/12/24-month) serves as the Working Capital Peg, defaulting to the 12-month average.
- The system shall display a Closing Balance Sheet column reflecting balances as of the deal's closing balance sheet date.
- The system shall calculate and display a Variance column equal to the Closing Balance Sheet value minus the Working Capital Peg value, for working-capital-included accounts and in total.
- The system shall calculate and display a True-Up amount and a labeled direction ("Seller owes Buyer" or "Buyer owes Seller") based on whether the Closing Balance Sheet working capital position is above or below the selected Peg.
- The system shall provide a "Show Working Capital Peg Analysis" toggle that shows or hides the Peg, Variance, and True-Up columns without deleting or recalculating underlying data.
- The system shall calculate and display the net working capital position (assets minus liabilities) both including and excluding cash, without requiring a separate report.
## Recommended Cash Balance
- The system shall provide a "Show Recommended Cash Balance" toggle, independent of the Working Capital Peg Analysis toggle, controlling visibility of this subsection.
- The system shall calculate a base monthly adjusted expense figure using the trailing twelve months of expense data ending at the closing balance sheet date, excluding depreciation, amortization, and other non-cash/non-operating add-back items already identified in QE - 0004.
- The system shall provide an "Include Debt Service" toggle and, when enabled, an input field for a monthly debt service amount sourced from or manually entered against the projection model, added to the base monthly expense figure.
- The system shall provide an "Include Capital Expenditure Estimate" toggle and, when enabled, an input field for an estimated monthly CapEx amount (e.g., defaulting to a value the user can override, such as $10,000/month), added to the base monthly expense figure.
- The system shall provide an Uncertainty Multiplier input, expressed in number of months (supporting fractional values such as 0.5), which multiplies against the fully-loaded monthly expense figure to calculate the Recommended Cash Balance.
- The system shall display the Recommended Cash Balance as a distinct, separately labeled figure from the Working Capital Peg and shall not include it in the working capital Net Position calculation unless the user explicitly includes cash per the existing including/excluding cash toggle.
## Narrative Generation & Versioning
- The system shall provide a "Generate Working Capital Narrative" action that produces a draft narrative referencing only accounts currently toggled to "included" in working capital.
- The narrative generation logic shall follow the firm's established working capital narrative approach and structure (maintained as internal guidance/reference material, not a live external integration) and shall refer to "the company," never "the seller," consistent with house terminology rules.
- The system shall incorporate relevant Q&A citations into the generated narrative using the existing structured citation tagging and click-through approach from QA - 0001/QA - 0002.
- The system shall allow the user to edit the generated narrative text directly in a text field.
- The system shall save a new version of the narrative each time the user clicks Save, retaining full version history rather than only the most recent prior version.
- The system shall allow the user to view prior narrative versions and revert the current narrative to any prior version.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| GL account balances by period (cash, other current assets, other current liabilities) | Read | DB - 0005 validated GL data; DB - 0009 bank statement data for cash cross-reference |
| Chart of Accounts hierarchy (parent/child structure) | Read | DB - 0003 COA hierarchy configuration; DB - 0006 firm-scoped hierarchy edits |
| Accounting basis (cash/accrual) used for balance interpretation | Read | DB - 0005 (basis inferred, not user-inputted) |
| Working Capital include/exclude flag per account | Read/Write | New field on QE - 0006 working capital account table, keyed to COA account ID |
| AI-suggested include/exclude classification + confidence | Read | Reuses DB - 0007 AI-assisted suggestion engine, scoped to working-capital classification prompt |
| User override of AI classification (manual toggle state) | Write | New field on QE - 0006 working capital account table |
| Selected date range for balance display | Read/Write | New field, session/report-scoped, not persisted per account |
| Rolling average balances (3/6/12/24-month, configurable) | Read | Calculated from DB - 0005 period balances; not stored, computed on render |
| Working Capital Peg period selection (3/6/12/24-month) | Read/Write | New field, deal-scoped, default = 12-month average |
| Closing Balance Sheet date and balances | Read | DB - 0005 / RP - 0001 Balance Sheet output as of user-selected closing date |
| Variance (Closing BS vs. WC Peg) and true-up direction/amount | Read | Calculated field; not stored, computed on render |
| Adjusted EBITDA/SDE monthly add-back detail (D&A and other non-cash/non-operating items) | Read | QE - 0004 SDE/EBITDA Tab |
| Recommended Cash Balance inputs (debt service amount, CapEx estimate, uncertainty multiplier in months) | Read/Write | New fields on QE - 0006, deal-scoped |
| Working Capital narrative text (current + full version history) | Read/Write | New narrative version table, deal-scoped, linked to QA module citations |
| Q&A citations referenced in narrative | Read | QA - 0001 / QA - 0002 structured citation tagging |
| Firm-specific Working Capital policy defaults (default peg period, default include/exclude rules) | Read | US - 0006 (proposed, not yet specced) — see Dependencies and Open Questions |
| "Show Working Capital Peg Analysis" and "Show Recommended Cash Balance" display toggles | Read/Write | New session/report-level display flags, deal-scoped |

# 5. Access & Security
- Roles with access: Accountant (QoE preparer/reviewer) — full edit access to classification toggles, peg selection, Recommended Cash Balance inputs, and narrative. Broker, Buyer, Bank, Company — view access to finalized output per the module/tab-level permission grants defined in SE - 0002; exact default visibility per role is an Open Question pending the SE - 0002 permission matrix.
- Roles explicitly excluded: none excluded by default at the module level; visibility is governed entirely by the SE - 0002 access grant for this tab, including deal stage-based restrictions where applicable (e.g., a Bank role may not see this tab until a deal reaches underwriting, consistent with SE - 0002 conventions).
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web only. The date-range slider, per-account inclusion toggles, hierarchy drill-down, multi-column peg/variance analysis, and narrative editor are full data-entry and analysis workflows not suited to the Mobile (light) companion experience; a read-only summary view of the finalized peg, true-up, and narrative may be considered for Mobile (light) in a future spec but is out of scope here.
- Wireframe reference: N/A
Layout should present the account hierarchy and balances as the primary table (parent rows collapsible into child accounts), with the working-capital inclusion toggle as a persistent column on that same table rather than a separate screen. The trailing averages should appear as columns to the side of the primary balances, consistent with Josh's description of averages sitting “off to the side.” The Peg/Variance/True-Up columns and the Recommended Cash Balance subsection should each collapse cleanly when their respective display toggles are off, so reviewers who don't use this analysis aren't shown unused columns. The narrative editor should sit below the numeric analysis, with a clearly labeled Generate button, an editable text area, a Save button, and a way to browse and revert version history (e.g., a version history side panel or dropdown).
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DB - 0003 | Depends on | Source of COA parent/child hierarchy structure used to display and roll up account balances. |
| DB - 0005 | Depends on | Source of validated GL period balances and inferred accounting basis; Working Capital tab does not re-validate data. |
| DB - 0006 | Depends on | Firm-scoped COA hierarchy edits carry forward and must be reflected in the hierarchy view here. |
| DB - 0007 | Depends on | Reuses the AI-assisted suggestion engine architecture to generate the working-capital include/exclude classification suggestion per account (e.g., flagging loans to shareholder). |
| DB - 0009 | Depends on | Bank statement data used to cross-reference actual cash balances shown for the selected date range. |
| QE - 0004 | Depends on | Adjusted EBITDA/SDE add-back detail (D&A and other normalization items) is the basis for the Recommended Cash Balance monthly adjusted-expense calculation. |
| RP - 0001 | Depends on | Balance Sheet output supplies the Closing Balance Sheet figures used in the Peg vs. Closing variance and true-up calculation. |
| QA - 0001 / QA - 0002 | Depends on | Working Capital narrative pulls structured Q&A citations using existing Module/Section/Account tagging and inline citation click-through. |
| US - 0006 (proposed — not yet specced) | Depends on | Firm-specific Working Capital policy defaults (default peg period, default classification rules) are assumed to live in a new User Profile module feature. This feature ID does not yet exist; see Open Questions. |
| SE - 0002 | Depends on | Module/tab-level access control governs who can view vs. edit the Working Capital tab and narrative. |
| Audit Trail / Activity Log (cross-cutting gap) | Depends on | Full version history and revert capability for the Working Capital narrative assumes the platform-wide audit trail capability; no local versioning mechanism should be built if a shared solution is coming. |
| Notifications Hub (cross-cutting gap) | Depends on | Narrative generation completion and narrative edits are natural candidates for notifying the deal team; deferred to the shared Notifications Hub rather than a local notification mechanism. |

# 8. Out of Scope / Deferred
- Execution or settlement of the true-up payment itself (e.g., escrow release, wire instructions) — this feature calculates and displays the true-up amount and direction only; settlement mechanics belong with deal closing/IOI-LOI execution features (e.g., BR - 0013, VL - 0009).
- Design and administration of firm-specific Working Capital policy defaults (default peg period, default classification rules) — belongs to a new User Profile feature, proposed as US - 0006, not yet specced.
- Live integration with the Tonnesen Accounting Services SharePoint-saved narrative guidance — that content is used only as internal reference material informing the narrative generation logic described in this spec; no external SharePoint connection is in scope.
- GL account classification engine mechanics themselves (model selection, prompt design, confidence scoring) — owned by DB - 0007; this feature only consumes that suggestion for a working-capital-specific classification.
- Cross-account or cross-deal working capital benchmarking/comps — not addressed here.
# 9. Open Questions
- US - 0006 (Firm-Specific Working Capital Policy Defaults) does not yet have a feature ID or spec; this feature assumes it will supply default peg period and default classification rules but cannot fully define the handoff until that spec exists.
- Default visibility of this tab per role (Broker, Buyer, Bank, Company) pending finalization of the default permission matrix in SE - 0002 (already an open item there).
- Default value and override rules for the monthly CapEx estimate input in Recommended Cash Balance (Josh suggested $10,000/month as a starting point — confirm whether this should vary by company size/industry or remain a flat manual override).
- Acceptable range and default value for the Uncertainty Multiplier (in months) — needs a sensible default (e.g., 1.0) and bounds.
- Whether the AI-assisted classification suggestion (reusing DB - 0007) should surface a confidence indicator to the user or simply present a binary suggested toggle state.
- Whether narrative version history and revert should be built locally within this feature or should wait for the platform-wide Audit Trail / Activity Log capability referenced as a cross-cutting gap.
- Whether Recommended Cash Balance, given it is described as materially distinct from standard QoE deliverables, should eventually be excluded from certain export/report configurations (relates to QE - 0013 Workbook Export) by default.
# 10. Acceptance Criteria
- User can select a date range and view cash, other current asset, and other current liability balances broken out by COA hierarchy, with a correctly calculated Net Position at the bottom.
- User can toggle any account's working capital inclusion status independent of its current asset/liability classification, with the system providing an AI-assisted suggested default that the user can override.
- System correctly calculates and displays 3/6/12/24-month trailing averages (where sufficient history exists) and allows the user to select any available interval as the Working Capital Peg, defaulting to 12-month.
- System correctly calculates Variance and a labeled True-Up direction/amount between the Closing Balance Sheet and the selected Working Capital Peg, and this section hides/shows cleanly via the "Show Working Capital Peg Analysis" toggle.
- System correctly calculates a Recommended Cash Balance from adjusted trailing-twelve-month monthly expenses, optional debt service, optional CapEx estimate, and the uncertainty multiplier, displayed separately from the working capital Net Position, and hides/shows cleanly via the "Show Recommended Cash Balance" toggle.
- User can generate a working capital narrative referencing only included accounts and relevant Q&A citations, edit the text, save it, view full version history, and revert to any prior version.
- All views respect SE - 0002 role-based access and deal isolation with no cross-deal data visibility.

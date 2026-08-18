CENTURIUUM
Feature Specification

| Feature ID | DB - 0005 |
|---|---|
| Feature Name | Validations |
| Module | DB - Database |
| Status | Draft |
| Related / Recycled IDs | N/A |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
This feature provides the self-check layer for the financial data the company uploads (P&L, Balance Sheet, and General Ledger detail) before that data is trusted downstream in Reports and QoE. It confirms that the Balance Sheet the system calculates by rolling GL activity forward or backward from a starting Balance Sheet actually agrees with the ending Balance Sheet the company uploaded, flags accounts that do not roll forward correctly, detects a mismatch in accounting basis (e.g., cash vs. accrual/payroll) between documents, and identifies date-range coverage gaps between the GL and the Balance Sheet date. Without this check, every downstream module (Reports, QoE, Valuations) inherits silent data errors that are expensive to trace back once discovered late in an engagement.
# 2. User Stories
- As a QoE reviewer, I want the system to automatically flag any account where the calculated ending Balance Sheet doesn't match the uploaded ending Balance Sheet, so that I can investigate discrepancies before relying on the data in my analysis.
- As a QoE reviewer, I want to see whether the uploaded GL, P&L, and Balance Sheet are on a consistent accounting basis, so that I understand why the math might not foot before assuming an account-level error.
- As a QoE reviewer, I want a single matrix view of validation status across document types and periods, so that I can quickly see where gaps or failures exist without checking each account individually.
- As a company user uploading financials, I want to be warned if my General Ledger detail doesn't cover the full period through the Balance Sheet date, so that I can re-upload complete data rather than get an inaccurate roll-forward.
# 3. Functional Requirements
- The system shall automatically run the validation check every time General Ledger, Balance Sheet, or P&L data is uploaded or re-pulled (per DR - 0003), without requiring the user to manually trigger it.
- The system shall also allow the user to manually re-trigger the validation check on demand from Key Reports.
- The system shall calculate the ending Balance Sheet by rolling the starting Balance Sheet forward or backward using GL activity, store the result in the Trial Balance table (DB - 0004), and compare it against the uploaded ending Balance Sheet, if one was uploaded for that period.
- The system shall store the calculated ending Balance Sheet even when a variance is identified; a failed validation shall not block the data from being saved.
- The system shall calculate a variance amount and variance percentage for each Balance Sheet account by comparing the calculated ending balance to the uploaded ending balance.
- The system shall classify each account-level variance into one of three severity tiers: Pass (no meaningful variance), Minor (below materiality threshold), or Material (at or above materiality threshold).
- The system shall treat a variance as Material if it exceeds a configurable fixed-dollar floor OR a configurable percentage-of-account-balance threshold, whichever condition is met first (e.g., variance flagged Material if it exceeds $[X] AND/OR [Y]% of the account's balance — thresholds configurable, not hardcoded, pending Open Question below).
- The system shall identify and list the specific account(s) that do not roll forward correctly, rather than only reporting an aggregate Balance Sheet-level variance.
- The system shall confirm the uploaded Balance Sheet itself is in balance (total assets equal total liabilities plus equity) as a precondition check, and shall flag the source document as out of balance if it is not, separately from the roll-forward comparison.
- The system shall infer the accounting basis (e.g., cash vs. accrual, cash vs. payroll basis) of each uploaded document by analyzing GL/P&L/BS behavior (e.g., presence and movement of AR/AP or accrual-related accounts), rather than relying on a user-entered basis designation.
- The system shall flag a basis inconsistency when the inferred basis of the GL does not match the inferred basis of the uploaded P&L or Balance Sheet for the same period.
- The system shall compare the date range of the uploaded GL detail against the Balance Sheet date and flag a coverage gap when the GL does not extend through the full Balance Sheet date (e.g., GL ends December 30 but Balance Sheet is dated December 31).
- The system shall present validation results in a matrix view with document type (GL, P&L, Balance Sheet) as rows and period/year as columns, with each cell showing a pass, fail, or coverage-gap status.
- The system shall support drilling down from a matrix cell into the specific account-level variances and their severity for that document/period combination.
- The system shall exclude bank statement and tax return reconciliation from this validation; those are covered separately in QE - 0003 (Bank Statement Review) and DB - 0008 (Tax Return Table) respectively.
- The system shall surface, alongside any Material flag, a plain-language explanation of the likely cause where determinable (e.g., "GL coverage ends 1 day before Balance Sheet date" or "Basis mismatch: GL appears cash basis, uploaded Balance Sheet appears accrual basis").
- The system shall record that a Material or unresolved validation flag exists at the period/company level so that it can be surfaced as a validation-risk indicator elsewhere in the system (e.g., on Reports); the design of that downstream indicator is out of scope for this spec.
# 4. Data Requirements
References DB - 0001 through DB - 0010 Database module table blocks.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Trial Balance table (period balances by account) | Read | DB - 0004 Trial Balance |
| GL transaction detail (date, account, amount, memo) | Read | DB - 0002 GL Data |
| Chart of Accounts (account list, type, hierarchy) | Read | DB - 0003 COA |
| Uploaded ending Balance Sheet (as-filed amounts by account) | Read | RP - 0002 Balance Sheet (source upload) |
| Uploaded P&L (as-filed amounts by account) | Read | RP - 0001 Profit & Loss (source upload) |
| Starting Balance Sheet (opening balances by account) | Read | DB - 0004 Trial Balance |
| Calculated ending Balance Sheet (system roll-forward result) | Read | DB - 0004 Trial Balance |
| Document date-range metadata (upload period start/end per document) | Read | DB - 0001 Table Structure / upload metadata |
| Validation results (per-account variance, pass/fail, severity) | Write | DB - 0005 Validations table (new) |
| Validation summary (document-type x period matrix, coverage gaps, basis flags) | Write | DB - 0005 Validations table (new) |

# 5. Access & Security
- Roles with access: Broker, Accountant, Company (any role permitted to view the underlying Trial Balance/Reports data for the deal).
- Roles explicitly excluded: Bank, Buyer — until/unless the deal stage and permission model (SE - 0001 / SE - 0002) explicitly grants visibility into underlying financial data quality issues.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web only.
- Wireframe reference: N/A.
The primary view is the document-type x period matrix described in Functional Requirements, surfaced under Key Reports. Cells are color-coded (e.g., green/pass, yellow/minor, red/material, gray/coverage gap) and clickable to drill into account-level detail. Account-level detail should show calculated amount, uploaded amount, variance $, variance %, severity, and the plain-language likely-cause note where available.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DB - 0002 GL Data | Depends on | Validations require GL data to already be loaded before roll-forward and coverage checks can run. |
| DB - 0003 COA | Depends on | Account-level matching between uploaded BS/P&L and calculated GL-derived balances requires a reconciled chart of accounts. |
| DB - 0004 Trial Balance | Depends on | Validations read the stored starting balances, calculated ending balances, and write results against this table structure. |
| DR - 0003 Data Retrieve Wizard | Depends on | Upload/re-pull events are the trigger point for automatic validation runs; also the source of per-document date-range metadata used in coverage-gap checks. |
| QE - 0015 Q&A Generator | Blocks (informs) | Material validation flags are a natural candidate to auto-generate Q&A items for the company; not built as part of this spec. |
| RP - 0001 / RP - 0002 Reports | Blocks (informs) | Reports should surface a validation-risk indicator when material discrepancies exist on the underlying period; report-level display is out of scope here. |
| Notifications Hub (cross-cutting gap) | Depends on | User notification of validation failures should route through the future notifications hub rather than a one-off local alert mechanism. |

# 8. Out of Scope / Deferred
- Bank statement reconciliation (Proof of Cash) — covered in QE - 0003.
- Tax return reconciliation and mapping — covered in QE - 0001 / QE - 0002 / DB - 0008.
- User-facing notification/alert delivery mechanism for validation failures — belongs to the future Notifications Hub cross-cutting gap, not built locally here.
- Display of the validation-risk indicator within Reports (RP - 0001 / RP - 0002) or QoE output itself — this spec only produces and stores the underlying validation result; downstream display is a separate feature.
- Automated Q&A item generation from validation flags — a natural extension of QE - 0015, not built as part of this spec.
# 9. Open Questions
- What are the default materiality thresholds (fixed $ floor and % of account balance) for flagging a Balance Sheet roll-forward variance as Material, and should these be configurable per engagement/firm or fixed platform-wide?
- Should basis-mismatch inference have a confidence level (e.g., "likely cash basis" vs. a hard determination), and how should the system behave when it cannot confidently infer a basis?
- Should a coverage gap of a certain size (e.g., missing more than N days) automatically escalate to Material severity even if the resulting dollar variance is small?
- How should validation results behave when a company re-uploads a corrected document for a period — does the prior validation result get versioned/retained, or superseded? (Ties to Document Versioning cross-cutting gap.)
# 10. Acceptance Criteria
- Given a starting Balance Sheet, GL detail, and an uploaded ending Balance Sheet for the same period, the system calculates an ending Balance Sheet via roll-forward and correctly identifies any account(s) where calculated and uploaded amounts differ.
- Given an account-level variance, the system correctly classifies it as Pass, Minor, or Material based on the configured $ floor and % thresholds.
- Given GL and Balance Sheet data on different accounting bases, the system flags a basis inconsistency without requiring a user-entered basis field.
- Given GL detail that does not extend through the Balance Sheet date, the system flags a coverage gap identifying the missing date range.
- The validation matrix correctly displays pass/fail/gap status by document type and period, and each cell drills down to account-level detail.
- A failed or material validation does not prevent the underlying data from being saved to the Trial Balance table.
- Validation runs automatically on every GL/P&L/BS upload or re-pull, and can also be manually re-triggered by the user from Key Reports.

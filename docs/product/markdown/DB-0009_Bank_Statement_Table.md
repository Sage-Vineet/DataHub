CENTURIUUM
Feature Specification

| Feature ID | DB - 0009 |
|---|---|
| Feature Name | Bank Statement Table |
| Module | DB - Database |
| Status | Draft |
| Related / Recycled IDs | Feeds QE - 0003 (Bank Statement Review / Proof of Cash) |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
This feature defines the structured data model for bank statement information — the starting balance, ending balance, total deposits, total withdrawals, and individual transaction line detail for each bank account tied to a company/deal. This table is the foundation the QoE Bank Statement Review / Proof of Cash feature (QE - 0003) depends on: without transaction-level detail captured in a consistent structure, the platform cannot automatically explain why a period's bank activity differs from the general ledger, and QoE reviewers are left doing that reconciliation by hand. Statement data is extracted via OCR from uploaded statement files rather than entered manually, consistent with the platform's OCR-first approach to uploaded source documents.
# 2. User Stories
- As an Accountant (QoE reviewer), I want to upload a company's bank statements and have the header totals and every transaction line extracted automatically, so that I can perform proof of cash and reconcile bank activity against the GL without re-keying data.
- As an Accountant, I want to review and correct any OCR-extracted field before a statement is marked complete, so that downstream reconciliation is built on accurate data.
- As a Broker, I want to see which bank accounts and statement periods have been uploaded and confirmed for a deal, so that I know what financial data is ready for QoE work.
- As a Company user, I want to upload our bank statements directly, so that our accountant or QoE provider does not need to chase us for source documents.
# 3. Functional Requirements
- The system shall allow a user to create and maintain a Bank Account record for a company/deal, capturing institution name, account nickname, account type (e.g., checking, savings, money market, line of credit), and account number (last 4 digits displayed).
- The system shall allow a user to upload a bank statement file (PDF or scanned image) to the Data Room and associate it with a specific Bank Account and statement period.
- The system shall extract, via OCR, the following header fields from each uploaded statement: statement period start date, statement period end date, starting balance, ending balance, total deposits, and total withdrawals.
- The system shall extract, via OCR, every individual transaction line appearing on the statement, capturing at minimum: transaction date, description as printed, amount, and direction (deposit or withdrawal).
- The system shall present all OCR-extracted header and transaction-line fields to the user for review and manual correction before the statement can be marked Confirmed.
- The system shall validate, for each statement, that Starting Balance + Total Deposits − Total Withdrawals equals Ending Balance, and shall flag the statement if this does not reconcile.
- The system shall validate that the sum of extracted deposit transaction lines equals the extracted Total Deposits header value, and that the sum of extracted withdrawal transaction lines equals the extracted Total Withdrawals header value, flagging any variance for user review.
- The system shall track a processing status for each statement: Pending, Extracted – Needs Review, Confirmed, or Failed.
- The system shall allow re-upload of a statement for a period that already has a record, creating a new version rather than overwriting the prior record or its transaction lines.
- The system shall retain a link from every Bank Statement record back to its source uploaded file for audit and reference purposes.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Bank Account (new table) | Write / Read | DB - 0009 (this feature) |
| Bank Statement Header (new table) | Write / Read | DB - 0009 (this feature) |
| Bank Transaction Line (new table) | Write / Read | DB - 0009 (this feature) |
| Source statement file | Read / Write | DR - 0001 Core Data Room |
| Header / transaction reconciliation checks | Write | DB - 0005 Validations |
| Statement + transaction detail (downstream consumption) | Read | QE - 0003 Bank Statement Review (Proof of Cash) |

Fields per new table (for dev reference): Bank Account — Bank Account ID, Company/Deal ID, Institution Name, Account Nickname, Account Type, Account Number (last 4), Status. Bank Statement Header — Statement ID, Bank Account ID (FK), Period Start Date, Period End Date, Starting Balance, Ending Balance, Total Deposits, Total Withdrawals, Source File Reference, Version Number, Processing Status. Bank Transaction Line — Transaction ID, Statement ID (FK), Transaction Date, Description, Amount, Direction (Deposit/Withdrawal), Line Sequence Number.
# 5. Access & Security
- Roles with access: Accountant, Broker, Company.
- Roles explicitly excluded: Bank, Buyer — raw bank statement detail is sensitive source financial data and is not exposed outside the QoE/deal team unless a broker explicitly grants it through the Data Room permission model in a later stage.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web only.
- Wireframe reference: N/A
Primary view is a statement list per Bank Account (grouped by account, sorted by period) showing status at a glance. Opening a statement shows the header fields alongside a scrollable transaction line grid; low-confidence OCR fields should be visually distinguishable from confirmed fields so a reviewer's eye goes to what needs checking first, though the exact visual treatment is left to design.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DR - 0001 Core Data Room | Depends on | Statement files are uploaded and stored through the core data room. |
| DB - 0005 Validations | Depends on | Header-to-transaction and starting/ending balance reconciliation checks surface through the platform's general validation framework. |
| QE - 0003 Bank Statement Review (Proof of Cash) | Blocks | QE - 0003 consumes this table's statement and transaction data to compare against GL and BS balances. |
| SY - 0003 Activity & Audit Log | Depends on | Manual corrections to OCR-extracted values should be logged — who changed which field, from what value to what. |
| Document Versioning (cross-cutting gap) | Depends on | Re-uploaded statements need general versioning support; not yet spec'd as its own feature (see Open Questions). |

# 8. Out of Scope / Deferred
- Matching or reconciling individual bank transactions against GL entries — belongs to QE - 0003 Bank Statement Review (Proof of Cash), which consumes this table.
- Transaction type / categorization (check, ACH, wire, transfer, fee, etc.) — deferred per product decision; kept minimal for now and can be added if QE - 0003 matching logic requires it.
- Direct bank feed or aggregator connections (e.g., Plaid-style live account linking) — out of scope; this spec covers OCR-from-upload only.
- Multi-currency support — not addressed; all amounts assumed USD unless specified otherwise in a future revision.
# 9. Open Questions
- How should the system handle a missing or overlapping statement period for an account (e.g., no January statement uploaded, or two statements covering the same dates)? Should gaps be flagged automatically?
- Should the full bank account number ever be captured (masked at rest) for future reconciliation automation, or should only the last 4 digits ever be captured and retained?
- General document versioning is a known cross-cutting gap with no dedicated feature ID yet. This spec assumes re-uploaded statements version correctly — that capability needs its own spec.
- Should low-confidence OCR fields be flagged at the individual field level (e.g., highlighted) versus a single statement-level “Needs Review” status? Affects both this spec's UI and dev effort.
# 10. Acceptance Criteria
- A user can create a Bank Account record and upload a bank statement file, associating it with that account and a statement period.
- Header fields (period start/end, starting/ending balance, total deposits, total withdrawals) are extracted via OCR and are reviewable and editable before the statement is Confirmed.
- Every transaction line on the uploaded statement appears as an individual, editable row with date, description, amount, and direction.
- The system flags a statement when Starting Balance + Total Deposits − Total Withdrawals does not equal Ending Balance, and when transaction-line sums do not match header totals.
- Re-uploading a statement for an already-Confirmed period creates a new version without deleting or overwriting the prior version.
- A user without access to the deal/company cannot view, search, or retrieve any bank statement or transaction data for that deal.

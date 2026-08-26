CENTURIUUM
Feature Specification

| Feature ID | DB - 0002 |
|---|---|
| Feature Name | GL Data |
| Module | DB - Database |
| Status | Draft |
| Related / Recycled IDs | N/A |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
The General Ledger (GL) table is the foundational data structure for every Centuriuum deal. Once a company's GL report has been uploaded or retrieved into the data room (via DR-0003), the user links the specific GL file(s) to use within Key Reports, which triggers ingestion of transaction-level detail into the standardized GL table defined here. This table is the single source that the Chart of Accounts (DB-0003), Trial Balance (DB-0004), Profit & Loss report (RP-0001), Tax Reconciliation (QE-0001), and the SDE/EBITDA bridge (QE-0004) are all built from — meaning any gap, error, or inconsistency introduced at ingestion propagates through the entire platform. Validations defined in DB-0005 run against this data to catch reconciliation issues and oddities before downstream modules rely on it.
# 2. User Stories
One story per user type that touches this feature. Format: "As a [role], I want to [action], so that [benefit]."
- As a broker or company user, I want to select a previously uploaded or retrieved GL report from Key Reports and link it for ingestion, so that transaction-level data flows into the standard tables the rest of the platform depends on.
- As a QoE reviewer, I want ingested GL data automatically validated against the DB-0005 ruleset, so that reconciliation issues and oddities are surfaced before I build the P&L, tax reconciliation, or SDE/EBITDA bridge on top of it.
- As a platform administrator, I want every ingestion event tied to a source file and logged to the audit trail, so that any anomaly in downstream reporting can be traced back to the exact file and user that introduced it.
# 3. Functional Requirements
Numbered, testable statements the dev team can build against directly. Avoid prose — each line should be independently verifiable.
- The system shall allow a user, from Key Reports, to select one or more GL report files already uploaded to or retrieved into the data room (via DR-0001 / DR-0003) and link them for ingestion.
- The system shall not allow a new GL retrieval to be triggered from the linking step itself — retrieval/upload must occur first via DR-0003 or direct data room upload.
- Upon linking, the system shall parse the source GL file and create GL table rows using the standard field set defined in Section 4.
- The system shall support ingestion from QBO-sourced exports (via DR-0003), QB Desktop-derived GL reports, and generic CSV/Excel GL exports at launch.
- Each ingested GL row shall retain a reference to its source file ID and the ingestion batch/timestamp that created it, so origin is traceable.
- When a user links an additional or corrected GL file covering a period already ingested, the system shall append new rows rather than overwrite or delete previously ingested rows.
- Immediately following ingestion, the system shall run the cross-validation ruleset defined in DB-0005 against the newly ingested rows and surface any reconciliation errors or anomalies to the user.
- Ingestion shall not be blocked by validation failures — data lands in the GL table and exceptions are surfaced separately for user review and correction (per DB-0005).
- The GL table shall store, at minimum: transaction date, account, entry/transaction number, transaction type, debit amount, credit amount, description/memo, customer, and a reference to the source file.
- The system shall generate the Chart of Accounts (DB-0003) from the distinct set of accounts present in ingested GL data.
- The system shall make ingested GL data available to downstream modules including the Trial Balance (DB-0004), Profit & Loss report (RP-0001), Tax Reconciliation (QE-0001), and SDE/EBITDA Tab (QE-0004).
- The system shall log every ingestion event — file(s) linked, user, timestamp, and row count — to the Activity & Audit Log (SY-0003).
# 4. Data Requirements
What tables/fields does this feature read from or write to? Reference the relevant Database module table blocks (DB-0001 through DB-0010) wherever applicable so every feature traces back to the reconciled data structure.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| GL Table (DB-0002) | Write | Populated at ingestion; referenced by DB-0003 (COA), DB-0004 (Trial Balance), DB-0005 (Validations), RP-0001 (P&L), QE-0001 (Tax Reconciliation), QE-0004 (SDE/EBITDA) |
| Source GL report file | Read | Data Room (DR-0001), populated via upload or Data Retrieve Wizard (DR-0003) |
| Chart of Accounts (DB-0003) | Write (derived) | Generated from distinct accounts present in ingested GL data |
| Trial Balance (DB-0004) | Write | Balance-related data derived alongside/from GL ingestion |
| Validation rules & results (DB-0005) | Read/Write | Ruleset applied to ingested GL rows; exceptions written back referencing affected GL rows |
| Ingestion event record | Write | Activity & Audit Log (SY-0003) — user, timestamp, source file, row count |

# 5. Access & Security
Confirm roles and deal isolation explicitly on every spec — never assume it.
- Roles with access: Broker (deal owner/admin), Company (as granted by broker), Accountant / QoE preparer.
- Roles explicitly excluded: Bank (never has GL-level access; only relevant post-underwriting per BK-0001, and never to raw transaction detail), Buyer (never — GL transaction detail is not buyer-facing at any stage).
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of GL data, ingestion history, or validation results.
# 6. UI / UX Notes
Layout, interaction notes, or wireframe reference. State platform scope explicitly per feature.
- Platform: Web only.
- Wireframe reference: N/A
The GL linking action lives within the Key Reports interface. Once a file is linked, the UI should show an ingestion status indicator (Queued / Processing / Complete / Complete with Exceptions) and a direct link into any validation exceptions raised by DB-0005 so the user can act on them without hunting for where the issue surfaced.
# 7. Dependencies
Upstream features that must exist first. This is the single most valuable section for sequencing the build.

| Related Feature | Relationship | Notes |
|---|---|---|
| DR-0003 — Data Retrieve Wizard | Depends on | GL report files must already exist in the data room (retrieved or uploaded) before they can be linked and ingested here. |
| DR-0001 — Core Data Room | Depends on | Storage location for source GL files prior to linking. |
| DB-0005 — Validations | Depends on | Cross-validation ruleset runs against ingested GL rows immediately after ingestion. |
| DB-0003 — Chart of Accounts | Blocks | COA generation reads distinct accounts from ingested GL data; cannot run until GL ingestion completes. |
| DB-0004 — Trial Balance | Blocks | Depends on GL ingestion having occurred. |
| RP-0001 — Profit & Loss | Blocks | P&L generation requires ingested GL data as its source. |
| QE-0001 — Tax Reconciliation | Blocks | Tax-to-book bridge requires reconciled GL/P&L data. |
| SY-0003 — Activity & Audit Log | Depends on | Every ingestion event (file linked, user, timestamp, row count) must write to the audit log. |

# 8. Out of Scope / Deferred
- OCR extraction of scanned/PDF GL reports — governed by the platform-wide OCR pipeline convention; not solved locally in this spec (see Open Questions).
- The mechanics of retrieving or uploading the source GL file itself — covered in DR-0003 (Data Retrieve Wizard) and DR-0001 (Core Data Room).
- Chart of Accounts hierarchy configuration, drag-and-drop rollups, and reclassification suggestions — covered in DB-0006 and DB-0007.
- Detailed validation rule logic and error messaging — covered in DB-0005; this spec only confirms that validation runs post-ingestion.
- Multi-entity/subsidiary tagging and class/department/employee dimensions — deferred; standard field set only for this spec.
# 9. Open Questions
- Should ingestion detect and flag exact duplicate re-ingestion of the same GL file (or an overlapping period) to prevent double-counted transactions in the P&L, or is catching that left entirely to DB-0005 validation after the fact?
- Does OCR apply to any GL ingestion path (e.g., a scanned GL report with no digital export available), and if so, is that in scope for DB-0002 or deferred to the broader OCR pipeline gap referenced in the conventions doc?
- Confirmed assumption to validate with Josh: ingestion is non-blocking — data lands in the GL table regardless of validation outcome, with exceptions surfaced separately per DB-0005. Please confirm this is correct before dev build.
- What is the expected behavior if two linked GL files cover an overlapping date range (e.g., both include March activity) — is this purely a DB-0005 validation catch, or does ingestion need its own overlap warning?
# 10. Acceptance Criteria
- User can, from Key Reports, select a previously uploaded or retrieved GL file and successfully trigger ingestion into the GL table.
- Ingested GL rows contain all standard fields (date, account, entry/transaction number, type, debit, credit, description/memo, customer, source file reference) correctly sourced from the uploaded file.
- Re-linking an additional GL file for the same or overlapping period appends new rows without deleting or overwriting prior rows.
- DB-0005 validation rules run automatically immediately after ingestion and surface flagged discrepancies to the user.
- Every ingestion event is recorded in the Activity & Audit Log (SY-0003) with user, timestamp, source file, and row count.
- The Chart of Accounts (DB-0003) reflects the distinct accounts found in ingested GL data.
- A user without assigned role/deal access cannot view GL data for that deal or company under any circumstance.

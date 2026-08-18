CENTURIUUM
Feature Specification

| Feature ID | DB - 0001 |
|---|---|
| Feature Name | Table Structure (Key Reports Ingestion & Storage Architecture) |
| Module | DB - Database |
| Status | Draft |
| Related / Recycled IDs | Feeds DB - 0002 (GL Data), DB - 0003 (COA), DB - 0004 (Trial Balance), DB - 0005 (Validations), DB - 0010 (Table Blocks) |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
Every downstream financial workflow in Centuriuum — QoE, valuation, projections, the CIM financial slides — ultimately depends on financial data that started life as a report the company or its accountant produced (a P&L, a balance sheet, a GL export, a tax return). This feature defines the base architecture: how a user takes a saved report living in the Data Room, links it through the Key Reports section to a defined table structure, and ingests it into stored, structured values that the rest of the system can build on.
Without this layer, every module that needs financial data would need its own ad hoc way of reading a report, and there would be no single, controlled, versioned source of truth. This feature establishes that source of truth: a user-controlled link between a source file and a table structure, a deliberate versioning model (overwrite an existing version or create a new one), and a defined landing point for validation status — without yet building the validation rules themselves (that is DB - 0005) or the specific table shapes for GL, COA, tax returns, or bank statements (DB - 0002, 0003, 0008, 0009 respectively).
This spec is aimed at a developer with no M&A background: think of it as the plumbing that turns "a PDF or Excel report someone uploaded" into "rows in a database that other features can query," with the company controlling which report feeds which slot, and the system keeping every version instead of quietly overwriting history.
# 2. User Stories
- As a Company user (or their accountant/QoE provider), I want to link a specific report in the Data Room to a Key Reports slot (e.g., "P&L"), so that the system knows which file is the authoritative source for that data element.
- As a Company user, I want to choose whether re-ingesting a report overwrites my current version or creates a new version, so that I control my own history rather than the system silently discarding prior data.
- As a QoE provider or Broker, I want the ingested table structure to be reusable across the QoE workbook, valuation module, and CIM prep, so that I don't have to re-upload or re-link the same report for each downstream use.
- As a developer building a downstream module (QoE, Valuation, Projections), I want a stable, generic table structure to read from, so that I don't need to know the specifics of how each report type was parsed.
- As a Broker or Company admin, I want to see which version of a report is currently "active" for a given deal, so that I know what data is driving the numbers I'm looking at.
# 3. Functional Requirements
- The system shall provide a Key Reports section, scoped to a single company/deal, where a user links a source file from the Data Room to a defined report slot (e.g., P&L, Balance Sheet, GL Export, Tax Return, Bank Statement).
- The system shall allow one report slot to have multiple named versions (e.g., "Version 1," "Version 2"), created explicitly by the user rather than automatically.
- The system shall allow the user to choose, at the point of re-linking or re-ingesting a report, whether to overwrite the currently active version's stored data or create a new version alongside it.
- The system shall clearly indicate to the user which version of each report slot is currently "active" (i.e., the version driving downstream modules) for a given company/deal.
- The system shall never allow an overwrite action to occur without an explicit user confirmation step, given that overwrite is destructive to previously stored values for that version.
- The system shall parse a linked source file into a generic, structured table format at ingestion time, independent of the specific downstream table shape (GL, COA, Tax Return, Bank Statement) that will later consume it.
- The system shall record an ingestion run entry (timestamp, acting user, source file reference, version, resulting status) every time a link is created, re-ingested, or overwritten.
- The system shall expose a landing field for validation status (e.g., pending / passed / failed) on each ingested version, without implementing the validation rule logic itself — that logic is defined in DB - 0005.
- The system shall support the same underlying report/table structure being scoped to more than one downstream module context (e.g., QoE vs. CIM prep vs. Broker-facing) per the Table Blocks approach in DB - 0010, without duplicating the stored data for each context.
- The system shall retain all prior versions of a report's stored data indefinitely (or per a retention policy to be defined) so that a company/deal's ingestion history is never lost through normal use.
- The system shall restrict which roles can create a link, ingest, or overwrite a version, per the role and company access model in SY - 0001 / SY - 0002.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Key Report Link (report_link_id) | Write | New table — links a source file/report in the Data Room to a Key Reports slot (e.g., P&L, BS) |
| Report Version (version_id, version_label, is_active) | Write | New table — one or more versions per report_link_id; user-controlled create/overwrite |
| Source File Reference (data_room_file_id) | Read | DR - 0001 Core Data Room (pointer to underlying stored file) |
| Ingestion Run Log (run_id, status, timestamp, actor) | Write | New table — one row per ingestion attempt against a version |
| Parsed Line-Item Rows (raw table rows) | Write | New generic table structure — populated by parser; consumed by DB - 0002 (GL), DB - 0008 (Tax Return), DB - 0009 (Bank Statement) |
| Table Block Assignment (module_scope) | Write | DB - 0010 Table Blocks — which module/workflow (QoE, CIM Prep, Broker) a given linked report serves |
| Validation Status (pass/fail/pending) | Read/Write | DB - 0005 Validations — this spec defines the landing field only; rule logic lives in DB - 0005 |
| Company / Deal ID | Read | SY - 0002 Company Access Setup — every row scoped to a single company/deal |

Note: this spec defines the generic linking, versioning, and landing-table architecture only. The specific column structures for GL Data, Chart of Accounts, Trial Balance, Tax Return Table, and Bank Statement Table are defined in their own specs (DB - 0002, DB - 0003, DB - 0004, DB - 0008, DB - 0009) and will read from the raw parsed rows this feature produces.
# 5. Access & Security
- Roles with access: Company (or their designated accountant/QoE provider), Broker, and any user role explicitly granted "data management" permission on the deal per SY - 0001 / SY - 0002.
- Roles explicitly excluded: Bank and Buyer roles do not have access to Key Reports linking, ingestion, or version management — they only ever see downstream, finished outputs (e.g., a QoE workbook or valuation) that this data feeds, never the raw ingestion layer itself.
- Overwrite and version-creation actions should be restricted to a defined subset of roles (e.g., Company admin, QoE provider) rather than open to every user with view access to the deal — the specific role list is an open question below.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web only.
- Wireframe reference: N/A
The Key Reports section should present each report slot (P&L, BS, GL, Tax Return, Bank Statement, etc.) as a row or card showing: the currently linked source file, the active version label, last ingestion date/status, and actions to (a) link a new file, (b) create a new version, or (c) overwrite the active version. The overwrite action must present a distinct, explicit confirmation (e.g., "This will replace the data currently stored under Version 1 — continue?") that is visually differentiated from the "create new version" action, since the two have very different consequences for downstream modules already using that data.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DR - 0001 | Depends on | Core Data Room must exist — source files being linked live there |
| DR - 0003 | Depends on | Data Retrieve Wizard is one path by which a report becomes available to link (QBO pull, QB Desktop backup); manual upload to the Data Room is the other |
| DB - 0002 / 0003 / 0004 / 0008 / 0009 | Blocks | Each of these consumes the generic table structure and ingestion pipeline defined here; they cannot be specced/built until this lands |
| DB - 0005 | Blocks | Validations spec defines the rules engine that runs against data landed by this feature |
| DB - 0010 | Depends on | Table Blocks defines how the same linked report can be scoped to multiple downstream contexts (QoE vs. CIM prep vs. Broker); this spec assumes that scoping exists but does not design it |
| SY - 0002 | Depends on | Company Access Setup provides the deal/company scoping every ingested table row must carry |
| SY - 0003 | Depends on | Activity & Audit Log — every ingestion run, version overwrite, and link change should write here |

# 8. Out of Scope / Deferred
- Specific column/field structure for GL Data — belongs to DB - 0002.
- Chart of Accounts generation and reclassification logic — belongs to DB - 0003.
- Trial Balance / Balance Sheet-specific storage — belongs to DB - 0004.
- Validation rule logic, error states, and reconciliation checks — belongs to DB - 0005. This spec only defines the landing field the validation status will populate.
- Tax Return table structure — belongs to DB - 0008.
- Bank Statement table structure — belongs to DB - 0009.
- Detailed cross-module Table Blocks scoping mechanics (how the same report is exposed differently to QoE vs. CIM prep vs. Broker) — belongs to DB - 0010; this spec assumes that mechanism exists and is consumed by it.
- Automatic re-validation or re-reconciliation of dependent modules (QoE, Valuation) when a new version is created or an overwrite occurs — not built here; per Josh's direction, versioning is a manual, user-driven action with no automatic downstream cascade in this spec.
# 9. Open Questions
- Which specific roles are permitted to overwrite an active version vs. only create new versions vs. only view? (Referenced against SY - 0001 role model — needs explicit mapping.)
- Is there a retention limit or archival policy on old versions, or are all versions kept indefinitely? Cross-cutting gap: none currently defined for storage/retention generally — flagging alongside the Legal / Compliance cross-cutting gap in the conventions doc.
- When a version is superseded (new version created, old one no longer "active"), do downstream modules that already generated output (e.g., a locked QoE workbook or valuation) automatically get flagged as based on a stale version, or is that a manual awareness problem for the user? (Relevant to VL - 0010's versioning/audit approach — worth aligning conventions.)
- Does linking a report in Key Reports copy the file's parsed data into Centuriuum's own storage, or does it retain only a reference back to the Data Room file that gets re-parsed on demand? This affects both performance and what "version" actually snapshots.
- Should ingestion failures (e.g., a file that can't be parsed, OCR failure) block the link from being marked active, and what does the user see in that failure state? (OCR pipeline noted as first-class per conventions doc — worth confirming failure handling here even though full validation logic is deferred to DB - 0005.)
# 10. Acceptance Criteria
- A user can link a source file from the Data Room to a Key Reports slot for a given company/deal, scoped so no other deal can see or access that link.
- A user can create a second version of a previously linked report without losing access to the data stored under the first version.
- A user attempting to overwrite an active version is shown an explicit confirmation before the prior version's stored data is replaced.
- Every link creation, version creation, and overwrite action produces a corresponding ingestion run log entry with timestamp and acting user.
- The generic parsed table structure produced by ingestion is queryable by at least one downstream consumer (e.g., a stub GL Data read) to confirm the handoff contract works end to end.
- Validation status field is present and settable on each version, even though no rule logic populates it yet in this spec.

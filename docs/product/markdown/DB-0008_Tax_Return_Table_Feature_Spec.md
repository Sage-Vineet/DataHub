CENTURIUUM
Feature Specification

| Feature ID | DB - 0008 |
|---|---|
| Feature Name | Tax Return Table |
| Module | DB - Database |
| Status | Draft |
| Related / Recycled IDs | Schedule C captured as part of 1040 (business-use lines only); see Dependencies for QE-0001 / QE-0002 |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
Every QoE and valuation engagement relies on tax returns as a primary source document, but today that data is trapped in PDF form and manually re-keyed by the QoE team. This feature builds a structured Tax Return Table that captures uploaded tax returns — Form 1120, 1120S, 1065, and the business-use lines of Schedule C within an individual's 1040 — at the line-item level via OCR extraction, tagged by return type, tax year, fiscal period, and source line. Because different return types have different line structures, each row records which return type it came from so downstream consumers (tax reconciliation, COA mapping) always know how to interpret the value. This replaces manual re-keying with a single validated, auditable data source that the rest of the platform can build on.
# 2. User Stories
- As a QoE analyst, I want uploaded tax returns automatically read via OCR and mapped into a standardized table, so that I don't have to manually re-key tax return data into workpapers.
- As a QoE analyst, I want the system to flag any return or line item that doesn't foot (e.g., income less expenses doesn't equal reported net income), so that I catch extraction errors before relying on the data downstream.
- As a company user, I want to upload my tax returns to the data room, so that they flow automatically into the tax reconciliation process without extra work on my part.
- As a broker, I want confidence that tax return data used in reconciliation and valuation has been validated, so that I can trust what's ultimately shown to buyers or lenders.
# 3. Functional Requirements
Numbered, testable statements the dev team can build against directly.
- The system shall allow a user to upload a tax return document (PDF or image) into the Data Room, associated with a single company/deal.
- The system shall run OCR extraction on the uploaded tax return as part of the standard ingestion pipeline.
- The system shall require the user to confirm the return type at upload or post-extraction from a controlled list: 1120, 1120S, 1065, or 1040 (Schedule C only).
- The system shall maintain a fixed, predefined line-item taxonomy per return type, mapping each line on the physical form to a return-type-specific Line Item Code and Label (e.g., 1120S line 1a → "Gross receipts or sales").
- The system shall populate a single normalized Tax Return Table with one row per extracted line item, containing at minimum: Company/Deal ID, Source Document ID, Return Type, Tax Year, Fiscal Period Start Date, Fiscal Period End Date, Line Item Code, Line Item Label, Extracted Value, Extraction Confidence, Validation Status, and Version/Upload Timestamp.
- The system shall capture the fiscal period covered by the return (start and end date) independent of calendar year, to correctly represent non-calendar fiscal years and partial-year (short-period) returns.
- The system shall run an automated footing/cross-validation check on each extracted return immediately after extraction (e.g., confirming total income less total deductions equals the reported net income / ordinary business income line for that return type).
- The system shall set Validation Status to "Needs Review" — rather than "Validated" — for any return that fails its footing check, and shall apply the same "Needs Review" status to any individual line item extracted below a defined OCR confidence threshold. When in doubt, the system shall flag rather than silently accept.
- The system shall prevent a return from being marked "Validated" while any line item on it remains in "Needs Review" status.
- The system shall allow an authorized user to review, correct, and confirm flagged line items, storing the corrected value alongside — not in place of — the original OCR-extracted value, for audit purposes.
- The system shall support multiple tax returns (multiple tax years) per company/deal, each stored as its own set of rows tied to its own Source Document ID and Tax Year.
- The system shall treat a re-uploaded or re-extracted version of a given tax year's return as a new version rather than overwriting the prior extracted data, consistent with platform versioning conventions.
- The system shall make Validated Tax Return Table data available for consumption by downstream features, including Tax Reconciliation (QE-0001) and Full Tax Return Mapping (QE-0002).
- The system shall restrict Schedule C handling to the business-related lines of the individual return; other personal 1040 lines and schedules are out of scope for extraction.
# 4. Data Requirements
Traces to Database module table blocks wherever applicable.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Company / Deal ID | Write | DB-0001 Table Structure (links row set to a single company/deal) |
| Source Document ID | Write | DR-0001 Core Data Room (reference to uploaded tax return file/version) |
| Return Type (1120 / 1120S / 1065 / 1040-Sch C) | Write | User-confirmed at upload; OCR-suggested |
| Tax Year | Write | OCR-extracted from return |
| Fiscal Period Start / End Date | Write | OCR-extracted from return (supports non-calendar and short/partial years) |
| Line Item Code | Write | Fixed taxonomy defined per return type (built as part of this feature) |
| Line Item Label | Write | Fixed taxonomy defined per return type |
| Extracted Value | Write | OCR extraction pipeline |
| Extraction Confidence | Write | OCR extraction pipeline |
| Validation Status (Needs Review / Validated) | Write | DB-0005 Validations (footing / cross-check logic) |
| Corrected Value (if applicable) | Write | User correction, retains original Extracted Value for audit |
| Version / Upload Timestamp | Write | Data Room upload event |
| Full Tax Return Table (validated rows) | Read | Consumed by QE-0001 Tax Reconciliation and QE-0002 Full Tax Return Mapping |

# 5. Access & Security
- Roles with access: Broker, Accountant / QoE provider, Company (own uploaded returns only) — per the role configuration in SY-0001 and company-level access in SY-0002.
- Roles explicitly excluded: Bank, Buyer — tax returns are highly sensitive and must not be exposed outside the sell-side/QoE team without an explicit, separate access grant from the broker.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web only.
- Wireframe reference: N/A
Upload occurs within the Data Room / Key Reports upload flow. Following extraction, present a review screen showing the source document alongside its extracted line items, with any "Needs Review" rows visually flagged (e.g., highlighted) for the user to confirm or correct before the return can be marked Validated. The footing check result should be shown explicitly and plainly — e.g., "Net income per return: $X — footing check passed / failed" — rather than buried in a status icon.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DR-0003 | Related | Data Retrieve Wizard — tax return upload may share the same ingestion/wizard flow |
| DB-0001 | Depends on | Table Structure — underlying architecture linking this table to a company/deal |
| DB-0005 | Depends on | Validations — footing/cross-check logic and the user-notification pattern for flagged data |
| QE-0001 | Blocks | Tax Reconciliation consumes this table's validated output |
| QE-0002 | Blocks | Full Tax Return Mapping depends on this table existing first |
| Document Versioning (cross-cutting gap) | Depends on | General re-upload/versioning capability referenced here, not reinvented locally |

# 8. Out of Scope / Deferred
- Full chart-of-accounts-to-tax-line mapping — belongs to QE-0002 (Full Tax Return Mapping).
- Personal (non-business) 1040 lines and schedules outside of Schedule C.
- The tax-to-book reconciliation/bridge logic itself — belongs to QE-0001 (Tax Reconciliation).
- Additional return types (e.g., 990, 1041, multi-state returns) beyond 1120 / 1120S / 1065 / Schedule C — may be added via a future spec if needed.
# 9. Open Questions
- Should the OCR confidence threshold that triggers "Needs Review" be admin-configurable, or fixed platform-wide at launch? (Ties to the Admin / Internal Ops Console cross-cutting gap.)
- Viewing a prior extracted version alongside a corrected version — should that UI be a shared, platform-wide versioning capability built once, or specific to this feature? Logged against the Document Versioning cross-cutting gap.
- Need Josh's sign-off on the exact footing formula per return type before dev builds the validation logic — e.g., 1120S: ordinary business income = total income − total deductions; 1065: similar; Schedule C: net profit = gross income − total expenses. Confirm these (and any line-level nuances, such as where to net out cost of goods sold) before build.
# 10. Acceptance Criteria
- User can upload a 1120, 1120S, 1065, or 1040-with-Schedule-C return, and the system extracts line items into the Tax Return Table tagged with the correct return type, tax year, and fiscal period (including non-calendar and short-year cases).
- Extracted data is mapped to the fixed line-item taxonomy defined for that return type.
- The system automatically runs the footing check on every extracted return and flags any return, or any individual line item below the confidence threshold, as "Needs Review."
- Flagged items are clearly surfaced to the user for review and correction, and a return cannot be marked Validated while any line remains flagged.
- Re-uploading a return for a tax year already on file creates a new version without overwriting the prior extracted data.
- No user outside the confirmed access roles (Broker, Accountant/QoE, Company for its own data) can view tax return data for a different company/deal.
- Validated Tax Return Table data is available to and consumable by Tax Reconciliation (QE-0001).

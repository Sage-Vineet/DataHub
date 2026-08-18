CENTURIUUM
Feature Specification

| Feature ID | QE - 0011 |
|---|---|
| Feature Name | AR Aging Analysis |
| Module | QE - Quality of Earnings |
| Status | Draft |
| Related / Recycled IDs | N/A |
| Author | Josh Tonnesen |
| Date | August 15, 2026 |

# 1. Purpose & Business Context
Quality of Earnings engagements routinely rely on accounts receivable aging reports to assess collectibility risk, customer payment behavior, and the reasonableness of any bad debt reserve used in normalizing working capital. Today the company's AR aging reports arrive in the data room as uploaded PDFs or spreadsheets for each reporting period, with no structured way to compare periods, spot customers who have dropped off (paid down or written off) or newly appeared, or flag deteriorating aging trends without a reviewer manually re-reading every report. This feature extracts uploaded AR aging reports into a structured table so the QoE reviewer can view aging by customer and by period in one place, see period-over-period customer movement, and carry findings into the working capital and risk sections of the engagement.
# 2. User Stories
- As a QoE reviewer, I want to see AR aging data extracted from uploaded reports in a structured table, so that I can analyze it without manually re-reading each PDF or spreadsheet.
- As a QoE reviewer, I want to compare AR aging across multiple periods, so that I can identify customers whose balances have newly appeared, dropped off, or shifted into a later aging bucket.
- As a QoE reviewer, I want to flag questionable balances or extraction errors, so that they can be routed to the company for clarification through the Q&A module.
- As a company user, I want to confirm the aging figures the platform is using reflect what I provided, so that I can catch any misread or mis-extracted data before it informs a valuation or reserve discussion.
# 3. Functional Requirements
- The system shall allow a user to designate an uploaded Data Room document (PDF or Excel) as an AR aging report for a specified period end date.
- The system shall extract, via OCR/parsing as needed, customer name, aging bucket labels as they appear in the source document, and the corresponding balance amounts for each customer/bucket combination.
- The system shall NOT assume a fixed standard bucket structure (e.g., Current/30/60/90); bucket labels and count shall be read from the source document as extracted, on a per-upload basis.
- The system shall store each extraction as a new version tied to its source file and period end date, without overwriting prior period extractions or prior versions of the same period.
- The system shall display a summary view showing total AR balance and balance by bucket for the selected period.
- The system shall display a customer-level detail view showing each customer's balance by bucket for the selected period.
- The system shall support side-by-side or trended comparison of the same customer's aging position across two or more uploaded periods.
- The system shall identify and flag customers present in a prior period's extraction but absent from the current period's extraction, and customers present in the current period but not in any prior period.
- The system shall flag a low-confidence extraction (e.g., unparseable bucket header, unrecognized layout, or amounts that do not sum to the document's stated total) for manual user review before the record is treated as final.
- The system shall allow a user to manually correct an extracted value and shall log the correction as a change to that version rather than a silent overwrite.
- The system shall allow a user to link a specific customer/period AR aging line item to a Q&A item for follow-up with the company.
- The system shall make AR Aging data available for inclusion in the QoE Workbook Export (QE-0013).
# 4. Data Requirements
This feature requires a new Database table block, proposed here as DB-0011 AR Aging Table, following the same pattern established by DB-0009 Bank Statement Table. This should be confirmed and formally added to the Database module numbering when that module is next revisited.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| AR Aging Header (period end date, report currency, customer count) | Write | New table block: DB-0011 AR Aging Table (proposed) |
| Customer name / customer ID | Write | DB-0011 AR Aging Table; matched against COA customer detail where available (DB-0003) |
| Bucket labels (as extracted from source document) | Write | DB-0011 AR Aging Table |
| Bucket amounts per customer per period | Write | DB-0011 AR Aging Table |
| Total AR balance per period | Write | DB-0011 AR Aging Table (derived/sum) |
| Source file reference (original upload) | Read | DR-0001 Core Data Room |
| Prior-period AR aging records (for trend comparison) | Read | DB-0011 AR Aging Table (prior versions) |
| Risk & Opportunities commentary tie-in | Write | QE-0007 Risk and Opportunities |

# 5. Access & Security
- Roles with access: Accountant/QoE provider (full read/write), Broker (read), Company (read-only view of their own submitted data, for confirmation purposes).
- Roles explicitly excluded: Bank and Buyer profiles do not have access to AR Aging Analysis unless and until the deal reaches a stage where underlying financial detail is explicitly shared with them, consistent with staged data room access.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web only. Underlying data extraction, correction, and multi-period comparison workflows are analysis-grade tasks not suited to the mobile-light experience.
- Wireframe reference: N/A
Presented as a tab within the QoE workbook experience, consistent with QE-0009 Customer Concentration and other QoE tabs. Default view shows the most recent period's summary with a control to add additional periods for comparison. Customers newly appearing or dropping off between periods should be visually distinguished (e.g., a status indicator) rather than requiring the reviewer to manually diff two tables.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DR-0001 Core Data Room | Depends on | AR aging source files (PDF/Excel) must be uploaded to the Data Room before extraction can occur. |
| DB-0001 Table Structure | Depends on | New table block (DB-0011, proposed) follows the same architectural pattern as DB-0009 Bank Statement Table. |
| DB-0003 COA | Depends on | Customer-level matching benefits from, but does not require, an existing customer/vendor dimension if one is established in the COA/GL structure. |
| QE-0007 Risk and Opportunities | Blocks | AR aging findings (e.g., rising past-due concentration in a key customer) should be surfaceable to Risk & Opportunities. |
| QE-0009 Customer Concentration | Related | Both features analyze customer-level receivables/revenue data; should share customer identity resolution logic where possible. |
| QE-0013 Workbook Export | Blocks | AR Aging tab must be includable in the full QoE workbook export. |
| Document Versioning (cross-cutting gap) | Depends on | Re-uploading a corrected or later-period AR aging report must version rather than overwrite prior extractions. |
| Admin / Internal Ops Console (cross-cutting gap) | Related | Manual correction of failed/low-confidence extractions may require an internal review tool. |

# 8. Out of Scope / Deferred
- Automated calculation or suggestion of a bad debt/uncollectible reserve — this feature surfaces the aging data; reserve judgment and its flow into the asset approach (VL-0008) is handled elsewhere.
- AR aging data retrieval via the Data Retrieve Wizard (DR-0003) or any live accounting-system connection — this feature is manual-upload extraction only per current scope; a future spec may extend DR-0003 to cover this report type.
- Structured extraction of AP Aging (QE-0012) — tracked as its own, separate feature spec, though it will likely share extraction infrastructure with this feature.
- Customer master data management (canonical customer records, deduplication rules across the platform) — out of scope here; this feature does best-effort name matching only within a single company/deal.
# 9. Open Questions
- DB-0011 AR Aging Table does not yet have a confirmed feature ID in the Database module — needs to be formally added to the product list and Database module numbering.
- What extraction/OCR confidence threshold should trigger a manual review flag, and who is notified when one is raised?
- How should customer name matching across periods handle minor naming variants (e.g., "ABC Corp" vs. "ABC Corporation") — exact match only, or fuzzy matching with user confirmation?
- Should a bad debt reserve estimate (even if manually entered rather than calculated) be captured on this tab for downstream reference by VL-0008, or does that belong entirely to a separate feature?
- Document versioning (cross-cutting gap) is assumed to apply here for re-uploads of a corrected same-period report — needs to be confirmed once that capability is formally specced.
# 10. Acceptance Criteria
- A user can upload an AR aging report (PDF or Excel) to the Data Room, designate it as an AR aging report for a given period, and see it appear as extracted structured data within the AR Aging Analysis tab.
- A user can view total AR and bucket-level balances for a selected period, and drill down to customer-level detail for that period.
- A user can select two or more periods and see a side-by-side or trended comparison of a given customer's aging position across those periods.
- Customers that dropped off or newly appeared between two compared periods are clearly flagged without manual diffing by the reviewer.
- A low-confidence or unreconciled extraction is flagged for review rather than silently presented as final data.
- A user can manually correct an extracted value and the correction is logged, not silently overwritten.
- AR Aging data is includable in the QoE Workbook Export.

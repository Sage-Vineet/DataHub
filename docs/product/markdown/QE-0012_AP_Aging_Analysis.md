CENTURIUUM
Feature Specification

| Feature ID | QE - 0012 |
|---|---|
| Feature Name | AP Aging Analysis |
| Module | QE - Quality of Earnings |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 15, 2026 |

1. Purpose & Business Context
Accounts payable aging is a standard part of a Quality of Earnings review, used to assess whether the company is managing vendor payments normally or stretching payables to artificially improve reported cash flow near a transaction. This feature adds a simple AP Aging tab within the QoE module that presents the company's uploaded AP aging data in standard aging buckets, at the vendor level, with a small set of automatically calculated flags to draw the reviewer's attention to outliers. It is intentionally a simple, presentation-first build: no manual adjustments, workpaper linking, or narrative authoring are in scope for this version.
2. User Stories
- As a QoE reviewer (accountant), I want to see the company's AP aging broken out by standard aging buckets and by vendor, so that I can quickly assess payables health without manually rebuilding the schedule from a source file.
- As a QoE reviewer, I want the system to flag vendor concentration and aged balances automatically, so that I know where to focus my review without recalculating totals by hand.
- As a broker or deal team member, I want the ability to turn the AP Aging tab on or off for a given engagement, so that it only appears when it's relevant to the scope of work.
3. Functional Requirements
- The system shall allow a user to upload an AP aging report as part of the standard data upload process (via DR-0001 Data Room).
- The system shall extract vendor, invoice/bill number, invoice date, and invoice amount/balance due from the uploaded AP aging report into a structured AP Aging Table.
- The system shall calculate an aging bucket for each line item using standardized buckets: Current, 1-30, 31-60, 61-90, and 90+ days, based on invoice date relative to the report's as-of date.
- The system shall display a summary view showing total AP by aging bucket.
- The system shall display a vendor detail view showing total AP by vendor, with a drill-down to bucket-level detail per vendor.
- The system shall calculate and display a vendor concentration flag showing the top vendor and top 5 vendors as a percentage of total AP.
- The system shall calculate and display the percentage of total AP balance aged over 90 days.
- The system shall visually flag (e.g., highlight or badge) any vendor concentration or aged-balance percentage that exceeds a configurable threshold.
- The system shall allow an authorized user to toggle the AP Aging tab on or off for a given engagement; when off, the tab shall not appear in the QoE module navigation for that engagement.
- The system shall display an empty state within the tab (when toggled on) if no AP aging report has been uploaded yet, with a prompt to upload.
- The system shall support re-upload of a new or corrected AP aging report, creating a new version per the platform's standard versioning convention rather than overwriting prior data.
4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| AP Aging Report (source file) | Read | DR-0001 Data Room (uploaded AP aging report document) |
| Vendor name | Read | Extracted from uploaded AP aging report |
| Invoice/bill number | Read | Extracted from uploaded AP aging report |
| Invoice date | Read | Extracted from uploaded AP aging report |
| Invoice amount / balance due | Read | Extracted from uploaded AP aging report |
| Aging bucket (Current / 1-30 / 31-60 / 61-90 / 90+) | Read/Write | System-calculated at extraction from invoice date vs. as-of date |
| AP Aging Table (structured) | Read/Write | New table, parsed on upload; follows DB-0009 (Bank Statement Table) structural pattern |
| Total AP by bucket | Read | Calculated from AP Aging Table |
| Total AP by vendor | Read | Calculated from AP Aging Table |
| Vendor concentration % (top vendor / top 5 vendors as % of total AP) | Read | Calculated from AP Aging Table |
| % of total AP over 90 days | Read | Calculated from AP Aging Table |
| Tab visibility toggle (On/Off) | Read/Write | QoE engagement setup / configuration |
| Company/Deal ID | Read | SY-0002 Company Access Setup (deal scoping) |

5. Access & Security
- Roles with access: Accountant/QoE provider, Broker, Company (subject to standard QoE visibility settings).
- Roles explicitly excluded: Bank and Buyer, unless and until explicitly granted access per SE-0002 permissioning (AP aging detail is sensitive vendor-level financial data not typically shared pre-LOI).
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
6. UI / UX Notes
- Platform: Web only.
- Wireframe reference: N/A
Presented as a tab within the QoE module, consistent with the layout pattern of other QoE tabs (e.g., QE-0011 AR Aging Analysis, QE-0006 Working Capital). Summary bucket totals displayed at the top (table and/or simple bar chart), with a sortable vendor detail table below. Concentration and aged-balance flags surfaced as a small callout or badge near the summary, not buried in the detail table.
7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DR-0001 | Depends on | AP aging report must be uploaded to the Data Room before extraction can occur. |
| DB-0009 | Related pattern | AP Aging Table follows the same structural approach as the Bank Statement Table (structured extraction into a defined table rather than a generic document store). |
| QE-0011 | Related pattern | AR Aging Analysis is the mirror feature on the receivables side; both should share the same aging-bucket and table-layout conventions for consistency. |
| SE-0002 | Depends on | Role/module-level access control gating who can view the AP Aging tab. |
| Document versioning (cross-cutting gap) | Depends on | Re-uploaded AP aging reports must version rather than overwrite; no dedicated feature ID exists yet for general versioning. |

8. Out of Scope / Deferred
- Manual reclassification or adjustment of individual AP line items — not supported in this version.
- Narrative commentary or Q&A linkage on specific vendors or aged balances (parallel to QE-0006 Working Capital's commentary tie-in) — deferred to a future spec if needed.
- Parsing of non-standard or non-tabular AP aging report formats beyond common accounting-system exports (e.g., QuickBooks) — flagged as an Open Question below.
- Trend analysis across multiple periods/uploads — this version presents the most recent uploaded report only.
9. Open Questions
- What specific file formats/sources must the extraction logic support at launch (e.g., QuickBooks Online AP Aging Detail export, QuickBooks Desktop, generic CSV/Excel)? This determines parsing complexity.
- What is the default threshold for the vendor concentration and 90+ day flags, and should it be configurable per engagement or fixed platform-wide?
- Should the toggle default to On or Off for new QoE engagements?
10. Acceptance Criteria
- Given an uploaded AP aging report, the system correctly extracts vendor, invoice, date, and amount data and assigns each line to the correct standardized aging bucket.
- The AP Aging tab displays accurate bucket totals and vendor-level totals that reconcile to the total AP balance on the uploaded report.
- Vendor concentration and 90+ day aging flags display correctly and update when the threshold is crossed.
- The tab can be toggled on/off per engagement, and the on/off state is respected in the QoE module navigation.
- Re-uploading an AP aging report creates a new version without deleting or overwriting the prior version's data.
- Access to the tab correctly respects role-based permissions per SE-0002, with Bank and Buyer excluded by default.

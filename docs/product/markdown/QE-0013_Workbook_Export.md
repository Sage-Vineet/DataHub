CENTURIUUM
Feature Specification

| Feature ID | QE - 0013 |
|---|---|
| Feature Name | Workbook Export |
| Module | QE - Quality of Earnings |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 15, 2026 |

1. Purpose & Business Context
The Quality of Earnings module produces a set of connected but individually-authored pages (financial statements, EBITDA/SDE workpapers, narrative summaries, adjustments, etc.), each rendered inside Centuriuum. Brokers, accountants, and buyers ultimately need to take this analysis outside the platform — to send to a lender, a buyer's diligence team, or a tax preparer — in a working Excel format they can review, recompute, and drill into, not a static printout.
This feature defines the export engine and workbook architecture that assembles a user-selected subset of QoE content into a single, structured .xlsx file: a title page, an Account Summary tab with collapsible account/vendor rollups and collapsible month columns, the P&L and Balance Sheet in standard chart-of-accounts hierarchy order, and any other QoE narrative or workpaper pages the user chooses to include. Where practical, tabs are linked by live formula rather than pasted values, so a reviewer can trace a number (e.g., a tax return line) back to its source (e.g., Total Revenue on the P&L) inside the workbook itself.
This spec covers the export architecture, the workbook's structural tabs (title page, Account Summary, P&L, Balance Sheet), and the generic mechanism (the “Exportable Page Registry”) that every other QoE page plugs into. It does not re-define the content of any individual QoE page — refer to that page's own feature spec (e.g., QE - 0001, QE - 0004, QE - 0007) for what appears on it.
2. User Stories
- As a broker, I want to export the QoE analysis to a single Excel workbook with only the pages relevant to my buyer, so that I don't have to manually rebuild the report outside the platform.
- As an accountant/QoE preparer, I want the P&L and account detail to be grouped and collapsible by account/vendor and by month, so that a reviewer can drill into supporting detail without me building a separate pivot workbook.
- As a buyer or lender, I want key figures (e.g., a tax return reconciliation) to be linked by formula back to their source tab, so that I can verify where a number came from without leaving Excel.
- As a company user, I want the exported workbook to look clean and functional — not a merged-cell BI printout — so that my own team can actually work in it.
3. Functional Requirements
- The system shall present an “Export QoE Report” action, accessible from the QoE module, that opens a page/menu listing every QoE page currently registered in the Exportable Page Registry for the active deal.
- The system shall render each registry entry as a checkbox item, reflecting a standard default selection defined by that page's own spec (or included-by-default if unspecified), and shall reset to this standard default set every time the export menu is opened — selections are not remembered per user or company.
- The system shall always include a Title Page tab and, when included, an Account Summary tab, a P&L tab, and a Balance Sheet tab, using the fixed and company-configured Chart of Accounts hierarchy (DB - 0003, DB - 0006) to order rows from top-level rollup down to lowest account level.
- The system shall build the Account Summary tab from GL data already summarized by account and by month (and, where available, by vendor/customer within an account) — not from raw, transaction-level GL detail.
- The system shall implement account/vendor row drill-down and month column drill-down using native Excel row and column grouping/outline (expand/collapse controls), with plain, unmerged cells beneath each grouping level.
- The system shall permit cell merging only on title/header cells (e.g., a workbook title banner or tab section header) and shall not merge cells within any data grid.
- The system shall link values across tabs using native Excel formulas (e.g., cell references or SUM formulas) wherever the referenced figure has a direct, unambiguous source cell, in preference to pasting a static value.
- Where a cross-tab formula's source account/row does not exist for the company in question (e.g., no separate COGS breakout), the system shall render the destination cell as $0 or blank without displaying an error value.
- The system shall assemble each selected QoE narrative or workpaper page (per its own spec's export layout) as its own tab, in a fixed tab order defined by the Exportable Page Registry.
- The system shall render inline Q&A citation tags (e.g., [QA-014]) that appear in exported narrative text as plain, non-interactive text labels, since a static Excel file cannot click through to the in-app Q&A record.
- The system shall generate the workbook asynchronously for exports above a to-be-determined page/size threshold, and shall notify the user when the file is ready for download (pending the Notifications Hub).
- The system shall log every export event — user, deal, pages included, and timestamp — to the Activity & Audit Log (SY - 0003).
- The system shall NOT persist a rendered copy of the exported workbook as the system of record; the workbook is generated fresh from live underlying data at export time and is not treated as a versioned document unless the user separately uploads it back into the Data Room.
4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Chart of Accounts hierarchy (levels 1-15) | Read | DB - 0003 |
| Firm/role-scoped hierarchy edits | Read | DB - 0006 |
| GL account balances by month, by vendor/customer subledger | Read | DB - 0007 / DB - 0009 ingested GL data |
| Trial Balance / validation status | Read | DB - 0005 |
| P&L and Balance Sheet computed structures | Read | RP - 0001 |
| Adjusted EBITDA/SDE workpaper values | Read | QE - 0004 |
| QoE narrative page content (per page, per registered page type) | Read | Individual QE page specs, e.g. QE - 0001, QE - 0003, QE - 0004, QE - 0006 |
| Q&A citation tags embedded in narrative text | Read | QA - 0002 |
| Exportable Page Registry entries (page type, tab order, default checkbox state) | Read | QE - 0013 (this feature) - registry defined here, populated by each page's own spec |
| Export event record (who exported, which pages, when) | Write | SY - 0003 Activity & Audit Log |

5. Access & Security
- Roles with access: Broker, Accountant/QoE preparer, Company (for their own deal), Buyer (where deal stage and access grant permit).
- Roles explicitly excluded: Bank, until the deal reaches a stage where export access is explicitly granted under SE - 0002.
- Export availability for any given page respects that page's own module/tab-level access grant (SE - 0002) — a user cannot export a page they cannot view in-app.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
6. UI / UX Notes
- Platform: Web only. Workbook generation and the export selection menu are not part of the Mobile (light) experience.
- Wireframe reference: N/A — Josh to provide reference from existing QoE workbook example.
The export menu presents the Exportable Page Registry entries as a simple checklist (grouped by module — Reports, QoE, Valuation — as the registry grows), each with its standard default checkbox state pre-applied. An “Export” button generates the workbook; for larger exports, the user sees a progress or “we'll notify you” state rather than a blocking spinner.
Within the workbook, the Account Summary, P&L, and Balance Sheet tabs use Excel's native outline symbols (+/−) at the left row margin and above grouped month columns. Formatting favors a clean, working-file look: consistent column widths, no merged data cells, standard number formatting, and light use of bold/shading only for rollup and header rows — explicitly avoiding a heavily merged, presentation-style layout.
7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DB - 0003 / DB - 0006 | Depends on | Chart of Accounts hierarchy drives the account-level rollup structure used for row grouping in the P&L and Balance Sheet tabs |
| DB - 0005 | Depends on | Validation/severity status informs whether an export should carry a data-quality warning on the title page |
| DB - 0007 / DB - 0009 | Depends on | Underlying GL ingestion and monthly summarization by account/vendor is the data source for the Account Summary tab |
| RP - 0001 | Depends on | Reports module supplies the computed P&L and Balance Sheet structures this feature exports |
| QE - 0004 | Depends on | Adjusted EBITDA/SDE values referenced by the Tax Return and Executive Summary tabs |
| QE - 0001, QE - 0003, QE - 0004, QE - 0006, QE - 0007 (and future QE page specs) | Depends on | Each QoE narrative/workpaper page registers itself with the Exportable Page Registry defined here; content and layout of each page is owned by its own spec, not this one |
| QA - 0002 | Depends on | Q&A citation tags carried into narrative text must render sensibly in a static Excel export (no click-through, since Excel can't reach the in-app Q&A record) |
| SY - 0003 | Depends on | Every export run is logged to the Activity & Audit Log |
| Notifications Hub (cross-cutting gap) | Depends on | Large exports may run asynchronously; user needs to be notified when the file is ready. No feature ID yet. |

8. Out of Scope / Deferred
- The content, layout, and calculation logic of any individual QoE narrative or workpaper page (e.g., Executive Summary, EBITDA/SDE workpaper, Risks & Opportunities) — owned by that page's own feature spec; this feature only defines how a registered page is assembled into the workbook.
- Raw, transaction-level General Ledger detail export — explicitly excluded per Josh's direction; only account/month (and vendor, where available) summary-level data is exported.
- PowerPoint/CIM export of QoE financial content — owned by CM - 0001 / QE - 0014.
- Any live/refreshing connection between the exported workbook and platform data after export — the workbook is a static, point-in-time file per the platform's data retrieval conventions.
- Design of the Exportable Page Registry's underlying storage/versioning mechanism beyond the conceptual model described here — left to engineering design, provided each QoE page can register a tab name, default inclusion state, and export layout.
9. Open Questions
- What page/size threshold triggers asynchronous generation instead of an immediate download, and what does the in-progress state look like without a finished Notifications Hub?
- Should the Account Summary tab default to a fixed lookback (e.g., trailing 12 months) or the full engagement/deal period, and is that configurable per export?
- For pages whose content spec hasn't been finalized yet, what should the export menu show — omit the checkbox entirely until that spec is drafted, or show it as “coming soon” and disabled?
- Does a data-quality flag from DB - 0005 (Minor/Material validation issues) need to surface as a visible warning on the workbook's title page, and if so, what triggers it?
10. Acceptance Criteria
- A user with export access can open the Export QoE Report menu and see a checklist of all currently registered QoE pages for the active deal, with the standard default selections pre-applied.
- Generating an export with the Account Summary, P&L, and Balance Sheet tabs selected produces a workbook where account/vendor rows and month columns are grouped using native Excel outline controls, with no merged cells within the data grids.
- At least one cross-tab formula (e.g., a Tax Return tab referencing Total Revenue on the P&L tab) resolves correctly via live Excel formula, and resolves to $0/blank without an error when the source account doesn't exist for that company.
- Every export event is recorded in the Activity & Audit Log with user, deal, pages included, and timestamp.
- Re-opening the export menu after a prior export shows the standard default checkbox selections, not the user's last selection.
- A user without export access to a given page (per SE - 0002) does not see that page as an exportable option.

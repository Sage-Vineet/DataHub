CENTURIUUM
Feature Specification

| Feature ID | RP - 0001 |
|---|---|
| Feature Name | Profit & Loss Report |
| Module | RP - Reports |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
The Profit & Loss report gives brokers, accountants, and company users a live, drillable P&L generated directly from the general ledger detail loaded through the Key Reports module, rather than a static uploaded document. It aggregates GL transaction-level detail up through the Chart of Accounts rollup structure, while preserving the ability to drill all the way back down to the vendor/customer and individual transaction level - the same experience users expect from QuickBooks. This matters because it lets deal teams work from one reconciled source of truth for financial reporting instead of re-requesting or re-keying P&L data for every engagement, and it is a foundational input to downstream modules (QoE, Valuation, Projections) that depend on clean, structured P&L data.
# 2. User Stories
- As a Broker, I want to view a company's P&L generated automatically from loaded GL data, so that I don't have to request or manually rebuild financial statements for every deal.
- As an Accountant/QoE preparer, I want to drill down from a P&L line item down to the vendor/customer and transaction level, so that I can investigate account activity without leaving the platform.
- As a Company user, I want to toggle between monthly and annual views and compare periods side by side, so that I can review trends in my own financials.
- As any report user, I want to export the P&L to PDF, Excel, or CSV, so that I can share it outside the platform or use it in other analysis.
# 3. Functional Requirements
- The system shall generate a Profit & Loss report by aggregating GL transaction detail (DB - 0002) up through the Chart of Accounts rollup hierarchy (DB - 0003).
- The system shall allow the user to select which Key Reports version the P&L is generated from, and shall regenerate the report entirely from the selected version's underlying GL data.
- The system shall allow the user to specify a date range (start and end date) to scope the P&L period.
- The system shall allow the user to toggle the report view between Monthly and Annual.
- The system shall allow the user to enable a side-by-side comparison view showing a selected comparison period (e.g., prior period or prior year) alongside the primary period, including a variance ($ and %) column.
- The system shall hide COA accounts with zero activity for the selected date range/period by default, consistent with standard QuickBooks P&L behavior.
- The system shall allow the user to drill down from any P&L rollup line into its constituent detail accounts, following the hierarchy defined in the Chart of Accounts (DB - 0003 / DB - 0006).
- The system shall allow the user to drill down from a detail account into vendor/customer-level subtotals, where vendor/customer name data exists on the underlying GL transactions.
- The system shall allow the user to drill down from a vendor/customer subtotal into the individual transaction-level detail (date, memo, amount, reference number) that composes it.
- The system shall suppress vendor/customer name and any other column identified as restricted by the permission model (SE - 0002) at the query level, so that a restricted user never receives that column in the report response, rather than hiding it only in the UI.
- The system shall keep row/column headers (account rollup labels and period headers) frozen/pinned in place when the user scrolls the report, both vertically and horizontally.
- The system shall allow the user to export the currently displayed P&L (including the selected period, comparison, and monthly/annual configuration) to PDF, Excel (.xlsx), and CSV.
- The system shall reflect the current Key Reports version and selected date range/comparison period on every export, so an exported file is self-describing without needing to reference the live report.
- The system shall visually flag (e.g., icon or banner) any account or period affected by an open validation/reconciliation issue surfaced by DB - 0005, without blocking the user from viewing the report.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| GL transaction detail (date, account, amount, memo, name/vendor-customer, class if used) | Read | DB - 0002 (GL Data) |
| Chart of Accounts hierarchy / rollup structure | Read | DB - 0003 (COA); reflects any reclassifications made via DB - 0006 (Configurable COA) |
| Key Reports version identifier and effective date range | Read | DB - 0002 / DR - 0003 (Data Retrieve Wizard) version metadata |
| Vendor / customer name field on GL transaction | Read | DB - 0002 (GL Data) - column visibility gated per SE - 0002 permission model |
| Column-level visibility/permission flags controlling which GL fields (e.g., vendor/customer name) are exposed to a given role | Read | SE - 0002 (Security / Permission model) - referenced, not owned by this feature |
| Report display state (selected version, date range, comparison period, monthly/annual toggle, zero-balance hide/show) | Write | User session / report configuration store (RP module) |
| Exported P&L output (PDF/Excel/CSV) file record | Write | DR - 0001 (Core Data Room) if saved, or ephemeral download |

# 5. Access & Security
- Roles with access: Broker, Company, Accountant (exact role-to-permission mapping, including which roles may view vendor/customer-level and transaction-level detail, is governed by the permission model in SE - 0002 rather than defined locally in this spec).
- Roles explicitly excluded: none excluded from the report at the module level by default; column-level restrictions (e.g., suppressing vendor/customer name for a given role such as Bank or Buyer) are configured and enforced through SE - 0002 at the data layer, not through report-level logic.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web only. Full P&L drill-down and analysis workflow is a web-only experience per the Mobile scope decision in project conventions; Mobile may surface a read-only summary in a future spec but is out of scope here.
- Wireframe reference: N/A - to be added once available.
Header row (account rollup structure) and header column (period/date labels) should remain frozen/pinned during scroll, matching the QuickBooks-style report experience Josh referenced. Drill-down should be presented as progressive disclosure (expand/collapse rollup rows, click-through to vendor/customer, click-through to transaction) rather than navigating to a separate page, so the user's place in the hierarchy is never lost. Comparison view should clearly label which column is the primary period vs. the comparison period, with variance shown adjacent to each account line.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DB - 0002 (GL Data) | Depends on | P&L is a direct aggregation of loaded GL transaction detail; cannot be built until GL data is loaded and stored. |
| DB - 0003 (COA) | Depends on | P&L rollup structure and account hierarchy come from the generated Chart of Accounts. |
| DB - 0006 (Configurable COA) | Depends on | User-defined rollup/reclassification changes made here must flow through to the P&L presentation. |
| DR - 0003 (Data Retrieve Wizard) | Depends on | Defines the Key Reports version concept (and, per Josh, will define accounting basis - cash vs. accrual - at the version level) that this report toggles between. |
| SE - 0002 (Security / Permission model - cross-cutting gap) | Depends on | Controls whether vendor/customer name and transaction-level columns are exposed to a given role. Not designed locally in this spec - see Open Questions. |
| DB - 0005 (Validations) | Depends on | P&L should reflect/flag any GL reconciliation errors surfaced by validation logic rather than silently displaying unreconciled data. |
| RP - 0002 (Balance Sheet) | Related | Shares the same GL/COA/version foundation; UI and export patterns should stay consistent between the two reports. |
| QE - 0004 (SDE/EBITDA Tab) | Blocks | QoE adjusted-earnings calculations are built on top of P&L account-level data. |

# 8. Out of Scope / Deferred
- Balance Sheet and Cash Flow statements - covered separately in RP - 0002 and RP - 0003.
- Design/configuration of the underlying role-based column permission system itself (which fields are restrictable and how a broker configures that) - that belongs to the SE - 0002 security spec, not this feature.
- Cash vs. Accrual basis toggle logic - per Josh, basis is expected to be defined at the Key Reports version level (DR - 0003) rather than as a toggle within the P&L report itself; if that changes, this spec will need to be revisited.
- Saving/scheduling recurring exports or distribution of the P&L to external parties - not covered here.
# 9. Open Questions
- Confirm with the SE - 0002 security spec exactly how column-level restriction (e.g., suppressing vendor/customer name) will be implemented and exposed to this report's query layer.
- Confirm with DR - 0003 whether/how the accounting basis (cash vs. accrual) is set per Key Reports version, and how that is displayed to the user on the P&L.
- Should a user be able to name/save a specific report configuration (period + comparison + toggles) for reuse, or is every session a fresh configuration?
- What is the expected behavior when a comparison period spans a different Key Reports version than the primary period (e.g., comparing this year's version to last year's separately-loaded version)?
# 10. Acceptance Criteria
- User can select a Key Reports version and date range, and the P&L regenerates correctly from that version's GL data.
- User can toggle Monthly/Annual view and enable a comparison period, with variance calculated correctly.
- Accounts with no activity in the selected period are hidden by default.
- User can drill down from rollup → detail account → vendor/customer → transaction, and back up, without losing report context.
- A user whose role is restricted from vendor/customer-level data never receives that column or drill-down level, in the UI or in any export.
- Header row and column remain frozen during scroll.
- User can export the current report view to PDF, Excel, and CSV, and each export reflects the exact version/period/comparison configuration shown on screen.

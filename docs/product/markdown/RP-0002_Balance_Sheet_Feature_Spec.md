CENTURIUUM
Feature Specification

| Feature ID | RP - 0002 |
|---|---|
| Feature Name | Balance Sheet |
| Module | RP - Reports |
| Status | Draft |
| Related / Recycled IDs | Related to RP - 0001 (Profit & Loss); depends on DB - 0002, DB - 0003, DB - 0004, DB - 0006 |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
The Balance Sheet report gives brokers, QoE reviewers, and other deal-team users a standard, drillable view of the company's financial position (assets, liabilities, and equity as of a point in time), generated from the stored Trial Balance and rendered through the Chart of Accounts hierarchy. It matters because balance sheet data underlies QoE working capital analysis, the Asset/Net Asset Value valuation approach, and buyer/lender diligence review — all of which need a consistent, reconciled, drillable source rather than a static uploaded file. Like QuickBooks, the report is generated from stored (not live) balances for speed, but supports drill-down into the underlying general ledger detail so a user can see exactly which transactions built up a given balance.
# 2. User Stories
- As a QoE reviewer, I want to view the company's balance sheet as of a specific date, so that I can assess financial position and support working capital analysis.
- As a broker or QoE reviewer, I want to drill down from a balance sheet line into the underlying general ledger transactions, so that I can verify or investigate what makes up a reported balance.
- As a QoE reviewer, I want to compare balance sheet figures across multiple periods (monthly or yearly) in side-by-side columns, so that I can spot trends and unusual account movements.
- As a broker or accountant, I want to select which stored data version (pull/re-pull) the balance sheet reflects, so that I can review historical balances exactly as they existed at a prior point in the engagement.
- As a company or accountant user, I want the balance sheet to reflect the reconciled Chart of Accounts hierarchy (including any reclassifications), so that the report matches the reporting structure the deal team has agreed on.
# 3. Functional Requirements
- The system shall generate the Balance Sheet by filtering the stored Trial Balance (DB - 0004) to only those accounts flagged as balance-sheet accounts in the Chart of Accounts (DB - 0003).
- The system shall render account rows and subtotals according to the Chart of Accounts hierarchy and rollup structure, including any user-driven reclassifications made in the Configurable COA (DB - 0006).
- The system shall require a single 'As Of' date to define the balance sheet's reporting point in time, consistent with standard balance sheet convention (a point-in-time report, not a date-range report).
- The system shall also accept a 'Compare From' date, used only to enable period-over-period comparison columns and change/drill-down analysis — it shall not alter the single-point-in-time balances themselves.
- The system shall default to a single balance column reflecting the selected 'As Of' date.
- The system shall allow the user to optionally switch to a multi-column comparison view (e.g., monthly or yearly columns across a user-defined date range), consistent with the toggle behavior in QuickBooks' 'Columns by Period' view.
- The system shall provide a monthly/yearly (and any other supported interval) toggle that controls the period granularity of comparison columns when multi-column view is enabled.
- The system shall provide a version selector allowing the user to choose from any prior stored Trial Balance version (per the pull/re-pull history maintained by the Data Retrieve Wizard, DR - 0003).
- The system shall default the version selector to the most recent stored version unless the user selects otherwise.
- The system shall scope general ledger drill-down to the GL data snapshot associated with the selected Trial Balance version — selecting a prior version shall never drill into current/live GL data.
- The system shall allow the user to click any balance sheet line item to drill down to the underlying general ledger transaction detail that composes that balance, for the selected version and (in comparison view) the selected column/period.
- The system shall support standard QuickBooks-style report filters/toggles, including at minimum: show/hide zero-balance rows, collapse/expand account subtotals, and whole-dollar vs. decimal display.
- The system shall visually reconcile the report (total assets equal total liabilities plus equity) and shall flag on-screen if the underlying stored data does not balance.
- The system shall support frozen header row(s) and a frozen leftmost column (account/label column) so account labels and period headers remain visible while scrolling through a wide, multi-column comparison view.
- The system shall allow the report to be exported (e.g., to PDF and/or Excel), consistent with the export approach used elsewhere in the Reports and QoE modules.
- The system shall write a log entry to the Activity & Audit Log (SY - 0003) whenever a user views, drills into, or exports the Balance Sheet.
# 4. Data Requirements
What tables/fields does this feature read from or write to? Reference the relevant Database module table blocks (DB - 0001 through DB - 0010) wherever applicable so every feature traces back to the reconciled data structure.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Stored Trial Balance (selected version) | Read | DB - 0004 (Trial Balance) |
| Chart of Accounts hierarchy, account type/subtype flags, rollup structure | Read | DB - 0003 (COA) / DB - 0006 (Configurable COA) |
| Balance-sheet-classification flag per account | Read | DB - 0003 (COA) |
| GL transaction detail (drill-down) | Read | DB - 0002 (GL Data), scoped to the GL snapshot tied to the selected TB version |
| Version / pull metadata (version ID, pull date, source) | Read | DR - 0003 (Data Retrieve Wizard) version history |
| Report display settings (as-of date, comparison periods, zero-balance toggle, column layout) | Read/Write | RP - 0002 report configuration (new; user- and report-level settings) |
| Report view/access/export events | Write | SY - 0003 (Activity & Audit Log) |

# 5. Access & Security
- Roles with access: Broker, Accountant, QoE reviewer, Company (view of their own company's data only).
- Roles explicitly excluded: Bank and Buyer, unless and until explicitly granted access to this report as part of a data room folder/permission grant (per the deal's access configuration) — the Balance Sheet is not exposed by default outside the deal team.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
- GL-level drill-down detail may reveal more granular financial activity than a summarized balance; access to drill-down shall respect the same role/permission scope as the summary report — no separate, broader grant of GL detail.
# 6. UI / UX Notes
- Platform: Web only.
- Wireframe reference: N/A
Layout should mimic familiar QuickBooks balance sheet conventions so accountant and QoE users have minimal learning curve:
- As Of date picker as the primary control; Compare From date and comparison toggle presented as secondary/optional controls, not required for a basic single-period view.
- Report type toggle: monthly / yearly (and any additional supported intervals), enabled only when comparison view is active.
- Version selector clearly labeled with version date/label (e.g., 'Pulled 6/30/2026') so it is obvious to the user which stored data set they are viewing.
- Frozen header row and frozen leftmost (account label) column when scrolling a wide comparison view.
- Clicking any line amount opens a transaction-level drill-down (e.g., a slide-over panel or modal) showing the underlying GL detail, with a clear path back to the report.
- Zero-balance row visibility, collapse/expand of subtotal groups, and decimal/whole-dollar display available as simple toggles near the report header, consistent with RP - 0001 (Profit & Loss) for a consistent cross-report experience.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DB - 0002 (GL Data) | Depends on | Drill-down from a TB line to transaction detail reads GL data tied to the same version/snapshot as the selected Trial Balance. |
| DB - 0003 (COA) | Depends on | Balance sheet classification and rollup hierarchy come from the Chart of Accounts; only accounts flagged as balance-sheet accounts are included. |
| DB - 0004 (Trial Balance) | Depends on | Balance Sheet is generated by filtering the stored Trial Balance to balance-sheet-classified accounts. |
| DB - 0006 (Configurable COA) | Depends on | Any user-driven reclassification or rollup change in the configurable COA UI must flow through to this report's hierarchy. |
| DR - 0003 (Data Retrieve Wizard) | Depends on | Supplies the version history (each pull/re-pull) that the version toggle selects from. |
| RP - 0001 (Profit & Loss) | Related to | Shares the same COA-hierarchy rendering, drill-down pattern, and QB-style filter/toggle conventions; should be built with a consistent shared UI component where feasible. |
| SY - 0003 (Activity & Audit Log) | Depends on | Report views, drill-down access, and exports should be logged. |
| Document Versioning (cross-cutting gap) | Depends on | General versioning capability referenced rather than reinvented locally; see Open Questions. |

# 8. Out of Scope / Deferred
- Statement of Cash Flow generation — covered separately in RP - 0003 (lower priority, to be specced later).
- Balance sheet projections (multi-year forward-looking BS) — covered in PJ - 0003 (BS Projection), not this feature.
- Editing, reclassifying, or overriding the Chart of Accounts hierarchy directly from this report — that capability belongs to DB - 0006 (Configurable COA); this report only renders the resulting hierarchy.
- Any live/refreshing connection back to QBO or another source system — per locked architectural decisions, all retrieved data is static per version; re-pulling creates a new version rather than refreshing this report's data in place.
- General document/version history UI shared across modules — the version selector here consumes version metadata but does not implement a general versioning system; see Open Questions / Document Versioning gap.
# 9. Open Questions
- Document versioning is a known cross-cutting gap (see Conventions doc, Section 3) without its own feature ID yet. This spec assumes DR - 0003 already produces the version history this report's selector consumes — confirm whether a dedicated Document Versioning feature spec is needed before or alongside this build.
- How many comparison columns/periods should the UI support before performance or usability degrades (e.g., cap at 12 monthly columns, or allow arbitrary ranges)?
- Should the Compare From date and comparison view be a report-level saved setting per user, or reset to default (single column, As Of only) each time the report is opened?
- For companies with sub-entities or consolidating structures (if any exist on the platform), does this report need a consolidation toggle, or is that out of scope for all Reports-module features at this stage?
- What is the source of truth for whether a Trial Balance version is 'final' vs. a rough/interim pull — should draft versions be selectable in this report, or hidden until marked final?
# 10. Acceptance Criteria
- Given a company with a stored Trial Balance, selecting the Balance Sheet report displays only balance-sheet-classified accounts, correctly rolled up per the Chart of Accounts hierarchy, as of the selected date, with total assets equal to total liabilities plus equity.
- Given the default (single-column) view, changing the As Of date updates the displayed balances to reflect that date's stored Trial Balance without requiring a Compare From date.
- Given the user enables comparison view and selects a date range and monthly/yearly interval, the report displays one column per period with correct balances for each.
- Given the user selects a prior stored Trial Balance version, the report displays that version's balances, and any drill-down from that report pulls GL detail tied to that same version — never current/live GL data.
- Given a balance sheet line item, clicking it opens a drill-down showing the underlying GL transactions that sum to the displayed balance, for the correct version and period.
- Given a wide, multi-column comparison view, scrolling right keeps the account label column and period header row visible (frozen).
- Given the zero-balance toggle is switched off, accounts with a zero balance for the selected period(s) are hidden from the report without affecting subtotal accuracy.
- Given a user without balance-sheet access permission (e.g., an excluded role) attempts to access the report, access is denied and the attempt is logged.
- Every view, drill-down, and export action against this report writes an entry to the Activity & Audit Log (SY - 0003).

CENTURIUUM
Feature Specification

| Feature ID | QE - 0010 |
|---|---|
| Feature Name | Vendor Concentration |
| Module | QE - Quality of Earnings |
| Status | Draft |
| Related / Recycled IDs | Mirrors QE - 0009 (Customer Concentration) architecture |
| Author | Josh Tonnesen |
| Date | August 15, 2026 |

# 1. Purpose & Business Context
Vendor Concentration surfaces how much of a company's expense base flows to individual vendors, so a buyer or lender can assess supply-chain dependency risk the same way Customer Concentration (QE - 0009) assesses revenue dependency risk. Unlike customer concentration, a raw "all vendors, all expenses" ranking is often noisy and not decision-useful — large companies typically have dozens of small, recurring vendors (utilities, software subscriptions, insurance) that will always rank low individually but say little about true operational risk. The feature therefore needs to let the QoE reviewer view concentration either across all expenses or scoped to a specific account or account rollup (e.g., concentration within COGS, or within a specific subcontractor expense line), since that scoped view is usually the one that actually tells a meaningful story (e.g., "60% of subcontractor spend goes to one vendor").
# 2. User Stories
- As a QoE reviewer (accountant), I want to see vendors ranked by spend, largest to smallest, so that I can identify supplier concentration risk.
- As a QoE reviewer, I want to toggle between an all-expenses view and an account/category-scoped view, so that I can find concentration stories that are actually meaningful rather than diluted across every small recurring vendor.
- As a QoE reviewer, I want the system to flag likely duplicate vendor names (typos, abbreviations, name variants), so that spend isn't artificially split across what is actually a single vendor relationship.
- As a QoE reviewer, I want the system to flag vendors that may be related parties (name similarity to the owner, or vendors that appear in tax return add-backs), so that I know to investigate before treating that spend as a normal arm's-length expense.
- As a QoE reviewer, I want to move across periods, so that I can see whether vendor concentration is trending up, down, or holding steady.
- As a buyer or lender reviewing the deliverable, I want a clear visual (table plus chart) of vendor concentration, so that I can quickly gauge supply-chain risk without digging through the full GL.
# 3. Functional Requirements
- The system shall generate a vendor concentration table from GL transaction detail (DB - 0002), filtered to expense-classified accounts only, aggregated by vendor.
- The system shall rank vendors largest to smallest by total spend for the selected period and view.
- The system shall provide a toggle between two views: (a) "All Expenses" — vendor spend aggregated across all expense accounts, and (b) "By Account/Category" — vendor spend scoped to a single account or rollup node selected ad hoc by the user from the Chart of Accounts hierarchy (DB - 0003/DB - 0006).
- In the By Account/Category view, the system shall allow the user to select any account or any rollup node in the hierarchy (not restricted to a fixed set of pre-defined categories).
- The system shall apply a default materiality threshold (configurable at the firm level) to determine which accounts/categories are surfaced as selectable in the By Account/Category view, so that immaterial accounts do not clutter the selection list; the user shall be able to override the threshold or view unfiltered.
- The system shall display, for the selected view, a ranked table showing vendor name, total spend, percentage of total (of all expenses or of the selected account/category, depending on view), and transaction count.
- The system shall provide at least one chart visualization (e.g., pie or bar) reflecting the same ranked data as the table, updating dynamically with the table.
- The system shall provide a period toggle allowing the user to move across fiscal periods/years, with the table and chart updating to reflect the selected period.
- The system shall run AI-based duplicate vendor name detection, flagging vendor name pairs/groups likely to represent the same underlying vendor (e.g., typos, abbreviations, punctuation variants, DBA name differences).
- The system shall allow the user to confirm or reject a suggested duplicate-vendor grouping; confirmed groupings shall consolidate spend under a single vendor entry in the ranked table going forward.
- The system shall flag vendors as potential related parties using the same detection logic and data sources established in QE - 0009 (name similarity to company owner, cross-reference against tax return add-back vendor names from QE - 0001/QE - 0002).
- The system shall visually distinguish related-party-flagged vendors in both the table and chart views.
- The system shall allow the user to confirm or dismiss a related-party flag; the confirmed/dismissed status shall persist for that vendor within the engagement.
- The system shall recalculate concentration percentages after any user-confirmed vendor consolidation, without altering the underlying GL transaction data.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| GL Transaction Detail (vendor, account, amount, date, memo) | Read | DB - 0002 GL Transaction table |
| Chart of Accounts hierarchy (account/rollup selection for 'By Account' toggle) | Read | DB - 0003, DB - 0006 |
| Vendor Master / Vendor Name field | Read | DB - 0002 (vendor attribute on transaction record) |
| Vendor Name Normalization Map (duplicate/typo vendor groupings, user-confirmed and AI-suggested) | Read/Write | New table - Vendor Concentration module (see Open Questions) |
| Related-Party Flag (vendor-level, reused mechanism from Customer Concentration) | Read/Write | QE - 0009 related-party detection logic/table |
| Owner Name / Tax Return Add-Back Vendor References (signal input for related-party detection) | Read | QE - 0001 Tax Reconciliation, QE - 0002 Tax Return Mapping |
| Materiality Threshold - Vendor Concentration (default %, firm-configurable) | Read | SE - 0001 firm-level settings (new setting, see Open Questions) |
| Period/Date Range Selection | Read | DB - 0002 (transaction date), DR - 0003 (Key Reports version/period) |
| Generation/View Event (account selected, toggle state, period viewed) | Write | SY - 0003 Activity & Audit Log |

# 5. Access & Security
- Roles with access: Accountant/QoE reviewer (full edit — confirm/reject duplicate groupings and related-party flags), Broker (view), Buyer (view, if shared per SE - 0002 permissioning), Bank (view, if shared per SE - 0002 permissioning).
- Roles explicitly excluded: Company/seller users do not have edit access to duplicate-vendor or related-party determinations, as these are QoE reviewer judgment calls; company users may view if explicitly shared.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web only. Vendor-level financial analysis with drill-down and hierarchy selection is not part of the Mobile (light) companion experience.
- Wireframe reference: N/A
Layout mirrors QE - 0009 Customer Concentration: a top toggle bar for All Expenses vs. By Account/Category (with an account/rollup picker appearing when the latter is selected), a period selector, a ranked table (vendor, spend, % of total, transaction count, flags column for duplicate/related-party indicators), and an adjacent chart panel. Vendors pending duplicate-name confirmation appear with a subtle indicator and an inline "merge?" action; related-party flags appear as a distinct badge with confirm/dismiss controls. The materiality threshold used to populate the By Account/Category picker list is visible and adjustable from that view.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| QE - 0009 | Related / Shared architecture | Vendor Concentration mirrors the Customer Concentration UI pattern (ranked table, charts, period toggle) and reuses its related-party detection logic and duplicate-name-matching approach as the baseline model. |
| DB - 0002 | Depends on | GL transaction detail (vendor, account, amount, date) is the sole data source for both the All Expenses view and the By Account/Category view. |
| DB - 0003 / DB - 0006 | Depends on | Chart of Accounts hierarchy is what the user browses/selects from in the By Account/Category toggle to scope concentration to a specific account or rollup node. |
| QE - 0001 / QE - 0002 | Depends on | Tax return add-back vendor names are one of the signals feeding related-party flagging, alongside name-similarity to the owner. |
| SE - 0001 | Depends on | Firm-level settings is the expected home for the configurable materiality threshold default; needs to be added as a new setting if not already present. |
| DB - 0005 | Related | Reuses the same Pass/Minor/Material materiality-threshold pattern established for GL validations, applied here to account/category inclusion rather than variance flagging. |
| SY - 0001 | Depends on | AI metering must account for AI-driven duplicate-vendor-name detection and related-party flagging calls generated by this feature. |
| QE - 0013 | Blocks | Workbook Export will need to include the Vendor Concentration tab (table + selected view state) as part of the full QoE export. |
| QE - 0014 | Blocks | PowerPoint Creator will need to be able to pull the vendor concentration table/chart into a generated slide. |

# 8. Out of Scope / Deferred
- Customer concentration analysis — owned by QE - 0009.
- AP Aging Analysis (open vendor balances/aging) — owned by QE - 0012; this feature covers historical spend concentration only, not outstanding payables.
- Automated narrative commentary generation on vendor concentration risk — may be consumed as a scoped input by a future Risk and Opportunities-style feature, but this feature only produces the underlying data/visuals.
- Formal vendor master data management (tax ID, contact info, 1099 status) — out of scope; this feature only groups vendor name strings appearing on GL transactions.
# 9. Open Questions
- The Vendor Name Normalization Map (confirmed duplicate groupings) is not yet represented in the existing DB module table blocks — confirm whether this lives as a new DB table (parallel to any similar table QE - 0009 introduced for customer name normalization) or is scoped locally to this feature.
- Confirm whether the default materiality threshold for the By Account/Category picker should be the same default value/mechanism as DB - 0005's validation threshold, or an independently configurable setting.
- Confirm whether AI service selection and data handling for duplicate-vendor detection should be resolved alongside the same open AI service/data-handling question already logged for DB - 0007 (COA Suggestions) and QE - 0009, since all three process potentially sensitive financial/vendor data through an AI service.
- Should a confirmed duplicate-vendor grouping or a confirmed/dismissed related-party flag carry forward automatically if the GL data is re-pulled (new version per the versioning convention), the way COA hierarchy edits carry forward in DB - 0006? This needs to be resolved consistently with however QE - 0009 answers the same question for customers.
# 10. Acceptance Criteria
- Given expense transactions in the GL, the vendor concentration table correctly ranks vendors largest to smallest by total spend for the selected period.
- Toggling between All Expenses and By Account/Category correctly re-scopes the table and chart to only the transactions within the selected account or rollup node.
- The By Account/Category picker only surfaces accounts/categories above the configured materiality threshold by default, and an override control reveals the full unfiltered list.
- The system correctly flags at least one plausible duplicate-vendor grouping in a test dataset containing a known typo/name-variant pair, and consolidating that grouping updates the ranked table and percentages accordingly without altering underlying GL amounts.
- The system correctly flags a vendor whose name closely matches the company owner's name, and correctly flags a vendor appearing in tax return add-back data, using the same mechanism validated for QE - 0009.
- Moving the period toggle updates the table and chart to reflect only transactions in the newly selected period, with no residual data from the prior period.

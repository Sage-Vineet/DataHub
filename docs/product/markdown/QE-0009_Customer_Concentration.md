CENTURIUUM
Feature Specification

| Feature ID | QE - 0009 |
|---|---|
| Feature Name | Customer Concentration |
| Module | QE - Quality of Earnings |
| Status | Draft |
| Related / Recycled IDs | Mirrors QE - 0010 (Vendor Concentration); consumed qualitatively by CM - 0005 (Teaser / Blind Profile) |
| Author | Josh Tonnesen |
| Date | August 15, 2026 |

# 1. Purpose & Business Context
Customer concentration is one of the most heavily scrutinized risk factors in a business sale — buyers and lenders discount value or decline to finance a deal when revenue depends heavily on a small number of customers. This feature calculates customer-level revenue concentration from GL sales transactions, presents it in ranked tabular and visual form across multiple periods, and helps the QoE reviewer surface two common sources of understated concentration: (1) the same customer recorded inconsistently under similar or misspelled names in the GL, and (2) sales to entities related to the business owner that should be disclosed and analyzed as related-party revenue. The output gives the reviewer, broker, and buyer a defensible, cross-period view of how dependent the business is on its top customers.
# 2. User Stories
- As a QoE reviewer/accountant, I want to see customer concentration ranked largest-to-smallest across multiple periods, so that I can assess and comment on revenue risk in the QoE narrative.
- As a QoE reviewer, I want the system to flag likely duplicate customer names, so that I don't understate concentration due to typos or inconsistent naming in the GL.
- As a QoE reviewer, I want the system to flag customers whose name resembles the business owner's name, so that I can investigate and disclose potential related-party revenue.
- As a broker or buyer, I want to view a visual summary of customer concentration, so that I can quickly gauge revenue risk without reading raw GL detail.
- As a QoE reviewer, I want to upload supplemental customer data when the GL is missing customer tags, so that the concentration analysis isn't distorted by data gaps.
# 3. Functional Requirements
- The system shall generate a customer concentration table sourced from GL sales transactions, filtered to revenue accounts, grouped by customer.
- The system shall rank customers by total sales, largest to smallest, for each selectable period.
- The system shall display, per customer: total sales for the period, % of total revenue, and rank.
- The system shall group any sales transaction lacking a customer identifier into an "Unidentified / Other" bucket, displayed separately in the table.
- The system shall allow the user to upload supplemental customer-level sales data to fill gaps where GL customer tagging is incomplete; supplemental data shall be tagged as user-supplied in the underlying record and visually distinguished wherever it is blended into the table or charts.
- The system shall provide a time-period toggle supporting a multi-period trend view (e.g., FY22, FY23, FY24, TTM) showing concentration per customer side-by-side or as a trend line across periods.
- The system shall run an AI-based fuzzy name-matching process to identify likely duplicate customer names (e.g., typos, punctuation or abbreviation variants) and present suggested merges in a review queue.
- The system shall NOT auto-apply suggested customer merges; a user must explicitly approve each suggested merge before it affects the concentration table or charts.
- The system shall allow the user to reject a suggested merge, in which case the customers remain separate in the table.
- Once a merge is approved, the system shall combine the merged customers' sales for concentration calculation and display, while retaining the ability to view the original unmerged detail.
- The system shall run an AI-based fuzzy name-matching process comparing customer names against the business owner's name as captured in tax return add-back data (QE - 0001), and flag any customer name with a high similarity score as a potential related party.
- The system shall present flagged potential related-party customers in a review queue distinct from the duplicate-merge queue, requiring user acknowledgment or dismissal rather than a merge action.
- The system shall display top-customer concentration via, at minimum: a ranked table, a bar or pie chart of the top N customers, and a trend view across periods.
- The system shall allow the user to configure the "top N" customers shown in the chart (e.g., top 5, top 10, top 20), independent of the full customer count shown in the underlying table.
- The system shall calculate and display standard concentration summary metrics: % of revenue from the top 1, top 5, and top 10 customers.
- The system shall support export of the customer concentration table and charts through the Workbook Export (QE - 0013) and PowerPoint Creator (QE - 0014) features.
- The system shall recalculate concentration automatically whenever underlying GL data is re-pulled as a new version; historical concentration views built on prior GL versions shall remain viewable.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| GL sales transaction detail (customer-tagged) | Read | DB module GL transaction table (transaction-level detail, DB - 0007 / DB - 0009 pull scope) |
| Customer master / name list | Read | Derived from GL customer field |
| Approved customer merge mapping | Read / Write | New QE - 0009 mapping table; carries forward on new GL pulls by name match, consistent with DB - 0006 firm-scoped carry-forward pattern |
| Related-party flag dispositions (acknowledged/dismissed) | Read / Write | New QE - 0009 tracking table |
| Owner name / tax return add-back data | Read | QE - 0001 Tax Reconciliation |
| Supplemental user-uploaded customer sales data | Write / Read | New upload object scoped to this feature; tagged as user-supplied |
| Revenue account mapping (which GL accounts are "sales") | Read | DB - 0003 Chart of Accounts hierarchy configuration |
| Period definitions (FY / TTM boundaries) | Read | RP - 0001 Reports module period configuration |

# 5. Access & Security
- Roles with access: Accountant/QoE reviewer (full edit — approve/reject merges, review related-party flags, upload supplemental data), Broker (view), Buyer (view, once deal stage permits).
- Company: view access is off by default and enabled per deal at the broker's discretion (open question — see Section 9).
- Roles explicitly excluded: Bank, until the deal reaches underwriting stage.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web only.
- Wireframe reference: N/A.
Primary view is a sortable, ranked customer table with a period-toggle control above it (single-period or multi-period trend mode). A top-N chart module (bar or pie, user-configurable N) sits alongside or below the table. Two separate review queues — duplicate-merge suggestions and related-party flags — are accessible from a tab or side panel on the same screen, each showing pending items with side-by-side name comparison and an approve/reject (merges) or acknowledge/dismiss (related-party) action.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| QE - 0001 | Depends on | Source of owner name / tax return add-back data for related-party matching |
| DB - 0003 | Depends on | Chart of Accounts hierarchy used to identify revenue accounts |
| DB - 0006 / DB - 0007 | Depends on | GL transaction data and firm-scoped carry-forward pattern for merge mappings |
| RP - 0001 | Depends on | Period definitions (FY / TTM boundaries) driving the time-period toggle |
| QE - 0013 | Blocks | Workbook Export must support pulling this table/chart in |
| QE - 0014 | Blocks | PowerPoint Creator must support pulling this table/chart in |
| QE - 0010 | Related | Mirror feature on the vendor/expense side; not a build dependency |
| Notifications Hub (cross-cutting gap) | Depends on | If pending merge/flag review items should trigger user notification — see Open Questions |

# 8. Out of Scope / Deferred
- Vendor/expense concentration — covered separately in QE - 0010.
- Related-party detection against a broader insider or related-entity list beyond the owner's name — deferred; only owner-name matching is in scope for this version.
- Automated correction or cleansing of GL customer tagging beyond presenting fuzzy-match merge suggestions.
- Generation of the qualitative customer-mix narrative for CIM/Teaser documents — this feature is a data source consumed by CM - 0001 and CM - 0005, not a narrative generator.
# 9. Open Questions
- Should outstanding merge-review or related-party-flag items feed the Executive Summary/Tracker (QE - 0005) as an open task?
- Should new merge suggestions or related-party flags trigger a Notifications Hub alert? (Notifications Hub is a cross-cutting gap without its own feature ID yet.)
- What confidence threshold should govern fuzzy-name-match suggestions, and should it be user-configurable per engagement?
- Does supplemental uploaded customer data need its own review/approval step before blending into the table, similar to the merge-approval flow?
- Should Company-role visibility default to hidden per deal, requiring an explicit broker toggle, consistent with the buyer-identity redaction pattern in BR - 0011?
# 10. Acceptance Criteria
- Given GL sales data for a selected period, the concentration table displays all customers ranked largest-to-smallest with % of revenue, and correctly buckets untagged sales into "Unidentified / Other."
- Given a change to the period toggle, the table and charts update to reflect the newly selected single period or multi-period trend view.
- Given the AI fuzzy-match process flags two customer names as likely duplicates, the merge does not take effect until the user explicitly approves it in the review queue.
- Given the user approves a merge, the concentration table reflects combined totals, and the original unmerged detail remains viewable.
- Given a customer name closely matches the owner's name from QE - 0001, the system flags it in the related-party review queue.
- Given the user uploads supplemental customer sales data, the system incorporates it into the concentration view and visibly distinguishes it as user-supplied.
- Given a new GL version is pulled, prior approved merges carry forward by customer name match, and historical period views remain accessible.
- The top-N chart and summary concentration metrics (top 1/5/10 % of revenue) are exportable via QE - 0013 and QE - 0014.

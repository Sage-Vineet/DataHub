CENTURIUUM
Feature Specification

| Feature ID | QE - 0004 |
|---|---|
| Feature Name | SDE / EBITDA Tab |
| Module | QE - Quality of Earnings |
| Status | Draft |
| Related / Recycled IDs | Related to QE-0001 (Tax Reconciliation), QE-0002 (Full Tax Return Mapping); structurally similar (not recycled) to the forthcoming CIM/SIM Builder Adjusted EBITDA build under Module CM |
| Author | Josh Tonnesen |
| Date | August 15, 2026 |

1. Purpose & Business Context
The SDE/EBITDA Tab allows a QoE preparer to build a defensible Seller's Discretionary Earnings (SDE) or Adjusted EBITDA bridge for the company, starting from net income and layering standardized EBIT add-backs and deal-specific discretionary add-backs on top. This bridge is the analytical backbone of the engagement: brokers, buyers, and lenders rely on its output directly in valuation and negotiation, so every line must be traceable back to source GL data, tax return data, or documented management representations.
This feature covers the QoE-side build only. A structurally similar Adjusted EBITDA/SDE calculation exists separately in the broker-facing CIM/SIM Builder (Module CM); the two are intentionally independent because a broker and a QoE provider may support, reject, or size add-backs differently on the same deal. See Out of Scope.
2. User Stories
- As a QoE preparer (accountant), I want to build an EBITDA/SDE bridge starting from net income sourced from either company financials or tax returns, so that I can support the appropriate metric for the size and complexity of the deal.
- As a QoE preparer, I want standardized EBIT add-backs (interest, income taxes, depreciation, amortization) pulled automatically from the GL, so that I don't have to manually locate and total them on every engagement.
- As a QoE preparer, I want to add discretionary add-backs linked directly to GL accounts, vendors, or manual/recast entries, so that every adjustment is traceable back to source data.
- As a QoE preparer, I want add-back support to link back to relevant Q&A entries, so that the rationale for each adjustment is documented and defensible.
- As a QoE preparer, I want to toggle between annual and monthly views across selectable years, so that I can present the bridge at whatever level of granularity the deal calls for.
- As a broker or buyer, I want to view the finalized Adjusted EBITDA/SDE bridge with supporting commentary, so that I understand how the reported earnings figure was derived.
- As a company profile owner, I want the system to apply the correct SDE-vs-Adjusted-EBITDA convention automatically based on my company setup, so that I don't have to configure it per tab.
3. Functional Requirements
1. The system shall provide a data source toggle at the top of the tab, allowing the user to select either “Company Financials” or “Tax Return” as the source for the entire tab.
2. Switching the data source toggle shall recalculate all rows on the tab using the newly selected source; the two data sets shall never be mixed within a single view.
3. When “Tax Return” is selected, the system shall source net income and all applicable line items from the Tax Return data table established in QE-0001.
4. The system shall retain each add-back record independently of the toggle state and shall apply source-appropriate account mapping so an add-back entered under one data source is not lost when the user toggles to the other (see Open Questions for translation logic).
5. The system shall default to “Company Financials” as the data source when the tab is first opened.
6. The system shall calculate and display a “Reported EBITDA” subtotal as: Net Income + Interest Expense − Interest Income + Depreciation Expense + Amortization Expense + Income Tax Expense.
7. The system shall pull Interest Income, Interest Expense, and Income Tax Expense from predefined, mapped GL account groupings.
8. The system shall identify Depreciation Expense and Amortization Expense using a centralized account-level flag maintained at the Chart of Accounts / data ingestion layer, shared with QE-0001 Tax Reconciliation.
9. The system shall display each EBIT add-back (Interest Income, Interest Expense, Depreciation, Amortization, Income Taxes) as its own line item, never pre-aggregated.
10. The system shall display a second subtotal section below Reported EBITDA, labeled “Add-Backs,” listing all discretionary/normalizing adjustments.
11. The system shall display a final bottom-line row labeled “Adjusted EBITDA” or “SDE” according to the metric convention configured in the Company Profile (CP-0001).
12. The system shall apply an Owner Compensation add-back rule that differs only by convention: “Adjusted EBITDA” adds back owner compensation net of one market-rate replacement salary; “SDE” adds back full owner compensation with no market-rate replacement. This shall be the only structural difference between the two calculations.
13. The system shall calculate and display an “Adjusted EBITDA/SDE Margin” as Adjusted EBITDA (or SDE) divided by Revenue.
14. The system shall allow the user to include or exclude individual fiscal years/periods as displayed columns via a selection control, not a continuous date-range picker.
15. The system shall allow the user to toggle column aggregation between Annual and Monthly views.
16. The system shall default to Annual columns for all fiscal years available in the ingested data.
17. The system shall provide an “Add New Add-Back” action that launches a guided wizard.
18. The wizard shall require the user to select an add-back type before proceeding: PNL Account/Vendor, Balance Sheet Change, Manual Adjustment, or Recast (post-close normalization).
19. For PNL Account/Vendor add-backs, the system shall require selection of the specific GL account (and vendor-level detail, if applicable) and shall pull the dollar amount directly from the GL; this amount shall not be manually overridden under any circumstance.
20. For Manual Adjustment add-backs, the system shall allow a free-form dollar amount and shall require a written explanation before the add-back can be saved.
21. For Recast add-backs, the system shall allow the user to select an existing PNL account and enter a normalized post-close value, and shall calculate the add-back as the delta between the normalized value and the actual GL value.
22. The system shall allow the user to specify, per add-back, whether the amount is entered at GL/monthly account-level detail or as a single smoothed amount applied evenly across all displayed periods.
23. The system shall support sub-account-level add-backs (e.g., “Officer Health Insurance” as a subset of a broader “Health Insurance” GL account) by allowing a manually entered partial dollar amount tied to the parent GL account, with a required supporting note.
24. The system shall persist every add-back as a record in a shared, cross-module Add-Back Library, tagged to the company/deal, so it can be referenced by the CIM/SIM Builder Adjusted EBITDA build and the future Projection Model.
25. Each stored add-back record shall retain, at minimum: add-back type, linked GL account(s)/vendor(s), amount(s) by period, supporting notes, and any linked Q&A reference(s).
26. The system shall allow the user to group multiple add-back line items under a user-defined subtotal/category header (e.g., “Owner-Related Add-Backs”) to manage visual density.
27. The system shall allow grouped add-back categories to be collapsed or expanded without loss of underlying account-level detail.
28. The system shall display a Commentary/Notes field adjacent to every bridge line item (EBIT add-backs and discretionary add-backs alike).
29. The system shall pre-populate a standard, non-deal-specific default note for each EBIT add-back line, explaining the general accounting rationale for the adjustment (e.g., why interest income is added back); the user shall be able to edit this default text per deal.
30. The system shall pre-populate the Net Income line's note with “Sourced from Company Financials” or “Sourced from Tax Return” based on the active data source toggle.
31. The system shall allow the user to manually enter or edit commentary on any add-back line.
32. When tax-return-sourced owner compensation data is available, the system shall auto-populate a suggested Owner Compensation add-back drawn from the tax return.
33. The system shall check whether the tax-return-sourced owner compensation figure also appears as an identifiable line item within the company financials/GL, and shall visually flag any discrepancy between the two for user review.
34. The system shall allow the user to upload supporting documents (e.g., W-2s) directly against an add-back record.
35. Supporting documents uploaded against an add-back shall also be stored in and accessible from the Data Room, tagged to the source deal.
36. When the ingested Tax Return document is available, the system shall auto-attach it as supporting documentation for tax-return-sourced add-backs (e.g., owner compensation).
37. The system shall allow the user to link an add-back record to one or more existing Q&A entries using the structured citation architecture defined in QA-0002, displaying the linked Q&A reference number (e.g., “Q&A #25”) inline with the add-back.
38. The system shall allow the user to request an auto-generated suggested commentary draft for an add-back, based on its linked Q&A content; this suggestion shall always be presented as an editable draft requiring explicit user review and confirmation before being saved — the system shall never auto-post or auto-finalize commentary without human confirmation, consistent with the platform's human-authored Q&A rule.
4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Net Income (Company Financials) | Read | GL / Trial Balance (DB-0005 validated financial data) |
| Net Income (Tax Return) | Read | Tax Return data table (QE-0001 Tax Reconciliation) |
| Interest Income / Interest Expense / Income Tax Expense | Read | GL Chart of Accounts, mapped account groupings (DB-0003 COA) |
| Depreciation Expense / Amortization Expense flag | Read | Centralized D&A account-level flag on COA (DB-0003 / DB-0006 – flag to be added, see Open Questions) |
| Add-Back records (type, linked account(s), amount(s) by period, notes) | Read/Write | Shared Add-Back Library table – new DB feature, not yet specced (see Open Questions) |
| Owner Compensation (Tax Return-sourced) | Read | Tax Return data table (QE-0001 / QE-0002) |
| Supporting documents (e.g., W-2s, tax return) | Write | Data Room, tagged to deal (DR module) |
| Linked Q&A reference(s) and citation tag | Read | QA-0002 structured tagging / citation architecture |
| SDE vs. Adjusted EBITDA metric convention | Read | Company Profile settings (CP-0001) |
| Revenue (for margin calculation) | Read | GL / Reports module (RP-0001) |

5. Access & Security
- Roles with access: Accountant / QoE Preparer (full edit – build bridge, manage add-backs, upload supporting documents); Broker (view, and edit if separately granted preparer-level access); Buyer (view, subject to deal stage and grant); Company (view, subject to grant).
- Roles explicitly excluded: Bank (excluded until the deal reaches underwriting stage, per platform convention).
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
- GL-linked add-back amounts (PNL Account/Vendor type) are locked with no manual override at any permission level; only Manual Adjustment and Recast add-back types accept user-entered dollar figures, each with a required note.
6. UI / UX Notes
- Platform: Web only (full analytical build-out; not part of the Web + Mobile (light) companion experience).
- Wireframe reference: N/A
Layout resembles a P&L-style report: fiscal years/periods as columns (user-selectable include/exclude, with an Annual/Monthly aggregation toggle), Net Income as the first row, EBIT add-backs individually listed leading to a Reported EBITDA subtotal, followed by a grouped/collapsible Add-Backs section, and a final Adjusted EBITDA/SDE bottom line with margin. A Commentary/Notes panel runs alongside each row. The “Add New Add-Back” wizard opens as a guided, step-based modal (type selection → account/vendor or manual entry → period allocation → notes/Q&A linking → supporting docs). Data source toggle (Financials/Tax Return) is persistent and prominent at the top of the tab.
7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| QE-0001 Tax Reconciliation | Depends on | Supplies tax return net income and tax-to-financial mapping needed for the data source toggle |
| QE-0002 Full Tax Return Mapping | Depends on | Supplies owner compensation and other tax-return line detail used for auto-populated add-backs |
| DB-0003 / DB-0006 Chart of Accounts | Depends on | Requires a new centralized D&A account-level flag, shared with QE-0001 |
| QA-0002 Q&A Linking to Other Modules | Depends on | Provides the structured tagging/citation architecture used to link add-backs to Q&A entries |
| CP-0001 Company Profile | Depends on | Determines whether the bottom line is SDE or Adjusted EBITDA, and drives the owner compensation add-back rule |
| Data Room (DR module) | Depends on | Supporting documents uploaded on an add-back must also be stored in and retrievable from the Data Room |
| Add-Back Library (new, unspecced) | Depends on | This feature both reads and writes to a shared cross-module Add-Back Library that does not yet have a feature ID |
| Audit trail / activity log (cross-cutting gap) | Depends on | GL-linked add-back amounts are locked with no override; changes to add-back records should be captured in the audit trail |
| CM-XXXX SIM/CIM Builder Adjusted EBITDA (unspecced) | Related, not blocking | Structurally similar calculation, separately owned by the broker-facing CIM/SIM builder; see Out of Scope |

8. Out of Scope / Deferred
- The CIM/SIM Builder's own Adjusted EBITDA/SDE build (Module CM) – structurally similar but a separately owned, separately specced feature reflecting the broker's own support/reject decisions on add-backs.
- Full tax-return line-item-to-COA mapping – owned by QE-0002.
- Consumption of stored Add-Back Library records by the future Projection Model – to be specced when that module is scoped.
- CIM Comparison / variance highlighting against a broker's reported bridge – owned by QE-0008.
- Working capital, customer/vendor concentration, AR/AP aging, and other QoE workbook tabs – each owned by its own feature (QE-0006, QE-0009 through QE-0012).
- Design of the shared Add-Back Library's own schema/ownership as a standalone database feature – flagged as an Open Question below pending its own feature ID.
9. Open Questions
- What is the exact field-level translation logic when a user toggles between Company Financials and Tax Return as the data source for an existing add-back record — which mappings carry forward automatically, and which require the user to re-enter or re-link? This depends on the mapping detail to be finalized in QE-0001/QE-0002.
- The Add-Back Library needs to be formalized as its own database feature/spec (shared schema across QE-0004, the CM builder's Adjusted EBITDA build, and the future Projection Model) – it is not currently represented on the product list and needs a feature ID.
- The centralized Depreciation/Amortization account-level flag needs to be added to the Chart of Accounts – confirm whether this is an amendment to DB-0003 or DB-0006, or its own small spec.
- Should the default standard commentary text for each EBIT add-back be configurable per firm/tenant, or hardcoded platform-wide?
- Should user-defined add-back subtotal/category groupings be fully free-text, or should the system offer a predefined starter list of common categories (e.g., “Owner-Related,” “One-Time,” “Non-Operating”) that users can extend?
10. Acceptance Criteria
- Toggling the data source between Company Financials and Tax Return recalculates all rows correctly and never blends the two data sets.
- The Reported EBITDA subtotal correctly equals Net Income + Interest Expense − Interest Income + Depreciation + Amortization + Income Tax Expense for every displayed period.
- Depreciation and Amortization rows populate correctly using the centralized COA-level flag, with no manual account hunting required.
- The Add-Back Wizard supports all four add-back types (PNL Account/Vendor, Balance Sheet Change, Manual Adjustment, Recast) with correct amount-locking and note requirements enforced per type.
- Add-back records persist to the shared Add-Back Library and are retrievable by company/deal.
- Default commentary is present for every EBIT add-back line and is editable; the Net Income note correctly reflects the active data source.
- Q&A links display the correct reference number inline, and any AI-suggested commentary appears only as an editable draft requiring explicit user confirmation before saving.
- Supporting documents uploaded against an add-back appear in both the add-back record and the Data Room, correctly tagged to the deal.
- Owner compensation auto-populates from the tax return when available, with a visible flag if it does not reconcile to the financials.
- The year include/exclude control and the Annual/Monthly toggle both correctly reshape the displayed columns without altering underlying data.
- The bottom-line label (Adjusted EBITDA vs. SDE), the owner-compensation add-back rule, and the margin calculation all correctly reflect the Company Profile's configured convention.

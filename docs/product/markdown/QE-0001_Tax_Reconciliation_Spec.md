CENTURIUUM
Feature Specification

| Feature ID | QE - 0001 |
|---|---|
| Feature Name | Tax Reconciliation |
| Module | QE - Quality of Earnings |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

1. Purpose & Business Context
Tax Reconciliation provides the bridge between the net income reported on a company's filed tax return and the net income shown in its GL-based financial statements, for the trailing three fiscal years, and is a foundational workpaper underneath the Quality of Earnings module. Tax return net income and financial statement net income virtually never match on their own — permanent and timing book/tax differences (Schedule M-1 items), cash-versus-accrual basis differences, and simple data or classification issues all drive a gap — and a QoE engagement cannot be relied on until that gap is explained. This feature uses the tax return data already captured in the Tax Return Table (DB-0008) and the GL-based financials (DB-0002 / RP-0001) to auto-populate a first-draft reconciliation — matching M-1 items to P&L accounts and testing a fixed set of cash/accrual adjustments against the remaining gap — so the accountant performing the reconciliation starts from a system-generated draft rather than a blank worksheet, reviews and confirms or corrects it, and finalizes it with any additional support from company Q&A.
2. User Stories
- As a QoE accountant, I want the system to auto-populate Schedule M-1 reconciling items against corresponding P&L accounts, so that I don't have to manually trace every M-1 line to its GL account from scratch.
- As a QoE accountant, I want the system to compute a fixed set of candidate cash/accrual basis adjustments directly from balance sheet account changes, so that I can quickly test which combination closes the gap between tax return net income and financial statement net income.
- As a QoE accountant, I want to accept, reject, edit, or manually add any reconciling item, so that I retain full control over the final reconciliation even when the system's suggestions are incomplete or wrong.
- As a QoE accountant, I want officer compensation and book/tax depreciation to always appear as reconciling lines even when zero, so that these commonly-relevant items are never accidentally skipped on an engagement.
- As a company user, I want to receive specific, prepopulated questions when the reconciliation can't be fully closed by the system, so that I can supply the missing explanation without lengthy back-and-forth.
- As a QoE reviewer, I want a summary showing what reconciled cleanly, what was manually resolved, and what remains open, so that I can assess the reliability of the engagement's financial data before relying on it downstream.
3. Functional Requirements
- The system shall create one reconciliation record per fiscal year, for each of the trailing three fiscal years, scoped to a single company/deal.
- The system shall support tax return types Form 1120, Form 1120-S, Form 1065, and Schedule C for v1; other return types are out of scope (see Section 8).
- The system shall pull tax return net/ordinary income for the applicable form type from the Tax Return Table (DB-0008) for each fiscal year in scope.
- The system shall pull GL-based net income for the same period from GL Data / Profit & Loss (DB-0002 / RP-0001), using the unadjusted figure as reported — not the adjusted EBITDA/SDE figure from QE-0004.
- The system shall pull all Schedule M-1 line items present on the loaded tax return from DB-0008 and attempt to match each to a corresponding P&L account using AI-assisted matching.
- For each matched M-1 item, the system shall display an explanatory note (e.g., hover/tooltip) describing the basis for the match, such as “matches the full balance of the charitable contributions account” or “matches half of the travel account (assumed 50% non-deductible meals/entertainment).”
- Matched M-1 items shall be presented as suggestions only; no matched item shall count toward the reconciled total until the accountant explicitly accepts it.
- The system shall always display an officer compensation reconciling line for every reconciliation, populated from the tax return officer compensation field and, where available, payroll data (DR-0007), defaulting to $0 when not applicable.
- The system shall always display a book-versus-tax depreciation reconciling line for every reconciliation, populated from GL depreciation expense and the tax return's reported depreciation figure, defaulting to $0 difference when not applicable.
- The system shall compute a fixed, defined set of candidate cash/accrual basis adjustments for each fiscal year, including at minimum: change in accounts receivable, change in customer deposits/deferred revenue, change in inventory, and change in accounts payable, each calculated as the exact beginning-to-ending balance delta for that account from the Trial Balance (DB-0004) — never as an AI-estimated or approximated value.
- The system shall also stage additional deterministic candidate items commonly relevant to closing a residual gap, including non-taxable income and book-recorded federal/state income tax expense, computed directly from GL data.
- The system shall test combinations of the staged candidate adjustments against the remaining variance (tax return net income less financial net income, after accepted M-1 items) and present the best-fit combination(s) that close the gap within the engagement's configured threshold.
- Each staged candidate adjustment shall be individually toggleable (include/exclude) by the accountant, and shall not count toward the reconciled total until included by the accountant.
- The accountant shall be able to manually add a new reconciling item with a description and amount, and to edit or remove any system-proposed or manually-added item.
- The system shall support an engagement-level configurable reconciliation threshold, expressed as a percentage of adjusted EBITDA/SDE (QE-0004) where that figure is available, falling back to a percentage of tax return net income or a user-entered dollar amount where it is not yet available.
- The system shall display the running total of confirmed reconciling items and the remaining variance in real time as items are accepted, rejected, edited, or added.
- The system shall mark a fiscal year's reconciliation as “Reconciled” when the remaining variance falls within the configured threshold, and as “Open” otherwise.
- When a fiscal year's reconciliation is marked “Open,” the system shall generate prepopulated clarifying questions tied to the specific unexplained account(s) or amount(s) and route them to the Q&A module (QA-0001 / QA-0002) for the company to answer.
- The system shall provide a summary view per fiscal year showing: tax return net income, financial net income, confirmed reconciling items, remaining variance, and reconciliation status.
- The system shall log every manual addition, edit, acceptance, or rejection of a reconciling item to the Activity & Audit Log (SY-0003), capturing user, timestamp, and before/after values.
- The reconciliation page shall be interactive, allowing the assigned QoE accountant to review, adjust, and finalize the reconciliation directly within the module rather than offline.
4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Tax return net/ordinary income | Read | DB - 0008 (Tax Return Table) |
| Schedule M-1 line items | Read | DB - 0008 (Tax Return Table) |
| Officer compensation (tax return) | Read | DB - 0008 (Tax Return Table) |
| Officer compensation (payroll, if available) | Read | DR - 0007 (Payroll System Integrations) |
| Tax return depreciation figure | Read | DB - 0008 (Tax Return Table) |
| GL-based net income | Read | DB - 0002 (GL Data) / RP - 0001 (Profit & Loss) |
| GL depreciation expense | Read | DB - 0002 (GL Data) |
| Beginning/ending balances: AR, AP, inventory, customer deposits/deferred revenue | Read | DB - 0004 (Trial Balance) |
| Adjusted EBITDA/SDE (threshold basis, where available) | Read | QE - 0004 (SDE/EBITDA Tab) |
| Reconciliation record (NI figures, matched/staged items, accepted status, variance, status per year) | Write | New QE - 0001 reconciliation table |
| Engagement-level reconciliation threshold setting | Read/Write | New QE - 0001 engagement settings table |
| Prepopulated clarifying questions | Write | QA - 0001 / QA - 0002 (Q&A Module) |
| Manual edit/audit trail entries | Write | SY - 0003 (Activity & Audit Log) |

5. Access & Security
- Roles with access: QoE Accountant/Preparer (full edit), QoE Reviewer (view, approve/sign-off), Broker (view summary only, per SE-0002 configuration).
- Roles explicitly excluded: Bank and Buyer users have no access to this workpaper unless and until explicitly granted per deal stage under SE-0002; Company/seller users see only the prepopulated clarifying questions routed to them through the Q&A module, not the full reconciliation workpaper, unless broader access is separately granted.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
6. UI/UX Notes
- Platform: Web only. This is a dense analytical workpaper consistent with the platform convention that full analysis workflows are web-only, with mobile limited to lighter status/review actions.
- Wireframe reference: N/A
Interactive grid with a fiscal-year selector across the three years in scope. Tax return net income and financial net income are shown at the top, with matched M-1 items, staged cash/accrual candidates, and manually-added items listed below — each with an include/exclude toggle and a hover/tooltip explanation of the system's matching logic. A running total and remaining variance update live as items are toggled, edited, or added. A status indicator shows Reconciled or Open per year against the configured threshold, and an action surfaces any generated clarifying questions along with their routing status in the Q&A module.
7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DB - 0008 | Depends on | Source of tax return data, including form type, net/ordinary income, M-1 items, officer compensation, and depreciation. |
| DB - 0002 / RP - 0001 | Depends on | Source of GL-based financial net income for the reconciliation. |
| DB - 0004 | Depends on | Source of exact beginning/ending balance sheet account deltas used for cash/accrual candidate adjustments. |
| QE - 0004 | Depends on | Preferred basis for the reconciliation threshold once adjusted EBITDA/SDE is available; see Open Questions for the interim fallback. |
| QA - 0001 / QA - 0002 | Depends on | Routing of system-generated prepopulated clarifying questions to the company for response. |
| QE - 0015 (Q&A Generator — not yet specced) | Related / Coordinate | Broader, more general question-generation engine referenced elsewhere in the product list. QE-0001 generates its own narrowly-scoped reconciliation questions independently for now; the two should be architected so the underlying flag-and-question pattern can be aligned or consumed later rather than duplicated (see Open Questions). |
| SY - 0001 | Depends on | AI-assisted M-1 item matching consumes metered AI usage. |
| SY - 0003 | Depends on | Logs all manual edits to the reconciliation. |
| SE - 0002 | Depends on | Role-based visibility into the reconciliation workpaper. |

8. Out of Scope / Deferred
- Full mapping of the tax return to the company's Chart of Accounts — belongs to QE-0002 (Full Tax Return Mapping), a separate future spec.
- Non-US tax returns (e.g., Canadian returns) — deferred; v1 covers Form 1120, 1120-S, 1065, and Schedule C only.
- Relying solely on the tax return's cash/accrual basis checkbox to determine whether an adjustment is needed — that checkbox is frequently incorrect, so the system tests balance-sheet-derived candidate adjustments against the actual gap regardless of the checkbox value.
- Structured, employee-level parsing of payroll data for officer compensation cross-checks — DR-0007 covers retrieval and static file storage only; structured parsing is a separate future feature.
- The QE-0015 Q&A Generator engine itself — out of scope for this spec; referenced only as a related/coordinating dependency.
9. Open Questions
- What interim threshold basis should apply before adjusted EBITDA/SDE (QE-0004) is available, given that figure is often not finalized until later in the engagement — percentage of tax return net income, a flat dollar default, or something else?
- Should the reconciliation threshold be editable mid-engagement, and if changed, should it retroactively re-flag the status of already-reconciled fiscal years?
- Is the initial fixed set of cash/accrual candidate adjustments (AR, customer deposits/deferred revenue, inventory, AP, non-taxable income, book tax expense) complete for v1, or should additional items (e.g., prepaid expenses, accrued liabilities) be included from the start?
- How should QE-0001's prepopulated clarifying questions ultimately relate to the QE-0015 Q&A Generator once that engine is specced — should they remain a separate feed into the Q&A module, or should QE-0001 become a consumer of the QE-0015 engine?
- For Schedule C returns where an individual has multiple businesses, does isolating the relevant Schedule C fully address the use case, or is a separate aggregation approach required?
10. Acceptance Criteria
- For a company with three fiscal years of GL data and matching tax returns loaded (Form 1120, 1120-S, 1065, or Schedule C), the system generates a reconciliation record per year showing tax return net/ordinary income and GL-based financial net income.
- Officer compensation and book/tax depreciation reconciling lines are present on every generated reconciliation, defaulting to $0 when not applicable.
- The system matches at least the M-1 items present on the loaded tax return to corresponding P&L accounts where a plausible match exists, with each match displaying an explanatory hover note, and no matched item counts toward the reconciled total until accepted.
- Each cash/accrual candidate adjustment shown equals the exact computed balance-sheet delta for its account and period, with no estimated or approximated values.
- The accountant can accept, reject, edit, or manually add any reconciling item, and the running total/variance recalculates immediately.
- When the running variance falls within the engagement's configured threshold, the reconciliation is marked Reconciled; otherwise it is marked Open and prepopulated questions are generated and routed to the Q&A module.
- All manual additions and edits to the reconciliation are captured in the audit log with user, timestamp, and before/after values.
- Access to the reconciliation workpaper respects role-based permissions and deal isolation as defined in Section 5.

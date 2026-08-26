CENTURIUUM
Feature Specification

| Feature ID | QE - 0002 |
|---|---|
| Feature Name | Full Tax Return Mapping |
| Module | QE - Quality of Earnings |
| Status | Draft |
| Related / Recycled IDs | Depends on QE - 0001 (Tax Reconciliation); writes into DB - 0003 / DB - 0006 (COA); reads DB - 0008 (Tax Return Table) |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
Banks and lenders reviewing a Quality of Earnings package want to see where each proposed add-back actually shows up on the company's filed tax return, not just where it lives on the internal P&L. This feature uses AI to map individual Chart of Accounts accounts (as reconciled in DB - 0003 / DB - 0006) to the specific line items on the company's filed tax return (as structured in DB - 0008, covering forms such as 1065, 1120, 1120-S, and Schedule C), so a QoE preparer can trace an add-back from the P&L, through the account, to its resting place on the return.
Tax preparers routinely group, split, or bury book accounts into tax return lines in ways that don't reconcile cleanly one-to-one - a single P&L account may be split across two return lines, several accounts may roll into one "Other deductions" line, or an item may not be separately identifiable on the return at all. This feature is explicitly not expected to fully solve every engagement. Its value is in shrinking the problem: instead of a preparer manually tracing 150 P&L accounts against 40 available tax return lines, the system does the confident mapping automatically and surfaces only the smaller residual set of accounts it could not confidently place, so manual effort concentrates where it's actually needed.
This is a supporting, non-mission-critical capability. It is not required for every engagement, is most valuable on messier deals where tax return support for add-backs is scrutinized (e.g., bank financing), and is explicitly deferred as a nice-to-have relative to the core reconciliation workflow in QE - 0001.
# 2. User Stories
- As a QoE preparer, I want to run an AI-assisted mapping of COA accounts to tax return lines, so that I can support each add-back with a traceable location on the filed return without manually cross-referencing every account by hand.
- As a QoE preparer, I want to see which accounts the system could not confidently map, so that I only need to manually research the smaller unresolved subset rather than the entire chart of accounts.
- As a bank/lender reviewer, I want to see the tax return line associated with a given add-back, so that I can validate the add-back is supportable and traceable to the company's actual filed tax position.
- As a QoE preparer, I want to trigger this mapping manually rather than have it run automatically on every GL load, so that I only incur the AI cost when the analysis is actually needed for a given engagement.
# 3. Functional Requirements
- The system shall allow a user to manually trigger a full tax return mapping analysis for a given company/engagement; the mapping shall not run automatically on GL upload or COA generation.
- The system shall require that a tax return has been loaded into the Tax Return Table (DB - 0008) for the relevant form type before the mapping analysis can be run.
- The system shall use AI to propose a mapping from each individual COA account (DB - 0003 / DB - 0006) to a specific line item on the loaded tax return, at the account level rather than a rolled-up category level.
- The system shall support many-to-many mapping relationships between COA accounts and tax return lines (a single account may map to multiple lines; multiple accounts may map to a single line), reflecting that tax preparers do not consistently map book accounts one-to-one to return lines.
- The system shall assign a confidence level (High / Medium / Low) to each proposed mapping, or explicitly mark an account as Unmapped where no confident association can be made.
- The system shall visually surface all Low-confidence and Unmapped accounts as a distinct, reviewable list, prioritizing a short residual list over forcing a low-confidence guess on every account.
- The system shall allow the user to manually accept, reject, or override any proposed mapping and manually assign a tax return line to an account the system left unmapped.
- The system shall persist the resulting tax return classification and confidence level on the COA account record (DB - 0003 / DB - 0006), leaving this field blank at initial GL data load and populated only once this feature has been run.
- The system shall scope the mapping run at the engagement level, applying a single mapping pass that covers the tax return years/forms loaded for that engagement, rather than requiring a separate manual run per individual tax return year.
- The system shall allow the user to re-run the mapping analysis for an engagement on demand (e.g., after an additional tax return year is loaded or after COA reclassification changes), creating an updated mapping result rather than silently overwriting prior manual overrides without confirmation.
- The system shall log each mapping run (date, triggering user, and a reference to AI usage) for metering purposes consistent with SY - 0004.
- The system shall make the mapped tax return line visible in context wherever an add-back is displayed or referenced downstream (e.g., QE - 0004 SDE/EBITDA Tab), so a reviewer can see the supporting tax return line alongside the add-back itself.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| COA account record (per company, per hierarchy scope) | Read | DB - 0003 / DB - 0006 (Chart of Accounts) |
| Tax return line item catalog (by form type: 1065, 1120, 1120-S, Schedule C) | Read | DB - 0008 (Tax Return Table) |
| Tax return classification (mapped line item reference) | Write | New field on the COA account record in DB - 0003 / DB - 0006 - blank at initial GL load, populated only when this feature is run |
| Mapping confidence level (High / Medium / Low / Unmapped) | Write | Same COA account record, alongside the tax return classification field |
| Mapping run metadata (date run, model/version, engagement-level flag) | Write | New mapping run log associated with the company/engagement |
| Tax reconciliation bridge totals (book-to-tax adjustment categories) | Read | QE - 0001 (Tax Reconciliation) |
| Unmapped account list surfaced for user review | Read | Derived at render time from COA account records with no/low-confidence classification |

# 5. Access & Security
- Roles with access: Accountant / QoE preparer (run mapping, review, override), Broker (view-only, if granted), Bank (view-only, read-only visibility into the resulting tax return line supporting an add-back, once the deal reaches a stage where bank access is appropriate).
- Roles explicitly excluded: Company/Seller users do not trigger or edit this mapping; Buyer does not have access to this feature.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web only.
- Wireframe reference: N/A
Primary view is a two-pane or table layout: mapped accounts (with confidence indicator) on one side, and a clearly separated "needs review" list of Low-confidence/Unmapped accounts on the other, so the preparer's attention goes to the smaller residual set rather than the full COA. A manual override/edit control should sit directly on each mapping row. The "Run Mapping" action should be an explicit, clearly labeled button (not automatic), and should indicate that it consumes metered AI usage before the user confirms.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| QE - 0001 | Depends on | Tax Reconciliation should be complete (or substantially complete) before line-level mapping is attempted; book-to-tax bridge categories inform which accounts are even mappable. |
| DB - 0003 / DB - 0006 | Depends on | Feature reads and writes against the Chart of Accounts structure; the tax return classification field lives on this record. |
| DB - 0008 | Depends on | Tax Return Table supplies the catalog of available line items per form type that the AI maps accounts against. |
| QE - 0004 (SDE/EBITDA Tab) | Blocks (informs) | Add-back-to-tax-line traceability is the primary downstream consumer of this mapping - lets a bank see where an add-back is reflected on the actual return. |
| SY - 0004 (Metered Usage) | Depends on | AI-driven mapping run should be metered consistent with other AI-assisted features, since it is user-triggered and not free to run at scale. |

# 8. Out of Scope / Deferred
- Guaranteeing a complete, fully-reconciled one-to-one mapping for every COA account on every engagement - this is explicitly not expected to be solvable in all cases.
- Automatic mapping on GL upload or COA generation - this is a manual, user-triggered analysis only.
- Building or maintaining the Tax Return Table structure itself - owned by DB - 0008.
- Performing the book-to-tax bridge/reconciliation calculation itself - owned by QE - 0001.
- Support for tax return form types beyond those defined in DB - 0008 at the time this feature is built.
# 9. Open Questions
- Should re-running the mapping after a manual override exists prompt the user before overwriting prior overrides, or always preserve manual overrides by default and only re-propose for still-unmapped accounts?
- What AI service/model will be used for this mapping, and does it follow the same data-handling decision to be made for DB - 0007 (COA Suggestions), or does it warrant its own evaluation given it also processes tax return data?
- Should there be a minimum confidence threshold below which the system does not even attempt to display a proposed mapping (i.e., goes straight to Unmapped rather than showing a low-confidence guess)?
- Does this feature warrant its own line item in SY - 0004 metered usage (distinct per-run cost), or roll into a general AI-metering bucket?
# 10. Acceptance Criteria
- A user with Accountant/QoE preparer access can manually trigger a tax return mapping run for an engagement with a loaded tax return, and the system does not run this automatically at any other point.
- The system produces an account-level (not category-level) proposed mapping from COA accounts to tax return lines, supporting many-to-many relationships where applicable.
- Each proposed mapping displays a confidence level, and accounts the system could not confidently map are clearly separated into a distinct review list rather than mixed in with confident mappings.
- A user can manually accept, override, or assign a mapping, and that result persists on the COA account record.
- The mapped tax return line and its confidence level are visible in context wherever an add-back is shown downstream (e.g., in QE - 0004).
- Bank-role users, once granted deal access, can view the resulting tax return line for an add-back but cannot trigger or edit the mapping.
- Running the mapping generates a logged, meterable usage event consistent with SY - 0004.

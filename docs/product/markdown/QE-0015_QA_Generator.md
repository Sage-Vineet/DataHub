CENTURIUUM
Feature Specification

| Feature ID | QE - 0015 |
|---|---|
| Feature Name | Q&A Generator |
| Module | QE - Quality of Earnings |
| Status | Draft |
| Related / Recycled IDs | Depends on RP-0001 (P&L), RP-0002 (Balance Sheet), DB-0002 (GL Data), QE-0004 (SDE/EBITDA Tab), QA-0001/QA-0002 (Q&A Module) |
| Author | Josh Tonnesen |
| Date | August 15, 2026 |

# 1. Purpose & Business Context
During initial QoE review, the accountant must identify which account-level changes in the company's financials are significant enough to warrant a business explanation from the company, and turn those into a structured set of questions. Today this scan is done manually against the P&L and Balance Sheet, account by account and period by period, which is slow and inconsistent across reviewers. This feature automatically scans account activity against configurable materiality thresholds, generates draft questions phrased to elicit an operational (not just financial) explanation of the change, and lets the reviewer edit and publish them into the Q&A module — with the underlying P&L/Balance Sheet display itself remaining the responsibility of RP-0001 and RP-0002.
# 2. User Stories
- As a QoE reviewer (accountant), I want the system to generate a first-pass list of material account changes as questions, so that I can get through initial review faster and not miss a significant variance.
- As a QoE reviewer, I want to edit the wording of a generated question before publishing it, so that the question reads naturally and reflects my judgment.
- As a QoE reviewer, I want to set the materiality thresholds for a deal, so that question volume matches the size and complexity of the business.
- As a QoE reviewer, I want obvious offsetting reclassifications to be suppressed automatically, so that I'm not asked to explain something that isn't a real business question.
- As a QoE reviewer, I want to export the generated question list to Excel, so that I can work with it outside the platform if needed.
- As a company user, I want to see and answer published questions in the Q&A module, so that I can provide the context the reviewer needs.
# 3. Functional Requirements
Materiality Settings
- The system shall allow the user to set a deal-level $ materiality threshold, pre-filled with a default of 1% of expected SDE/EBITDA (from QE-0004) when that value is available.
- The system shall allow the user to set a deal-level % materiality threshold, pre-filled with a default of 5% of the account's prior-period balance.
- If expected SDE/EBITDA is not yet available from QE-0004, the system shall prompt the user to enter a $ materiality threshold manually before generating any questions, and shall not generate questions using a zero or blank threshold.
- The system shall allow the user to edit either threshold at any time; changed thresholds shall apply to the next question-generation run and shall not retroactively alter previously generated or published questions.
Question Generation — P&L
- The system shall generate P&L questions only on an annual, full-year basis (not partial/interim periods).
- For each P&L account, the system shall compare account totals across the selected annual review periods.
- The system shall flag an account for a question if the change between periods meets or exceeds both the $ materiality threshold and the % materiality threshold.
- The system shall support comparison across more than two periods within a single generated question when relevant (e.g., a 3-year trend).
- The system shall analyze whether an account behaves as fixed or variable relative to revenue (e.g., rent vs. direct labor) and shall phrase the question as a percentage-of-sales change instead of, or in addition to, a dollar/percent change when that framing is more meaningful.
- The system shall phrase each question to elicit an operational explanation of the underlying business change, not solely a financial description of the variance.
- Where vendor- or customer-level detail is available for an account, the system shall identify the largest contributing vendor(s)/customer(s) to a flagged variance and shall reference them by name in the question text.
- Every generated question shall retain a reference to its source account(s), including account name/number, so the reviewer can trace the question back to its underlying data.
- The system shall detect likely offsetting reclassifications, defined as two or more accounts within the same account grouping (per DB-0003/DB-0006 COA hierarchy) whose changes in the same period substantially net to zero within a configurable tolerance, and shall suppress the auto-generated question for those accounts, flagging the suppression as a system decision the reviewer can override.
- The system shall flag unnatural balances on the P&L (e.g., a negative expense account) as a question candidate, unless the account is already suppressed as a detected reclass.
Question Generation — Balance Sheet
- The system shall apply the same $ and % materiality comparison logic to Balance Sheet accounts across annual periods.
- The system shall flag unnatural balances on the Balance Sheet (e.g., a negative balance in an account that should not carry a negative balance, such as a credit card asset) as a question candidate.
- The system shall generate a check confirming that retained earnings rolls forward correctly (beginning retained earnings + net income − distributions = ending retained earnings) for each annual period, and shall generate a question automatically if the roll-forward does not tie out.
Review, Edit, Publish
- The system shall display all system-generated questions for the current review period(s) in a column adjacent to the P&L (or Balance Sheet) display, without altering how RP-0001/RP-0002 render the underlying report.
- The system shall allow the reviewer to edit the text of any generated question prior to publishing.
- The system shall allow the reviewer to delete/discard a generated question without publishing it.
- The system shall allow the reviewer to manually re-include a suppressed (auto-reclass) question if they disagree with the suppression.
- The system shall allow the reviewer to publish an edited or unedited question directly into the Q&A module (per QA-0001/QA-0002 structure and tagging), preserving the account reference as the citation tag.
- The system shall allow the reviewer to export the full list of generated questions (published or not) to Excel.
- The system shall retain a record of which questions were generated, edited, discarded, suppressed, or published, and by whom.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| GL account balances by period (P&L) | Read | DB-0002 GL Data, via RP-0001 Profit & Loss |
| GL account balances by period (Balance Sheet) | Read | DB-0002 GL Data, via RP-0002 Balance Sheet |
| Chart of Accounts hierarchy / account groupings | Read | DB-0003 COA, DB-0006 Configurable COA |
| Customer/vendor-level transaction detail within an account | Read | DB-0002 GL Data (vendor/customer drill-down, per RP-0001) |
| Expected SDE/EBITDA value | Read | QE-0004 SDE/EBITDA Tab |
| Materiality settings ($ threshold, % threshold) | Read/Write | New: QE-0015 Materiality Settings table, deal-scoped |
| Generated question records (account ref, period(s), variance amount, variance %, question text, status) | Read/Write | New: QE-0015 Generated Questions table |
| Published question record | Write | QA-0001/QA-0002 Q&A Module (structured tagging, Module/Section/Account taxonomy) |
| Reclass-offset suppression flags | Read/Write | New: QE-0015 Generated Questions table (suppressed = true/reason) |
| Retained earnings roll-forward check result | Read | DB-0004 Trial Balance / Balance Sheet retained earnings activity |

# 5. Access & Security
- Roles with access: Accountant/QoE reviewer (generate, edit, publish questions); Broker (view-only, if granted per deal access settings).
- Roles explicitly excluded: Bank, Buyer — no access to question generation or unpublished questions; Company sees only published questions via the Q&A module, not the underlying generation logic or discarded/suppressed questions.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web only.
- Wireframe reference: N/A
The P&L (or Balance Sheet) is displayed per its own report spec (RP-0001/RP-0002), toggled by review period as already supported there. A checkbox/toggle at the top of the report (e.g., "Show Analysis" or "Analyze for Questions") triggers this feature's question generation panel. When enabled, a column to the right of the report populates with the system-generated questions for the currently toggled period(s), each showing the account reference, variance amount/percentage, and editable question text. Reviewers can edit inline, discard, or publish each question individually, or in bulk. An Excel export action and a per-question 'publish to Q&A' action are both available from this panel.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| RP-0001 Profit & Loss | Depends on | QE-0015 reads from and is displayed alongside the P&L; QE-0015 does not own the P&L layout itself. |
| RP-0002 Balance Sheet | Depends on | Same relationship as RP-0001, applied to the Balance Sheet variant of this feature. |
| DB-0002 GL Data | Depends on | Source of account balances and vendor/customer-level detail used for question generation and drill-in. |
| DB-0003 / DB-0006 COA | Depends on | Account groupings and hierarchy used to identify related/offsetting accounts for reclass suppression. |
| QE-0004 SDE/EBITDA Tab | Depends on | Source of expected SDE/EBITDA used to calculate the default $ materiality threshold. |
| QA-0001 / QA-0002 Q&A Module | Depends on | Published questions become standard Q&A items, inheriting structured tagging and citation traceability rules already defined in QA-0002. |
| Notifications Hub (cross-cutting gap) | Depends on | Company should be notified when new questions are published to Q&A; no dedicated notification feature exists yet. |
| QE-0013 Workbook Export | Related | Excel export of generated questions should align with the broader QoE workbook export mechanism where practical. |

# 8. Out of Scope / Deferred
- The layout, filtering, and toggling of the P&L and Balance Sheet themselves — owned by RP-0001 and RP-0002 respectively; this spec only covers the question-generation logic and its adjacent UI panel.
- Company-side answer authoring and citation/traceability mechanics — owned by QA-0001/QA-0002; this feature only publishes questions into that structure.
- Interim/partial-period (monthly/quarterly) question generation — v1 is annual-only; may be considered in a future revision.
- Vendor/customer-level drill-down data itself is not created here — it is consumed from DB-0002/RP-0001; any gaps in that underlying data are out of scope for this spec.
- Notification to the company when new questions are published — depends on the Notifications Hub cross-cutting gap, not yet specced.
# 9. Open Questions
- What tolerance (in $ and/or %) should define an "offsetting" reclass for auto-suppression purposes, and should this tolerance be user-configurable per deal?
- Should the retained earnings roll-forward check apply only at the annual level, or also whenever the Balance Sheet is toggled to a partial period?
- For accounts identified as variable-vs-revenue (e.g., percentage-of-sales framing), what specific logic/threshold determines whether an account is treated as fixed or variable — is this AI-inferred per account per deal, or based on a standard account-type mapping maintained centrally?
- Should discarded (not published, not suppressed) questions be visible to anyone besides the reviewer who discarded them, e.g., for QA/review purposes on the engagement?
- Should there be a limit on how many vendors/customers are cited by name within a single question when several contribute to a flagged variance?
# 10. Acceptance Criteria
- Given a deal with an expected SDE/EBITDA value populated in QE-0004, when the reviewer enables "Show Analysis" on the P&L, the system generates questions using default thresholds of 1% of SDE/EBITDA and 5% of account balance without further input.
- Given a deal with no expected SDE/EBITDA value yet populated, when the reviewer enables "Show Analysis," the system prompts for a manual $ threshold and does not generate questions until one is provided.
- Given two accounts in the same COA grouping whose period-over-period changes offset within tolerance, the system does not generate a question for either account and marks them as suppressed.
- Given a Balance Sheet account with a balance sign contrary to its normal nature, the system generates an unnatural-balance question for that account.
- Given an annual period where beginning retained earnings + net income − distributions does not equal ending retained earnings, the system generates a retained-earnings roll-forward question.
- The reviewer can edit, discard, and publish any generated question, and the resulting state (edited/discarded/published) is retained and auditable.
- Published questions appear in the Q&A module with the correct account-level citation tag.
- The reviewer can export the full current list of generated questions to Excel.

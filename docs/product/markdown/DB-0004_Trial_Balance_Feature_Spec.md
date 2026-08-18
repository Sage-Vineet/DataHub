CENTURIUUM
Feature Specification

| Feature ID | DB - 0004 |
|---|---|
| Feature Name | Trial Balance |
| Module | DB - Database |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
The Trial Balance feature stores a daily calculated snapshot of every account's balance for a company, giving the platform a data foundation that can answer "what was the balance sheet on this specific date" rather than only at month-end. Balance sheet accounts store the point-in-time ending balance for each day; profit & loss accounts store the accumulated year-to-date balance for each day. This daily granularity is what allows downstream features — the Balance Sheet report, bank statement reconciliation, and QoE analysis — to reconcile to any specific date, which matters because bank statement cutoffs, diligence requests, and reconciliation checkpoints rarely land neatly on a month-end.
The daily trial balance is not entered directly by a user. It is calculated by the system from a starting and/or ending balance sheet (uploaded via Key Reports / the Data Retrieve Wizard, DR-0003) rolled forward and/or backward through the general ledger activity in DB-0002. Where both anchors exist, the platform validates that the starting balance plus GL activity mathematically arrives at the provided ending balance, and flags where it does not — which is the primary defense against the most common real-world failure mode: a user uploads a report, then makes journal entries afterward, silently invalidating everything built downstream of it.
# 2. User Stories
- As a QoE reviewer, I want to see the trial balance as of any specific date, so that I can reconcile bank statement activity to the balance sheet on that exact date rather than only at month-end.
- As a QoE reviewer, I want the system to flag when a starting balance sheet rolled forward through GL activity does not foot to the provided ending balance sheet, so that I catch data or version issues before they propagate into reporting and valuation.
- As a broker or company user, I want the trial balance to reflect the most recently uploaded GL or key report version, so that I am not working off numbers that have since been superseded by later journal entries.
# 3. Functional Requirements
- The system shall calculate and store a daily trial balance record, for every account in the chart of accounts (DB-0003), for every calendar date within the range covered by the uploaded GL.
- The system shall store, for each balance sheet account, the ending balance as of each calendar date.
- The system shall store, for each profit & loss account, the accumulated year-to-date balance as of each calendar date, resetting the accumulation at the start of each fiscal year.
- The system shall calculate daily balances by rolling a starting balance sheet forward through GL activity, an ending balance sheet backward through GL activity, or both, depending on which anchor(s) are present in the uploaded key reports for that company.
- The system shall, when only one anchor (starting or ending balance sheet) is provided, roll balances as far as the available GL data allows and mark the resulting trial balance date range as "Unvalidated" until an opposing anchor is supplied.
- The system shall, when both a starting and ending balance sheet are provided, validate per account that the starting balance plus net GL activity equals the provided ending balance, and shall flag any account where this does not foot.
- The system shall record and surface the variance amount for any account that fails the foot-to-ending validation, rather than a pass/fail flag alone, per the validation framework in DB-0005.
- The system shall associate every calculated trial balance value with the specific GL and key report version used to produce it.
- The system shall, upon upload of a new GL or key report version, recalculate the trial balance for the affected date range and overwrite the previously calculated values under that version — the system shall not automatically retain a copy of the values it is overwriting.
- The system shall allow a user to manually export or duplicate a trial balance version as a backup prior to triggering a recalculation, since prior calculated values are not automatically retained.
- The system shall make the daily trial balance queryable by a single date or a date range, per account or in aggregate, for consumption by downstream features (e.g., RP-0002 Balance Sheet, QE-0003 Bank Statement Review).
- The system shall tag every trial balance date range with a validation status of Validated, Unvalidated, or Foot Exception, so downstream features can surface data-quality context to the user rather than presenting calculated figures as unconditionally reliable.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Daily balance sheet account balance | Write | DB - 0004 Trial Balance table |
| Daily P&L account YTD balance | Write | DB - 0004 Trial Balance table |
| GL transaction detail | Read | DB - 0002 GL Data |
| Chart of accounts structure | Read | DB - 0003 COA |
| Starting / ending balance sheet values | Read | DR - 0003 Data Retrieve Wizard (Key Reports) |
| Foot-check / variance results | Write | DB - 0005 Validations |
| GL / key report version reference | Read/Write | DB - 0001 Table Structure (version metadata) |

# 5. Access & Security
- Roles with access: Broker, Accountant / QoE reviewer, Company (view access, scoped by deal stage), internal admin.
- Roles explicitly excluded: Bank (until deal reaches underwriting stage); Buyer (unless explicitly granted data room access to the underlying financials for that stage).
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web only. This is a backend data and calculation layer with no dedicated end-user screen of its own; any user-facing presentation of trial balance data (e.g., balance sheet as of a date) is delivered through the consuming feature's own UI/UX spec (e.g., RP-0002).
- Wireframe reference: N/A.
A lightweight internal/admin view showing validation status (Validated / Unvalidated / Foot Exception) and variance detail per date and per version is recommended for QA and support use, but is not required for the initial build of this feature — see Open Questions.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DB - 0002 GL Data | Depends on | GL activity is the input to the roll-forward/backward calculation. |
| DB - 0003 COA | Depends on | Chart of accounts structure the trial balance is stored against. |
| DR - 0003 Data Retrieve Wizard | Depends on | Source of the starting/ending balance sheet anchors. |
| DB - 0005 Validations | Blocks | Foot-check exceptions and variances feed the validation/notification framework. |
| RP - 0002 Balance Sheet | Blocks | Balance sheet report is built off daily trial balance data. |
| QE - 0003 Bank Statement Review | Blocks | Bank reconciliation relies on the trial balance as of a specific date. |
| Document Versioning (cross-cutting gap) | Depends on | General versioning capability referenced by the conventions doc; recalculation behavior in this spec assumes it exists. |

# 8. Out of Scope / Deferred
- Statement of Cash Flow generation — belongs to RP - 0003, a separate feature.
- Automatic system-level archiving of prior calculated trial balance versions before a recalculation overwrites them — not built in this spec; the user is responsible for manually exporting/duplicating a version as a backup. See Open Questions.
- Storage or browsing of underlying GL transaction-level detail — this feature stores calculated daily balances only; transaction detail lives in DB - 0002 GL Data.
- Multi-entity or consolidated trial balance across more than one company — explicitly excluded per deal isolation.
# 9. Open Questions
- Given that recalculation overwrites the current version's values with no automatic backup, and the user is relying on manually exporting/duplicating a version beforehand — should the platform show an explicit warning/confirmation at the moment a new GL/key report upload is about to trigger a recalculation, so the user has a clear opportunity to back up first?
- Is a dedicated internal/admin UI needed to review validation status and foot exceptions per date and version, or is this purely a backend data layer consumed by other features in v1?
- What fiscal year-end convention (calendar year vs. company-specific fiscal year) governs the year-to-date reset for P&L accounts, and where is that configured per company?
- For "daily" granularity, should the system calculate and store a record for every calendar day regardless of GL activity that day, or only for days on which a transaction posted (carrying forward the prior day's value otherwise)?
# 10. Acceptance Criteria
- Given a GL and both a starting and ending balance sheet upload, the system generates a daily trial balance for every calendar date across the range, with balance sheet accounts stored as ending balance and P&L accounts stored as year-to-date balance.
- Given a GL with only a starting balance sheet uploaded, the system rolls forward as far as GL data allows and marks the resulting daily trial balance date range as "Unvalidated."
- Given a starting and ending balance sheet that do not foot after rolling forward GL activity, the system flags the specific account(s) and displays the variance amount rather than passing silently or failing without detail.
- Given a new GL or key report version is uploaded, the trial balance for the affected date range recalculates under the current version, overwriting the prior calculated values without an automatic system backup.
- Given a request for the trial balance as of a specific date, the system returns the balance for every account as of that date, usable by downstream reporting features (e.g., RP - 0002 Balance Sheet).

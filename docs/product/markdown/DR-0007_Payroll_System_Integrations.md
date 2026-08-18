CENTURIUUM
Feature Specification

| Feature ID | DR - 0007 |
|---|---|
| Feature Name | Payroll System Integrations |
| Module | DR - Data Room |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
Owner and family compensation is the largest and most frequently disputed add-back in a lower middle market SDE or EBITDA bridge, and the underlying detail is almost never available in the general ledger at sufficient granularity to support it. This feature lets a user connect directly to the company's payroll provider and retrieve standard payroll reports into the data room, replacing the manual back-and-forth of requesting these documents from the company. This spec covers connection and retrieval only — the reports are saved into the data room as static files. Parsing that retrieved data into structured, employee-level fields for use elsewhere in the system (e.g., QoE add-back support) is explicitly a separate, future feature (see Dependencies and Open Questions).
# 2. User Stories
- As a QoE preparer, I want to connect to the company's payroll provider and pull standard payroll reports directly into the data room, so that I don't have to request and manually upload these documents from the company.
- As a company user, I want to authorize a secure connection to my payroll system once, so that I don't have to repeatedly export and upload payroll reports myself.
- As a broker, I want the retrieved payroll reports to live in the data room like any other document, so that anyone with access to that folder can reference them without extra steps.
# 3. Functional Requirements
- The system shall allow a user to initiate a payroll connection through the Data Retrieve Wizard (DR-0003), with payroll providers presented as a connection type alongside financial data sources.
- The system shall support OAuth-based connection to Gusto, ADP (Run and Workforce Now), Paychex, Paylocity, Rippling, and QuickBooks Payroll, using each provider's official API — never browser automation or stored credentials.
- The system shall support a mapped file import path for payroll providers outside the six supported integrations, allowing manual upload of an exported report mapped to a standard template.
- The system shall retrieve standard payroll reports (e.g., payroll summary, payroll detail, tax liability report) for a user-specified date range.
- The system shall save retrieved reports as static files in the data room; retrieved reports do not maintain a live/refreshing connection to the payroll source.
- The system shall create a new version of the retrieved report set each time a pull is re-run for the same connection, rather than overwriting the prior pull.
- The system shall record which payroll provider, connection account, date range, and user initiated each retrieval.
- The system shall place retrieved payroll reports into the data room folder structure defined for payroll documentation (per DR-0002), subject to standard folder-level permissions.
- The system shall notify the user of retrieval success or failure, including authentication errors and provider-side rate limits or outages.
- The system shall NOT parse retrieved reports into structured, employee-level data fields as part of this feature.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Retrieved payroll report files | Write | Data room storage, filed per the templated folder structure in DR-0002 |
| Retrieval metadata (provider, account, date range, initiating user, timestamp, version) | Write | System — dedicated DB module table block not yet defined; see Open Questions |
| Provider OAuth connection/token | Write | Integration/auth layer — not a Database (DB) module table |

Note: structured, employee-level compensation fields (base wages, bonus, owner draws, employer taxes, headcount) are explicitly out of scope for this feature and are deferred to a future spec (see Dependencies).
# 5. Access & Security
- Roles with access: any role granted access to the data room folder where payroll reports are stored (e.g., Broker, Accountant/QoE, Company), governed by the standard data room permission model — no additional restriction layer beyond normal folder permissions.
- Roles explicitly excluded: none beyond standard folder-level permission exclusions already governed elsewhere in the system.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
Decision note: the original product-list description for this feature flagged payroll data as restricted to the QoE/valuation team only and never exposed in the data room. Per direction from Josh, this spec instead treats retrieved payroll reports like any other data room document — visibility is governed strictly by data room folder access, with no additional gating layer.
# 6. UI / UX Notes
- Platform: Web only
- Wireframe reference: N/A
Payroll retrieval extends the existing Data Retrieve Wizard (DR-0003) UI: the user selects a payroll provider as a connection type alongside financial data sources, completes OAuth consent, selects a date range, initiates retrieval, and sees a confirmation with a link to the saved files in the data room.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DR-0003 — Data Retrieve Wizard | Depends on | Payroll retrieval extends the same wizard framework and connection UI used for financial data sources. |
| DR-0002 — Templated File Structure | Depends on | Determines where retrieved payroll reports are filed within the data room. |
| TBD (future spec) — Payroll Data Structuring / Parsing | Blocks (future) | Extracting employee-level compensation detail from these reports into structured data is a separate, not-yet-specced feature that consumes the output of this one. |

# 8. Out of Scope / Deferred
- Parsing or structuring employee-level compensation detail (base wages, bonus, owner draws, employer taxes, headcount) into database tables — deferred to a future spec that consumes the reports retrieved here.
- Any restriction of payroll data visibility beyond standard data room folder permissions.
- Live or refreshing sync with the payroll provider — retrieval produces static files only, consistent with the Data Retrieve Wizard convention.
# 9. Open Questions
- A future spec is needed to parse retrieved payroll reports into structured data (to support QE-0004 add-back analysis, among others) — this will need its own Feature ID and should be added to the Known Cross-Cutting Gaps or Spec Log once scoped.
- Which standard report types should be pulled by default per provider (payroll summary vs. detail vs. tax liability) — may vary by provider capability and needs confirmation per provider during build.
- Should retrieval support a recurring/scheduled pull (e.g., monthly during an active engagement), or is it always manually triggered per session? Not yet decided.
# 10. Acceptance Criteria
- User can select a payroll provider from the Data Retrieve Wizard and connect via OAuth, or upload via the mapped file import path for unsupported providers.
- Retrieved payroll reports for the selected date range are saved as static files in the correct data room folder.
- Re-running a retrieval for the same connection creates a new version without overwriting the prior pull.
- Retrieval metadata (provider, account, date range, initiating user, timestamp) is recorded and viewable.
- Any user with access to the payroll documents' data room folder can view them; users without folder access cannot.
- Failed authentication or provider errors surface a clear, actionable message to the initiating user.

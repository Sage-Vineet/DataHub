CENTURIUUM
Feature Specification

| Feature ID | DR - 0003 |
|---|---|
| Feature Name | Data Retrieve Wizard |
| Module | Data Room |
| Status | Draft |
| Related / Recycled IDs | N/A |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
Business owners currently populate the Centuriuum data room with financial reports by manually running and exporting each report from QuickBooks, then uploading them one at a time — a slow, error-prone process that discourages timely updates and inconsistent report sets across deals. The Data Retrieve Wizard lets a company user connect QuickBooks Desktop (via backup file upload) or QuickBooks Online (via OAuth login) and automatically retrieve a standard set of financial reports directly into the deal's data room, with minimal manual effort.
This benefits brokers, QoE providers, and companies by ensuring the data room has a consistent, complete, and current set of financials with far less friction, and by giving companies an easy way to re-pull an updated report set as their books change over time.
# 2. User Stories
- As a company user, I want to upload my QuickBooks Desktop backup file and unlock it with my credentials, so that I don't have to manually run and export each report myself.
- As a company user, I want to connect my QuickBooks Online account, so that reports can be pulled automatically without any file handling.
- As a company user, I want to choose which reports to retrieve and where they get saved in the data room, so that I retain control over what's shared and where.
- As a company user, I want to start a retrieval and leave, so that I don't have to wait around while reports are generated.
- As a broker or QoE provider, I want each report pull to be clearly date-stamped, so that I can tell which version of the financials I'm looking at when multiple pulls exist.
# 3. Functional Requirements
- The system shall allow a user to choose a data source: QuickBooks Desktop (backup file upload) or QuickBooks Online (OAuth login).
- The system shall accept a QuickBooks Desktop backup (.qbb) file upload.
- The system shall prompt the user for a QuickBooks Desktop username and password if the uploaded backup file is password-protected.
- The system shall store the QuickBooks Desktop username and password (encrypted at rest) so the user is not required to re-enter credentials on subsequent retrievals for the same connection.
- The system shall allow the user to update or remove stored QuickBooks Desktop credentials at any time.
- The system shall connect to QuickBooks Online exclusively via Intuit's official OAuth API (no browser automation or stored raw credentials for QBO).
- The system shall present a checkbox list of available reports — including Accounts Receivable Aging, Accounts Payable Aging, Profit & Loss, Balance Sheet, General Ledger, and Bank Reconciliation — with a default subset pre-checked, before starting retrieval.
- The system shall allow the user to add or remove individual reports from the pre-checked default list before starting retrieval.
- The system shall require the user to manually select a date range applicable to the selected reports before starting retrieval (no default date range is applied).
- The system shall require the user to select a destination folder within the current deal's data room before starting retrieval.
- The system shall require the user to confirm the selections (source, reports, date range, destination) before the retrieval job begins.
- The system shall run the report retrieval as a background job so the user may navigate away or close the session once the job has started.
- The system shall notify the user upon job completion (success or failure) via the platform's notification mechanism.
- The system shall append a date-based suffix (retrieval date) to each saved report file name or version label.
- The system shall display the retrieval date to the user alongside each saved report set so multiple retrievals for the same deal can be visually distinguished.
- The system shall save each retrieval as a new version and shall not overwrite previously retrieved report sets.
- The system shall log a failed retrieval with a clear, user-visible reason (e.g., invalid credentials, connection timeout, unsupported report) rather than failing silently.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Deal / Company ID | Read | Active deal context (session) |
| QBO OAuth connection record | Write | DB - 0004 (Integrations / Connections block) |
| QB Desktop stored credentials (encrypted) | Write | DB - 0004 (Integrations / Connections block) |
| Uploaded .qbb backup file | Write | DB - 0002 (Document / File block) |
| Retrieved report files (PDF/CSV/XLSX) | Write | DB - 0002 (Document / File block) |
| Report retrieval job record (status, timestamps, report list, date range) | Write | DB - 0006 (Jobs / Background Process block) |
| Report version metadata (date-stamped suffix, version number) | Write | DB - 0002 (Document / File block, versioning fields) |
| Destination folder / module selection | Read | DB - 0001 (Data Room Structure block) |

# 5. Access & Security
- Roles with access: Company, Broker, Accountant (Broker/Accountant access is view/initiate only where permitted by deal role settings; exact per-role permissions to be confirmed against the platform's role matrix).
- Roles explicitly excluded: Bank, Buyer (until explicitly granted document access at a later deal stage).
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, credentials, or search results.
- Stored QuickBooks Desktop credentials must be encrypted at rest and scoped to the single deal/connection they were entered for — never shared or reused across deals or companies.
# 6. UI / UX Notes
- Platform: Web only. (Financial report retrieval and file upload are excluded from the mobile-light experience per platform scope conventions.)
- Wireframe reference: N/A
Wizard flow: (1) Select source (QB Desktop or QBO) → (2) Authenticate/unlock → (3) Select reports via checkbox list (default subset pre-checked) → (4) Select date range → (5) Select destination folder in data room → (6) Confirm → (7) Job runs in background; user may leave → (8) Notification on completion.
Each completed retrieval should be clearly labeled in the data room UI with its retrieval date so a user browsing multiple report sets can immediately tell them apart.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| QB Desktop backup parsing engine (cross-cutting gap) | Depends on | Wizard cannot extract reports from a .qbb file until this engine exists; see Open Questions. |
| Notifications hub (cross-cutting gap) | Depends on | Wizard completion alerts (in-app/email) should use the shared notification system once built, not a one-off local notifier. |
| Document versioning (cross-cutting gap) | Depends on | Date-suffixed report sets rely on the general versioning capability rather than a wizard-specific implementation. |
| Data Room Structure / Folder Navigation | Depends on | User must be able to browse and select a destination folder within the deal's data room. |

# 8. Out of Scope / Deferred
- Parsing/extraction logic for the QuickBooks Desktop backup (.qbb) file itself — covered by the separate QB Desktop backup parsing engine (cross-cutting gap), not this wizard spec.
- The Notifications hub's underlying delivery mechanism (email templates, in-app notification center) — this spec only requires that a completion notification is triggered.
- Report content analysis, QoE adjustments, or narrative commentary generated from retrieved reports — handled by separate analysis features.
- Live/refreshing sync with QuickBooks after the initial pull — each retrieval is a static, point-in-time snapshot per locked architectural decisions.
# 9. Open Questions
- The QB Desktop path in this spec assumes the system parses the .qbb backup file directly to extract report data, which requires the QB Desktop backup parsing engine (currently an unbuilt cross-cutting gap, distinct from the QBO OAuth path). Confirm this engine will be scoped/built, and in what timeframe, since this wizard cannot function for QB Desktop users without it.
- What is the exact default (pre-checked) report list, and is it the same for every industry/company type, or configurable per deal?
- Should there be a limit on how many historical retrieval versions are retained per deal, or is retention unlimited?
- Does a failed QuickBooks Online OAuth token refresh require the user to fully reconnect, or can the system silently retry within a grace period?
# 10. Acceptance Criteria
- A company user can upload a QB Desktop .qbb file, enter credentials if prompted, select reports and a date range, choose a destination folder, and successfully receive a completed report set with no manual report exporting.
- A company user can connect via QuickBooks Online OAuth and successfully retrieve the same set of report types without uploading any file.
- The user can start a retrieval, close the browser/app, and later see a completion notification and the resulting files in the data room.
- Each retrieved report set is saved with a distinct date-based suffix and does not overwrite a prior retrieval for the same deal.
- A failed retrieval produces a visible, specific error rather than an indefinite pending state or silent failure.
- Stored QB Desktop credentials are encrypted at rest and scoped to a single deal/connection.

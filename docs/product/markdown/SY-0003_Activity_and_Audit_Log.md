CENTURIUUM
Feature Specification

| Feature ID | SY - 0003 |
|---|---|
| Feature Name | Activity & Audit Log |
| Module | SY - System |
| Status | Draft |
| Related / Recycled IDs | Feeds DR - 0006 (Document Control & Watermarking), BO - 0004 (Buyer Engagement Analytics); referenced by BR - 0009, SY - 0004, VL - 0010 |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
This feature establishes a comprehensive, immutable, platform-wide activity and audit log surfaced on each company profile, capturing who did what, when, and from where across every module touching that deal. It exists both as a legal and confidentiality safeguard for a sensitive M&A data room (proving who accessed or changed what if a dispute or leak occurs) and as the foundational data source that other features — buyer engagement analytics, document control, and valuation version history — depend on. Because it underlies several downstream features, it is intentionally built early rather than retrofitted.
# 2. User Stories
- As a broker, I want to see a filterable log of all activity on a deal, so that I can answer questions about who accessed or changed what and demonstrate process integrity to a seller or counsel.
- As a company (seller) user, I want to view activity on my company profile that I've been granted visibility into, so that I understand what is happening on my deal without seeing information outside my permission scope.
- As a buyer, I want my own activity to be logged for accountability, without being able to see activity performed by parties or in folders I don't have access to, so that confidentiality of the process is preserved.
- As an accountant or QoE reviewer, I want to see when financial data was uploaded, refreshed, or reclassified, so that I can track the state of the engagement and identify when source data changed.
- As a platform administrator, I want the log to be append-only and tamper-evident, so that it can serve as a defensible record in the event of a legal or security incident.
# 3. Functional Requirements
- The system shall record an activity log entry for every event within the categories defined in Section 3.1, at minimum capturing: acting user, event type, object/entity affected, module, timestamp (UTC, displayed in user's local time zone), IP address, and device/browser where applicable.
- The system shall scope every log entry to a single company/deal; no entry shall be visible to a user outside that company's granted access.
- The system shall filter each user's view of the log according to their role-based and folder-level permissions on that deal — a user shall never see a log entry referencing an object (folder, file, or record) they themselves do not have access to, even if they otherwise have visibility into the log.
- The system shall provide filtering by: user, date range, module/event category, and object type, plus a free-text search bar across log entry descriptions.
- The system shall log authentication events: successful logins, failed login attempts, password and multi-factor changes, and session termination — with IP address, geolocation, device, and browser.
- The system shall log document events: view (with duration), download, print, and denied access attempts, per user and per file version.
- The system shall log permission events: every grant, modification, and revocation of company, folder, or file access, identifying the granting user.
- The system shall log data events: financial data uploads/refreshes, chart of accounts reclassifications, QoE adjustment and add-back changes, and valuation assumption changes.
- The system shall log workflow events: deal stage changes, offer receipt, NDA/signature execution, and report generation or external release.
- The system shall log administrative events: user creation, role changes, and integration connection or disconnection.
- The system shall log Q&A events: questions asked and answered, including the asking/answering user and the module context.
- The system shall store all log records as append-only; no user role, including administrators, shall have the ability to edit or delete a log entry through the application.
- The system shall retain all log records indefinitely as part of the underlying company profile's data, which itself is retained indefinitely by the platform (per current data retention approach; see Open Questions for a future formal policy).
- The system shall support export of the filtered log view to CSV and to PDF.
- The system shall generate a security-relevant alert (visible to the broker and/or platform admin, per role) for the following anomaly patterns: mass/bulk downloads in a short window, access attempts from an unexpected or new geography, repeated failed login attempts, and any access attempt by a user whose access has been revoked or who has been marked "passed" on the deal.
- The system shall NOT generate operational or business-process alerts (e.g., buyer stalling in a pipeline stage, deal inactivity) from this log — such alerts belong to the relevant business feature (e.g., BR - 0009 outreach pipeline), not to the audit log itself.
- The system shall log all access to the activity log view itself (who viewed the log, when, and with what filters), consistent with the log-the-log requirement for the log's own integrity.
3.1 Event Categories (reference)
- Authentication — login success/failure, MFA changes, session end
- Document — view, download, print, denied access
- Permission — grant, modify, revoke access
- Data — upload, refresh, reclassification, adjustment/assumption change
- Workflow — stage change, offer receipt, signature execution, report release
- Administrative — user creation, role change, integration connect/disconnect
- Q&A — question asked, question answered
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Log entry record (user, event type, object, module, timestamp, IP, device) | Write | New activity_log table — see Open Question on schema ownership |
| User identity / role | Read | SY - 0001 Role Based Access Setup |
| Company/deal access grants | Read | SY - 0002 Company Access Setup |
| Financial data upload/refresh events | Read | DB - 0001 Table Structure, DB - 0002 GL Data |
| Document view/download/print events | Read | DR - 0001 Core Data Room, DR - 0006 Document Control & Watermarking |
| Q&A activity | Read | QA - 0001 User Based Tracking |
| Valuation assumption changes | Read | VL - 0010 Version Control & Assumption Audit Log |
| Filtered/exported log view | Read | Rendered to Company Profile UI; exported as CSV/PDF |

Note: this feature is itself a foundational data source for DB-0001 (table structure) rather than a strict consumer of an existing DB block. The activity_log table should be added to the reconciled data structure under the Database module.
# 5. Access & Security
- Roles with access: Broker (full log for their deals), Company (scoped to what they've been granted visibility into), Accountant/QoE reviewer (scoped to their granted access), Platform Admin (full log, own access also logged).
- Roles explicitly excluded from broader visibility: Buyer, Bank — each sees only their own activity and any activity explicitly surfaced to them (e.g., their own document access history); they do not see other parties' activity on the deal.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
- Log visibility is further filtered at the object level: a user shall never see a log entry referencing a folder, file, or record outside their own permission scope, even within a deal they otherwise have access to (e.g., a buyer must not see that a broker modified a folder the buyer cannot access).
- Access to the log itself is permission-restricted per role, and all access to the log is itself logged.
# 6. UI / UX Notes
- Platform: Web only. Full activity/audit log review is a web-only workflow; mobile is not in scope for this feature given the lighter-weight mobile companion scope defined in project conventions.
- Wireframe reference: N/A
Log surfaces as a tab or panel on the Company Profile. Default view shows most recent activity first. Filter bar includes: User (dropdown, populated from users with access to the deal), Date Range (picker), Module/Event Category (dropdown/multi-select per Section 3.1), and a free-text Search field. Each entry displays: timestamp, acting user, event description, and module tag. Export (CSV/PDF) applies to the currently filtered view, not the full unfiltered log.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| SY - 0001 Role Based Access Setup | Depends on | Role definitions drive who can view which log entries |
| SY - 0002 Company Access Setup | Depends on | Company/deal-level access grants determine object-level log visibility |
| DR - 0006 Document Control & Watermarking | Blocks | Document view/download/print/denied-access events feed this log |
| BO - 0004 Buyer Engagement Analytics | Blocks | Engagement scoring is built from this log's document access telemetry |
| VL - 0010 Version Control & Assumption Audit Log | Related | Valuation assumption change events feed into this log; VL-0010 retains its own detailed version snapshots |
| SY - 0004 E-Signature Service | Blocks | Signature execution events feed this log |
| Audit trail / activity log (cross-cutting gap) | Related | This spec is the formal definition of that previously-unspecced cross-cutting gap |

# 8. Out of Scope / Deferred
- Operational/business-process alerting (e.g., buyer stage stalls, deal inactivity thresholds) — belongs to the relevant business feature (e.g., BR - 0009), not this audit log.
- Formal data retention/purge policy and legal hold procedures — see Open Questions.
- Detailed valuation assumption diffing and version comparison UI — owned by VL - 0010; this log records that a change occurred and links to it.
- Mobile view of the activity log — deferred; web only for this spec per current mobile scope conventions.
# 9. Open Questions
- Should a formal, written data retention/legal-hold policy be defined (even though the current default is indefinite retention), particularly for regulatory or legal-hold scenarios post-close?
- What is the exact set of anomaly-alert thresholds (e.g., how many downloads in what window counts as "mass download"), and who configures them — platform-level default, or per-brokerage configurable?
- Who receives security alerts by default — broker only, platform admin only, or both — and is there an escalation path?
- Does this log need to reference the Notifications Hub (cross-cutting gap) for delivering alerts, or does it render alerts only within the log/company profile UI for this phase?
# 10. Acceptance Criteria
- A broker can open a company profile, view the activity log, and filter by user, date range, module, and free-text search, with results updating accordingly.
- A buyer viewing the log (or their own activity history) cannot see any entry referencing a folder, file, or action they do not have permission to access.
- All authentication, document, permission, data, workflow, administrative, and Q&A events defined in Section 3 generate a corresponding log entry with the required fields.
- No user role, including admin, can edit or delete an existing log entry through the application.
- A filtered log view can be exported to both CSV and PDF, and the export reflects only the currently applied filters.
- A simulated mass-download or off-hours access event generates a visible security alert per the configured pattern.
- Viewing the activity log itself generates a log entry recording who viewed it and when.

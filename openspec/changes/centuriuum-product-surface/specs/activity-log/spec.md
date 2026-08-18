## Purpose

The platform-wide, append-only record of who did what, when, and from where, surfaced per company /
deal. Covers `SY - 0003` (Activity & Audit Log). It exists both as a legal and confidentiality safeguard
for a sensitive M&A data room — proving who accessed or changed what when a dispute or a leak occurs —
and as the data source several later features are built from: buyer engagement analytics (`BR - 0010`),
document control and watermarking (`DR - 0006`), and valuation version history (`VL - 0010`). The source
specification is explicit that it is "intentionally built early rather than retrofitted".

**Fidelity: specified.** Requirements are drawn from the `SY - 0003` feature specification (Josh
Tonnesen, 14 Aug 2026).

**ID note.** This feature was previously numbered `SE - 0004`; the `SE` module was folded into `SY`. The
source document's dependency table still refers to `SY - 0004` for the e-signature service (now
`SY - 0007`, `SY - 0004` being metered usage) and to `BO - 0004` for buyer engagement analytics (now
`BR - 0010`).

## ADDED Requirements

### Requirement: Every logged event carries a common attribution envelope

The system SHALL record an activity log entry for every event in the categories below, capturing at
minimum: acting user, event type, object or entity affected, module, timestamp in UTC (displayed in the
viewer's local time zone), IP address, and device/browser where applicable. (`SY - 0003`)

#### Scenario: Entry carries the full envelope
- **WHEN** any logged event occurs
- **THEN** the resulting entry records acting user, event type, affected object, module, UTC timestamp,
  IP address, and device/browser where applicable

#### Scenario: Timestamps display locally
- **WHEN** a user views the log
- **THEN** UTC timestamps are rendered in that user's local time zone

### Requirement: Event categories covered

The system SHALL log, at minimum:

- **Authentication** — successful logins, failed login attempts, password and multi-factor changes, and
  session termination, each with IP address, geolocation, device, and browser.
- **Document** — view (with duration), download, print, and denied access attempts, per user and per
  file version.
- **Permission** — every grant, modification, and revocation of company, folder, or file access,
  identifying the granting user.
- **Data** — financial data uploads and refreshes, chart of accounts reclassifications, QoE adjustment
  and add-back changes, and valuation assumption changes.
- **Workflow** — deal stage changes, offer receipt, NDA and signature execution, and report generation
  or external release.
- **Administrative** — user creation, role changes, and integration connection or disconnection.
- **Q&A** — questions asked and answered, including the asking and answering user and the module
  context.

(`SY - 0003`)

#### Scenario: Each category generates entries
- **WHEN** an event in any of the seven categories occurs
- **THEN** a corresponding log entry is generated with the required fields for that category

#### Scenario: Denied access is logged
- **WHEN** a user is denied access to a document
- **THEN** the denial is recorded as a document event, not silently dropped

### Requirement: Log entries are scoped to one deal and filtered to the viewer's own permissions

The system SHALL scope every log entry to a single company/deal, and SHALL NOT make an entry visible to
any user outside that company's granted access. Within a deal, the system SHALL further filter each
user's view by their role-based and folder-level permissions: a user SHALL NEVER see a log entry
referencing a folder, file, or record they do not themselves have access to, even where they otherwise
have visibility into the log. (`SY - 0003`, depends on `SY - 0001`, `SY - 0002`)

#### Scenario: No cross-deal visibility
- **WHEN** a user with access to company A views the log
- **THEN** no entry from any other company appears

#### Scenario: Object-level filtering inside a deal
- **WHEN** a buyer views the log on a deal they have access to
- **THEN** entries referencing folders, files, or actions outside that buyer's permission scope are not
  shown — including a broker's action on a folder the buyer cannot access

### Requirement: Role-differentiated log visibility

The system SHALL grant log visibility by role: Broker (full log for their deals), Company (scoped to
what they have been granted visibility into), Accountant / QoE reviewer (scoped to their granted
access), and Platform Admin (full log, with the admin's own access also logged). Buyer and Bank roles
SHALL see only their own activity and any activity explicitly surfaced to them, and SHALL NOT see other
parties' activity on the deal. (`SY - 0003`)

#### Scenario: Buyers see only their own activity
- **WHEN** a buyer opens their activity view
- **THEN** only that buyer's own events appear, with no other party's activity on the deal

### Requirement: Filtering, search, and export

The system SHALL provide filtering by user, date range, module/event category, and object type, plus a
free-text search across entry descriptions. The system SHALL support export of the **currently filtered**
view to CSV and to PDF; an export SHALL reflect the applied filters, not the full unfiltered log.
(`SY - 0003`)

#### Scenario: Filters compose
- **WHEN** a broker filters by user, date range, module, and a free-text term
- **THEN** results update to satisfy all applied filters together

#### Scenario: Export honours the filter
- **WHEN** a filtered view is exported to CSV or PDF
- **THEN** the export contains only the filtered rows

### Requirement: The log is append-only and retained

The system SHALL store all log records append-only. No user role, including administrators, SHALL be
able to edit or delete a log entry through the application. Records SHALL be retained indefinitely as
part of the company profile's data, pending a formal retention policy. (`SY - 0003`)

#### Scenario: No edit or delete path exists
- **WHEN** any role, including a platform administrator, attempts to modify or remove a log entry
- **THEN** no application path permits it

### Requirement: Access to the log is itself logged

The system SHALL log all access to the activity log view — who viewed the log, when, and with what
filters. (`SY - 0003`)

#### Scenario: Viewing the log leaves a trace
- **WHEN** a user opens the activity log
- **THEN** an entry records that user, the time, and the filters applied

### Requirement: Security anomaly alerts, and only security alerts

The system SHALL generate a security-relevant alert — visible to the broker and/or platform admin per
role — for: mass or bulk downloads within a short window, access from an unexpected or new geography,
repeated failed login attempts, and any access attempt by a user whose access has been revoked or who
has been marked "passed" on the deal. The system SHALL NOT generate operational or business-process
alerts from this log — buyer stalling in a pipeline stage, deal inactivity, and similar belong to the
owning business feature (for example `BR - 0009`), not to the audit log. (`SY - 0003`)

#### Scenario: Mass download raises an alert
- **WHEN** a user downloads documents in bulk within a short window
- **THEN** a visible security alert is raised to the configured recipients

#### Scenario: Revoked user's access attempt raises an alert
- **WHEN** a user whose access has been revoked attempts to access the deal
- **THEN** a security alert is raised

#### Scenario: Business-process events raise no audit-log alert
- **WHEN** a buyer stalls in a pipeline stage
- **THEN** the audit log raises no alert; the pipeline feature owns that notification

### Requirement: The log is a source for downstream features

Document view, download, print, and denied-access telemetry SHALL be available to document control and
watermarking (`DR - 0006`) and to buyer engagement analytics (`BR - 0010`); signature execution events
from `SY - 0007` and valuation assumption changes from `VL - 0010` SHALL be recorded here, with
`VL - 0010` retaining its own detailed version snapshots. (`SY - 0003`)

#### Scenario: Engagement scoring reads document telemetry
- **WHEN** buyer engagement analytics computes a score
- **THEN** it reads document access telemetry from this log rather than a parallel store

### Requirement: Usage metering is a sibling stream, not part of this log

Usage events captured by `SY - 0004` SHALL share this capability's event-capture conventions — user,
company/deal, timestamp, IP where applicable — so the two can be correlated later, but SHALL NOT be
written into the audit log or surfaced in its UI. (`SY - 0003`, `SY - 0004`)

#### Scenario: Metering does not pollute the audit log
- **WHEN** metered AI, OCR, or third-party provider usage is recorded
- **THEN** no entry appears in the activity log UI as a result

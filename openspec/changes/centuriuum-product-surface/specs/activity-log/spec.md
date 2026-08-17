## Purpose

The platform-wide, append-only record of who did what, when, and from where (`SE - 0004`). It is two
things at once: the legal necessity for a confidential M&A data room, and the data source that makes
buyer engagement analytics (`BR - 0010`), document control (`DR - 0006`), and the seller status report
(`BR - 0011`) possible at all. The source row is explicit that it must be built early rather than
retrofitted — and it is right, because this is a **capture** problem: activity that was not logged when
it happened cannot be recovered later.

**Fidelity: sketch.** Not currently scheduled in the modernization cutover order; `design.md` §D5
recommends moving it forward.

## ADDED Requirements

### Requirement: Authentication events are logged

The system SHALL log successful logins, failed attempts, password and multi-factor changes, and session
terminations, each with IP address, geolocation, device, and browser. (`SE - 0004`)

#### Scenario: Failed login is recorded
- **WHEN** a login attempt fails
- **THEN** an entry records the identifier attempted, the outcome, and the originating IP, device, and
  browser

### Requirement: Document events are logged per user and per file version

The system SHALL log document views with duration, downloads, prints, and every **denied** access
attempt, attributed to the user and to the specific file version. (`SE - 0004`, feeds `DR - 0006`,
`BR - 0010`)

#### Scenario: View duration is captured
- **WHEN** a user opens a document in the viewer and closes it
- **THEN** an entry records the user, the file version, and how long it was open

#### Scenario: Denied access is logged, not silently dropped
- **WHEN** a user attempts to open a file they lack permission for
- **THEN** the denial is logged with the same fidelity as a successful access

### Requirement: Permission, data, workflow, and administrative events are logged

The system SHALL log: permission grants, modifications, and revocations with the granting user;
financial data uploads and refreshes, chart-of-accounts reclassifications, QoE adjustment and add-back
changes, and valuation assumption changes; deal stage changes, offer receipt, NDA and signature
execution, and report generation and external release; and user creation, role changes, and integration
connection or disconnection. (`SE - 0004`)

#### Scenario: An add-back change is attributable
- **WHEN** a user changes a QoE add-back
- **THEN** an entry records the user, the deal, the prior and new value, and the time

#### Scenario: An integration disconnect is recorded
- **WHEN** a source system connection is disconnected
- **THEN** an entry records who disconnected it and when

### Requirement: Records are append-only and tamper-evident

Log records SHALL be append-only and tamper-evident, with **no** user-level delete or edit capability —
including for administrators. (`SE - 0004`)

#### Scenario: No delete path exists
- **WHEN** any user, including a platform administrator, attempts to delete or modify a log entry
- **THEN** the operation is unavailable, and the attempt is itself logged

### Requirement: Retention outlives the engagement

Log records SHALL be retained per a defined policy that survives the closure of the engagement they
relate to, because disputes surface years later. (`SE - 0004`)

#### Scenario: Closed deal retains its log
- **WHEN** a deal is closed or archived
- **THEN** its activity log remains queryable under the retention policy

### Requirement: Search, filter, and defensible export

The system SHALL make the log searchable and filterable by user, deal, date range, event type, and
object, and SHALL export records in a format usable as evidence. (`SE - 0004`)

#### Scenario: Per-deal log view
- **WHEN** a broker opens the log for one deal
- **THEN** only that deal's events are shown, filterable by user, date range, and event type

#### Scenario: Export preserves integrity
- **WHEN** a filtered set is exported
- **THEN** the export includes the tamper-evidence needed to present it as evidence

### Requirement: Anomaly alerting

The system SHALL support configurable alerting on anomalous patterns — mass download, access from an
unexpected geography, off-hours activity, and access attempts by a party whose access has ended.
(`SE - 0004`)

#### Scenario: Mass download raises an alert
- **WHEN** a user's download volume exceeds the configured threshold within the configured window
- **THEN** an alert is raised to the deal's owner

#### Scenario: Passed buyer attempts entry
- **WHEN** a buyer whose access was revoked attempts to open a data room file
- **THEN** the attempt is denied, logged, and raised as an alert

### Requirement: Access to the log is itself restricted and logged

Access to the activity log SHALL be permission-restricted, and every access to it SHALL be logged.
(`SE - 0004`)

#### Scenario: Reading the log is recorded
- **WHEN** a user views or exports log records
- **THEN** that access is itself written to the log

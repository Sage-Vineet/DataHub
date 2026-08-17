## Purpose

The Data Retrieve Wizard (`DR - 0003`) is the primary on-ramp for financial data. It lets a user with
upload permission on a company connect a source system — QuickBooks Online first, a QuickBooks Desktop
backup file second — pick a reporting date range, and pull the engagement's key report set into the
Data Room as **static, versioned files** in one action. This spec captures the observable behavior:
who may launch it, what it retrieves, where the output lands, how re-runs version, and how partial
failures surface. It does not specify the QBO API client, the `.qbb` parser, or any downstream
validation of the retrieved data.

**Traceability:** requirements below carry the source spec's identifiers (`FR-n` = §3 functional
requirement, `AC-n` = §10 acceptance criterion).

## ADDED Requirements

### Requirement: Wizard launch is gated on Data Room upload permission

The system SHALL expose a single "Retrieve Reports" entry point within a company's Data Room, and
SHALL make it visible and invocable **only** to users holding upload permission on that company's Data
Room. Users without that permission SHALL neither see the entry point nor be able to start a pull by
calling the underlying endpoint directly. (FR-1, AC-7)

#### Scenario: Authorized user sees the entry point
- **WHEN** a Broker, Company (seller/owner), or Accountant with upload permission opens the Data Room
- **THEN** the "Retrieve Reports" action is present and starts the wizard for that company

#### Scenario: Bank and Buyer roles are excluded
- **WHEN** a Bank or Buyer user opens a Data Room they have view access to
- **THEN** the "Retrieve Reports" action is absent, and a direct call to the wizard start endpoint is
  denied

#### Scenario: Endpoint enforces the gate independently of the UI
- **WHEN** a user without upload permission on company A posts a pull-start request for company A
- **THEN** the request is denied and no connection, pull, or file is created

### Requirement: Source selection is an extensible registry

The wizard SHALL begin by presenting the available source systems — at minimum "QuickBooks Online" and
"QuickBooks Desktop (backup file upload)" — and SHALL resolve each source through a registry so that
adding a source (e.g. Xero, Sage) adds an option without restructuring the entry flow or the steps
that follow. (FR-2)

#### Scenario: Both launch sources are offered
- **WHEN** an authorized user starts the wizard
- **THEN** step 1 presents "QuickBooks Online" and "QuickBooks Desktop (backup file upload)" as the
  selectable sources

#### Scenario: A newly registered source appears without flow changes
- **WHEN** an additional source is registered
- **THEN** it appears as a further option in step 1 and proceeds through the same
  authenticate → date range → confirm → progress → summary sequence

#### Scenario: Unavailable source is disabled, not hidden silently
- **WHEN** a registered source is not yet available in the environment (e.g. the Desktop parser is not
  deployed)
- **THEN** the option is shown in a disabled state with the reason, rather than the user reaching a
  dead end after selecting it

### Requirement: QuickBooks Online authorization uses Intuit's hosted OAuth flow

For the QBO path the system SHALL authenticate exclusively through Intuit's official OAuth flow: the
user is redirected to Intuit's hosted login, grants access there, and is returned to the wizard. The
system SHALL NOT use browser automation, screen scraping, or any form of credential capture, and SHALL
never store, log, or display the user's QuickBooks username or password. (FR-3, AC-1, AC-6)

#### Scenario: Successful authorization returns to the wizard
- **WHEN** a user selects QuickBooks Online and completes Intuit's hosted consent
- **THEN** control returns to the wizard at the date-range step with an authorized connection recorded
  for that company

#### Scenario: Denied or abandoned consent
- **WHEN** the user declines consent at Intuit or abandons the redirect
- **THEN** the wizard returns to source selection with a plain explanation, and no connection or pull
  is recorded

#### Scenario: No QuickBooks credentials exist anywhere in the platform
- **WHEN** any connection record, log line, API response, or UI surface is inspected after a successful
  authorization
- **THEN** no QuickBooks username or password is present in any of them

### Requirement: Date range is confirmed before any data is retrieved

The wizard SHALL prompt for the reporting date range and SHALL NOT issue any report request until the
user confirms it. The confirmed range SHALL be stored as metadata on the resulting pull version.
(FR-4, AC-2)

#### Scenario: No retrieval before confirmation
- **WHEN** a user has authorized the source but has not confirmed a date range
- **THEN** no report request has been issued to the source system

#### Scenario: Range is recorded on the pull
- **WHEN** a pull completes
- **THEN** the date range used is readable from that pull version's metadata

#### Scenario: Invalid range is rejected at the step
- **WHEN** the user submits a range whose end precedes its start, or a range outside the source's
  supported bounds
- **THEN** the wizard rejects it in place with the reason and does not advance

### Requirement: Configured key-report set is retrieved for the confirmed range

For the QBO path the system SHALL retrieve, for the confirmed date range, the reports named in the
**key-report registry**. The registry SHALL be configuration rather than a hardcoded list, and SHALL
launch containing at minimum: Profit & Loss, Balance Sheet, General Ledger, Chart of Accounts, Trial
Balance, AR Aging (Summary and Detail), and AP Aging (Summary and Detail). Adding a report to the
registry SHALL cause subsequent pulls to include it without a code change to the wizard flow. (FR-5)

#### Scenario: Launch report set is pulled
- **WHEN** a QBO pull runs for a confirmed range
- **THEN** each report in the key-report registry is requested for that range and accounted for in the
  completion summary as either saved or failed

#### Scenario: Registry is extended
- **WHEN** a report is added to the key-report registry
- **THEN** the next pull includes it, and pulls taken before the change remain valid with their
  original report set recorded

#### Scenario: Report unavailable for the selected range
- **WHEN** the source reports that a required report cannot be produced for the confirmed range
- **THEN** that report is marked failed with its reason and the remaining reports still complete

### Requirement: QuickBooks Desktop backup upload path

The wizard SHALL accept a drag-and-drop upload of a single QuickBooks Desktop backup file (`.qbb`) or
an equivalent export file as an alternate source, and SHALL produce the same report set and the same
Data Room output as the QBO path once the file is processed. Extraction of reports from the backup is
delegated to a parser seam that is **not implemented by this change**; until a parser is available the
system SHALL accept and retain the upload and report the pull as awaiting processing rather than
failing silently or appearing to succeed. (FR-6, FR-7, AC-3)

#### Scenario: Backup file is accepted by drag-and-drop
- **WHEN** an authorized user selects the Desktop source and drags a single `.qbb` file onto the step
- **THEN** the file uploads against that company and the wizard advances to the date-range step

#### Scenario: Wrong file type or multiple files
- **WHEN** the user drops an unsupported file type, or more than one file
- **THEN** the upload is rejected in place with the reason and no pull is created

#### Scenario: Parser not yet available
- **WHEN** a Desktop pull is submitted in an environment without the parser
- **THEN** the pull is recorded as awaiting processing with that reason surfaced to the user, and no
  partial or placeholder report files are written to the Data Room

#### Scenario: Parsed output is indistinguishable downstream
- **WHEN** a Desktop pull completes with a parser available
- **THEN** its files land in the same folder structure, under the same versioning, and in the same
  formats as an equivalent QBO pull

### Requirement: Retrieved reports are saved as static individual files in the templated tree

On completion the system SHALL save each retrieved report as its own static file into the company's
Data Room file tree, under a dedicated auto-created subfolder (e.g. "Key Reports") consistent with the
templated file structure (`DR - 0002`). The saved files SHALL be point-in-time artifacts — not live or
refreshing links — and the system SHALL maintain no ongoing connection to the source after the pull
completes unless the user explicitly re-runs the wizard. (FR-8, FR-9, AC-2)

#### Scenario: Each report is an individually addressable file
- **WHEN** a pull completes successfully
- **THEN** every retrieved report exists as a separate file in the Data Room, openable and downloadable
  under the Data Room's normal permission model

#### Scenario: Destination subfolder is created if absent
- **WHEN** a company's tree has no Key Reports subfolder at pull time
- **THEN** the subfolder is created at the location the templated structure specifies and the files
  land inside it

#### Scenario: Files do not change after the pull
- **WHEN** the underlying data in the source system changes after a completed pull
- **THEN** the files saved by that pull are unchanged, and no background refresh has occurred

### Requirement: Re-running the wizard creates a new version and preserves prior pulls

When a company already has a prior pull on file, a subsequent run SHALL be stored as a **new version**,
preserving the earlier pull and its files intact. The system SHALL NOT overwrite or delete a prior
pull's reports as part of a re-run. Each version SHALL record its source, date range, report set,
initiating user, and completion time. (FR-11, AC-4)

#### Scenario: Second pull does not disturb the first
- **WHEN** a user re-runs the wizard for a company with an existing completed pull
- **THEN** a new version is created and every file from the prior pull remains present and unmodified

#### Scenario: Version history is visible
- **WHEN** a user views the Key Reports area for a company with multiple pulls
- **THEN** each version is listed with its source, date range, and completion time, and its files are
  reachable

#### Scenario: Commentary tied to a prior version survives
- **WHEN** downstream work references a report from an earlier version
- **THEN** that reference continues to resolve to the same file after a later pull

### Requirement: Real-time per-report progress

While a pull is running the system SHALL show the user live progress across the report set, naming the
report currently being retrieved and the count completed against the total (e.g. "Retrieving Profit &
Loss… 3 of 8 complete"), whether reports are fetched sequentially or in parallel. (FR-12)

#### Scenario: Progress advances during the pull
- **WHEN** a pull is in flight
- **THEN** the wizard shows which report is in progress and how many of the total have completed,
  updating as each finishes

#### Scenario: Progress survives a page reload
- **WHEN** the user reloads or reopens the wizard while a pull is still running
- **THEN** the current progress is shown rather than the pull appearing lost or restarting

### Requirement: Partial failure is surfaced with selective retry

If one or more reports fail to retrieve — API timeout, report unavailable for the range, source error
— the system SHALL complete the remaining reports, SHALL clearly identify which succeeded and which
failed and why, and SHALL let the user retry **only** the failed reports without re-pulling those that
already succeeded. (FR-13, AC-5)

#### Scenario: Mixed outcome is reported per report
- **WHEN** a pull finishes with some reports failed
- **THEN** the completion summary lists each report as saved or failed, with a reason for each failure

#### Scenario: Retry re-pulls only the failures
- **WHEN** the user retries a partially failed pull
- **THEN** only the previously failed reports are requested from the source, and the already-saved
  files are neither re-fetched nor replaced

#### Scenario: Successful retry completes the same version
- **WHEN** a retry succeeds
- **THEN** the newly retrieved files join the same pull version rather than creating a separate one

### Requirement: Completion notification and checklist satisfaction

On successful completion the system SHALL notify the initiating user and SHALL mark the corresponding
Data Room checklist and tracker items as satisfied where such items are configured — the Deal Tracker
(`BR - 0001`) and Lender Requirements (`DR - 0005`). (FR-14)

#### Scenario: User is notified on completion
- **WHEN** a pull completes
- **THEN** the initiating user receives a completion notification identifying the company, the version,
  and where the files were saved

#### Scenario: Tracked checklist items are satisfied
- **WHEN** a completed pull produces a report that a tracker or lender-requirement item asks for
- **THEN** that item is marked satisfied and links to the saved file

#### Scenario: No tracker configured
- **WHEN** a company has no checklist or tracker items mapped to key reports
- **THEN** the pull still completes and notifies, with no checklist side effect

### Requirement: Source connection credentials are isolated and never readable

Source connection credentials (the Intuit OAuth token set) SHALL be stored in a dedicated,
access-scoped connection store separate from the financial `DB` module, SHALL NOT be returned by any
read API or rendered in any UI, and SHALL be scoped to the single company connection that created
them. (§4, §5, AC-6)

#### Scenario: Tokens are never returned
- **WHEN** any wizard, connection, or pull API response is inspected
- **THEN** it contains connection status and metadata but no access token, refresh token, or realm
  secret

#### Scenario: Credential store is separately scoped
- **WHEN** a component with read access to financial data attempts to read the connection store
- **THEN** access is denied — the connection store is not part of the `DB` module's access surface

### Requirement: Deal isolation across companies

A source connection, pull, and its retrieved files SHALL be scoped to exactly one company/deal. A
connection authorized for one company SHALL NOT be reusable, browsable, referenceable, or discoverable
from another company or deal, and retrieved documents SHALL NOT appear in another deal's listings or
search results. (§5)

#### Scenario: Connection is not reusable across deals
- **WHEN** a user with access to companies A and B starts the wizard for company B
- **THEN** company A's existing connection is not offered, referenced, or reusable — B requires its
  own authorization

#### Scenario: Cross-deal search isolation
- **WHEN** a user searches within company B's Data Room
- **THEN** files retrieved by a pull for company A never appear in the results

### Requirement: Wizard flow and platform scope

The wizard SHALL be a web-only flow (not part of the mobile-capable feature set) presented as the
sequence: (1) choose source, (2) authenticate or upload the backup file, (3) select date range,
(4) confirm and pull, (5) progress view, (6) completion summary showing what was saved and where.
The user SHALL be able to abandon the wizard before step 4 without leaving a pull or partial file set
behind. (§6)

#### Scenario: Completion summary names files and location
- **WHEN** a pull finishes
- **THEN** the summary lists each saved report and the Data Room folder it landed in, with a link to
  that folder

#### Scenario: Abandoning before confirmation leaves nothing behind
- **WHEN** a user closes the wizard at the source, authenticate, or date-range step
- **THEN** no pull version and no report files exist for that attempt

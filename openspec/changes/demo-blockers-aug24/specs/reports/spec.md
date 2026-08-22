## Purpose

How the financial reporting surfaces behave **when their data source fails**. The sources
themselves — `report-sources`, `key-reports/chart-of-accounts`, `key-reports/popup-preference` —
are still on the legacy Supabase read path and return 500 after 7–24 seconds in any environment
without Supabase credentials. Moving them is the `reports` cutover and is out of scope here.

This delta is narrow on purpose: it governs what the user is told, not what the server does. A
server error that renders as an unresolved spinner is worse than one that renders as an error,
because the reader keeps waiting.

## ADDED Requirements

### Requirement: A failed financial retrieval is reported as a failure

The system SHALL distinguish three states on every financial retrieval surface — in progress,
failed, and succeeded-but-empty — and SHALL render them distinguishably. A failed retrieval SHALL
state that it failed and offer a retry.

Observed today: Chart of Accounts renders "Loading…" and "0 accounts" indefinitely against a 500,
while 71 rows sit in the database; Generate Reports spins and then reverts to its empty prompt with
no message at all.

#### Scenario: The retrieval fails

- **WHEN** a financial retrieval returns an error
- **THEN** the surface reports the failure and offers a retry
- **AND** does not remain in a loading state
- **AND** does not present the failure as an empty result

#### Scenario: The retrieval succeeds with no rows

- **WHEN** a financial retrieval succeeds and returns nothing
- **THEN** the surface says there is nothing to show, distinctly from the failure state

#### Scenario: The retrieval exceeds the client's patience

- **WHEN** a financial retrieval has not resolved within the client timeout
- **THEN** the surface reports it as failed without waiting for the server's own retry budget to
  expire

### Requirement: Report generation reports its own outcome

The system SHALL NOT return a report-generation surface to its pre-generation state without telling
the user what happened. Where the generated statements remain unavailable, the surface SHALL say
which step failed.

#### Scenario: Generation fails

- **WHEN** report generation is requested and the underlying retrieval fails
- **THEN** the surface reports the failure
- **AND** the statement tabs remain unavailable with a stated reason

## MODIFIED Requirements

### Requirement: Integration status reflects configuration, not reachability

The system SHALL warn that an accounting integration is disconnected only where that integration
was previously connected. A never-configured integration SHALL produce no warning, and a failed
health check SHALL NOT be reported to the user as a disconnection.

Observed today: a warning reading "QuickBooks disconnected. Showing last synced data. The data
shown is from your last successful sync and may not reflect recent changes" renders on three
financial pages of an environment that has never held a QuickBooks credential, above figures
sourced from an uploaded general ledger. Every source on the Connections page reads
`Last sync: Never`.

#### Scenario: The integration was never connected

- **WHEN** a financial page is viewed and no accounting integration has ever been connected
- **THEN** no disconnection warning is shown

#### Scenario: The integration was connected and is now unavailable

- **WHEN** an integration that was previously connected is no longer connected
- **THEN** the disconnection warning is shown, with the date of the last successful sync

#### Scenario: The health check itself fails

- **WHEN** the connection health check cannot complete
- **THEN** the surface reports that status could not be checked
- **AND** does not assert that the integration is disconnected

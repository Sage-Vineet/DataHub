## Purpose

The platform substrate three feature changes sit on for the 24 Aug 2026 booth demo: a way to apply
schema migrations at all, and a way for the client to honor a server-side feature switch by showing
less rather than by breaking. Both are prerequisites rather than features — the first because
`packages/db` has no migration-apply path, the second because the promised T-48h kill switch
currently degrades into a permanent spinner.

## ADDED Requirements

### Requirement: Migrations apply in order, once, inside a transaction

The system SHALL provide a migration runner that applies every `NNNN_*.sql` file under
`packages/db/migrations/` in ascending filename order, excluding `*.down.sql`, each within its own
transaction, and SHALL record each applied file in a `schema_migrations` table carrying the version,
a content checksum, and an applied-at timestamp. A file already recorded SHALL NOT be re-applied.

#### Scenario: A fresh database applies every migration
- **WHEN** the runner is pointed at a database with no `schema_migrations` table
- **THEN** the table is created and every migration is applied once, in filename order

#### Scenario: A second run is a no-op
- **WHEN** the runner is run again against the same database with no new migration files
- **THEN** nothing is applied and the run succeeds

#### Scenario: A failing migration rolls back
- **WHEN** a migration raises an error partway through
- **THEN** that migration's effects are rolled back and it is not recorded as applied

### Requirement: An edited migration fails loudly

The system SHALL compute a checksum of each migration file at apply time and store it. On a
subsequent run, a file whose recorded checksum no longer matches its content SHALL cause the runner
to exit non-zero with a message naming the file, rather than silently skipping it as already
applied. An explicit force flag SHALL re-record the new checksum without re-applying, for iteration
during development.

#### Scenario: Editing an applied migration is caught
- **WHEN** an already-applied migration file is modified and the runner is run
- **THEN** the run fails and names the modified file

#### Scenario: Forcing re-records the checksum
- **WHEN** the runner is run with the force flag after a deliberate edit
- **THEN** the new checksum is recorded and the run succeeds

### Requirement: Migrations can be rolled back

The system SHALL support rolling back to a named version using the `.down.sql` sibling of each
migration, applying them in descending order, and SHALL remove each rolled-back version from
`schema_migrations`.

#### Scenario: Rolling back one migration
- **WHEN** the runner is asked to roll back to the version preceding the latest
- **THEN** the latest migration's down script runs and its row is removed from `schema_migrations`

### Requirement: The demo stack bootstraps through the runner

The demo bootstrap SHALL apply `packages/db/migrations/` through the runner rather than through
hand-listed `psql` invocations, in an order that satisfies the dependency of `0002_qoe_bridge.sql`
on the tables created by the legacy `049` and `050` migrations.

#### Scenario: A cold demo stack comes up green
- **WHEN** the demo stack is brought up from a destroyed volume
- **THEN** the schema loads through the runner and the stack's own verification checks pass

### Requirement: The gateway declares which features are live

The gateway health endpoint SHALL report, alongside its status, the live value of every module
feature flag. This payload SHALL be served from the gateway application itself rather than from any
domain module router, so that it claims no route surface a domain module could be checked against.

#### Scenario: Health reports the flag set
- **WHEN** the health endpoint is called
- **THEN** it returns the current value of each module feature flag

#### Scenario: A disabled feature is reported as disabled
- **WHEN** a module flag is set to false and the API is restarted
- **THEN** the health endpoint reports that feature as false

### Requirement: The client treats a feature as off unless told otherwise

The client SHALL fetch the feature payload once at application boot and expose it to the interface.
Every feature SHALL be treated as unavailable while that fetch is pending and if it fails, so that
availability is only ever asserted by the server.

#### Scenario: Availability is not assumed before the answer arrives
- **WHEN** the application is still loading the feature payload
- **THEN** every feature is treated as unavailable

#### Scenario: A failed fetch does not enable anything
- **WHEN** the feature payload cannot be retrieved
- **THEN** every feature is treated as unavailable rather than defaulting to available

### Requirement: A disabled feature is absent, not broken

Where a feature is unavailable, the client SHALL omit its navigation entries and its interface
surfaces entirely, rather than rendering them in a disabled, empty, or loading state. No request
belonging to a disabled feature SHALL be issued.

#### Scenario: No navigation entry for a disabled feature
- **WHEN** a feature is reported unavailable
- **THEN** its navigation entry is not rendered at all

#### Scenario: No request is issued for a disabled feature
- **WHEN** a feature is reported unavailable
- **THEN** the client issues no request to that feature's endpoints, so no proxy fallthrough occurs

### Requirement: Client-persisted state is scoped to the signed-in user

Client-side persisted state SHALL be keyed by the signed-in user's identity and SHALL be cleared on
sign-out, so that no cached tree, permission grant, or preference belonging to one user is readable
by the next user of the same device.

#### Scenario: A second user on a shared device sees none of the first user's cache
- **WHEN** one user signs out on a shared device and another signs in
- **THEN** the second user's view is built from their own data, with none of the first user's cached
  folder tree or access grants

### Requirement: The demo returns to a known state on demand

The system SHALL provide a reset path that restores the seeded demo state without restarting or
rebuilding any container, and SHALL leave the application usable immediately afterwards.

#### Scenario: Reset clears visitor-generated mess
- **WHEN** the reset path is run after arbitrary changes have been made through the interface
- **THEN** the seeded state is restored and the application continues to work in an already-open
  browser session

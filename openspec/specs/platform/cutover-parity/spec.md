# platform/cutover-parity Specification

## Purpose
The cutover-parity capability is how the program decides a route-group may be flipped, and — more consequentially — that a legacy handler may be **deleted**. It covers the staging environment seeded from a production snapshot and the harness that replays a derived request set against both engines, comparing their answers and reporting what it did and did not cover. It is a tool and an environment, not a request-path feature: it adds no behavior to the gateway.
## Requirements
### Requirement: Request set is derived from source

The harness SHALL derive the endpoints it exercises from the legacy route surface and the module route
surface as declared in source, and SHALL NOT depend on a hand-maintained list of endpoints. For a given
domain, the request set SHALL be the set of paths both engines claim.

#### Scenario: A newly added module route is exercised automatically
- **WHEN** a module gains a route that legacy also serves
- **THEN** the next harness run includes that path in the request set with no change to the harness

#### Scenario: A module route with no legacy counterpart is excluded and reported
- **WHEN** a module declares a path legacy does not serve
- **THEN** the path is excluded from comparison and reported as additive rather than compared or
  silently dropped

### Requirement: Responses are compared on status, shape, and declared invariants

The harness SHALL compare the two engines' responses by: exact status code; body shape — the same keys
with the same types, recursively, after normalizing volatile fields such as identifiers and timestamps
to type placeholders; and any per-endpoint semantic invariants the domain supplies. Byte equality SHALL
NOT be required.

#### Scenario: Differing ids and timestamps do not fail parity
- **WHEN** both engines return equivalent bodies whose identifiers and timestamps differ
- **THEN** the endpoint passes

#### Scenario: A missing field fails parity
- **WHEN** the module's response omits a key legacy returns, or returns it with a different type
- **THEN** the endpoint fails with the specific path to the differing field

#### Scenario: A status divergence fails parity
- **WHEN** legacy answers 200 and the module answers 401 for the same request
- **THEN** the endpoint fails and both status codes are reported

#### Scenario: Latency is reported but never gates
- **WHEN** the module is slower than legacy on an endpoint
- **THEN** the difference is recorded in the report and the endpoint's verdict is unaffected

### Requirement: The harness refuses to run against production

The harness SHALL refuse to start when its target database matches the configured production host, and
SHALL refuse to start unless the target reports the staging marker written by the seed process. Both
checks SHALL be independent, and failing either SHALL prevent any request from being issued.

#### Scenario: Production database rejected
- **WHEN** the harness is started with a production `DATABASE_URL`
- **THEN** it exits with an error and issues no requests

#### Scenario: Unmarked environment rejected
- **WHEN** the harness is pointed at a database with no staging marker
- **THEN** it exits with an error and issues no requests

### Requirement: Mutating requests are opt-in

The harness SHALL issue only non-mutating requests by default, and SHALL issue mutating requests only
when explicitly enabled.

#### Scenario: Default run is read-only
- **WHEN** the harness runs without the mutation flag
- **THEN** only non-mutating verbs are issued, and mutating endpoints are reported as skipped with that
  reason

#### Scenario: Mutation enabled in staging
- **WHEN** the mutation flag is set against a marked staging target
- **THEN** mutating endpoints are exercised and included in the verdicts

### Requirement: Coverage is reported alongside verdicts

The harness SHALL report, for every run: the endpoints compared with their verdicts, and the endpoints
**not** compared with the reason each was skipped. A run SHALL NOT present verdicts without the
coverage they were drawn from.

#### Scenario: Skipped endpoints are visible
- **WHEN** endpoints are skipped for missing fixtures, disallowed mutation, or absent authentication
- **THEN** each appears in the report with its reason

#### Scenario: Report distinguishes sampled from complete
- **WHEN** a run compares a subset of a domain's endpoints
- **THEN** the report states the compared count against the domain's total, so a partial run cannot read
  as full parity

### Requirement: Staging is seeded from a production snapshot with contact identifiers rewritten

The staging environment SHALL be seeded from a production snapshot by a repeatable process that, as part
of the seed, rewrites every email address to a routable sink address and replaces phone numbers, so no
outbound message from staging can reach a customer. Financial data SHALL be retained unmodified, since
production-shaped data is the reason for the snapshot.

#### Scenario: No production address survives the seed
- **WHEN** the seed completes
- **THEN** no user record holds a production email address or phone number

#### Scenario: Outbound mail is contained
- **WHEN** staging sends a password-reset or notification email
- **THEN** it is delivered to the sink and no customer receives it

#### Scenario: Financial rows are unmodified
- **WHEN** seeded financial data is compared against the snapshot
- **THEN** it matches, so parity comparison runs against real shapes and volumes

### Requirement: Schema drift is reconciled against a recorded baseline

The system SHALL reconcile the introspected snapshot schema against the declared Drizzle schema, and
SHALL record the result as a dated, committed baseline so that later runs distinguish new drift from
known, already-triaged drift.

#### Scenario: New drift is distinguishable
- **WHEN** a reconciliation runs after a baseline exists
- **THEN** differences already present in the baseline are reported separately from differences that
  are new

#### Scenario: Baseline is an artifact, not an observation
- **WHEN** a reconciliation completes
- **THEN** its result is committed to the repository rather than existing only in a run log

### Requirement: The legacy schema file applies to a clean database or is retired

`backend/sql/schema.sql` SHALL either apply successfully to a clean database or be retired in favour of
the Drizzle baseline. The repository SHALL NOT carry a schema file that fails to build the schema it
claims to define.

#### Scenario: Applying the schema file succeeds
- **WHEN** the retained schema file is applied to an empty database
- **THEN** it completes without error

#### Scenario: Retired instead
- **WHEN** the file is retired
- **THEN** the Drizzle baseline is the single declared schema and no stale file remains

### Requirement: Rollback is exercised, not assumed

Before a domain's legacy handlers are deleted, the rollback path SHALL have been exercised
deliberately — the flag turned off and legacy confirmed to serve the route-group again — rather than
inferred from an absence of errors.

#### Scenario: Rollback drill passes
- **WHEN** an enabled domain's flag is turned off in staging
- **THEN** the route-group is served by legacy again, verified by request, and the drill is recorded

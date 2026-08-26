# activity-log Specification

## Purpose
The **capture half** of `SY - 0003`: recording activity as it happens, across both the legacy backend and the migrated modules, into storage whose immutability is demonstrable. The read half — search, filter, export, alerting, and the log's own access control — is specified in the `activity-log` capability sketch (`centuriuum-product-surface`) and deliberately deferred: it can be built over history at any time, and history cannot. Requirements here are implementation-level and additive to that sketch; they do not restate it.
## Requirements
### Requirement: Every request is captured, whichever engine serves it

The system SHALL record a request envelope for every request passing through the gateway, including
requests forwarded to the legacy backend, and SHALL record which engine served each one.

#### Scenario: Legacy-served request is captured
- **WHEN** a request is proxied to the legacy backend
- **THEN** an envelope is recorded identifying the request and the legacy engine

#### Scenario: Module-served request is captured
- **WHEN** a request is served by an in-process module
- **THEN** an envelope is recorded identifying the request and the module engine

#### Scenario: Denied and failed requests are captured
- **WHEN** a request is rejected with 401, 403, or fails with 5xx
- **THEN** an envelope is recorded with that status, as with any other request

### Requirement: Capture never reads the request body

Capture SHALL record only transport metadata — timestamp, method, raw and normalized path, status,
actor, IP, user agent, duration, correlation id, and engine — and SHALL NOT read or buffer request or
response bodies.

#### Scenario: Streaming is unaffected
- **WHEN** a file upload or download passes through the gateway with capture enabled
- **THEN** the body streams through unbuffered and the proxied request is byte-identical to one made
  with capture disabled

#### Scenario: Body content is absent from the record
- **WHEN** a request with a body is captured
- **THEN** the stored record contains no body content

### Requirement: Capture does not alter the response or its timing semantics

Capture SHALL attach after the response completes, SHALL NOT modify status, headers, or body, and a
capture failure SHALL NOT fail the request.

#### Scenario: Capture failure leaves the request intact
- **WHEN** the capture write path errors
- **THEN** the client receives the response it would have received anyway

#### Scenario: Response is unmodified
- **WHEN** capture is enabled
- **THEN** status, headers, and body are identical to the same request with capture disabled

### Requirement: Actor attribution, with anonymous recorded as such

The system SHALL attribute each envelope to the actor asserted by the presented credential, and SHALL
record requests with no credential or an invalid one as anonymous rather than omitting them.

#### Scenario: Authenticated request carries the actor
- **WHEN** a request presents a valid token
- **THEN** the envelope records the asserted subject

#### Scenario: Unauthenticated request is still recorded
- **WHEN** a request presents no credential, or an invalid one
- **THEN** an envelope is recorded as anonymous with the outcome

### Requirement: Semantic events from migrated modules

Migrated modules SHALL emit typed semantic events carrying the same correlation id as their envelope,
covering at minimum: authentication outcomes, permission grant/modify/revoke with the granting user,
document open and download, and integration connect/disconnect.

#### Scenario: A permission grant emits an event
- **WHEN** a module grants a user access to a company or folder
- **THEN** an event records the granting user, the grantee, the scope, and the time

#### Scenario: Event joins its envelope
- **WHEN** a semantic event is recorded
- **THEN** it shares a correlation id with the envelope of the request that produced it

### Requirement: Storage is append-only with no update or delete path

The system SHALL provide no code path to update or delete an activity record — including for
administrators — and the database role used by the application SHALL NOT hold update or delete
privileges on the activity table. Retention deletion SHALL run through a separate privileged path.

#### Scenario: No application path mutates history
- **WHEN** any caller attempts to modify or delete a record through the application
- **THEN** no such operation exists

#### Scenario: A code defect cannot mutate history
- **WHEN** an update or delete is issued against the activity table using the application's database role
- **THEN** the database rejects it

### Requirement: Tamper evidence via hash chain

Each record SHALL carry a hash of its own canonical content and of the preceding record, and the system
SHALL provide a verification pass that detects alteration or removal.

#### Scenario: Altered record is detected
- **WHEN** a stored record's content is changed out of band
- **THEN** verification reports the chain as broken at that record

#### Scenario: Removed record is detected
- **WHEN** a record is deleted out of band
- **THEN** verification reports the chain as broken at that point

#### Scenario: Intact chain verifies
- **WHEN** no records have been altered or removed
- **THEN** verification passes over the full range

### Requirement: Dropped records are recorded as visible gaps

When the capture path sheds load, the system SHALL write a gap marker recording the interval, the
number of records not captured, and the reason. It SHALL NOT drop records silently.

#### Scenario: Overflow produces a gap marker
- **WHEN** the capture buffer overflows
- **THEN** a gap marker records the affected interval, the dropped count, and the reason

#### Scenario: Reader can distinguish quiet from lossy
- **WHEN** a period contains no records
- **THEN** the presence or absence of a gap marker distinguishes "nothing happened" from "capture was
  shedding"

### Requirement: Capture is switchable and its absence is unambiguous

Capture SHALL be enabled by configuration, and disabling it SHALL leave the request path unchanged.
Records written before it was disabled SHALL remain, and the disabled interval SHALL be distinguishable
from a quiet one.

#### Scenario: Disabled capture does not change behavior
- **WHEN** capture is disabled
- **THEN** requests are served exactly as before and no records are written

#### Scenario: Prior records survive
- **WHEN** capture is disabled after records exist
- **THEN** those records remain and remain verifiable

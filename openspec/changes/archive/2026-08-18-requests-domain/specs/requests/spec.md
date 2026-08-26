## Purpose

Broker↔client requests for DataHub: how document/narrative requests are created (single and bulk),
validated, listed, updated, approved, and deleted, how reminder frequency follows priority, and how
a request carries a narrative and links to fulfilling documents. Parity with legacy (reminder
*delivery* is out of scope).

## ADDED Requirements

### Requirement: Validated request creation
The system SHALL create a request only when its title, description, category, response type,
priority, status, and due date are valid, and SHALL derive the reminder frequency from priority.

#### Scenario: Valid create
- **WHEN** an authorized user submits a valid request for a company they can access
- **THEN** it is created with the derived reminder frequency and recorded creator

#### Scenario: Invalid create rejected
- **WHEN** a request has a bad enum value or a malformed/past due date
- **THEN** it is rejected (400) and nothing is created

### Requirement: Tenant-scoped requests
The system SHALL list/return requests only to callers who may access the owning company.

#### Scenario: Cross-tenant denied
- **WHEN** a user lists or reads requests for a company they cannot access
- **THEN** the request is denied

### Requirement: Approval flow
The system SHALL let an authorized user approve a request, recording who approved it and when.

#### Scenario: Approve
- **WHEN** an authorized user approves a request
- **THEN** its approval status becomes approved with the approver and timestamp recorded

### Requirement: Narrative, reminders, and document links
The system SHALL maintain a single narrative per request, an append-only reminder log, and links to
the documents that fulfil it.

#### Scenario: Narrative upsert
- **WHEN** a request's narrative is set and later updated
- **THEN** the latest content is stored (one narrative per request)

#### Scenario: Reminder event
- **WHEN** a reminder is recorded for a request
- **THEN** it is appended to the request's reminder log

#### Scenario: Document link
- **WHEN** a document is linked to a request
- **THEN** it appears in the request's document list

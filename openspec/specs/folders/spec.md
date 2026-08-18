# folders Specification

## Purpose
Workspace folders for DataHub: the per-company folder tree, its default structure, archiving, protected deletion, and the per-folder access grants that decide who can read/write/download. This spec captures the behavior the rebuilt `folders` module must honor at parity with legacy (folders + folder-access only; documents/uploads are a later phase).
## Requirements
### Requirement: Tenant-scoped folder listing and tree

The system SHALL return a company's folders (flat or as a nested tree) only to callers who may access that company, and MAY include or exclude archived folders on request.

#### Scenario: Authorized tree read
- **WHEN** an authorized user requests a company's folder tree
- **THEN** the folders are returned as a parent/child hierarchy

#### Scenario: Archived filter
- **WHEN** the caller opts to include archived folders
- **THEN** archived folders appear; otherwise they are omitted

#### Scenario: Cross-tenant denied
- **WHEN** a user requests folders for a company they cannot access
- **THEN** the request is denied

### Requirement: Create, update, move folders

The system SHALL let authorized users create folders (optionally nested), rename/recolor them, and move them under a new parent.

#### Scenario: Create nested folder
- **WHEN** an authorized user creates a folder with a `parent_id`
- **THEN** it is created under that parent with `created_by` recorded

#### Scenario: Move folder
- **WHEN** an authorized user moves a folder under a different parent
- **THEN** its `parent_id` is updated

### Requirement: Archive and restore (soft delete)

The system SHALL support archiving and unarchiving folders without destroying data.

#### Scenario: Archive then restore
- **WHEN** a folder is archived and later unarchived
- **THEN** `archived_at` is set and then cleared; the folder's contents are unchanged

### Requirement: File-link-protected hard delete

The system SHALL prevent deleting a folder that is linked to another module (e.g. Key Reports) until it is unlinked.

#### Scenario: Linked folder cannot be deleted
- **WHEN** a delete is attempted on a folder linked to a Key Report
- **THEN** it is rejected (409) with a clear "linked" error

#### Scenario: Unlinked folder deletes
- **WHEN** an authorized user deletes an unlinked folder
- **THEN** the folder is removed (cascading to its access grants)

### Requirement: Default-folder provisioning

The system SHALL provision a company's standard folder set idempotently, and SHALL not create duplicates under concurrency.

#### Scenario: Provision on demand
- **WHEN** default folders are ensured for a company that has none
- **THEN** the standard hierarchy is created

#### Scenario: Idempotent under repeat/concurrency
- **WHEN** provisioning runs again (or concurrently)
- **THEN** no duplicate folders are created

### Requirement: Per-folder access grants

The system SHALL let brokers/admins grant access to a folder for exactly one subject — a user OR a group — with independent read/write/download flags.

#### Scenario: Grant to a user
- **WHEN** a broker/admin grants a user `can_read` on a folder
- **THEN** an access record is created for that user with the given flags

#### Scenario: One subject only
- **WHEN** a grant specifies both a user and a group (or neither)
- **THEN** it is rejected (exactly one subject is required)

#### Scenario: Only privileged users manage access
- **WHEN** a non-broker/admin attempts to create/modify/delete an access grant
- **THEN** the request is denied

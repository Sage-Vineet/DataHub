# reports Specification

## Purpose
Key Report *versions* for DataHub: how a company's report versions are listed, created (auto-numbered), read, updated, duplicated, activated, and deleted, and how exactly one version is the official (active) one. This is the first slice of the reports decomposition; the GL computation/sync stays on legacy.
## Requirements
### Requirement: Tenant-scoped version lifecycle
The system SHALL let users who can access a company list and manage that company's key-report versions,
and SHALL deny access to other companies' versions.

#### Scenario: Create and list
- **WHEN** an authorized user creates a version for their company
- **THEN** it is created as a numbered draft and appears in that company's version list

#### Scenario: Cross-tenant denied
- **WHEN** a user reads or manages a version for a company they cannot access
- **THEN** the request is denied

### Requirement: Single official version
The system SHALL keep at most one active (official) version per company; activating one SHALL
deactivate any previously active version.

#### Scenario: Activate deactivates the previous
- **WHEN** a user activates a version while another was active
- **THEN** the newly activated version is active and the previous one is not

### Requirement: Duplicate a version
The system SHALL duplicate a version's name/metadata into a new draft that is not active.

#### Scenario: Duplicate
- **WHEN** a user duplicates a version
- **THEN** a new numbered draft is created with the copied metadata and `is_active = false`

### Requirement: Deferred GL sync
The system SHALL expose the GL sync as a seam that is not yet migrated; invoking it indicates the
computation is still handled by the legacy engine.

#### Scenario: Sync not yet migrated
- **WHEN** a caller triggers a version sync through the module
- **THEN** the module reports the sync is handled by the legacy engine (not implemented here)

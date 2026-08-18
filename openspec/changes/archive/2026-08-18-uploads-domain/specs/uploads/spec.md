## Purpose

File storage and folder documents for DataHub: how a file blob is stored and streamed back,
how documents are attached to a company's folder, listed, archived, and deleted, and how
document activity is recorded. This spec captures the behavior the rebuilt `uploads` module
must honor at parity with legacy (generic uploads + folder documents; manual-GL upload
sessions are a later phase).

## ADDED Requirements

### Requirement: Store and stream a file blob

The system SHALL accept a file upload, persist its bytes and content type, and later stream
the identical bytes back to authorized callers.

#### Scenario: Round-trip
- **WHEN** a file is uploaded and then its content is requested by id
- **THEN** the same bytes and content type are returned

#### Scenario: Unknown upload
- **WHEN** content is requested for an upload id that does not exist
- **THEN** the request is denied (404)

### Requirement: Folder-scoped documents

The system SHALL let authorized users attach a document to a company's folder, list a
folder's documents, and remove a document — enforcing the same tenant access as the folder.

#### Scenario: Add and list
- **WHEN** an authorized user adds a document to a folder and later lists that folder's documents
- **THEN** the document appears with its name, size, extension, and uploader

#### Scenario: Cross-tenant denied
- **WHEN** a user adds or lists documents for a folder in a company they cannot access
- **THEN** the request is denied

### Requirement: Archive and delete documents

The system SHALL support archiving/unarchiving a document (soft delete) and hard-deleting it.

#### Scenario: Archive then restore
- **WHEN** a document is archived and later unarchived
- **THEN** `archived_at` is set and then cleared; it is excluded from the default list while archived

#### Scenario: Delete
- **WHEN** an authorized user deletes a document
- **THEN** it is removed along with its activity records

### Requirement: Document activity log

The system SHALL record and return an append-only activity log for a document.

#### Scenario: Record and read
- **WHEN** an activity event is recorded for a document and the log is then read
- **THEN** the event appears with its actor and action

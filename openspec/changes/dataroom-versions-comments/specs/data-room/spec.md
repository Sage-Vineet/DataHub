## Purpose

The three data room behaviours `DR - 0001` requires and the system does not have: a re-uploaded file
becomes a new version rather than an overwrite or a rename, documents carry comment threads with an
internal/shared split, and large uploads are chunked, resumable, and report progress within the
file. Scoped to observable behaviour; it does not specify the storage backend, which stays
`bytea` behind the existing port.

## ADDED Requirements

### Requirement: Re-upload creates a version, never an overwrite or a rename

The system SHALL create a new version — not an overwrite and not a renamed copy — whenever a file
with the same name is uploaded to a folder that already contains that name. The document SHALL keep
its identity, so every reference held elsewhere in the system continues to resolve, and SHALL track
which version is current and how many exist. (`DR - 0001`)

#### Scenario: Same name uploaded twice
- **WHEN** a user uploads a file whose name already exists in that folder
- **THEN** the document gains a second version, its identity is unchanged, and no renamed copy is
  created

#### Scenario: Existing references keep resolving
- **WHEN** a document that is linked from elsewhere in the system gains a new version
- **THEN** the existing link continues to resolve, and resolves to the current version

### Requirement: Prior versions remain viewable and restorable

The system SHALL list every version of a document with its author, timestamp, size and version
number, SHALL allow any version's content to be viewed, and SHALL allow a prior version to be made
current again. Restoring SHALL append a new version rather than deleting or mutating any existing
one, so version history is append-only. (`DR - 0001`)

#### Scenario: A prior version is readable
- **WHEN** a user opens version 1 of a document that is now at version 3
- **THEN** version 1's content is served

#### Scenario: Restore appends rather than rewrites
- **WHEN** a user restores version 1 of a document at version 3
- **THEN** a version 4 is appended carrying version 1's content, and versions 1 through 3 remain

### Requirement: Every document has at least one version

The system SHALL ensure that any document with stored content has at least one version record, so a
version list is never empty for a document that has content.

#### Scenario: Documents predating versioning still list a version
- **WHEN** a user opens the version history of a document uploaded before versioning existed
- **THEN** a single version is listed rather than an empty list

### Requirement: Documents carry comment threads

The system SHALL allow a user with access to a document to post a comment against it, SHALL record
the author and timestamp, and SHALL display comments in chronological order. A comment MAY be
associated with a specific version.

#### Scenario: A comment is posted and attributed
- **WHEN** a user posts a comment on a document
- **THEN** it appears in that document's thread with the author's identity and a timestamp

### Requirement: Internal comments are visible only to the deal-owning side

Each comment SHALL carry a visibility of either internal or shared. An internal comment SHALL be
readable only by users holding a broker or administrator role; a shared comment SHALL be readable by
any user who can read the document. Visibility SHALL be chosen when the comment is posted.

#### Scenario: A counterparty cannot read an internal comment
- **WHEN** a user without a broker or administrator role reads a document's comments
- **THEN** internal comments are absent from the response, not merely hidden in the interface

#### Scenario: Shared comments are visible to everyone with document access
- **WHEN** any user who can read the document reads its comments
- **THEN** shared comments are returned

### Requirement: Large uploads are chunked and resumable

The system SHALL support uploading a file as an ordered sequence of chunks against an upload session
that records the file's name, type, total size and expected chunk count. Uploading the same chunk
index more than once SHALL be idempotent, so an interrupted upload can resume by sending only the
chunks the server has not recorded. The system SHALL report which chunks it has received.

#### Scenario: An interrupted upload resumes
- **WHEN** an upload is interrupted partway and then resumed
- **THEN** only the chunks not already received are sent, and the completed file is intact

#### Scenario: Re-sending a chunk is harmless
- **WHEN** the same chunk index is sent twice
- **THEN** the second send replaces the first and the received count does not double

### Requirement: Completing a session produces one document version

On completion, the system SHALL assemble the received chunks in index order into a single stored
file, discard the chunk data, and produce either a new document or a new version of an existing
document, according to whether the session named an existing document.

#### Scenario: A session against a new file creates a document
- **WHEN** a session that names no existing document completes
- **THEN** a new document is created in the target folder with version 1

#### Scenario: A session against an existing document appends a version
- **WHEN** a session that names an existing document completes
- **THEN** that document gains a new version and remains the same document

#### Scenario: Chunk data does not outlive the session
- **WHEN** a session completes
- **THEN** its chunk data is discarded and only the assembled file remains

### Requirement: Abandoned upload sessions do not accumulate

The system SHALL expire upload sessions that are neither completed nor aborted, and SHALL reclaim
their chunk data, without depending on a scheduled job.

#### Scenario: A stale session is reclaimed
- **WHEN** a session passes its expiry without completing and further upload activity occurs
- **THEN** the stale session and its chunks are removed

### Requirement: Upload progress is reported within a file, not only across files

The interface SHALL report upload progress in terms of bytes transferred for the file currently
uploading, in addition to how many files of a batch are complete.

#### Scenario: A large file shows moving progress
- **WHEN** a user uploads a file large enough to be chunked
- **THEN** progress advances as bytes are transferred rather than only when the file finishes

### Requirement: The new data room endpoints enforce access on themselves

Every endpoint added by this capability SHALL verify that the requesting user may access the owning
company before returning or modifying anything, and SHALL apply the folder grant predicate to
document-scoped reads.

#### Scenario: A user outside the company is refused
- **WHEN** a user requests versions or comments for a document belonging to a company they cannot
  access
- **THEN** the request is refused

### Requirement: Disabling the capability restores prior behaviour exactly

Where this capability is disabled, the system SHALL behave as it did before it existed, including
the prior handling of a same-name upload, and SHALL expose none of its endpoints or interface
surfaces.

#### Scenario: Flag off falls back to the prior upload path
- **WHEN** the capability is disabled and a file with an existing name is uploaded
- **THEN** the prior behaviour applies and no version is created

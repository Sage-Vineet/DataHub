## Purpose

Closing the half of `QA - 0003` that `deal-qa-module` specified and did not deliver: an
answer's evidence must be reachable, and a respondent must be able to produce it. The
requirements here govern how an attachment binds to the answer it accompanies, how a
respondent chooses where it is filed, and what happens when part of that sequence fails.

## ADDED Requirements

### Requirement: An attachment binds to the answer it accompanies

The system SHALL bind every attachment to a specific response. Where a caller supplies no
response, the system SHALL resolve the item's current answer and bind to that, rather than
recording an attachment bound to nothing. An attachment that is bound to no response SHALL
NOT be treated as successfully recorded, since it can never be returned on any view of the
item. (`QA - 0003`)

#### Scenario: An unnamed response resolves to the current answer
- **WHEN** a document is attached to an item without naming a response
- **THEN** it is bound to that item's current answer and appears on that answer

#### Scenario: A superseded answer keeps the evidence it was given
- **WHEN** an answer carrying an attachment is superseded by a corrected answer
- **THEN** the attachment remains on the answer it was originally bound to

### Requirement: A respondent chooses a destination without leaving the answer

The system SHALL let a respondent attach a file while composing an answer, and SHALL offer a
destination folder chosen from the data room folders that are reachable by normal navigation.
The destination SHALL default to a folder suggested by the item's category and SHALL NEVER
default to empty, because a destination is required and an empty default is an error the
respondent can only discover by failing. (`QA - 0003`)

#### Scenario: The destination is pre-chosen from the category
- **WHEN** a respondent opens the attach control on an item in a given category
- **THEN** a destination folder matching that category is already selected

#### Scenario: An unmatched category still selects a destination
- **WHEN** the item's category matches no folder name
- **THEN** a folder is still selected, and the respondent is never presented with an empty
  destination

#### Scenario: Archived folders are not offered
- **WHEN** the destination list is built
- **THEN** folders excluded from normal navigation are not offered as destinations

### Requirement: The answer is recorded before its evidence is uploaded

The system SHALL record a respondent's answer before uploading any attached file. Where the
upload then fails, the answer SHALL remain on the record and the respondent SHALL be told
that the answer was posted and the file was not. (`QA - 0003`)

#### Scenario: A failed upload does not cost the answer
- **WHEN** a respondent submits an answer with a file and the upload fails
- **THEN** the answer is on the item, and the failure reported concerns the file alone

### Requirement: A failed link never destroys an uploaded document

Where a document uploads successfully but linking it to the answer fails, the system SHALL
retain the document and SHALL NOT delete it to repair the link — it is a correctly-filed data
room document missing only a backlink. The system SHALL offer the link to be retried against
the document already uploaded, and linking SHALL be idempotent so that a retry is safe.
(`QA - 0003`)

#### Scenario: Linking twice records one link
- **WHEN** the same document is attached to the same response twice
- **THEN** one attachment is recorded and the second attempt succeeds

#### Scenario: The document survives a failed link
- **WHEN** the link fails after a successful upload
- **THEN** the document remains in its data room folder and the link can be retried without
  re-uploading

#### Scenario: A failed link is not reported as success
- **WHEN** the link fails after a successful upload
- **THEN** the respondent is told the file was filed but not linked, and is not simultaneously
  told the attachment succeeded

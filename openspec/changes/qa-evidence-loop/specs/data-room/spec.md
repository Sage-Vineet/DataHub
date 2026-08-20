## Purpose

How the data room answers a reference to one document — the receiving half of the link an
answer's evidence now carries. `deal-qa-module` required attached evidence to be
"discoverable from either place"; this is what makes arriving from the Q&A side land on the
document rather than merely in the vicinity of it.

## ADDED Requirements

### Requirement: A document can be opened directly by reference

The system SHALL accept a reference to a single document, navigate to the folder containing
it, select it, and open its preview. The system SHALL resolve the containing folder from the
document's actual ancestor chain rather than from any folder named in the reference, so that a
reference remains correct after the document is moved. (`DR - 0001`, `QA - 0003`)

#### Scenario: A reference opens the document
- **WHEN** the data room is opened with a reference to a document it holds
- **THEN** the containing folder is shown, the document is selected, and its preview opens

#### Scenario: A moved document is still found
- **WHEN** the reference names a folder the document no longer lives in
- **THEN** the document's current folder is used

### Requirement: A reference is acted on once, against real data

The system SHALL act on a reference only after the folder tree has loaded from the server,
never against a locally cached tree from a previous session. The system SHALL act on a given
reference at most once, and SHALL clear it so that reloading or navigating back does not
reopen the document. (`DR - 0001`, `QA - 0003`)

#### Scenario: A stale cached tree is not acted on
- **WHEN** a reference arrives before the folder tree has loaded
- **THEN** no navigation occurs until the loaded tree is available

#### Scenario: Reloading does not replay the reference
- **WHEN** the page is reloaded after a reference has been acted on
- **THEN** the document is not reopened

#### Scenario: A background refresh does not reopen the preview
- **WHEN** the folder tree reloads while the viewer is elsewhere in the data room
- **THEN** the preview does not reopen

### Requirement: An unresolvable reference does not disclose what it referred to

Where a reference names a document the viewer cannot see or that no longer exists, the system
SHALL report that the file is not in this data room, and SHALL NOT disclose the document's
name or distinguish "does not exist" from "you may not see it". (`DR - 0001`, `QA - 0003`)

#### Scenario: An unresolvable reference is reported without disclosure
- **WHEN** a reference cannot be resolved
- **THEN** the viewer is told the file is not in this data room, and is told neither its name
  nor whether it exists

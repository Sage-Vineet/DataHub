## Purpose

Who can see and change what inside a deal's data room. Enforcement of per-folder grants already
exists in shipped code — a client sees a narrower document count than the broker on the same room —
but there is no interface anywhere that sets or reveals it, and the client's write scope is the
whole room rather than the folders they were asked to fill.

This delta makes access a thing a broker can express, and narrows contribution to match how a
broker-run process actually works.

## ADDED Requirements

### Requirement: Folder access is granted and revoked from the folder

The system SHALL allow a user who administers a deal to grant and revoke access to a folder for a
person or a role, from the folder itself, and SHALL show the current grants on that folder without
requiring the reader to open another screen.

A grant SHALL apply to the folder's contents, including folders created inside it after the grant
was made. Revoking a grant SHALL remove access to those contents.

#### Scenario: A folder is opened to a person

- **WHEN** a deal administrator grants a person access to a folder
- **THEN** that person can see the folder and its contents
- **AND** the grant is visible on the folder to anyone who administers the deal

#### Scenario: A grant does not reach above itself

- **WHEN** a person is granted access to a folder
- **THEN** they gain no access to that folder's parent or to sibling folders

#### Scenario: A grant covers content added later

- **WHEN** a document is added to a folder that a person already has access to
- **THEN** that person can see the new document without a further grant

#### Scenario: Access is revoked

- **WHEN** a grant is revoked
- **THEN** the person can no longer see the folder or its contents

#### Scenario: Grants do not cross deals

- **WHEN** a grant is attempted for a user who is not a member of the deal
- **THEN** the grant is refused

### Requirement: A document reveals who can see it

The system SHALL show, for any document, which people and roles can currently see it, resolved
through the grants on the folders that contain it.

The broker's question is "why can this bidder see that file". It SHALL be answerable from the
document, not reconstructed by reading the folder tree.

#### Scenario: Inherited access is shown on the document

- **WHEN** a user who administers a deal views a document's access
- **THEN** the people and roles who can see it are listed
- **AND** the folder grant each one derives from is identified

### Requirement: Contribution is a level of access, not a role

The system SHALL support granting a person the ability to add documents to a folder without the
ability to change the room's structure or remove content. A contributor SHALL be able to upload
into folders granted to them, and SHALL NOT be able to create, rename, move, archive or delete
folders or documents.

Expressing the seller's narrowed scope as a grant level rather than a role check keeps one
authorization path rather than two, and lets the same mechanism serve buyers later.

#### Scenario: A contributor uploads

- **WHEN** a contributor uploads a document into a folder granted to them
- **THEN** the upload succeeds

#### Scenario: A contributor cannot restructure the room

- **WHEN** a contributor attempts to create, rename, move, archive or delete a folder or document
- **THEN** the action is refused and the affordance is not offered

#### Scenario: A contributor cannot reach ungranted folders

- **WHEN** a contributor attempts to upload into a folder they have no grant on
- **THEN** the upload is refused

## MODIFIED Requirements

### Requirement: Staged disclosure is expressible through the interface

The system SHALL allow a broker to open one set of folders to one group and a further set to a
narrower group, entirely through the interface, without editing data directly.

This is the defining act of running a data room — phase one to all bidders, phase two to the
shortlist — and is the capability the current interface cannot express at all.

#### Scenario: Two phases are staged

- **WHEN** a broker grants one group access to a first set of folders, and a narrower group access
  to a second set
- **THEN** each group sees exactly the folders granted to it
- **AND** neither set of grants affects the other

#### Scenario: The narrower group is widened later

- **WHEN** the broker grants the wider group access to the second set of folders
- **THEN** that group gains access to it without any existing grant being disturbed

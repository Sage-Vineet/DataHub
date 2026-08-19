## Purpose

The system of record for formal, trackable questions and answers on a deal (`QA - 0001`, `QA - 0002`,
`QA - 0003`): who asked what of whom, who is accountable for answering, what was answered, how that
answer changed over time, and what the broker chose to present onward. Nothing of this exists today,
so every requirement here is new behaviour rather than a migration of existing behaviour.

Three requirements below depart from the source documents by explicit decision — seller nomination,
broker rewording, and answer versioning. Each is reconciled with the specification it departs from
rather than overriding it; see `proposal.md`.

## ADDED Requirements

### Requirement: Q&A items belong to a deal and a category

The system SHALL allow a user with access to a deal to create a Q&A item consisting of a question,
a category, and a target, scoped to exactly one company. Categories SHALL be per-company records
rather than a fixed global list, so that a category can carry deal-specific configuration. No user
SHALL see or address a Q&A item belonging to a deal they cannot access. (`QA - 0003`)

#### Scenario: An item is created against a category
- **WHEN** a user with deal access creates a Q&A item in a category
- **THEN** the item is recorded against that company and category

#### Scenario: Items do not cross deals
- **WHEN** a user requests Q&A items for a company they cannot access
- **THEN** the request is refused and no item is returned

### Requirement: Items carry one requestor and one or more requestees

The system SHALL record exactly one requestor and one or more requestees per item, defaulting the
requestor to the creating user, and SHALL record the date asked and, on the first answer, the date
answered. All current requestees and the requestor SHALL be visible on every view of the item.
(`QA - 0001`, `QA - 0003`)

#### Scenario: Parties and dates are captured automatically
- **WHEN** an item is created
- **THEN** the requestor and date asked are recorded without the creator supplying them

#### Scenario: Date answered is set once
- **WHEN** the first answer is submitted
- **THEN** the date answered is recorded, and a later answer does not overwrite it

### Requirement: The seller nominates who answers a category

The system SHALL allow a company to nominate one or more of its own users as the default answerers
for a category on its deal. When an item is created in a category that has nominees, those nominees
SHALL become its requestees without the asker choosing them.

This extends rather than replaces broker assignment: the nomination supplies a default, and the
reassignment behaviour below continues to apply unchanged. (departure from `QA - 0001`, reconciled)

#### Scenario: A nominated answerer is assigned automatically
- **WHEN** an item is created in a category that has a nominee
- **THEN** that nominee is a requestee on the item without the asker naming them

#### Scenario: A nomination is a default, not a lock
- **WHEN** an item created from a nomination is later reassigned
- **THEN** the reassignment succeeds and is recorded

### Requirement: Assignment is deal-scoped, reassignable by any member, and logged

The system SHALL restrict requestor and requestee selection to users who are active members of the
same deal. Any user with access to the deal SHALL be able to reassign the requestees of an existing
item regardless of who created it, and every assignment change SHALL be recorded with the prior
assignees, the new assignees, the acting user, and a timestamp. (`QA - 0001`)

#### Scenario: Off-deal assignment is refused
- **WHEN** a user attempts to assign someone who is not an active member of the deal
- **THEN** the assignment is refused

#### Scenario: Reassignment history records who, when, and from what to what
- **WHEN** a deal member reassigns an item
- **THEN** the history shows the acting user, the timestamp, and both the prior and new assignees

### Requirement: Items filter by the viewer's relationship to them

The system SHALL allow a user to view Q&A items filtered to those they raised and those assigned to
them, separately, and to filter by category and status. (`QA - 0001`)

#### Scenario: Raised-by-me and assigned-to-me are separable views
- **WHEN** a user filters their Q&A view by relationship
- **THEN** items they raised and items assigned to them are shown separately

### Requirement: A thread preserves the exchange in one item

The system SHALL support threaded follow-up responses on a single item, preserving the full exchange
in chronological order under that item rather than spawning disconnected items. (`QA - 0003`)

#### Scenario: A follow-up appends rather than forking
- **WHEN** a follow-up response is posted
- **THEN** it appends to the same item's thread in chronological order

### Requirement: A posted response is never edited or deleted

Once posted, a response's text SHALL NOT be modified or removed by any user, including its author,
through any route. Each response SHALL receive a permanent citation reference at the moment it is
posted, unique across the system and independent of the item's own identifier, so a specific
response can be cited rather than only a thread. (`QA - 0002`)

#### Scenario: Editing is refused at the system level
- **WHEN** any user attempts to change the text of a posted response
- **THEN** the attempt is refused, and posting a further response instead succeeds

#### Scenario: Each response is individually citable
- **WHEN** a response is posted
- **THEN** it receives its own permanent citation reference, distinct from the item's

### Requirement: A corrected answer supersedes rather than replaces

The system SHALL allow a respondent to supersede their own earlier answer with a corrected one,
recording the new answer as a further response that references the answer it supersedes and carries
an incremented version number. Every superseded version SHALL remain readable with its original
citation reference and timestamp, and the system SHALL identify which version is current.

Because no version is ever destroyed, a narrative citing an earlier version continues to resolve.
(departure from `QA - 0002`, reconciled)

#### Scenario: Correcting an answer preserves the original
- **WHEN** a respondent supersedes their earlier answer
- **THEN** the new version becomes current and the earlier version remains readable at its own
  citation reference

#### Scenario: Exactly one version is current
- **WHEN** an answer has been superseded twice
- **THEN** exactly one of its versions is marked current

### Requirement: The broker may author a presentable version of an answer

The system SHALL allow a broker to author a reworded, presentation-ready version of a specific
response, stored separately from that response, attributed to its author, and versioned on its own
counter. Authoring or revising a presentable version SHALL NOT alter the response it derives from,
and both SHALL be viewable together so a reviewer can compare them.

A presentable version SHALL be marked draft or published, and only a published one SHALL be offered
to any downstream consumer. (departure noted, reconciles with `QA - 0002` immutability)

#### Scenario: Rewording leaves the respondent's words intact
- **WHEN** a broker authors a presentable version of an answer
- **THEN** the original response text is unchanged and both are visible together

#### Scenario: Only published rewordings travel onward
- **WHEN** a downstream consumer requests presentable content for an item
- **THEN** only published presentable versions are offered

### Requirement: Answers accept text, an attached document, or both

The system SHALL allow a respondent to reply with text, one or more uploaded documents, or both. At
upload time the system SHALL require the respondent to choose a destination folder in the data room
before the upload completes, and SHALL link the resulting document to both its data room location
and the originating item, so it is discoverable from either. (`QA - 0003`)

#### Scenario: A destination folder is required
- **WHEN** a respondent attaches a document to an answer
- **THEN** a data room destination folder must be chosen before the upload completes

#### Scenario: The document is reachable from both sides
- **WHEN** a document is attached to an answer
- **THEN** it appears in the data room folder and on the Q&A item

#### Scenario: Attachment is unavailable rather than broken when the data room is disabled
- **WHEN** the data room capability is disabled and a respondent attempts to attach a document
- **THEN** the attachment route reports the capability as unavailable, and text answers continue to
  work

### Requirement: Status and source of origin are tracked

The system SHALL track a status per item of open, answered, follow-up or closed, changeable by the
requestor or an authorized role, and SHALL tag each item with whether it was created manually,
generated by the reconciling-item generator, or generated by guided CIM Q&A. (`QA - 0003`)

#### Scenario: Origin is recorded for downstream reporting
- **WHEN** an item is created by a user, by the generator, or by guided CIM Q&A
- **THEN** its source of origin is recorded accordingly

### Requirement: Default visibility follows deal roles, with a per-item override

The system SHALL apply the deal's standard role-based permissions by default to determine who may
view an item, and SHALL allow the requestor, broker or company owner to hide a specific item from
named users or role groups independent of their standard deal access, without disturbing that access
elsewhere. (`QA - 0003`)

#### Scenario: The default needs no configuration
- **WHEN** a new item is created
- **THEN** its visibility matches the viewer's standard deal role permissions with no extra setup

#### Scenario: Hiding one item disturbs nothing else
- **WHEN** a requestor hides an item from a named user
- **THEN** that user no longer sees the item and retains their access to everything else

### Requirement: Items carry structured module metadata

The system SHALL tag every item with a module, a section or topic, and where applicable an account
reference, populated on the server without requiring the asker or respondent to tag it. An item
originating from a generated question SHALL inherit that question's context directly. An item with
no supplied context SHALL receive an explicit unclassified tag rather than being omitted from the
tagging pipeline. (`QA - 0002`)

#### Scenario: Generated questions inherit their context
- **WHEN** an item is created by a generator that supplies module and section context
- **THEN** it is tagged with that context without user action

#### Scenario: Ambiguous items are tagged, not dropped
- **WHEN** a manually created item has no supplied context
- **THEN** it receives an unclassified tag rather than no tag

### Requirement: Q&A activity is recorded on the platform audit trail

The system SHALL record item creation, response posting, assignment change, and presentable-version
publication on the platform activity log, each carrying the acting user and a timestamp.

#### Scenario: The exchange is auditable end to end
- **WHEN** an item is created, answered, reassigned and its rewording published
- **THEN** each of those events is present on the activity log with actor and timestamp

### Requirement: Notifications are emitted, not delivered

The system SHALL emit a notification event on assignment, reassignment and answer, for a platform
notifications hub to consume, and SHALL NOT implement its own email or delivery mechanism.
(`QA - 0001`)

#### Scenario: No bespoke Q&A mailer exists
- **WHEN** an assignment or answer occurs
- **THEN** an event is emitted for the hub to consume and no email is sent directly by this
  capability

## Purpose

The diligence question-and-answer surface of a deal: who asked what of whom, what was answered, and how
those answers become citable evidence inside other modules' narratives. Covers `QA - 0001` (User Based
Tracking), `QA - 0002` (Linking to Other Modules), and `QA - 0003` (Q&A Module Purpose).

**Fidelity: specified.** Requirements are drawn from the three `QA` feature specifications (Josh
Tonnesen, 14 Aug 2026).

**ID note.** `QA - 0003` was previously a dangling reference with no row in the product list; it now
exists as the Q&A module purpose specification and is covered here.

## ADDED Requirements

### Requirement: Q&A items carry one requestor and one or more requestees

The system SHALL allow any user with access to a deal — broker, QoE provider, company, buyer, bank,
accountant, per their standard role permissions — to create a Q&A item consisting of a question and a
target, designating exactly one requestor and one or more requestees at creation. The requestor SHALL
default to the creating user and SHALL be reassignable to another user on the same deal before or after
creation. The system SHALL record, per item, the requestor, the requestee, the date asked, the date
answered, and the answer text, recording the date answered automatically when the first answer is
submitted. (`QA - 0001`, `QA - 0003`)

#### Scenario: Item records its parties and dates
- **WHEN** a user with deal access creates a Q&A item specifying a requestee
- **THEN** requestor, requestee, and date asked are recorded automatically

#### Scenario: Date answered is captured on first answer
- **WHEN** the first answer is submitted
- **THEN** the date answered is recorded automatically

### Requirement: Assignment is deal-scoped, reassignable, and logged

The system SHALL restrict requestor and requestee selection to users who are active members of the same
deal, with no cross-deal assignment. Any user with access to the deal SHALL be able to reassign the
requestee(s) on an existing item at any time regardless of who created it, and every assignment and
reassignment SHALL be logged capturing prior requestee(s), new requestee(s), the user who made the
change, and a timestamp. All current requestees and the requestor SHALL be displayed on every item view
along with current assignment status. (`QA - 0001`)

#### Scenario: Off-deal assignment is blocked
- **WHEN** a user attempts to assign someone who is not an active member of the deal
- **THEN** the assignment is blocked

#### Scenario: Reassignment history shows who, when, and from→to
- **WHEN** a deal member reassigns the requestee(s)
- **THEN** the assignment history shows the acting user, the timestamp, and the prior and new assignees

### Requirement: Q&A items filter by the viewer's relationship to them

The system SHALL allow filtering and viewing of Q&A items by "items where I am requestor" and "items
where I am requestee". (`QA - 0001`)

#### Scenario: Raised-by-me and assigned-to-me views
- **WHEN** a user filters their Q&A view
- **THEN** they can see items assigned to them and items they raised, separately

### Requirement: Q&A notifications route through the notifications hub

The system SHALL trigger a notification event on assignment, reassignment, and answer/resolution, routed
through the platform notifications hub rather than a standalone email mechanism built for Q&A.
(`QA - 0001`)

#### Scenario: No bespoke Q&A mailer
- **WHEN** an assignment, reassignment, or resolution occurs
- **THEN** a notification event is emitted to the notifications hub integration point rather than an
  email sent directly from the Q&A module

### Requirement: Answers accept text, documents, or both, filed into the data room

The system SHALL allow the requestee, or any user permitted to respond, to reply with text, an uploaded
document, or both. At time of upload the system SHALL present a folder picker and SHALL require the
uploader to select a destination folder in the data room before the upload completes, and SHALL store a
reference linking the uploaded document to both its data room location and the originating Q&A item, so
it is discoverable from either place. (`QA - 0003`)

#### Scenario: Upload requires a destination folder
- **WHEN** a respondent attaches a document to an answer
- **THEN** a data room destination folder must be selected before the upload completes

#### Scenario: Document is discoverable from both sides
- **WHEN** a document is attached to an answer
- **THEN** it is visible both in the data room and from the Q&A item

### Requirement: Threads preserve the back-and-forth in one item

The system SHALL support threaded follow-up replies on a single Q&A item, preserving the full
back-and-forth in chronological order under that item rather than spawning disconnected new items.
(`QA - 0003`)

#### Scenario: Follow-up appends to the thread
- **WHEN** a follow-up reply is posted
- **THEN** it appends to the same item's thread in chronological order rather than creating a new item

### Requirement: Item status and source of origin are tracked

The system SHALL track a status per Q&A item — Open, Answered, Follow-Up, Closed — allowing the
requestor or an authorized role to change it, and SHALL tag each item with its source of origin:
manually created, generated by `QE - 0015`, or generated by `CM - 0004` Guided Q&A. (`QA - 0003`)

#### Scenario: Origin is recorded for downstream reporting
- **WHEN** an item is created by a user, by `QE - 0015`, or by `CM - 0004`
- **THEN** its source of origin is tagged accordingly

### Requirement: Default visibility follows deal roles, with a per-item override

The system SHALL apply the deal's standard role-based permissions by default to determine who can view a
given Q&A item, and SHALL allow the item's requestor, or the broker/company owner, to override that by
hiding a specific item from one or more named users or role groups independent of those users' standard
deal access. No user SHALL view Q&A items belonging to a deal or company they do not have access to.
(`QA - 0003`, depends on `SY - 0001` / `SY - 0002`)

#### Scenario: Default needs no configuration
- **WHEN** a new Q&A item is created
- **THEN** its visibility matches the viewer's standard deal role permissions with no extra setup

#### Scenario: Hiding one item does not disturb other access
- **WHEN** a requestor hides an item from a named user
- **THEN** that user no longer sees the item and retains standard access to everything else

### Requirement: Every Q&A item is tagged with structured module metadata

The system SHALL tag every Q&A item at creation with structured metadata: Module (QE, VL, CM, RP),
Section/Topic (Working Capital, Customer Concentration, EBITDA Bridge), and where applicable an
Account/COA reference traceable to `DB - 0003`. The system SHALL auto-populate this metadata on the
backend without requiring the requestor or respondent to tag the item in the UI. An item originating
from a system-generated question — such as the variance-driven questions in `QE - 0015` — SHALL inherit
that question's originating module, section, and account reference directly rather than re-deriving
them. A manually created item with no system-supplied context SHALL receive a best-effort Module/Section
tag from the structured taxonomy, defaulting to "Unclassified / General" where no confident match
exists, so no item is silently dropped from the tagging pipeline. (`QA - 0002`)

#### Scenario: Generated questions inherit their context
- **WHEN** a Q&A item is created through the `QE - 0015` generator
- **THEN** it is tagged with the correct Module, Section, and Account without user action

#### Scenario: Ambiguous manual items are tagged, not dropped
- **WHEN** a manually created item has no system-supplied context and no confident taxonomy match
- **THEN** it receives an "Unclassified / General" tag rather than being omitted

### Requirement: Retrieval is tag-narrowed, deal-scoped, and permission-aware

The system SHALL expose an internal retrieval service that, given a target module and section/topic,
returns the set of Q&A items — question, answer, respondent, timestamp, Q&A ID — tagged to that
module/section for the current deal only, ranked by relevance within that tagged pool. Candidate ranking
SHALL be restricted to items already narrowed by structured tag match; the service SHALL NOT perform an
untagged full-corpus semantic search across all Q&A items on the deal. Retrieval SHALL apply the same
deal/company isolation as every other module, and SHALL respect role-based visibility rules so a
narrative-drafting feature cannot surface a response to a role not otherwise permitted to see it.
(`QA - 0002`, depends on `SY - 0001` / `SY - 0002`)

#### Scenario: Retrieval returns only the tagged, in-deal pool
- **WHEN** the retrieval service is called for a module and section
- **THEN** only items tagged to that module/section on the current deal are returned, and nothing from
  another deal or company

#### Scenario: Retrieval cannot launder permissions
- **WHEN** a narrative-drafting feature retrieves Q&A for a role that may not see a given response
- **THEN** that response is not returned

### Requirement: Posted responses are immutable and individually citable

Once a Q&A response is posted, the system SHALL NOT allow its text to be edited or deleted by any user,
including the original respondent, while allowing additional follow-up responses on the same thread each
retaining its own immutable identity and timestamp. The system SHALL assign a unique, permanent citation
ID to every individual response at the moment it is posted — independent of the question's own ID — so a
specific response, not just a thread, can be cited. (`QA - 0002`)

#### Scenario: Edits are blocked, follow-ups are not
- **WHEN** a user attempts to edit a previously posted response, then posts a follow-up instead
- **THEN** the edit is blocked at the system level and the follow-up succeeds with its own citation ID

### Requirement: Narratives cite Q&A responses inline and link back to them

Any downstream feature drafting narrative text from one or more Q&A responses SHALL render an inline
citation tag at the point in the text the sourced content supports, and SHALL attach a source list
mapping each tag to its Q&A response ID. Each citation tag SHALL be a clickable link opening the
originating thread at the cited response. Because original responses are immutable, a later follow-up on
a cited thread SHALL NOT block, invalidate, or force re-generation of an existing narrative.
(`QA - 0002`)

#### Scenario: Citations resolve to the specific response
- **WHEN** a generated narrative displays an inline citation tag and the reader clicks it
- **THEN** the correct, specific Q&A response opens

#### Scenario: A follow-up does not invalidate a narrative
- **WHEN** a cited thread receives a new follow-up response
- **THEN** the existing narrative remains valid and is not forced to regenerate

### Requirement: Retrieval and citation events are logged

The system SHALL log every citation event — which narrative, which section, which Q&A response ID, when,
and generated by whom or what — and every retrieval call to the platform activity log. (`QA - 0002`,
feeds `SY - 0003`)

#### Scenario: Citation provenance is auditable
- **WHEN** a narrative cites a Q&A response or a retrieval call is made
- **THEN** the activity log records narrative ID, section, Q&A response ID, and timestamp

### Requirement: Q&A is available to other modules without knowing their display

The system SHALL make Q&A items and their answers available for reference and linking by other modules —
QoE, Reports — through the `QA - 0002` retrieval service, without this capability needing to know how
each consuming module displays them. (`QA - 0003`)

#### Scenario: Consumers integrate through one service
- **WHEN** a QoE or Reports surface needs the Q&A for a topic
- **THEN** it reads the retrieval service rather than a module-specific integration

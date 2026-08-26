## Purpose

The seller's side of the Q&A capability. `deal-qa-module` built the record — items, categories,
nominated answerers, insert-only responses, answer versioning, broker presentable versions — and
built a client-facing page for it at `/client/qa`. What it did not build is any way for the seller
to reach that page.

These requirements are written as ADDED rather than MODIFIED because `deal-qa-module` sits at 49/1
and its baseline has not yet synced into `openspec/specs/`. They are a strict addition to it, not a
correction of it.

## ADDED Requirements

### Requirement: A person assigned a question can reach it from their own navigation

The system SHALL provide every user who can be assigned a Q&A item with a navigable route to the
items assigned to them, from the navigation of the workspace they log in to.

Observed today: `/client/qa` renders correctly — it lists what is still to answer, offers an Answer
action, and separates already-answered items — and appears in no navigation and on no dashboard.
A question can be asked, categorised, and routed to a nominee who has no path to it. The capability
is closed end to end.

#### Scenario: The assignee navigates to their questions

- **WHEN** a user who has been assigned a Q&A item opens their workspace
- **THEN** a navigation entry leads to the items assigned to them

#### Scenario: Waiting questions are surfaced without navigating

- **WHEN** a user has unanswered Q&A items assigned to them
- **THEN** the count is shown on the landing surface of their workspace

#### Scenario: The loop closes

- **WHEN** a broker creates an item in a category with a nominee, and the nominee answers it from
  their own workspace without being sent a link
- **THEN** the answer is recorded against the item and visible to the broker

### Requirement: A user's assigned items are listed by the server

The system SHALL provide a listing scoped to the items assigned to the calling user, rather than
requiring a client to retrieve a company's items and filter them locally.

#### Scenario: Only assigned items are returned

- **WHEN** a user requests the Q&A items assigned to them
- **THEN** only items on which they are a requestee are returned

#### Scenario: The listing respects deal access

- **WHEN** a user requests assigned items for a company they cannot access
- **THEN** the request is refused

### Requirement: A category without a nominee is flagged

The system SHALL indicate when a Q&A category has no nominated answerer, wherever nominations are
managed.

Observed today: Finance and Legal are nominated; Compliance, HR, Tax, M&A and Other are not, with
no indication of where an item created in those categories is routed.

#### Scenario: An unassigned category is visible as such

- **WHEN** a user views the nomination surface for a deal
- **THEN** categories with no nominee are identifiable

### Requirement: A Q&A listing shows age and party

The system SHALL show, for every item in a Q&A listing, when it was asked and who is accountable
for answering it, and SHALL order the listing predictably.

The data exists — the item detail shows the dates — so this is an omission in the listing rather
than in the record. In a capability whose central question is how long something has been
outstanding, a list without dates cannot be triaged.

#### Scenario: Items carry their dates in the list

- **WHEN** Q&A items are listed
- **THEN** each shows when it was asked, and its age is derivable without opening it

#### Scenario: The party column is identified

- **WHEN** a listing shows a person against an item
- **THEN** the column states whether that person is the asker or the answerer

#### Scenario: Ordering is predictable

- **WHEN** Q&A items are listed
- **THEN** they appear in a stated order, and the order can be changed by the reader

### Requirement: An item awaiting a follow-up is not reported as answered

The system SHALL NOT report an item as answered where the most recent message on it is an
unanswered question.

Observed today: a thread whose last message is a broker follow-up — "can you send the termination
letter for the file?" — is listed as `Answered`, while the Follow-up counter for the deal reads 0.

#### Scenario: A follow-up reopens the item

- **WHEN** a further question is posted on an answered item
- **THEN** the item is reported as awaiting a response
- **AND** it is counted in the follow-up total

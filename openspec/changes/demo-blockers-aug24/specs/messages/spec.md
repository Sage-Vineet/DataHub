## Purpose

The direct-messaging surface of a deal: who a user may message within a company, and the
conversation between two of them. This delta restores one behaviour that exists in the legacy
handler (`backend/src/routes/messages.js:19`) but was dropped when the module was rewritten in
TypeScript — the contacts listing. Without it the whole messaging capability is unreachable for
both roles, because the SPA loads contacts before it can render anything.

## ADDED Requirements

### Requirement: A deal's messageable contacts can be listed

The system SHALL provide a listing of the users a caller may exchange direct messages with inside
a given company, and SHALL resolve that listing at a path segment that cannot be confused with a
recipient identifier. A caller without access to the company SHALL be refused.

The listing is the entry point to the capability: every messaging view requests it first, so a
failure here disables direct messaging entirely rather than degrading it.

#### Scenario: Contacts are listed for a deal the caller can access

- **WHEN** a user with access to a company requests that company's messageable contacts
- **THEN** the deal's members are returned, and the request succeeds

#### Scenario: The contacts path is not treated as a recipient

- **WHEN** the contacts listing is requested
- **THEN** it resolves to the contacts listing
- **AND** it is never interpreted as a conversation with a recipient named `contacts`

#### Scenario: Contacts do not cross deals

- **WHEN** a user requests contacts for a company they cannot access
- **THEN** the request is refused and no user is returned

#### Scenario: Requesting a conversation still works

- **WHEN** a user requests the conversation with a specific recipient in a company they can access
- **THEN** the conversation between the two users is returned

## MODIFIED Requirements

### Requirement: Direct messaging degrades visibly rather than silently

The system SHALL NOT present a failed contacts lookup as an absence of contacts. When the listing
cannot be retrieved, the interface SHALL say that it failed and offer a retry.

Today a server failure renders as "No message groups yet", advising the reader to ask their broker
to add users — shown to the broker, in their own workspace, on a deal that already has members.
An empty result and a failed request are different states and SHALL read differently.

#### Scenario: The listing fails

- **WHEN** the contacts listing returns an error
- **THEN** the interface reports that contacts could not be loaded and offers a retry
- **AND** does not claim there are no contacts

#### Scenario: The deal genuinely has no other members

- **WHEN** the contacts listing succeeds and contains no other users
- **THEN** the interface says so, in copy addressed to the role that is reading it

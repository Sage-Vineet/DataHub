# messages Specification

## Purpose
In-app messaging for DataHub: per-company conversations, 1:1 direct messages, and topic message-groups with membership and unread tracking. Parity with legacy (auto-created groups and thread/contacts aggregations are out of scope).
## Requirements
### Requirement: Company conversation
The system SHALL let users who can access a company read and post that company's conversation.

#### Scenario: Post and read
- **WHEN** an authorized user posts to a company's conversation and then reads it
- **THEN** the message appears in chronological order with its sender

#### Scenario: Cross-tenant denied
- **WHEN** a user reads or posts to a company they cannot access
- **THEN** the request is denied

### Requirement: Direct messages
The system SHALL provide a symmetric 1:1 conversation within a company between two users.

#### Scenario: Symmetric conversation
- **WHEN** A messages B and B messages A within a company
- **THEN** both directions appear in the single A↔B conversation, in order

### Requirement: Message groups and membership
The system SHALL let authorized users create groups, manage membership, and restrict group messages to members.

#### Scenario: Members only
- **WHEN** a non-member (without a company management role) tries to read or post to a group
- **THEN** the request is denied

#### Scenario: Manage membership
- **WHEN** an authorized user adds or removes a group member
- **THEN** the membership list reflects the change

### Requirement: Unread tracking
The system SHALL track per-user unread counts for a group via a read watermark.

#### Scenario: Mark read resets unread
- **WHEN** a user marks a group read after new messages arrive
- **THEN** their unread count for that group becomes zero

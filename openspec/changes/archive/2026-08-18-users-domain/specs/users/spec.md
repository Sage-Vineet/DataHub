## Purpose

User management for DataHub: who can see and manage which users, how accounts are created/updated/deleted, how a user's effective role and company memberships are computed, and how broker teams work. This spec captures the behavior the rebuilt `users` module must honor at parity with legacy.

## ADDED Requirements

### Requirement: Tenant-scoped user visibility

The system SHALL show a user only to themselves, to admins, and to brokers/admins who share a company with them.

#### Scenario: Broker sees users in their companies
- **WHEN** a broker lists or reads users
- **THEN** they see themselves and users associated with their assigned companies, not users from other tenants

#### Scenario: Admin sees all
- **WHEN** an admin lists users
- **THEN** all users are returned

### Requirement: Role/sub-role-gated creation

The system SHALL let only brokers/admins create users, and SHALL prevent brokers from creating admins or top-level brokers.

#### Scenario: Broker creates a team member
- **WHEN** a broker creates a user with a broker-team sub-role (e.g. `broker_team_member`, `banker`, `loan_broker`) or a buyer
- **THEN** the account is created and a welcome email + in-app notification are dispatched (best-effort, non-fatal)

#### Scenario: Broker cannot create an admin
- **WHEN** a broker attempts to create an `admin` or a top-level `broker`
- **THEN** the request is rejected (403)

### Requirement: Guarded updates

The system SHALL restrict what non-admins can change, require the current password for self password changes, and invalidate the auth cache on update.

#### Scenario: Broker cannot change roles
- **WHEN** a broker updates a user
- **THEN** profile/company fields may change but `role` cannot, and company assignment is limited to the broker's own companies

#### Scenario: Self password change
- **WHEN** a user changes their own password
- **THEN** the current password must be supplied and verified before the new one is stored (bcrypt)

#### Scenario: Cache invalidation
- **WHEN** a user is updated
- **THEN** that user's cached session data is invalidated so the next request reflects the change

### Requirement: Delete with reassignment

The system SHALL refuse to delete a user when no replacement owner is available, and otherwise reassign the deleted user's records to a replacement.

#### Scenario: No replacement available
- **WHEN** deleting a user for whom no admin/broker replacement exists in a shared company
- **THEN** the deletion is rejected (400) and nothing is changed

#### Scenario: Reassign then delete
- **WHEN** a valid replacement exists
- **THEN** the user's `created_by`/`uploaded_by` records (folders, requests, documents, activity, reminders) are reassigned to the replacement, company links are cleaned up, and the user is deleted — atomically

### Requirement: Company membership management

The system SHALL let authorized users add/remove a user's company associations, with brokers limited to their own companies.

#### Scenario: Broker adds within scope
- **WHEN** a broker adds a user to one of the broker's own companies
- **THEN** the association is created

#### Scenario: Broker blocked out of scope
- **WHEN** a broker adds a user to a company they don't control
- **THEN** the request is rejected

### Requirement: Broker-team invitations

The system SHALL let a broker invite another broker to their team and remove them.

#### Scenario: Invite and remove
- **WHEN** a broker invites another broker
- **THEN** a team-invite association is recorded; removing it deletes the association

### Requirement: Effective-role computation

The system SHALL compute each user's `effective_role` consistently with legacy (admin, broker, client, or user), including client-team restrictions.

#### Scenario: Client sub-roles resolve to client
- **WHEN** a buyer has a client-side sub-role (`company_owner`, `client_team_member`, `client_accountant`) or matches a company contact email
- **THEN** their effective role is `client`

#### Scenario: Client-team members are request-restricted
- **WHEN** a user is a `client_team_member` or `client_accountant`
- **THEN** their visibility is limited to requests assigned to them (not all company requests)

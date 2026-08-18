## Purpose

Company management for DataHub: how companies are listed, read, created, updated, and deleted, and how multi-tenant access is enforced around them. Companies are the primary tenant boundary — nearly every other domain is scoped to one. This spec captures the behavior the rebuilt `companies` module must honor at parity with legacy.

## ADDED Requirements

### Requirement: Tenant-scoped company listing

The system SHALL return only the companies the caller may access: admins see all; other users see the companies they are associated with.

#### Scenario: Admin sees all
- **WHEN** an admin lists companies
- **THEN** all companies are returned

#### Scenario: Non-admin is scoped
- **WHEN** a broker or client lists companies
- **THEN** only companies in their associations (`company_id` + `user_companies`) are returned

### Requirement: Read a company with stats

The system SHALL return a single company the caller may access, including its request counts (total, pending, completed).

#### Scenario: Authorized read
- **WHEN** an authorized user requests a company by id
- **THEN** the company and its request-count stats are returned

#### Scenario: Cross-tenant read denied
- **WHEN** a user requests a company they are not associated with
- **THEN** the request is denied (403/404) without leaking the other tenant's data

### Requirement: Create a company

The system SHALL let brokers and admins create a company, normalize its profit metric, and run the post-create side effects.

#### Scenario: Broker creates a company
- **WHEN** a broker submits a valid new company
- **THEN** the company is created, the creating user is associated with it, its default folders are provisioned, and (if a contact email is given) a client-representative user is synced

#### Scenario: Non-privileged create rejected
- **WHEN** a client/buyer attempts to create a company
- **THEN** the request is rejected (403)

#### Scenario: Profit metric normalized
- **WHEN** a company is created or updated with a profit-metric alias (e.g. `ebitda`, `adj_ebitda`, `seller_discretionary_earnings`)
- **THEN** it is stored as one of the canonical values (`adjusted_ebitda` or `sde`)

### Requirement: Update a company

The system SHALL let authorized users update safe company fields without clobbering integration state, and re-sync the client representative when the contact email changes.

#### Scenario: Safe-field update
- **WHEN** an authorized user updates name/industry/contact/profit-metric
- **THEN** those fields change and `quickbooks_connected` / `data_source_type` are left untouched

#### Scenario: Contact email change re-syncs the representative
- **WHEN** the contact email is changed on update
- **THEN** the client-representative user is re-synced to the new email

### Requirement: Delete a company (cascade)

The system SHALL let authorized users delete a company and all data scoped to it, in a single consistent operation.

#### Scenario: Cascade delete
- **WHEN** an authorized user deletes a company
- **THEN** the company and its dependent records (folders, documents, requests, groups, messages, reports, activity, `user_companies`, and `users.company_id` set to null) are removed, and the operation is atomic

#### Scenario: Delete requires access
- **WHEN** a user without access attempts to delete a company
- **THEN** the request is denied

### Requirement: Multi-tenant access is enforced everywhere

Every company operation SHALL enforce the same access rule (`canAccessCompany`) as the legacy system.

#### Scenario: Consistent guard
- **WHEN** any company read/update/delete is attempted
- **THEN** access is allowed only for admins, the company's associated users, or brokers assigned to it — identical to legacy behavior

## Purpose

Who a user *is* on the platform, and separately what they may see and do **on each individual deal** —
the distinction the product list is emphatic about, because the same accountant is sell-side on one
engagement and buy-side on another. Covers `SE - 0001` (role-based access setup), `SE - 0002` (company
access setup), `SE - 0003` (deal team). This capability gates every other capability in the surface;
nothing else in the product is correct without it.

**Fidelity: sketch.** Requirements are scoped to be reviewable and testable, not built from. Extends,
does not replace, the existing `auth` spec — `auth` covers proving identity; this covers what that
identity is permitted to do. Depends on unresolved question: none blocking.

## ADDED Requirements

### Requirement: Platform role assignment

The system SHALL assign each user a platform role (Broker, Company/Seller, Buyer, Bank, Accountant),
and SHALL drive the user's default dashboard and available navigation from that role. A user's platform
role SHALL NOT by itself grant access to any company's data. (`SE - 0001`)

#### Scenario: Role drives the landing experience
- **WHEN** a user signs in
- **THEN** they land on the dashboard defined for their platform role

#### Scenario: Role alone grants no company data
- **WHEN** a user with any platform role requests a company they have not been granted access to
- **THEN** the request is denied

### Requirement: Per-company access grants are independent of platform role

The system SHALL let a company's owner (typically the broker) grant a user access to that company, and
SHALL make that grant carry its own permission set — independent of the user's platform role and
independent of any grant that user holds on another company. (`SE - 0002`)

#### Scenario: Same user, different permissions per deal
- **WHEN** a user is granted sell-side permissions on company A and buy-side permissions on company B
- **THEN** each company's permissions apply only within that company, with no leakage in either
  direction

#### Scenario: Grant is revocable
- **WHEN** a company owner revokes a user's access
- **THEN** that user can no longer read any of that company's data, and existing sessions do not
  bypass the revocation

### Requirement: Configurable per-object permissions within a company

A company access grant SHALL support configuring what the grantee may see and do at the level of the
objects the product exposes — folders and files, financial data, QoE artifacts, valuation output — so
an owner can share and hide per user rather than only per company. (`SE - 0002`)

#### Scenario: Folder-level visibility differs by grantee
- **WHEN** an owner grants user X access to a subset of the data room and user Y access to a different
  subset
- **THEN** each user sees only their subset, in listings and in search

#### Scenario: Permission changes take effect without re-invitation
- **WHEN** an owner changes an existing grantee's permissions
- **THEN** the new permissions apply on the grantee's next request

### Requirement: Deal team roster

The system SHALL present, on a company profile, the deal team — the users with access to that company,
their platform role, their role on this deal, and who granted them. (`SE - 0003`)

#### Scenario: Roster reflects current grants
- **WHEN** a user with access views the company profile
- **THEN** the deal team tab lists current grantees with their role on this deal

#### Scenario: Revoked members leave the roster
- **WHEN** a grant is revoked
- **THEN** that user no longer appears as a current deal team member

### Requirement: Access changes are auditable

Every grant, modification, and revocation of company, folder, or file access SHALL be recorded with the
acting user, the affected user, the object, and the time, so that "who gave this party access to this
file" has a definitive answer. (`SE - 0002`, feeds `SE - 0004`)

#### Scenario: Grant is attributable
- **WHEN** an access grant is created or changed
- **THEN** an immutable record identifies the granting user, the grantee, the scope, and the timestamp

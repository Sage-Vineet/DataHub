## Purpose

Who a user *is* on the platform, and separately what they may see and do **on each individual company /
deal** — the distinction the product list is emphatic about, because the same accountant is sell-side on
one engagement and buy-side on another. Covers `SY - 0001` (Role Based Access Setup) and `SY - 0002`
(Company Access Setup). This capability gates every other capability in the surface; nothing else in the
product is correct without it.

**Fidelity: specified.** Requirements are drawn from the `SY - 0001` and `SY - 0002` feature
specifications (Josh Tonnesen, 14 Aug 2026). Extends, does not replace, the existing `auth` spec —
`auth` covers proving identity; this covers what that identity is permitted to do.

**ID note.** These two features were previously numbered `SE - 0001` / `SE - 0002`. The `SE` module was
folded into `SY` and renumbered; the bodies of both source documents still carry the old `SE` numbers in
places. `SE - 0003` (deal team) became `DR - 0009` and is specified in `data-room`; `SE - 0004` (activity
log) became `SY - 0003` and is specified in `activity-log`.

## ADDED Requirements

### Requirement: Profile Type is selected at account creation

The system SHALL require every new user to select exactly one Profile Type from a fixed list — Broker,
Accountant, Buyer, Bank, Company — during account creation, on both the public self-signup path and the
invitation path, and SHALL NOT allow account creation to complete without one. Exactly one Profile Type
SHALL be held per account at a time; multi-select SHALL NOT be supported. (`SY - 0001`)

#### Scenario: Signup cannot complete without a Profile Type
- **WHEN** a user attempts to complete self-service signup without selecting a Profile Type
- **THEN** account creation is refused

#### Scenario: Invited users choose a Profile Type too
- **WHEN** a user accepts an invitation
- **THEN** the same Profile Type selection is presented as part of the invitation-acceptance flow

### Requirement: Profile Type drives navigation only

The system SHALL store the selected Profile Type on the user's account record and SHALL use it to
determine the default landing dashboard and default navigation/menu configuration at login. Profile Type
SHALL be treated strictly as a navigation and UI default, and SHALL NOT be used as the basis for
granting or restricting access to any company, deal, document, or record — that is governed exclusively
by company access grants. (`SY - 0001`)

#### Scenario: Each Profile Type has its own default dashboard
- **WHEN** a user signs in
- **THEN** they are routed to the default dashboard defined for their Profile Type, verified for all
  five types

#### Scenario: Profile Type alone grants no company data
- **WHEN** a user with any Profile Type requests a company they hold no grant on
- **THEN** the request is denied

#### Scenario: Changing Profile Type does not move any access
- **WHEN** a user's Profile Type is changed
- **THEN** every company and deal grant that user holds is unaffected

### Requirement: Users can change their own Profile Type

The system SHALL allow a user to change their own Profile Type at any time from account settings, SHALL
apply the new default navigation from the next login or navigation refresh without requiring account
recreation, and SHALL log each change with prior value, new value, changed-by user, and timestamp.
(`SY - 0001`, feeds `SY - 0003`)

#### Scenario: New navigation takes effect without a new account
- **WHEN** a user changes their Profile Type in account settings
- **THEN** the new default navigation applies on next login or navigation refresh

#### Scenario: Profile Type changes are retrievable for audit
- **WHEN** a Profile Type is changed
- **THEN** a record of prior value, new value, changed-by user, and timestamp is retrievable

### Requirement: Only the company owner administers access to that company

The system SHALL permit only the current company owner to grant, modify, or revoke another user's access
to that company. The system SHALL support exactly one owner per company at a time, SHALL allow the
current owner to transfer ownership to a user who already has — or is concurrently granted — access to
that company, and SHALL log owner identity and transfer history. (`SY - 0002`)

#### Scenario: Non-owners cannot administer access
- **WHEN** a user who is not the company owner attempts to grant or revoke access on that company
- **THEN** the attempt is refused

#### Scenario: Ownership transfer confers full rights
- **WHEN** ownership of a company is transferred to another user with access
- **THEN** the new owner immediately holds full grant, revoke, and configure rights, and the transfer is
  recorded in the transfer history

### Requirement: Grants are scoped to one company and are independent per company

The system SHALL scope every access grant to a single company, such that a grant made on one company has
no effect on any other, and SHALL support one user holding different, independently configured access
profiles on several companies simultaneously. (`SY - 0002`)

#### Scenario: Same user, different permissions per deal
- **WHEN** a user is granted sell-side permissions on company A and buy-side permissions on company B
- **THEN** each company's permissions apply only within that company, with no leakage in either
  direction, confirmed with both grants active at once

#### Scenario: Ungranted companies are undiscoverable
- **WHEN** a user without a grant on a company browses, searches, or otherwise navigates the platform
- **THEN** that company is not viewable, searchable, or discoverable anywhere

### Requirement: Role-defaulted, two-axis permission granularity

The system SHALL let the owner grant access by selecting the grantee's system role as the basis for a
pre-populated default permission set, then adjust it before or after the grantee gains access. Grants
SHALL support two independent axes of granularity: (a) folder and document level within the data room,
and (b) module or tab level for functional areas — QoE, Reports, Projections, Q&A, CIM — each toggleable
per grantee. (`SY - 0002`)

#### Scenario: A new grant starts from a role default
- **WHEN** an owner grants a user access and selects that user's system role
- **THEN** the grant is pre-populated with the default permission set for that role and remains editable

#### Scenario: Folder-level visibility differs by grantee
- **WHEN** an owner grants user X one subset of the data room and user Y a different subset
- **THEN** each user sees only their subset, in listings and in search

#### Scenario: Module visibility toggles independently of folders
- **WHEN** an owner disables a grantee's access to the QoE module while leaving data room folders visible
- **THEN** the grantee retains those folders and loses the QoE tab

### Requirement: Reusable named permission templates

The system SHALL allow a company owner to save a given combination of folder-level and module-level
settings as a named, reusable permission template, apply that template to a new or existing grantee, and
adjust individual settings afterwards. (`SY - 0002`)

#### Scenario: Template applied then adjusted
- **WHEN** an owner applies a saved permission template to a grantee and then changes one folder toggle
- **THEN** the grantee holds the template's settings with that single adjustment, and the template itself
  is unchanged

### Requirement: Access changes take effect promptly and revocation is complete

The system SHALL allow an owner to update an existing grant at any time, with changes taking effect on
the grantee's next page load or session refresh, and SHALL allow full revocation that immediately
removes the grantee's ability to view any data room content or module tied to that company. Existing
sessions SHALL NOT bypass a revocation. (`SY - 0002`)

#### Scenario: Permission changes need no re-invitation
- **WHEN** an owner changes an existing grantee's permissions
- **THEN** the new permissions apply on the grantee's next request, with no re-invitation

#### Scenario: Revocation is immediate
- **WHEN** an owner revokes a user's access
- **THEN** that user immediately loses all access to the company's data room and modules, and an open
  session does not bypass the revocation

### Requirement: Access changes are auditable

Every grant, modification, and revocation of company, folder, or file access SHALL be recorded with the
acting user, the affected user, the object, and the time, so that "who gave this party access to this
file" has a definitive answer. (`SY - 0002`, feeds `SY - 0003`)

#### Scenario: Grant is attributable
- **WHEN** an access grant is created, changed, or revoked
- **THEN** an immutable record identifies the granting user, the grantee, the scope, and the timestamp

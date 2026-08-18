## Purpose

Cross-cutting platform mechanics that are not tied to one deal: AI and compute usage metering
(`SY - 0004`), user creation (`SY - 0005`), and referral tracking (`SY - 0006`). Grouped because each is
a platform-level service consumed by many capabilities and owned by none of them.

**Fidelity: specified.** Requirements are drawn from the `SY - 0004`, `SY - 0005`, and `SY - 0006`
feature specifications (Josh Tonnesen, 14 Aug 2026). E-signature (`SY - 0007`) is specified separately as
its own capability; role and company access setup (`SY - 0001` / `SY - 0002`) live in `access-control`;
the audit log (`SY - 0003`) in `activity-log`.

**ID note.** These three features were previously numbered `SY - 0001` / `SY - 0002` / `SY - 0003`; the
`SE` module was folded into `SY` and the System module renumbered by three. `SY - 0004`'s body still
refers to the audit log as `SE - 0003`.

## ADDED Requirements

### Requirement: Every metered action records a Usage Event

The system SHALL record a Usage Event each time a metered action occurs, covering at minimum AI/LLM
invocations (guided Q&A generation, drafting assistance, extraction from uploaded documents), OCR
processing of uploaded or scanned documents, and outbound calls to metered third-party data providers
(for example market and transaction data queries under `DR - 0008`). Each Usage Event SHALL capture:
event type, timestamp, initiating user ID, associated company/deal ID where applicable, the specific
provider/model/engine invoked, a unit quantity appropriate to the event (tokens, pages processed, API
calls), and the computed raw cost to Centuriuum. (`SY - 0004`)

#### Scenario: AI, OCR, and provider calls all meter
- **WHEN** an AI/LLM invocation, an OCR job, or a metered third-party data provider call executes
- **THEN** a Usage Event is written with user, company/deal where applicable, event type,
  provider/model, unit quantity, and computed cost

### Requirement: Usage rolls up by user and by deal

The system SHALL associate every Usage Event with exactly one user and, where the action occurs in the
context of a company/deal, exactly one company/deal, so that usage can be aggregated either way.
(`SY - 0004`, depends on `SY - 0001` / `SY - 0002`)

#### Scenario: Same events roll up two ways
- **WHEN** an administrator aggregates usage
- **THEN** the same events total correctly both by user and by company/deal

### Requirement: Rate reference table drives cost computation

The system SHALL maintain a Rate Reference table mapping each metered provider, model, or engine to its
current per-unit cost, allowing raw cost to be computed at event time or recalculated retroactively if
rates change. (`SY - 0004`)

#### Scenario: Updated rates apply going forward
- **WHEN** an internal administrator updates a rate in the reference table
- **THEN** newly computed Usage Event costs reflect the updated rate

### Requirement: Internal-only usage dashboard with projected spend

The system SHALL provide an internal-facing usage dashboard, not visible to Broker, Bank, Buyer,
Company, or Accountant roles, allowing an administrator to filter and aggregate usage by user, by
company/deal, by event type, and by date range, and SHALL support projected-spend views that extrapolate
recent usage forward, at minimum by user and by company/deal. (`SY - 0004`)

#### Scenario: Customer-facing roles cannot reach the dashboard
- **WHEN** a Broker, Bank, Buyer, Company, or Accountant user attempts to open the usage dashboard
- **THEN** access is denied

#### Scenario: Projected spend extrapolates
- **WHEN** an administrator opens the projected-spend view
- **THEN** recent usage is extrapolated forward by user and by company/deal

### Requirement: Metering does not restrict usage in this phase

The system SHALL NOT block, throttle, or otherwise restrict any user's usage based on volume in this
phase. This capability is data capture and visibility only. Usage Event history SHALL be retained
indefinitely pending a data retention policy. (`SY - 0004`)

#### Scenario: Heavy usage is tracked, never capped
- **WHEN** a test account consumes an unusually large volume of metered actions
- **THEN** every action is tracked and none is blocked, throttled, or capped

### Requirement: Public self-signup collects the required account fields

The system SHALL provide a public sign-up page, reachable without an invite, collecting First Name, Last
Name, Email Address, Phone Number, Password, and Role (Business Broker, Bank, Business Buyer,
Accountant, or Company). These SHALL be the only required fields; all other per-role profile fields
defined in `US - 0001` … `US - 0005` SHALL be optional at signup and completable later. The system SHALL
prevent creation of two accounts with the same email address and SHALL enforce a minimum password policy
of at least 8 characters including at least one letter and one number. (`SY - 0005`)

#### Scenario: Only the six fields block signup
- **WHEN** a user completes signup with First Name, Last Name, Email, Phone, Password, and Role
- **THEN** account creation succeeds and no other profile field blocks it

#### Scenario: Duplicate email is refused
- **WHEN** signup is attempted with an email that already has an account
- **THEN** a second account is not created

### Requirement: Invite-link signup carries deal context

The system SHALL support a second entry path — an invite link generated by a broker — that pre-fills and
locks the invited email address and carries the inviting broker's ID and the target company/deal ID
through to account creation. Where a verified account already exists for the invited email, the system
SHALL attach the new company/deal access grant to that existing account instead of creating a duplicate,
and SHALL notify the existing user of the new access. (`SY - 0005`, depends on `SY - 0002`)

#### Scenario: Invited email is locked
- **WHEN** a user opens a broker's invite link
- **THEN** the email address is pre-filled and cannot be edited

#### Scenario: Existing account is reused, not duplicated
- **WHEN** a broker invites an email address that already has a verified account
- **THEN** the new deal access is attached to the existing account and that user is notified

### Requirement: Email verification gates deal data, not login

The system SHALL send a welcome/verification email containing a time-limited verification link on
successful signup and SHALL flag the account unverified until the link is used. An unverified
self-signed-up user SHALL be able to log in but SHALL be restricted from any company or deal data access
until verification completes. (`SY - 0005`)

#### Scenario: Unverified user can log in but sees no deal data
- **WHEN** an unverified self-signed-up user logs in
- **THEN** login succeeds and every company/deal data access is refused until verification

### Requirement: Two-factor enrolment is prompted, never blocking

The system SHALL prompt every new user, during or immediately after signup, to optionally enrol in
two-factor authentication by SMS to the phone number provided, with a visible explanation of why it
matters for financial data. Declining SHALL NOT block account creation, email verification, or login,
and a user who declines SHALL be able to enable it later from account settings. (`SY - 0005`)

#### Scenario: Declining 2FA blocks nothing
- **WHEN** a new user declines the 2FA prompt
- **THEN** account creation, verification, and login all proceed, and 2FA can be enabled later from
  account settings

### Requirement: Post-verification landing depends on role and entry path

The system SHALL land a verified user as follows. A self-signed-up user with no company or deal access
yet SHALL land on a role-appropriate default: a Business Broker on the Deal Tracker / Deal Listing entry
point (`BR - 0001` / `BR - 0003`); a Business Buyer on the active deal listings view (`BY - 0001`); an
Accountant, Bank, or Company user — roles with no independent deal-sourcing entry point — on an
account/profile screen indicating that deal access follows once a broker grants it. A user who signed up
through a broker's invite link SHALL instead land directly inside the company/deal they were invited to,
per the grant created under `SY - 0002`, and SHALL NOT be routed through the marketplace landing.
(`SY - 0005`)

#### Scenario: Invited user lands inside the deal
- **WHEN** an invite-link user completes verification
- **THEN** they land inside the specific company/deal they were invited to, not a generic marketplace
  screen

#### Scenario: Roles without a sourcing entry point wait for a grant
- **WHEN** a self-signed-up Accountant, Bank, or Company user verifies
- **THEN** they land on an account/profile screen indicating deal access will follow

### Requirement: Signup role is an account default only

The role selected at signup SHALL be stored as a default label on the account and SHALL NOT, by itself,
grant access to any company or deal. The actual per-deal role and permissions are determined separately
by the broker under `SY - 0002` and MAY differ from the account default on different deals. (`SY - 0005`)

#### Scenario: Per-deal role does not rewrite the account default
- **WHEN** a broker sets a different per-deal role for a user under `SY - 0002`
- **THEN** that user's account-level default role from signup is unchanged

### Requirement: Account lifecycle events are audited

The system SHALL write account creation, email verification, 2FA enrolment or decline, and
role-default-selection events to the Activity & Audit Log. (`SY - 0005`, feeds `SY - 0003`)

#### Scenario: Lifecycle events appear in the audit log
- **WHEN** an account is created, verified, or enrols in or declines 2FA
- **THEN** each event appears in the Activity & Audit Log

### Requirement: Referral records are created within a deal

The system SHALL allow a user holding an eligible role — Broker, Company, Bank, Accountant, or Admin —
to create a Referral record from within a deal, selecting a Referring User, a Referred-To Provider (an
existing platform user or profile flagged as a referral provider), and a Referral Type (Accountant,
Business Broker, Bank/Lender, Insurance Broker, Other). Every Referral SHALL be associated with exactly
one company/deal at creation; a referral SHALL NOT be logged without a deal context. (`SY - 0006`)

#### Scenario: Referral requires a deal
- **WHEN** a user attempts to create a Referral with no company/deal association
- **THEN** creation is refused

### Requirement: Referral status is tracked and attributed

The system SHALL carry a Referral Status field with at minimum the values Logged, Contacted, Engaged,
Closed, Fee Collected, and Cancelled/Void, and SHALL record a timestamp and the acting user for every
status change. Status MAY be updated by the Referring User, the Referred-To Provider, or an Admin. Each
Referral SHALL carry a creation timestamp, the creating user, and an immutable log of all edits.
(`SY - 0006`, feeds `SY - 0003`)

#### Scenario: Every status change is attributed
- **WHEN** any eligible party changes a Referral's status
- **THEN** the change is timestamped, attributed, and written to the audit log

### Requirement: Fee fields record intent without moving money

The system SHALL provide an optional Referral Fee Amount (numeric, currency) and an optional Fee
Basis/Notes free-text field on each Referral record for future use. Populating either SHALL NOT trigger
payment processing, invoicing, or escrow. The system SHALL NOT process, hold, or transfer funds.
(`SY - 0006`)

#### Scenario: Entering a fee triggers nothing
- **WHEN** a user enters or edits a Fee Amount and Fee Basis on a Referral
- **THEN** the values are saved and no payment, invoice, or escrow action occurs

### Requirement: Referrals link to the access grant they produced

The system SHALL allow a user to mark a Referral as the reason a provider was granted access to a deal,
linking the Referral record to the corresponding access grant made under `SY - 0002` where applicable.
(`SY - 0006`)

#### Scenario: Referral is linked to its grant
- **WHEN** a provider named in a Referral is granted access to that deal
- **THEN** the Referral can be linked to that access grant

### Requirement: Duplicate referrals are caught before creation

The system SHALL prevent duplicate active Referral records for the same Referring User + Referred-To
Provider + company/deal combination, warning the user that a matching record already exists before a new
one is created. (`SY - 0006`)

#### Scenario: Duplicate is flagged
- **WHEN** a user creates a Referral matching an existing active record on all three keys
- **THEN** the user is warned before creation proceeds

### Requirement: Referral search is scoped to the viewer's deals

The system SHALL allow filtering and searching of Referral records by company/deal, Referring User,
Referred-To Provider, Referral Type, and Status, scoped to what the requesting user's role and deal
access permit, with no cross-deal visibility. (`SY - 0006`)

#### Scenario: No cross-deal referral visibility
- **WHEN** an eligible user searches Referral records
- **THEN** only referrals on deals they have access to are returned

### Requirement: Referral parties are notified

The system SHALL notify the Referred-To Provider when a new Referral naming them is logged, and SHALL
notify the Referring User whenever the Referral's status changes. (`SY - 0006`)

#### Scenario: Provider is notified of a new referral
- **WHEN** a Referral naming a provider is created
- **THEN** that provider is notified

#### Scenario: Referring user is notified of status movement
- **WHEN** a Referral's status changes
- **THEN** the Referring User is notified

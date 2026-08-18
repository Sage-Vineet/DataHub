## Purpose

What each of the five platform roles gets when they log in — the profile fields they hold and the
landing surface they land on. Covers `US - 0001` (Broker), `US - 0002` (Bank), `US - 0003` (Business
Buyer), `US - 0004` (Accountant), and `US - 0005` (Company). This capability is deliberately thin: it
defines role-specific profile data and the landing experience, and defers account creation mechanics to
`SY - 0005` and all access grants to `SY - 0002`.

**Fidelity: specified.** Requirements are drawn from the five `US` feature specifications (Josh
Tonnesen, 14 Aug 2026). The `US - 0003` source document still refers to the permission model as
`SE - 0002`; it is now `SY - 0002`.

## ADDED Requirements

### Requirement: Broker lands directly on their deal portfolio

The system SHALL present the broker's landing view immediately on successful login with no intermediate
screen, populated with every deal for which the logged-in broker is the deal owner or an assigned deal
team member per `SY - 0002`. Deals the broker neither owns nor is assigned to SHALL be excluded
regardless of brokerage affiliation. (`US - 0001`)

#### Scenario: Login goes straight to the portfolio
- **WHEN** a broker signs in
- **THEN** the summarized deal view renders with no intermediate screen

#### Scenario: Unassigned deals never appear
- **WHEN** a deal exists at the broker's brokerage that this broker neither owns nor is assigned to
- **THEN** it does not appear on their landing view

### Requirement: Broker landing view format is selectable and persistent

The system SHALL allow the broker to toggle the deal display between list, table, and card views, and
SHALL persist the last-selected format as a user-level preference applied on subsequent logins.
(`US - 0001`)

#### Scenario: View choice survives logout
- **WHEN** a broker selects card view and later signs in again
- **THEN** the deal display renders in card view

### Requirement: Broker landing view content and navigation

The system SHALL display per deal, at minimum: deal/company name, current stage sourced from
`BR - 0001`, the broker's role on the deal (owner vs. co-broker), and last activity date. Clicking a
deal SHALL land the broker in that deal's Core Data Room (`DR - 0001`). From inside a deal, the broker
SHALL be able to reach the SIM/CIM Builder (`CM - 0001`) and other deal-specific tools without returning
to the landing view. The landing view SHALL provide a control that opens the full Deal Tracker
(`BR - 0001`), and SHALL display a summarized action items / key dates panel sourced from the platform
notification and task system. (`US - 0001`)

#### Scenario: Deal click enters the data room
- **WHEN** a broker clicks a deal on the landing view
- **THEN** they land in that deal's Core Data Room

#### Scenario: Deal Tracker is one control away
- **WHEN** a broker uses the Deal Tracker control on the landing view
- **THEN** the full Deal Tracker opens

#### Scenario: Deal entry is logged
- **WHEN** a broker enters a deal from the landing view
- **THEN** the entry is written to the Activity & Audit Log

### Requirement: The Bank role is invitation-only and never browses

The system SHALL create a distinct Bank role at account creation, separate from Broker, Buyer,
Accountant, and Company. A bank user's access to a deal SHALL be provisioned only through an explicit
grant event — a financing-assistance request or equivalent invite — never through open browsing or
self-registration into a deal, and their visible deals SHALL be limited to those they hold an active
grant on. Access SHALL be revoked when the grant is revoked or expires. (`US - 0002`, depends on
`SY - 0001` / `SY - 0002`)

#### Scenario: No grant, no deal
- **WHEN** a Bank user is created with no access grant
- **THEN** no deal is visible to them

#### Scenario: One grant does not imply another
- **WHEN** a bank user holds a grant on Deal A and the same broker also runs Deal B
- **THEN** Deal B cannot be seen, searched, or inferred

### Requirement: Bank Profile fields and logging

The Bank Profile SHALL capture at minimum representative name, email, institution name, and primary
contact phone. Every bank user login and deal view SHALL be written to the Activity & Audit Log.
(`US - 0002`, feeds `SY - 0003`)

#### Scenario: Bank activity is auditable
- **WHEN** a bank user logs in or views a deal
- **THEN** the event appears in the Activity & Audit Log with timestamp and user identity

### Requirement: Bank buyer contacts are private and there is no buyer directory

The system SHALL allow a bank user to add an individual buyer as a private contact by entering that
buyer's email or name; where a matching platform buyer profile exists, the system SHALL surface the
match for confirmation before any connection or messaging is enabled. The system SHALL NOT expose a
searchable or browsable directory of platform buyers to bank users under any circumstance, and SHALL NOT
display a bank user's contacts to any other bank, broker, or buyer account. (`US - 0002`)

#### Scenario: No match leaks nothing
- **WHEN** a bank user enters a buyer email that matches no platform profile
- **THEN** no error revealing directory contents and no directory data is exposed

#### Scenario: Match shows a confirmation, not a profile
- **WHEN** a bank user enters a buyer email that matches a platform profile
- **THEN** only a confirmation prompt is shown; profile details are withheld until confirmed

#### Scenario: Buyer directory is unreachable
- **WHEN** a bank user attempts, in any account state, to browse platform buyers
- **THEN** no such list is available

### Requirement: Buyers maintain multiple named Buy Boxes

The system SHALL allow a buyer to create, edit, deactivate, and delete one or more named Buy Boxes, each
capturing industry/NAICS, revenue range, EBITDA/SDE range, geography, and deal structure preference.
Only active Buy Boxes SHALL be used for listing matches and `BY - 0003` notification triggers. The
system SHALL raise a Buy Box match event whenever a new marketplace listing or curated match satisfies
an active Buy Box's criteria, for consumption by the notifications hub. (`US - 0003`)

#### Scenario: Inactive Buy Boxes are inert
- **WHEN** a buyer deactivates a Buy Box and a listing matching it is published
- **THEN** no match or notification trigger is raised for that Buy Box

### Requirement: Buyer lending profile and qualification display

The system SHALL provide a lending/funding profile form capturing at minimum liquid capital available,
source of equity, financing type (personal, fund, SBA-backed, seller-financed expectation), and — for
sponsors — fund name, vintage, committed capital, and dry powder. Buyers SHALL be able to upload
supporting documents including bank/brokerage statements and a lender pre-qualification letter, routed
through the redaction capability in `DR - 0004`. The profile SHALL NOT independently compute a
qualification grade; it SHALL display the status computed by `BY - 0007` — unverified, self-reported,
document-verified, or lender pre-qualified — rendered as a progress-wheel visual. (`US - 0003`)

#### Scenario: Displayed status matches the grading engine
- **WHEN** a buyer completes lending fields and uploads a supporting document
- **THEN** the qualification status displayed equals the status computed by `BY - 0007`

### Requirement: Buyer dashboard separates browsing, curation, and active deals

The system SHALL display three distinct views: **Browse Active Listings**, showing public marketplace
listings from `BR - 0003` filterable by the buyer's active Buy Box criteria; **Matched for You**, showing
deals curated to this buyer by broker matching logic (`BR - 0007`), visually distinct from the open
marketplace; and **My Active Deals**, listing every deal for which the buyer holds an executed NDA and
active data room access, sourced from existing permission grants. For each deal in My Active Deals the
system SHALL show a buyer-safe subset of the `BR - 0009` pipeline stage (NDA executed, CIM delivered, in
diligence) and never internal-only stages or broker notes. (`US - 0003`)

#### Scenario: Curated and open listings are distinguishable
- **WHEN** a buyer opens their dashboard
- **THEN** Matched for You and Browse Active Listings render as separate, visually distinct sections,
  with matched results reflecting the buyer's active Buy Box criteria

#### Scenario: Internal stages stay internal
- **WHEN** a buyer views a deal's stage in My Active Deals
- **THEN** only buyer-safe stages appear, with no internal-only stage or broker note

### Requirement: The buyer profile grants no access and sees no other buyer

The system SHALL NOT grant, modify, or revoke data room access from within the Business Buyer Profile;
all access changes SHALL originate from the broker-side NDA and access-grant workflow in `BR - 0008`. A
buyer SHALL be able to view only their own Buy Boxes, lending profile, and deal lists. (`US - 0003`)

#### Scenario: No access controls in the buyer profile
- **WHEN** a buyer views My Active Deals
- **THEN** no control exists to grant or alter data room access

#### Scenario: Buyers are opaque to each other
- **WHEN** a buyer attempts to view another buyer's Buy Box, lending profile, or deal list
- **THEN** the attempt is refused under every condition

### Requirement: The Accountant role is grant-gated and multi-deal

The system SHALL provide an Accountant role distinct from Broker, Bank, Buyer, and Company. An
accountant SHALL be onboardable either by direct invite from a broker or company user on that deal, or
by self-registering and then requesting access to a specific deal. An explicit grant under `SY - 0002`
SHALL be required before any deal is visible. One accountant account SHALL be grantable on multiple
separate deals and SHALL be presented with a dashboard of all deals they currently hold access to, with
full isolation between them. (`US - 0004`)

#### Scenario: Ungranted accountant sees nothing
- **WHEN** an accountant account exists with no active grant
- **THEN** no deal is visible

#### Scenario: Multi-deal dashboard stays isolated
- **WHEN** an accountant holds grants on Deal A and Deal B
- **THEN** both appear on one dashboard and no data, document, or activity crosses between them

### Requirement: Accountant module visibility is configured per deal

The system SHALL allow the broker or company controlling access on that deal to configure, per deal,
which modules and tabs an accountant can see — data room upload, QoE workbook, specific QoE tabs,
Reports. The Deal Tracker, Proof of Funds, and Deal/Business Search SHALL NOT be enabled by default for
the Accountant role. Broker-only tools (Buyer List Builder, Teaser Distribution, Outreach Pipeline, Fee
Management) and Buyer- or Bank-only tools SHALL NOT be displayed to an Accountant regardless of per-deal
module visibility settings. (`US - 0004`)

#### Scenario: Navigation reflects only enabled modules
- **WHEN** a broker enables the data room and disables QoE for an accountant on a deal
- **THEN** the accountant's navigation on that deal shows the data room and no QoE tab

#### Scenario: Broker-only tools stay hidden
- **WHEN** any per-deal module visibility configuration is applied to an accountant
- **THEN** broker-only and buyer/bank-only tools remain unavailable

### Requirement: Accountant QoE access requires both engagement and visibility

The system SHALL treat the QoE module's paid/active status as a property of the company/deal engagement,
not of the Accountant role. An accountant's access to the QoE module SHALL require both that QoE is an
active, paid engagement on that deal, and that the broker or company has made the module visible to that
accountant. (`US - 0004`)

#### Scenario: Both conditions are necessary
- **WHEN** QoE is visible to an accountant but the engagement is not active and paid, or the engagement
  is active but the module is not made visible
- **THEN** the accountant cannot access the QoE module

### Requirement: Accountant uploads and activity

An accountant with an active data-room grant SHALL be able to upload documents to that deal's data room,
consistent with the templated file structure in `DR - 0002`. All accountant logins, uploads, and
document views SHALL be written to the Activity & Audit Log. (`US - 0004`, feeds `SY - 0003`)

#### Scenario: Accountant activity is auditable
- **WHEN** an accountant logs in, uploads a document, or views one
- **THEN** the event appears in the Activity & Audit Log

### Requirement: Company users arrive by invite or by self-serve

The system SHALL allow a new user to select "I'm a company owner" during signup, whether they arrived
via an invite link or the general signup page. Invite-based creation SHALL associate the new Company
Profile user with the specific company/deal record the broker already established. Self-serve creation
SHALL create a new company record from scratch. On self-serve signup the system SHALL check for pending
broker-issued invites addressed to that email and present them as an option to accept; the user SHALL be
able to decline and list their business independently with no broker attached, and SHALL be able to
invite a broker of their choosing to the record they created. (`US - 0005`, depends on `SY - 0005`)

#### Scenario: Invite link avoids a duplicate company
- **WHEN** a user signs up through a broker-issued invite link
- **THEN** they land in the broker-created company/deal record and no duplicate company is created

#### Scenario: Pending invites are offered at self-serve signup
- **WHEN** a user self-serves with an email that has a pending invite
- **THEN** the invite is presented and may be accepted instead of creating a new company

#### Scenario: Independent listing is permitted
- **WHEN** a self-serve user declines all pending invites
- **THEN** they can create a company record and either list independently or invite a broker

### Requirement: Duplicate company records are never auto-merged

Where a self-serve company record and a broker-created company record exist for what is in fact the same
underlying business, the system SHALL NOT automatically merge or link them. Each SHALL remain a fully
separate company record, with reconciliation handled manually by the parties involved. (`US - 0005`)

#### Scenario: Records stay separate
- **WHEN** two records exist for the same underlying business by different creation paths
- **THEN** both remain fully separate with no automatic merge or linkage

### Requirement: Broker-gated insight visibility on the company profile

The system SHALL allow the broker who owns or administers a company record to toggle, per insight
category — deal activity summary, NDA signing status, listing view counts, buyer interest indicators —
whether that category is visible to the associated Company Profile user. A category the broker has not
enabled SHALL render as fully absent from the company user's view, not as a visible-but-locked or
placeholder element. Visibility changes SHALL take effect immediately without requiring the company user
to re-authenticate. (`US - 0005`)

#### Scenario: Disabled categories are absent, not locked
- **WHEN** a broker disables an insight category
- **THEN** the company user's dashboard omits it entirely, with no locked or placeholder element

#### Scenario: Toggles apply without re-login
- **WHEN** a broker toggles an insight category while the company user is signed in
- **THEN** the change is reflected without the company user re-authenticating

### Requirement: Company profile events are audited

The system SHALL log all invite issuance, invite acceptance, company record creation, and broker
visibility-flag changes to the platform activity/audit log. (`US - 0005`, feeds `SY - 0003`)

#### Scenario: Company lifecycle events are recorded
- **WHEN** an invite is issued or accepted, a company record is created, or a visibility flag is changed
- **THEN** the event appears in the activity/audit log

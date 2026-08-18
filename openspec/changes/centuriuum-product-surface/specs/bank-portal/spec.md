## Purpose

The lender's entry point (`BK - 0001`): banks log in to see the deals sent their way for underwriting.
The commercial intent behind it is explicit in the source list — controlling lead flow and the referral
base so that referral fees can be paid — which makes attribution, not the UI, the load-bearing part.

**Fidelity: sketch, thin by source.** `BK - 0001` is a placeholder row with no specification document —
the product list describes it as "placeholder for future functionality around the banks". What a bank
user *is* on the platform is now specified: `US - 0002` (Bank Profile) in `user-profiles` defines the
role's invitation-only access model, its profile fields, and the hard rule that no buyer directory is
ever exposed to a bank user. This capability covers the deal-side surface those users land on. Depends
on `access-control` for what a bank user may see, and on `platform-services` (`SY - 0006`) for referral
tracking.

**ID note.** `BK - 0005` appears in the product list only as a retired identifier available for reuse
("can be recycled with `BK - 0005`"), not as a reference to a missing feature.

## ADDED Requirements

### Requirement: Financing assistance can be requested from a deal

The system SHALL let a buyer, broker, or other authorized party request financing assistance on a deal
with a single action, producing a request visible to bank users. (`BK - 0001`)

#### Scenario: Request raised
- **WHEN** an authorized party requests financing assistance on a deal
- **THEN** a financing request is created against that deal

### Requirement: Bank users see the deals routed to them

The system SHALL present to a bank user the financing requests routed to them, and SHALL email them to
prompt login where needed. A bank user SHALL see only the deals routed to them. (`BK - 0001`)

#### Scenario: Routed requests are listed
- **WHEN** a bank user signs in
- **THEN** the financing requests routed to them are listed

#### Scenario: Non-routed deals are invisible
- **WHEN** a bank user browses or searches
- **THEN** deals not routed to them do not appear

### Requirement: Bank access to deal documents is granted, never assumed

A bank user's access to a deal's documents SHALL follow an explicit grant under the per-company
permission model, and the financing request alone SHALL NOT grant document access. (`BK - 0001`, gated
by `SY - 0002`)

#### Scenario: Request without document access
- **WHEN** a financing request is routed to a bank user
- **THEN** they see the request but no data room documents until access is granted

### Requirement: Lead flow and referral attribution

The system SHALL record who referred each financing request and which deal it belongs to, so that lead
flow is controlled and referral fees are payable against an attributable record. (`BK - 0001`, uses
`SY - 0003`)

#### Scenario: Referral attributed
- **WHEN** a financing request results in a funded transaction
- **THEN** the referring party and the deal remain linked for fee purposes

### Requirement: Lender requirements are visible to the request

The system SHALL relate a financing request to the lender requirements checklist for that deal, so a
bank sees what has been prepared and the broker sees what remains. (`BK - 0001`, ties to `DR - 0005`)

#### Scenario: Checklist status visible on the request
- **WHEN** a financing request is opened
- **THEN** the deal's lender requirement items show as satisfied or outstanding

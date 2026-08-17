## Purpose

The seller's view of their own transaction: visibility into the active deal at the level the broker
chooses to share (`CP - 0001`), and the post-close relationship (`CP - 0002`). Thin in the source list,
but this is the surface the seller judges the broker's service by — the recurring status report in
`BR - 0011` is delivered here.

**Fidelity: sketch, thin by source.**

## ADDED Requirements

### Requirement: Seller sees deal activity at the level the broker shares

The system SHALL let a designated company user see the activity on their deal, with the broker
controlling what is shared. (`CP - 0001`)

#### Scenario: Broker controls the shared view
- **WHEN** a broker configures what the seller sees
- **THEN** the seller's view reflects exactly that configuration and nothing beyond it

#### Scenario: Designated company user
- **WHEN** the company designates which of its users may see deal activity
- **THEN** only those users have that visibility

### Requirement: Status reports are delivered to the company profile

The system SHALL deliver the recurring seller status report to the company profile with email
notification, and SHALL archive past reports so the seller can review the process history. (`CP - 0001`,
delivered from `BR - 0011`)

#### Scenario: Report delivered and archived
- **WHEN** a status report is released
- **THEN** it appears on the company profile with notification, and prior reports remain retrievable

### Requirement: Buyer identities are shown only where the broker permits

Where the broker has enabled identity redaction, the seller's view SHALL present activity and pass
reasons without buyer identities. (`CP - 0001`, per `BR - 0011`)

#### Scenario: Anonymized activity
- **WHEN** redaction is enabled
- **THEN** the seller sees aggregate activity and pass reasons with no buyer names

### Requirement: Post-close referral surface

After the sale of the company, the system SHALL surface referrals to wealth managers and other post-close
services to the individual seller. (`CP - 0002`)

#### Scenario: Post-close referrals presented
- **WHEN** a deal moves to closed
- **THEN** the seller is presented with post-close service referrals

#### Scenario: Referrals are attributed
- **WHEN** a post-close referral is made
- **THEN** it is recorded for referral tracking under `SY - 0003`

## Purpose

The broker's own operating surface, distinct from the sell-side process (`deal-marketing`) and the
post-offer phase (`deal-execution`): deal tracker (`BR - 0001`), NDA management (`BR - 0002`), deal
listing on the platform marketplace (`BR - 0003`), cross-posting to external channels (`BR - 0004`),
deal sourcing (`BR - 0005`), and buyer ERP (`BR - 0006`).

**Fidelity: sketch.** No `BR` feature specification document exists; every requirement below restates
a product-list summary. `BR - 0006` is the least-specified row in the list ("create some concept of the
buyer ERP that could be helpful") and its requirement is written narrowly on purpose — see `design.md`
§D2. `BR - 0005` shares the external data provider dependency with `external-integrations`.

**Inbound contracts.** Several specified capabilities now depend on `BR - 0001` and `BR - 0002`
concretely: `US - 0001` reads deal stage from the tracker for the broker landing view; `CP - 0002` marks
a deal Closed/Sold from the tracker with a close date; `CP - 0001` and `US - 0003` read stage from it;
and `SY - 0007` owns the signature execution the NDA flow consumes. Those obligations are stated below
so this capability is specified against what already depends on it.

## ADDED Requirements

### Requirement: Deal tracker

The system SHALL give a broker a tracker across their deals showing, per deal, the stage it is in and
its outstanding requests, so their book is manageable from one view. (`BR - 0001`)

#### Scenario: Deals with outstanding items
- **WHEN** a broker opens the tracker
- **THEN** each deal shows its stage and its outstanding requests

#### Scenario: Tracker items satisfied by platform events
- **WHEN** a platform event satisfies a tracked item — such as a completed report pull
- **THEN** that item is marked satisfied and linked to what satisfied it

### Requirement: Deal stage is the platform's system of record for stage

The tracker SHALL be the system of record for a deal's stage and status, readable by other capabilities
rather than duplicated by them — the broker landing view (`US - 0001`), the seller's Active Deal snapshot
(`CP - 0001`), the buyer's My Active Deals view (`US - 0003`), and the company profile dashboard
(`US - 0005`) all present a filtered read of the same stage data. (`BR - 0001`)

#### Scenario: Consumers read, never re-derive
- **WHEN** any capability displays a deal's stage
- **THEN** it reads the tracker's stage rather than maintaining its own

### Requirement: Marking a deal closed from the tracker

The system SHALL let a broker mark a deal Closed/Sold from the tracker, recording a close date, which
transitions the associated company profile to its Post Close state per `CP - 0002`. (`BR - 0001`)

#### Scenario: Close date drives the post-close transition
- **WHEN** a broker marks a deal Closed/Sold with a close date
- **THEN** the associated company profile transitions to Post Close immediately

### Requirement: NDA required as a condition of data room access

When granting data room access, the system SHALL let the user require an NDA, sent automatically by
email based on the NDA held on the broker's profile. (`BR - 0002`)

#### Scenario: NDA required on grant
- **WHEN** an owner grants access with the NDA requirement selected
- **THEN** the NDA is sent to the grantee and access is withheld until it is executed

#### Scenario: Requirement can be waived
- **WHEN** the broker has an offline or different process
- **THEN** the requirement can be turned off for that grant

#### Scenario: Execution provisions access automatically
- **WHEN** the NDA reaches Executed in `SY - 0007`
- **THEN** data room access is provisioned automatically for the signing buyer

### Requirement: NDA signing runs on the shared e-signature service

The NDA flow SHALL be a consumer of the `SY - 0007` e-signature service — its templates, merge fields,
signer routing, status set, reminders, expiry, and executed-document filing — and SHALL NOT implement
its own signing mechanism. (`BR - 0002`, depends on `SY - 0007`)

#### Scenario: No second signing implementation
- **WHEN** an NDA is sent for signature
- **THEN** it is dispatched through the shared e-signature service

### Requirement: NDA tracker

The system SHALL track, per recipient, who received the NDA, who redlined it, and where the changes
were. (`BR - 0002`)

#### Scenario: Redline history visible
- **WHEN** a recipient returns a redlined NDA
- **THEN** the tracker shows the recipient, the redline, and what changed

### Requirement: NDA and MNDA templates on the broker profile

The system SHALL let a client broker hold an integrated NDA template on their profile, supporting either
an NDA or an MNDA, used as the default for their deals. (`BR - 0002`)

#### Scenario: Broker template used
- **WHEN** an NDA is sent for a broker's deal
- **THEN** their own template is used

### Requirement: Deal listing on the platform marketplace

The system SHALL let a broker list a business they have prepared on the platform, forming a marketplace
of deals from the platform's brokers. (`BR - 0003`, surfaced by `BY - 0001`)

#### Scenario: Listing published and discoverable
- **WHEN** a broker publishes a listing
- **THEN** it appears in the marketplace to buyers whose access permits it

#### Scenario: Listing respects confidentiality
- **WHEN** a listing is published
- **THEN** it presents the anonymous profile, not identifying information

### Requirement: Cross-posting to external channels

The system SHALL generate content for a broker to publish their current transactions elsewhere on a
confidential basis — for example a LinkedIn post generated from the platform for the broker to share
with their network, and posting to external listing platforms such as BizBuySell where possible.
(`BR - 0004`)

#### Scenario: Post generated for review
- **WHEN** a broker requests external content for a deal
- **THEN** confidential-basis content is generated for them to review and publish

#### Scenario: External posting where supported
- **WHEN** an external listing platform integration is available
- **THEN** the listing can be posted to it from the platform

### Requirement: Deal sourcing from public information

The system SHALL help brokers identify local businesses by area and industry from publicly available
information, to source new transactions. (`BR - 0005`, shares the provider dependency in `DR - 0008`)

#### Scenario: Businesses identified by area and industry
- **WHEN** a broker searches an area and industry
- **THEN** candidate businesses from the available data sources are returned

### Requirement: Buyer ERP concept

The system SHALL provide the broker with a view of the buyer-side operating information the platform
already holds, in support of the deal. The scope of this feature is not yet determined and this
requirement covers only what is decidable from the source list. (`BR - 0006`)

#### Scenario: Buyer information available to the broker
- **WHEN** a broker views a buyer on their deal
- **THEN** the buyer information the platform holds and their permissions allow is presented

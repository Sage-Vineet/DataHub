## Purpose

The buyer's side of the platform: the listing marketplace they source from (`BY - 0001`), lending
information capture toward pre-approval (`BY - 0002`), criteria-matched deal notifications
(`BY - 0003`), deal screening with a referral-generating analysis package (`BY - 0004`), proprietary
off-market deal sourcing (`BY - 0005`), post-close cross-sell (`BY - 0006`), and buyer qualification
and KYC (`BY - 0007`).

**Fidelity: sketch.** No `BY` feature specification document exists; every requirement below restates a
product-list summary. `BY - 0007` is described in the source list as the highest-leverage time saver in
the entire product for a sell-side broker; `BY - 0005` is explicitly a "super end game" ambition and its
requirement is written narrowly on purpose (`design.md` §D2). Notifications (`BY - 0003`) depend on a
notification capability that still has no feature ID — Register B §2.

**Overlap note.** The buyer-side *profile* is now specified: `US - 0003` (Business Buyer Profile) in
`user-profiles` owns Buy Boxes, the lending profile, the qualification progress wheel, and the three
dashboard views — Browse Active Listings, Matched for You, and My Active Deals. This capability covers
the deal-facing behaviour behind those surfaces. Where the two touch, `US - 0003` is authoritative for
what the buyer sees and this capability for what produces it. `US - 0003` is explicit that the buyer
profile grants no data room access — all access changes originate from `BR - 0008`.

**ID note.** `BK - 0005` appears against `BY - 0006` only as a retired identifier available for reuse,
not a reference to a missing feature.

## ADDED Requirements

### Requirement: Buyers can find and source deals from active listings

The system SHALL present active listings to buyers so they can find and source deals, including listings
placed by the platform's brokers. (`BY - 0001`)

#### Scenario: Listings browsable and filterable
- **WHEN** a buyer browses the marketplace
- **THEN** active listings are presented, filterable by the criteria the listings carry

#### Scenario: Listings show anonymous content only
- **WHEN** a buyer views a listing before executing an NDA
- **THEN** only the anonymous profile content is shown

### Requirement: Buyer lending profile

The system SHALL let buyers record lending information on their profile — not required — to support
pre-approval by lenders on the platform and to strengthen the quality of LOIs submitted. (`BY - 0002`)

#### Scenario: Lending profile is optional
- **WHEN** a buyer leaves lending information incomplete
- **THEN** they retain full use of the platform

#### Scenario: Profile supports referral to lenders
- **WHEN** a buyer opts to seek financing
- **THEN** their recorded lending information is available to the referral flow

### Requirement: Criteria-matched deal notifications

The system SHALL let a buyer register acquisition criteria and SHALL notify them of new listings that
match. (`BY - 0003`)

#### Scenario: Matching listing notifies
- **WHEN** a listing matching a buyer's registered criteria is published
- **THEN** that buyer is notified

#### Scenario: Criteria also feed buyer suggestion
- **WHEN** a broker builds a buyer list
- **THEN** buyers whose registered criteria match the deal are suggested

### Requirement: Deal screening analysis package

The system SHALL let a buyer screen a deal from its listing information and produce a quick analysis
package, reusing the sell-side preparation features where applicable, delivered cheaply or free.
(`BY - 0004`)

#### Scenario: Screening produces an analysis
- **WHEN** a buyer screens a listing
- **THEN** an analysis package is produced from the listing's available data

### Requirement: Screening output surfaces the preferred deal team

The screening output SHALL present the preferred deal team for the buyer — accountants, lawyers, banks,
insurance brokers — as the platform's referral surface. (`BY - 0004`)

#### Scenario: Referrals presented with the analysis
- **WHEN** a screening analysis completes
- **THEN** the preferred deal team is presented, and referrals made are attributed for tracking

### Requirement: Off-market deal sourcing

The system SHALL support searching for off-market businesses from collected public data by geography and
industry. The scope and data sources for this feature are not yet determined; this requirement covers
only the decidable part and shares the provider dependency in `DR - 0008`. (`BY - 0005`)

#### Scenario: Off-market candidates returned
- **WHEN** a buyer searches an area and industry
- **THEN** candidate businesses from the available sources are returned

### Requirement: Post-close cross-sell

When a deal moves to closed, the system SHALL notify the buyer on file about post-close support partners
and available efficiencies. (`BY - 0006`)

#### Scenario: Closed deal triggers the notification
- **WHEN** a deal's stage becomes closed
- **THEN** the buyer on file is notified of post-close partners

#### Scenario: Closed deal data feeds the proprietary comps database
- **WHEN** a deal closes
- **THEN** its multiples are captured for the proprietary transaction database, anonymized per
  `VL - 0004`

### Requirement: Proof of funds and financing capacity verification

The system SHALL collect and verify buyer financing capacity: liquid capital available, source of equity
(personal, fund, SBA-backed with a lender relationship, seller-financed expectation), bank or brokerage
statement upload with a redaction option, lender pre-qualification letter, and for sponsors the fund
name, vintage, committed capital, and dry powder. (`BY - 0007`)

#### Scenario: Statement uploaded with redaction
- **WHEN** a buyer uploads a bank or brokerage statement
- **THEN** they can redact it consistently with `DR - 0004` before it is shared

### Requirement: Graded qualification status usable as a hard gate

The system SHALL produce a graded qualification status — unverified, self-reported, document-verified,
lender pre-qualified — visible to the broker, and SHALL let the broker configure a minimum status a
buyer must reach before receiving the CIM or being granted data room access, enforced by the platform
rather than by the broker's judgment under time pressure. (`BY - 0007`, enforced in `BR - 0008`)

#### Scenario: Under-qualified buyer is gated
- **WHEN** a buyer below the configured minimum is included in a CIM or access distribution
- **THEN** the platform blocks it and states the reason

#### Scenario: Status visible in the pipeline
- **WHEN** a broker views their outreach pipeline
- **THEN** each buyer's qualification status is shown and drives their suggested tier

### Requirement: Identity, entity, and sanctions screening

The system SHALL capture identity and entity information for the acquiring party, beneficial ownership
where the buyer is an entity, and screening against sanctions and politically exposed person lists.
(`BY - 0007`)

#### Scenario: Beneficial ownership captured for an entity buyer
- **WHEN** the acquiring party is an entity
- **THEN** its beneficial ownership is recorded

#### Scenario: Screening result recorded
- **WHEN** screening runs
- **THEN** its result and date are recorded against the buyer

### Requirement: Buyer track record is visible platform-wide

The system SHALL record buyer track record — prior acquisitions completed, and deals that went under LOI
and died with the reason — so that a repeat non-closer is visible to every broker on the platform.
(`BY - 0007`, fed by `BR - 0015`)

#### Scenario: Prior dead LOIs are visible
- **WHEN** a broker reviews a buyer with prior failed LOIs on the platform
- **THEN** those deals and their stated reasons are visible on the buyer's record

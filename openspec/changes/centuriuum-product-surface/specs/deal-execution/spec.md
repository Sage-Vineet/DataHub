## Purpose

Everything from the broker's engagement through closing: engagement and fee management (`BR - 0012`),
IOI/LOI intake with version control (`BR - 0013`), offer comparison and bid analysis (`BR - 0014`),
exclusivity and post-LOI milestone tracking (`BR - 0015`), and the LOI template library with
negotiation support (`BR - 0016`). The source list identifies the post-LOI window as where the majority
of lower-middle-market deals die — roughly half of signed LOIs never close — which makes `BR - 0015`
the highest-marginal-value feature in this capability.

**Fidelity: sketch.** No `BR` feature specification document exists; every requirement below restates a
product-list summary. The four features this capability previously recorded as blocked by
referenced-but-nonexistent rows now all exist: `VL - 0007`, `VL - 0009`, and `VL - 0010` are product-list
rows specified in `valuations`, and `QA - 0003` is a specified feature in `deal-qa`. `VL - 0009` (the
deal structure engine `BR - 0012` and `BR - 0014` both compute from) remains the binding constraint —
it has a row and a detailed summary but no specification document, so `BR - 0014` is still not buildable
against a settled contract. The UPL exposure noted in `BR - 0016` needs an owner outside engineering
(`design.md` Register B §7).

**ID note.** `BR - 0013` and `BR - 0014` were previously `LO - 0001` and `LO - 0002`; the product list's
own summaries still use those numbers, and refer to the e-signature service as `IN - 0005` (now
`SY - 0007`), to referral fee tracking as `SY - 0003` (now `SY - 0006`), to the outreach pipeline as
`BO - 0003` (now `BR - 0009`), to the seller status report as `BO - 0006` (now `BR - 0011`), and to a
notification and task service as `SY - 0004`, which is metered usage in the current numbering. See
`design.md` Register A.

## ADDED Requirements

### Requirement: Engagement letter and listing agreement lifecycle

The system SHALL generate the engagement letter and listing agreement from the broker's or brokerage's
template with deal-specific terms merged in, execute it through the e-signature service, store it
against the deal, and track expiration and renewal — an expired listing agreement being a common and
real revenue leak. (`BR - 0012`)

#### Scenario: Agreement generated and executed
- **WHEN** a broker raises an engagement letter for a deal
- **THEN** it is generated with deal terms merged and executed through the signature service

#### Scenario: Expiry warned in advance
- **WHEN** a listing agreement approaches expiration
- **THEN** the broker is warned before it lapses

### Requirement: Fee structure capture

The system SHALL capture the full fee structure: retainer or work fee with amount and billing frequency,
minimum fee, and success fee on a configurable basis — flat percentage, straight Lehman, double Lehman,
or a custom tiered scale — with the user defining whether the fee applies to enterprise value, total
consideration including earnout and seller note, or equity proceeds. (`BR - 0012`)

#### Scenario: Fee basis is explicit
- **WHEN** a fee structure is configured
- **THEN** the value definition it applies to is recorded explicitly, since that definition is where
  fee disputes originate

### Requirement: Live projected fee under each offer

The system SHALL calculate the projected success fee from the concluded value and the modeled deal
structure, so the broker sees their fee under each offer scenario and the seller sees a transparent
basis. (`BR - 0012`)

#### Scenario: Fee recalculates per offer
- **WHEN** offers are compared
- **THEN** the projected fee under each is shown

### Requirement: Commission splits and referral obligations

The system SHALL handle commission splits across multiple agents, referring parties, and the brokerage
house percentage, with referral obligations tracked through the referral service. (`BR - 0012`, uses
`SY - 0003`)

#### Scenario: Split allocated
- **WHEN** a fee is earned on a deal with multiple participants
- **THEN** the split across agents, referrers, and the house is calculated per the configured structure

### Requirement: Invoicing and closing fee summary

The system SHALL generate invoices for retainers and the closing fee, track paid and outstanding
amounts, and produce a fee summary for the closing funds flow. (`BR - 0012`)

#### Scenario: Outstanding amounts tracked
- **WHEN** invoices are issued and partially paid
- **THEN** paid and outstanding amounts are current per deal

### Requirement: Broker licensing compliance tracking

The system SHALL carry a compliance section for broker licensing where a state requires a real estate or
business broker license, with expiration reminders. (`BR - 0012`)

#### Scenario: License expiry reminded
- **WHEN** a recorded license approaches expiration
- **THEN** the broker is reminded

### Requirement: Two intake paths for offers

The system SHALL accept offers both by buyer submission through the platform against a defined template
and by broker upload of an offer received outside the platform, with AI extraction of key terms for the
broker to confirm. Both paths SHALL exist, because sophisticated buyers will send their own paper.
(`BR - 0013`)

#### Scenario: Buyer submits through the platform
- **WHEN** a buyer completes the offer template
- **THEN** the offer is created as a structured record

#### Scenario: Uploaded offer is extracted for confirmation
- **WHEN** a broker uploads an externally received offer
- **THEN** key terms are extracted and presented for the broker to confirm before the record is created

### Requirement: Structured offer terms

An offer record SHALL capture: offering party and whether an entity is yet formed; purchase price and
the basis stated (enterprise value, equity value, asset purchase); transaction form (asset or stock);
consideration breakdown across cash at close, seller note with rate and term, earnout with metric and
cap, rollover equity, escrow and holdback, assumed liabilities; working capital treatment and peg; real
estate treatment and lease terms; key employment and non-compete terms for the owner; contingencies
(financing, confirmatory diligence, landlord/franchisor consent, licensing, environmental); requested
exclusivity period; offer expiration; and the buyer's proposed timeline to close. (`BR - 0013`)

#### Scenario: Offers are comparable as data
- **WHEN** several offers exist on a deal
- **THEN** each is a structured record over the same fields, comparable without re-reading the PDFs

### Requirement: Version control with redline comparison

The system SHALL version successive drafts and counters with redline comparison between versions, SHALL
make clear at all times which version is live, and SHALL lock executed versions immutably. (`BR - 0013`)

#### Scenario: Negotiation history visible
- **WHEN** an offer has been countered several times
- **THEN** each version and the differences between them are visible, with the live version identified

#### Scenario: Executed version is immutable
- **WHEN** a version is executed
- **THEN** it can no longer be modified

### Requirement: Offer receipt drives stage, notification, and filing

Receipt of an offer SHALL advance the buyer's stage in the outreach pipeline, notify the deal team, and
file the document to the data room under the permission model — offers being among the most sensitive
documents in a process and never visible across competing buyers. (`BR - 0013`)

#### Scenario: Competing buyers cannot see each other's offers
- **WHEN** a buyer with data room access browses or searches
- **THEN** no other buyer's offer is visible to them

### Requirement: Offer comparison on economics, not headline price

The system SHALL present a comparison grid with one column per offer showing headline price, and SHALL
run each offer through the deal structure model to produce: risk-adjusted present value of total
consideration (earnout probability-weighted and discounted, seller note discounted for subordination and
collection risk, escrow discounted for release probability and timing), cash at close, total after-tax
net proceeds differentiated by asset versus stock form and entity type, and the implied multiple on
adjusted EBITDA or SDE for comparison against the comp evidence. (`BR - 0014`)

#### Scenario: Identical headline prices differ on value
- **WHEN** two offers state the same price with different structures
- **THEN** the comparison shows their differing risk-adjusted value and net proceeds

#### Scenario: After-tax proceeds by transaction form
- **WHEN** offers differ between asset and stock form
- **THEN** after-tax net proceeds are computed for each using the platform's tax logic

### Requirement: Non-economic scoring with broker-set weights

The comparison SHALL layer on non-economic factors the broker weights: buyer qualification grade,
financing certainty and any SBA contingency, contingency burden and remaining confirmatory diligence,
speed and certainty to close, cultural and employee-retention fit, the post-close role and non-compete
demanded of the owner, and the buyer's demonstrated engagement and closing track record. (`BR - 0014`)

#### Scenario: Weights are the broker's
- **WHEN** a broker sets factor weights
- **THEN** the ranking reflects them

### Requirement: Ranked recommendation with exposed reasoning

The system SHALL produce a ranked recommendation with its reasoning exposed rather than a black-box
score, a seller-facing summary suitable for the client conversation, and a negotiation gap analysis
identifying which specific terms on the leading offers are worth countering. (`BR - 0014`)

#### Scenario: Reasoning is inspectable
- **WHEN** a recommendation is produced
- **THEN** the contributing factors and their weights are shown

#### Scenario: Gap analysis identifies counter terms
- **WHEN** the leading offers are analyzed
- **THEN** the specific terms worth countering to close the value gap are identified

### Requirement: Best-and-final round management

The system SHALL support a best-and-final round in which multiple buyers are asked to improve, with
version history showing how each offer moved. (`BR - 0014`)

#### Scenario: Movement across the round is visible
- **WHEN** a best-and-final round completes
- **THEN** each buyer's before and after terms are comparable

### Requirement: Exclusivity clock and extension tracking

On LOI execution the system SHALL start the exclusivity or no-shop clock with the expiration prominent,
track the countdown, warn in advance of expiry, and manage extension requests with each extension logged
so a pattern of serial extensions is visible rather than normalized. (`BR - 0015`)

#### Scenario: Clock starts on execution
- **WHEN** an LOI is executed
- **THEN** the exclusivity period starts with its expiration date displayed

#### Scenario: Serial extensions are visible
- **WHEN** exclusivity has been extended repeatedly
- **THEN** the extension history is presented, not just the current expiry

### Requirement: Post-LOI workstream plan

The system SHALL generate the post-LOI workstream plan with owners and dates covering: confirmatory
diligence scope and completion, the QoE engagement status, lender application, underwriting and
commitment milestones, purchase agreement drafting and turn tracking with counsel for both sides,
disclosure schedules, third-party consents (landlord, franchisor, key customer, licensing, regulatory),
insurance and environmental review, employee notification and retention planning, and the working
capital peg determination. (`BR - 0015`)

#### Scenario: Plan generated with owners and dates
- **WHEN** an LOI is executed
- **THEN** the workstream plan is created with owners and target dates

#### Scenario: Milestones raise reminders
- **WHEN** a milestone approaches or passes
- **THEN** a reminder is raised to its owner and the item appears on the seller status report

### Requirement: Deal health indicator

The system SHALL surface a single deal health indicator combining days remaining under exclusivity,
percentage of workstreams on schedule, open diligence items aging past due, and unresolved retrade or
price adjustment requests — so a broker knows which of their live LOIs is at risk. (`BR - 0015`)

#### Scenario: At-risk deal is identifiable
- **WHEN** a broker reviews their live LOIs
- **THEN** the health indicator distinguishes the at-risk ones with its contributing factors

### Requirement: Retrade capture

The system SHALL capture retrade attempts with the stated basis and amount, retained both for the
current negotiation and as buyer track record data. (`BR - 0015`, feeds `BY - 0007`)

#### Scenario: Retrade recorded against the buyer
- **WHEN** a buyer attempts a retrade
- **THEN** the basis and amount are recorded and attach to that buyer's track record

### Requirement: LOI and IOI template library

The system SHALL maintain templates by transaction type — asset purchase, stock or membership interest
purchase, SBA-financed acquisition with the lender-required provisions, seller-financed, partial or
majority recapitalization with rollover — and by brokerage, merging deal and party data so a draft is
generated substantially complete. (`BR - 0016`)

#### Scenario: Template by transaction type
- **WHEN** a user selects a transaction type
- **THEN** the corresponding template is used and populated from platform data

### Requirement: Templates carry a legal disclaimer

Every template SHALL carry a clear disclaimer that it is not legal advice and that counsel review is
required. (`BR - 0016`)

#### Scenario: Disclaimer present on output
- **WHEN** a document is generated from a template
- **THEN** the disclaimer is present and not removable by the user

### Requirement: Clause-level guidance

The system SHALL provide clause-level guidance explaining the practical effect of the terms brokers most
often get wrong: what exclusivity grants and its appropriate length; binding versus non-binding
provisions and which sections survive; a working capital peg with a true-up versus a simple minimum;
earnout metric definition and the disputes caused by defining it on EBITDA without specifying accounting
treatment; escrow release mechanics; non-compete scope and its enforceability variance by state; and the
treatment of transaction expenses. (`BR - 0016`)

#### Scenario: Guidance available in context
- **WHEN** a user edits a clause with guidance available
- **THEN** the guidance for that clause is presented in place

### Requirement: Deviation and omission flagging

The system SHALL flag terms in a received offer that deviate materially from market for a deal of that
size and type, and SHALL flag missing provisions that will cause problems later — an earnout with no
dispute resolution mechanism, no working capital definition, no purchase price allocation where the tax
consequence is significant. (`BR - 0016`)

#### Scenario: Missing provision flagged
- **WHEN** a received offer contains an earnout with no dispute resolution mechanism
- **THEN** the omission is flagged before the offer is progressed

### Requirement: Counter-offer drafting from the gap analysis

The system SHALL generate the counter-offer draft from the negotiation gap analysis produced by offer
comparison. (`BR - 0016`)

#### Scenario: Counter drafted from the gaps
- **WHEN** a broker acts on the gap analysis
- **THEN** a counter-offer draft is generated addressing the identified terms

## Purpose

The sell-side process from buyer list to seller update — five features sharing one state machine and one
data spine: buyer list builder and tiering (`BR - 0007`), teaser distribution and NDA gating
(`BR - 0008`), outreach pipeline and follow-up cadence (`BR - 0009`), buyer engagement analytics
(`BR - 0010`), and the client status report (`BR - 0011`). This is the capability the product list
describes in the most detail, and where the platform replaces the spreadsheet every broker maintains by
hand.

**Fidelity: sketch.** Depends on `activity-log` (`SE - 0004`) for all of `BR - 0010`, on `e-signature`
for NDA execution, and on a notification capability that does not exist in the source list — see
`design.md` Register B §2. Referenced elsewhere in the source list as `BO - 0001` … `BO - 0006`.

## ADDED Requirements

### Requirement: Buyer list built from multiple sources

The system SHALL let a user build a per-deal buyer target list from scratch, from the broker's saved
historical lists, from platform-wide buyers whose registered acquisition criteria match, or by
spreadsheet import. (`BR - 0007`)

#### Scenario: List assembled from several sources
- **WHEN** a user builds a list from saved lists, matched registrants, and an import
- **THEN** all sources merge into one deal list without duplicate buyer records

### Requirement: Buyer record captures type, criteria, and relationship

Each buyer record SHALL capture: type (strategic/corporate acquirer, PE platform, PE add-on with sponsor
and platform company named, family office, search fund or independent sponsor, individual owner-operator),
acquisition criteria (industry, revenue and EBITDA range, geography, deal structure preference), multiple
contacts per firm with role, capital availability and financing type, prior deal history on the platform,
and the relationship owner within the brokerage. (`BR - 0007`)

#### Scenario: Multiple contacts per firm
- **WHEN** a buyer firm has several contacts
- **THEN** each is recorded with their role against the same buyer record

### Requirement: Tiering sequences outreach

The system SHALL support tiering buyers — Tier 1 most likely, Tier 2, Tier 3 broad market — so outreach
can be sequenced with strategics and best-fit sponsors approached first and quietly, and the broad
market approached only if needed. (`BR - 0007`)

#### Scenario: Outreach by tier
- **WHEN** a user distributes to Tier 1
- **THEN** only Tier 1 buyers are contacted, and later tiers remain untouched

### Requirement: Conflict and exclusion flags are enforced at distribution

The system SHALL support flagging buyers the seller has named as off-limits, and SHALL enforce that
restriction **at the distribution step** rather than relying on the user to remember. (`BR - 0007`,
enforced in `BR - 0008`)

#### Scenario: Restricted buyer cannot be contacted
- **WHEN** a distribution includes a buyer flagged as excluded or conflicted
- **THEN** that buyer is blocked from the send and the user is told why

### Requirement: Buyer suggestion and list reuse

The system SHALL suggest buyers by matching the deal's industry and size against registered acquisition
criteria and against the closed-deal history in the proprietary database, and SHALL support list reuse
across deals so a broker's network compounds in value over time. (`BR - 0007`)

#### Scenario: Suggestions from criteria and history
- **WHEN** a deal's industry and size are known
- **THEN** matching registered buyers and relevant prior acquirers are suggested

#### Scenario: List reused on a later deal
- **WHEN** a broker starts a new deal
- **THEN** their saved historical lists are available as a starting point

### Requirement: Tracked teaser distribution with per-recipient attribution

The system SHALL distribute the teaser by tracked email sent from the broker's own domain and signature,
with per-recipient links so every open, forward, and click is attributable rather than lost in a mass
blind copy. (`BR - 0008`)

#### Scenario: Opens attributed per recipient
- **WHEN** recipients open or click the teaser
- **THEN** each event is attributed to the specific recipient

#### Scenario: Forward is visible
- **WHEN** a recipient forwards the teaser and the new party opens it
- **THEN** the activity is attributable to the original recipient's link

### Requirement: NDA is the gate between anonymous interest and identified information

On expression of interest the system SHALL trigger the NDA or MNDA through the e-signature service and
track issue, redline, countersignature, and full execution. The NDA requirement SHALL be toggleable,
since brokers may run a different or offline process. (`BR - 0008`)

#### Scenario: Interest triggers the NDA
- **WHEN** a recipient expresses interest
- **THEN** the NDA is issued to them and its status tracked

#### Scenario: Requirement toggled off
- **WHEN** a broker disables the NDA requirement for a deal
- **THEN** the process proceeds without it, and the choice is recorded

### Requirement: Execution provisions access automatically, never before

Only on NDA execution SHALL the system provision that buyer's access to the data room folder set defined
for their stage. Access SHALL never be granted manually as part of this flow and SHALL never be granted
before execution. (`BR - 0008`, via `e-signature` and `access-control`)

#### Scenario: Access appears on execution
- **WHEN** an NDA is fully executed
- **THEN** the buyer's stage-appropriate folder access is provisioned automatically

#### Scenario: No access before execution
- **WHEN** an NDA is issued but not executed
- **THEN** the buyer has no data room access

### Requirement: Staged information release

The system SHALL support staged release — teaser, then NDA and CIM, then full data room, then management
meeting materials — tracking each buyer's current stage and never exposing a later stage's documents
early. (`BR - 0008`)

#### Scenario: Later-stage documents are not visible
- **WHEN** a buyer at the CIM stage browses the data room
- **THEN** documents belonging to later stages are absent from listings and search

### Requirement: Distribution log

The system SHALL maintain a log showing exactly who received which version of the teaser and when —
needed both for confidentiality defense if a leak occurs and to demonstrate process to the seller.
(`BR - 0008`)

#### Scenario: Log reconstructs the distribution
- **WHEN** the distribution log is reviewed
- **THEN** each recipient, the teaser version they received, and the time are shown

### Requirement: Per-buyer pipeline stages with captured pass reasons

The system SHALL move each buyer through defined stages — identified, contacted, teaser sent, no
response, passed, NDA out, NDA executed, CIM delivered, in diligence, management meeting held, IOI
received, LOI received, exclusivity, closed, dead — and SHALL capture the pass or dead reason from a
controlled list (valuation expectation, size too small, industry fit, customer concentration, timing,
financing, owner dependence). (`BR - 0009`)

#### Scenario: Pass requires a reason
- **WHEN** a buyer is marked passed or dead
- **THEN** a reason from the controlled list is captured

#### Scenario: Reasons aggregate across deals
- **WHEN** pass reasons are reviewed across a brokerage's deals
- **THEN** the aggregate shows where listings consistently fail

### Requirement: Follow-up cadence drafts rather than blasts

The system SHALL support configurable follow-up sequences and intervals per stage, **drafting** the next
touch for the broker to review and send rather than sending automatically, and SHALL raise stall alerts
when a buyer sits in a stage beyond a threshold. (`BR - 0009`)

#### Scenario: Next touch drafted for review
- **WHEN** a follow-up interval elapses
- **THEN** the next touch is drafted and presented to the broker, unsent

#### Scenario: Stall alert
- **WHEN** a buyer exceeds the stage threshold
- **THEN** the broker is alerted

### Requirement: Pipeline views and per-deal funnel

The system SHALL provide kanban and list views filterable by tier, stage, owner, and last-contact age,
and SHALL roll up to a per-deal funnel showing counts at each stage — so a broker can see immediately
whether a process is failing at the top of the funnel (list or teaser) or the bottom (price or
diligence). (`BR - 0009`)

#### Scenario: Funnel shows stage counts
- **WHEN** a broker opens the deal funnel
- **THEN** counts at each stage are shown

#### Scenario: All stage changes and touches are logged
- **WHEN** a stage changes or a touch is recorded
- **THEN** it writes to the activity log

### Requirement: Per-buyer engagement telemetry

The system SHALL surface, per buyer: teaser opens and forwards, time from NDA issue to execution, first
data room login and login frequency, session duration, which documents were opened and for how long,
download and print activity, how many individuals from that buyer's team are credentialed and active,
and question volume submitted through Q&A. (`BR - 0010`, built on `SE - 0004`)

#### Scenario: Telemetry assembled per buyer
- **WHEN** a broker opens a buyer's engagement view
- **THEN** the above signals are presented for that buyer

### Requirement: Engagement score and document heat map

The system SHALL present engagement as a ranked score and a document-by-buyer heat map, so a broker can
distinguish a buyer who has spent hours in the tax returns, QoE workbook, and concentration schedules
from one who opened the CIM once three weeks ago, and prioritize accordingly. (`BR - 0010`)

#### Scenario: Buyers ranked by engagement
- **WHEN** the engagement view is opened
- **THEN** buyers are ranked by score with the underlying signals inspectable

#### Scenario: Document-level signal surfaced
- **WHEN** serious buyers consistently stall on the same schedule
- **THEN** that document-level pattern is surfaced as a diligence problem to address proactively

### Requirement: Engagement data supports anonymized seller presentation

Engagement analytics SHALL support anonymized presentation to the seller, so a seller sees aggregate
activity without necessarily seeing buyer identities. (`BR - 0010`, feeds `BR - 0011`)

#### Scenario: Seller sees activity without identities
- **WHEN** engagement data is presented to the seller with anonymization on
- **THEN** aggregate activity is shown and buyer identities are withheld

### Requirement: Scheduled seller status report generated from process data

The system SHALL generate a recurring seller status report — weekly or biweekly, configurable — from
process data rather than hand-written, summarizing: buyers contacted this period and cumulatively,
funnel counts by stage, NDAs executed, CIMs delivered, aggregate data room activity and engagement
trend, questions received and answered, meetings held and scheduled, offers received, upcoming
milestones and deadlines, and a summary of pass reasons. (`BR - 0011`)

#### Scenario: Report generated on schedule
- **WHEN** the configured interval elapses
- **THEN** a report is generated from current process data

#### Scenario: Pass reasons included as market feedback
- **WHEN** buyers have passed during the period
- **THEN** their reasons are summarized in the report

### Requirement: Broker controls narrative, redaction, and whether it sends

The broker SHALL be able to add narrative commentary and recommendations before release, control buyer
identity redaction, configure what is shared, and treat the report as optional — completing it
themselves if they prefer. (`BR - 0011`)

#### Scenario: Broker edits before release
- **WHEN** a report is generated
- **THEN** it is held for the broker's commentary and approval before the seller sees it

#### Scenario: Identity redaction protects the network
- **WHEN** redaction is enabled
- **THEN** activity and pass reasons are shown without buyer names

### Requirement: Report delivery, archival, and export

The report SHALL be delivered through the platform to the seller's company profile with email
notification, archived per deal so the full process history is reconstructable, exportable to PDF, and
renderable from a firm-branded template. (`BR - 0011`)

#### Scenario: Archived per deal
- **WHEN** past reports are reviewed
- **THEN** every issued report for that deal is retrievable in order

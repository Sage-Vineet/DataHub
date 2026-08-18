## Purpose

What the seller sees of their own deal — a broker-gated view during the process, and the referral
surface after it closes. Covers `CP - 0001` (Active Deal) and `CP - 0002` (Post Close). The company
user's account creation and dashboard sharing flags are in `user-profiles` (`US - 0005`); this
capability is the deal-facing surface those flags govern.

**Fidelity: specified.** Requirements are drawn from the `CP - 0001` and `CP - 0002` feature
specifications (Josh Tonnesen, 14 Aug 2026).

## ADDED Requirements

### Requirement: Active Deal is a cadenced snapshot, not a live dashboard

The system SHALL generate an Active Deal snapshot for each company/deal on a defined cadence — daily or
weekly, configurable by the broker — consistent with the cadence model used for the broker's Client
Status Report (`BR - 0011`), and SHALL NOT present Active Deal as a live or real-time dashboard.
Displayed data SHALL reflect the most recent snapshot, with the snapshot generation timestamp shown to
the company user. (`CP - 0001`)

#### Scenario: The page carries an "as of" stamp
- **WHEN** a company user opens Active Deal
- **THEN** the snapshot renders with a visible generation timestamp and does not update in real time

### Requirement: Snapshot content is limited to broker-enabled categories

The system SHALL include in the snapshot only the categories the broker has enabled through the sharing
flags defined in `US - 0005` / `SY - 0002` — deal stage, aggregate activity counts, NDA execution
counts, buyer interest trend, upcoming milestones — and SHALL render a disabled category as fully absent
rather than as a locked, greyed-out, or placeholder element. Upcoming milestones and deadlines, such as
exclusivity expiration and diligence items sourced from `BR - 0015` and `BR - 0001`, SHALL appear only
when their sharing flag is enabled. (`CP - 0001`)

#### Scenario: Disabled categories leave no trace
- **WHEN** a category's sharing flag is off
- **THEN** it is absent from the snapshot, with no locked or placeholder element

### Requirement: Buyer data reaches the seller only in aggregate

The system SHALL present all buyer interest and engagement data in aggregate form only — counts, trends,
rankings by stage — and SHALL NEVER expose individual buyer names, contact details, or other
buyer-identifying information to the company user, regardless of sharing-flag settings. (`CP - 0001`)

#### Scenario: No sharing flag can reveal a buyer
- **WHEN** any combination of sharing flags is enabled
- **THEN** no buyer name or buyer-identifying detail is shown to the company user

### Requirement: Multi-deal company users switch between independently governed deals

The system SHALL allow a company user associated with more than one company/deal to switch between them
via a deal switcher, with each deal's snapshot and sharing-flag settings evaluated independently, and
SHALL restrict the switcher to the deals that user is explicitly associated with per `SY - 0002`.
(`CP - 0001`)

#### Scenario: Each deal carries its own settings
- **WHEN** a company user switches between two deals
- **THEN** each snapshot reflects only that deal's own sharing flags and data

### Requirement: Pending question notifications are broker-gated

The system SHALL notify the company user when a question is pending their response in Q&A
(`QA - 0001`), gated by whether the broker has enabled question and notification visibility for that
deal, delivered through the platform notifications hub. (`CP - 0001`)

#### Scenario: Notification follows the flag
- **WHEN** a question awaits the company user and the broker has enabled notification visibility
- **THEN** the company user is notified

### Requirement: Active Deal generation and views are logged

The system SHALL log snapshot generation and any company-user view of the Active Deal page to the
platform activity/audit log. (`CP - 0001`, feeds `SY - 0003`)

#### Scenario: Both generation and viewing are recorded
- **WHEN** a snapshot is generated or a company user views the page
- **THEN** the activity/audit log records it

### Requirement: Closing a deal transitions the company profile to Post Close

The system SHALL allow a broker to mark a deal Closed/Sold from the Deal Tracker (`BR - 0001`),
recording a close date, and SHALL transition the associated Company Profile (`US - 0005`) to a Post
Close state immediately. The system SHALL support one or more company-side contacts — owner and other
designated stakeholders — carried forward into that state, and SHALL notify the company
representative(s) that the deal has closed and post-close partner options are available. (`CP - 0002`)

#### Scenario: Transition is immediate and dated
- **WHEN** a broker marks a deal Closed/Sold
- **THEN** the Company Profile immediately reflects Post Close with the recorded close date

#### Scenario: Multiple representatives carry forward
- **WHEN** a deal enters Post Close
- **THEN** all designated company-side representatives are displayed

### Requirement: Referral partners are suggested but contact is never shared without opt-in

The system SHALL display a list of suggested referral partners — wealth managers and similar — sourced
from the referral network maintained in `SY - 0006`, filterable or matched by partner type. The system
SHALL require the company representative to give explicit, logged opt-in consent before any of their
contact information is shared with a specific referral partner, and SHALL NOT share that information
absent the opt-in. The representative SHALL be able to request an introduction to a selected partner,
generating a referral/introduction request record in `SY - 0006`. (`CP - 0002`)

#### Scenario: Consent precedes introduction
- **WHEN** a representative attempts to request an introduction without having given consent
- **THEN** the request cannot proceed

#### Scenario: No sharing without a consent record
- **WHEN** contact information would be shared with a partner
- **THEN** a logged opt-in consent record tied to that specific partner and representative must exist

#### Scenario: Introduction creates a referral record
- **WHEN** a representative requests an introduction
- **THEN** a record is created in `SY - 0006` and an entry written to the Activity & Audit Log

### Requirement: Closing prompts an access review without changing access

The system SHALL notify the broker, when a deal is marked Closed/Sold, that the data room's access
settings may need review, without automatically changing any data room permission, and SHALL retain the
company's existing data room access unchanged on transition to Post Close unless the broker manually
updates it. (`CP - 0002`)

#### Scenario: Access is unchanged and the broker is reminded
- **WHEN** a deal transitions to Post Close
- **THEN** data room access is unchanged and the broker sees a passive reminder to review it

### Requirement: Post Close activity is deal-isolated and logged

The system SHALL log the consent event, the partner suggested, and the introduction request event to the
Activity & Audit Log, and SHALL prevent users outside the Company and Broker roles on that deal from
viewing Post Close referral activity. (`CP - 0002`, feeds `SY - 0003`)

#### Scenario: Referral activity stays within the deal
- **WHEN** a user outside the Company and Broker roles on that deal seeks Post Close referral activity
- **THEN** access is refused

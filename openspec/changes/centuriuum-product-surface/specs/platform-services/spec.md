## Purpose

Cross-cutting platform mechanics that are not tied to one deal: AI usage metering (`SY - 0001`), user
creation and onboarding (`SY - 0002`), and referral tracking with payment flow (`SY - 0003`). Grouped
because each is a platform-level service consumed by many capabilities and owned by none of them.

**Fidelity: sketch.** `SY - 0001` is explicitly undecided in the source list ("nothing to determine
yet") while AI features appear across QoE, CIM, redaction, and offer intake — see `design.md`
Register B §9. E-signature (`SY - 0004`) is specified separately as its own capability.

## ADDED Requirements

### Requirement: AI usage is metered per user and per engagement

The system SHALL meter AI consumption attributably — per user, per company/deal, and per feature — and
SHALL make that consumption readable, so that pricing and abuse limits can be applied to a real number.
(`SY - 0001`)

#### Scenario: Consumption is attributed
- **WHEN** a user invokes an AI-backed feature
- **THEN** the consumption is recorded against that user, that deal, and that feature

#### Scenario: Metering covers every AI surface
- **WHEN** any AI-backed feature runs — extraction, redaction, Q&A generation, offer term extraction
- **THEN** its consumption is metered through the same service, with no unmetered path

### Requirement: Free-tier and per-account limits are enforceable

The system SHALL support configurable usage limits per account tier, and SHALL enforce them at the
point of consumption rather than reporting the overage after the fact. (`SY - 0001`)

#### Scenario: Limit reached
- **WHEN** an account reaches its configured limit
- **THEN** further AI-backed invocations are refused with an explanation, and non-AI functionality is
  unaffected

#### Scenario: Limit raised
- **WHEN** an account's limit is increased
- **THEN** invocations resume without any other change to the account

### Requirement: Metering extends to metered third-party data

The metering mechanism SHALL extend to per-query or per-seat priced external data providers, so that
provider usage is attributable per user and per engagement in the same way as AI usage. (`SY - 0001`,
required by `DR - 0008`)

#### Scenario: A provider query is metered
- **WHEN** a comparable or transaction record is pulled from a metered external provider
- **THEN** the query is recorded against the user and the engagement that caused it

### Requirement: Two paths to a user account

The system SHALL create users either by data room invitation or by self-service sign-up from the login
page, and both paths SHALL converge on the same account and profile model. (`SY - 0002`)

#### Scenario: Invited user
- **WHEN** a company owner invites an email address to a data room
- **THEN** the recipient can create an account from that invitation and lands with access to that
  company only

#### Scenario: Self-service sign-up
- **WHEN** a user signs up from the login page
- **THEN** an account and profile are created with no access to any company until granted

#### Scenario: Invitation to an existing account
- **WHEN** an invited email already has an account
- **THEN** the grant attaches to the existing account rather than creating a duplicate

### Requirement: Referrals are tracked to their source

The system SHALL record how a user or engagement arrived — referring party, referring deal, and
referral type — and SHALL make referral obligations reportable per party. (`SY - 0003`)

#### Scenario: Referral attribution is retained
- **WHEN** a user arrives via a referral and later transacts
- **THEN** the referring party and the referred engagement remain linked

#### Scenario: Referral obligations are reportable
- **WHEN** a referring party's obligations are reviewed
- **THEN** the referred engagements and their status are listed

### Requirement: Referral payment flow is supported but optional

The system SHALL support collecting payment for services through the platform and holding funds with a
third-party escrow so that referral fees can be settled from proceeds, and SHALL NOT require the
payment flow for referral tracking to function. (`SY - 0003`)

#### Scenario: Tracking without payment
- **WHEN** an installation does not use platform payment
- **THEN** referral tracking and reporting still work

#### Scenario: Prepayment held in escrow
- **WHEN** a client prepays for a service through the platform
- **THEN** funds are held with the third-party escrow provider and their release is recorded against
  the engagement

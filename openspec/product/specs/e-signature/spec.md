## Purpose

One signature service, consumed by every module that needs a signature rather than re-implemented inside
each. Covers `SY - 0007` (E-Signature Service). The product list describes signing four separate times —
NDA (`BR - 0002`), engagement letter / listing agreement (`BR - 0012`), IOI/LOI execution (`BR - 0013`),
and buyer qualification attestations (`BY - 0007`) — which is why it is pulled out as its own capability.

**Fidelity: specified.** Requirements are drawn from the `SY - 0007` feature specification (Josh
Tonnesen, 14 Aug 2026).

**ID note.** This feature was previously numbered `SY - 0004`; the System module was renumbered when the
`SE` module was folded in. `SY - 0004` is now AI & compute usage metering. The source document's
functional requirements refer to the NDA consumer as `BR - 0002` / `BO - 0002` and to engagement letters
as `BR - 0007`; in the current product list engagement and fee management is `BR - 0012`.

## ADDED Requirements

### Requirement: Templates with merge fields, at firm and user level

The system SHALL support template management with merge fields, so a template's placeholders — party
name, deal name, date, dollar amount — are populated from platform data at send time. Templates SHALL be
creatable and manageable at two levels: firm/brokerage level, visible to all users at that firm, and
individual user level, visible only to that user. Firm-level templates SHALL take precedence as the
default unless the user selects their own. (`SY - 0007`)

#### Scenario: Merge fields populate at send time
- **WHEN** a document is generated from a template containing at least one merge field
- **THEN** the field is populated from platform data for that deal

#### Scenario: Firm template is the default
- **WHEN** both a firm-level and a user-level template exist for the same document type
- **THEN** the firm-level template is offered as the default and the user may select their own instead

### Requirement: Provider is abstracted behind official APIs

The system SHALL abstract the signature provider so that Docusign, Dropbox Sign, and Adobe Acrobat Sign
can each be connected via their official API, with no browser automation and no credential scraping. A
firm SHALL be able to connect its own corporate account with any supported provider; where no firm
account is connected, the system SHALL use a platform-level default provider account. (`SY - 0007`)

#### Scenario: Firm account is used when connected
- **WHEN** a firm administrator connects a supported provider account and a user at that firm initiates
  a signature request
- **THEN** the request routes through the firm's connected account

#### Scenario: Platform default covers unconnected firms
- **WHEN** a firm has no connected provider account
- **THEN** requests route through the platform-level default provider account

#### Scenario: Disconnection is supported
- **WHEN** a firm administrator disconnects a provider account
- **THEN** the connection is removed and subsequent requests fall back to the platform default

### Requirement: Signer roles, order, and type are configurable

The system SHALL allow the initiating user to define signer roles, signer order (sequential or
parallel), and signer type (individual, entity representative, guarantor/spouse) for each request. The
system SHALL support in-person and remote signing, delegated or authorized-representative signing for
entity signers, and counter-signature workflows such as buyer-signs-then-broker-countersigns.
(`SY - 0007`)

#### Scenario: Sequential order is respected
- **WHEN** a request with two or more signers is sent in a defined sequential order
- **THEN** each signer receives the request only after the prior signer completes their action

#### Scenario: Countersignature closes the loop
- **WHEN** a buyer signs a document configured for broker countersignature
- **THEN** the request routes to the broker to countersign before reaching Executed

### Requirement: Status is tracked and shown on the originating record

The system SHALL track and expose signature request status at all times across the set: Draft, Sent,
Viewed, Partially Signed, Executed, Declined, Expired, Voided. The current status SHALL be surfaced
directly on the record of the module that initiated the request — the NDA record, the engagement letter
record — and NOT only in a separate central log screen. (`SY - 0007`)

#### Scenario: Originating record shows live status
- **WHEN** a signature request changes state
- **THEN** the initiating module's record reflects the new status in real time or on next page load

### Requirement: Reminders, expiry, voiding, and amendment

The system SHALL send configurable automated reminders to outstanding signers on a schedule set by the
initiating user or firm default, SHALL support a configurable expiration period after which an unsigned
request moves automatically to Expired, SHALL allow a user to void an in-flight request with the reason
optionally logged and status updated to Voided across all views referencing it, and SHALL make
re-sending or amending an unsigned request generate a new version rather than overwrite the original.
(`SY - 0007`)

#### Scenario: Unsigned request expires
- **WHEN** the configured expiration period elapses with the request unsigned
- **THEN** the request moves to Expired

#### Scenario: Voiding propagates
- **WHEN** a user voids an in-flight request
- **THEN** every view referencing that request shows Voided

#### Scenario: Amendment creates a version
- **WHEN** an unsigned request is amended and re-sent
- **THEN** a new version is created and the original is retained

### Requirement: Executed documents file themselves to the data room

Upon full execution, the system SHALL automatically retrieve the executed document and its completion
certificate and file both into the data room folder associated with the originating module and
company/deal, per the folder structure defined in `DR - 0002`. (`SY - 0007`, depends on `DR - 0001` /
`DR - 0002`)

#### Scenario: Executed pair lands in the right folder
- **WHEN** a request reaches Executed
- **THEN** the signed document and its completion certificate appear in the correct data room folder for
  that company/deal within an acceptable processing window

### Requirement: The evidentiary record is immutable

The system SHALL retain the audit certificate — signer identity, IP address, and timestamp for each
signing event — immutably, and this record SHALL NOT be editable or deletable by any user, consistent
with ESIGN/UETA evidentiary requirements. Every status change (sent, viewed, signed, declined, expired,
voided) SHALL be written to the Activity & Audit Log with the deal/company association. (`SY - 0007`,
feeds `SY - 0003`)

#### Scenario: Certificate cannot be altered
- **WHEN** any user attempts to edit or delete a completion certificate
- **THEN** no application path permits it

#### Scenario: Status changes reach the audit log
- **WHEN** a request changes status
- **THEN** the Activity & Audit Log records it with company/deal association, timestamp, and
  user/signer identity

### Requirement: Deal isolation applies to signature requests

A user SHALL only initiate, view, or manage signature requests for companies/deals they have been
granted access to. (`SY - 0007`, depends on `SY - 0001` / `SY - 0002`)

#### Scenario: No access, no request
- **WHEN** a user without access to a company/deal attempts to view or act on a signature request tied
  to it
- **THEN** the attempt is refused

### Requirement: Execution triggers downstream automation

The system SHALL trigger downstream automation on execution where applicable — most notably, execution
of an NDA SHALL trigger data room access provisioning per `BR - 0002`. (`SY - 0007`)

#### Scenario: NDA execution provisions the data room
- **WHEN** an NDA-type request reaches Executed
- **THEN** data room access is provisioned automatically for the signing buyer

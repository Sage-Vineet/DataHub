## Purpose

One reusable signature service consumed by every module that needs an executed document (`SY - 0004`).
Specified once, here, rather than rebuilt inside NDA (`BR - 0002`), engagement letters (`BR - 0012`),
IOI/LOI (`BR - 0013`), buyer attestations (`BY - 0007`), and closing documents. Its execution events
drive downstream automation — most consequentially, NDA execution provisioning data room access.

**Fidelity: sketch.** Not currently scheduled in the cutover order; `design.md` §D4 lists it as one of
four gating capabilities. The source list also references `SY - 0004` as a task/reminder service in two
places, which is a separate unresolved question — see `design.md` Register B §1. Referenced elsewhere
in the source list as `IN - 0005`.

## ADDED Requirements

### Requirement: Provider is abstracted, not hardcoded

The system SHALL integrate e-signature through a provider abstraction supporting Docusign, Dropbox Sign,
and Adobe Acrobat Sign via API, and SHALL allow a brokerage to connect its own corporate account with
that provider. No consuming module SHALL depend on a specific provider. (`SY - 0004`)

#### Scenario: Provider swapped without touching consumers
- **WHEN** the configured provider changes
- **THEN** every consuming module continues to send, track, and file documents unchanged

#### Scenario: Brokerage connects its own account
- **WHEN** a brokerage connects its corporate provider account
- **THEN** documents for that brokerage's deals are sent through that account

### Requirement: Templates merge platform data

The system SHALL manage signature templates with merge fields populated from platform data, so a
document is generated substantially complete rather than filled in by hand. (`SY - 0004`)

#### Scenario: Generated document arrives populated
- **WHEN** a user sends a document from a template against a deal
- **THEN** party names, deal terms, and dates are already merged from platform data

### Requirement: Multi-party routing and signer roles

The system SHALL support defined signer roles and routing order across multiple parties — seller, buyer,
broker, guarantor, and spouse where a personal guarantee is involved — plus in-person and remote
signing, counter-signature workflows, and delegated or authorized-representative signing for entity
signers. (`SY - 0004`)

#### Scenario: Ordered routing
- **WHEN** a document defines a signing order
- **THEN** each party is requested only after the preceding party completes

#### Scenario: Entity signer delegates
- **WHEN** an entity party designates an authorized representative
- **THEN** that representative signs on the entity's behalf and the certificate records the delegation

### Requirement: Status is surfaced on the originating record

The system SHALL track status — draft, sent, viewed, partially signed, executed, declined, expired,
voided — and SHALL surface the current status on the record that originated the document, with reminder
and expiration handling. (`SY - 0004`)

#### Scenario: Status visible where the document was raised
- **WHEN** an NDA raised from a buyer record is viewed
- **THEN** that buyer record shows the current signature status without the user going elsewhere

#### Scenario: Reminders and expiry
- **WHEN** a sent document goes unsigned past its configured reminder interval or expiry
- **THEN** a reminder is issued, and on expiry the status becomes expired

### Requirement: Executed documents are filed automatically

On execution the system SHALL file the executed document and its completion certificate to the correct
data room folder against the correct deal, with no manual filing step. (`SY - 0004`)

#### Scenario: Execution files the document
- **WHEN** the last required party signs
- **THEN** the executed document and its certificate appear in the deal's designated folder

### Requirement: Audit certificate is retained immutably

The system SHALL retain, immutably, the audit certificate showing signer identity, IP address, and
timestamps — the record that gives the signature legal weight under ESIGN and UETA. (`SY - 0004`)

#### Scenario: Certificate cannot be altered
- **WHEN** any user attempts to modify or delete a completion certificate
- **THEN** the operation is unavailable

### Requirement: Execution triggers downstream automation

Execution events SHALL trigger the automation the consuming module defines — most importantly, NDA
execution provisioning the counterparty's data room access — and SHALL write to the activity log.
(`SY - 0004`, drives `BR - 0008`, feeds `SE - 0004`)

#### Scenario: NDA execution provisions access
- **WHEN** an NDA is fully executed
- **THEN** the counterparty's data room access is provisioned automatically for the folder set defined
  for their stage, without a manual grant

#### Scenario: Execution is logged
- **WHEN** any document reaches executed status
- **THEN** an activity log entry records the parties, the document, and the time

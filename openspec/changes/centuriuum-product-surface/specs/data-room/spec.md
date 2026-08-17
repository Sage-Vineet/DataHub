## Purpose

The secure document store at the centre of every engagement: the core data room (`DR - 0001`), the
templated file structure (`DR - 0002`), the data retrieve wizard entry point (`DR - 0003`), AI
redaction on upload (`DR - 0004`), the lender requirements checklist (`DR - 0005`), and document
control and watermarking (`DR - 0006`). Folder-level permission lives in `access-control`; this
capability covers what a party may *do with a file* once opened, which in an M&A process is the
sharper risk.

**Fidelity: sketch**, except `DR - 0003`, which is specified at implementation fidelity by the separate
`data-retrieve-wizard` change and only referenced here. Depends on the unresolved document-versioning
gap — see `design.md` Register B §3.

## ADDED Requirements

### Requirement: Core document storage

The system SHALL store a company's documents in a per-company data room, with upload, organization into
folders, viewing, and download, all governed by the permission model in `access-control`. (`DR - 0001`)

#### Scenario: Documents are per-company isolated
- **WHEN** a user with access to company A browses or searches
- **THEN** only company A's documents appear, with no cross-company results

#### Scenario: Access follows the grant, not the role
- **WHEN** a user's per-company permissions restrict them to a folder subset
- **THEN** only that subset is listed, searchable, and openable

### Requirement: Templated file structure

The system SHALL let the owner of a created company apply a desired file tree template, and SHALL
create that structure so incoming documents — including those produced by the retrieve wizard — land in
defined locations rather than an empty root. (`DR - 0002`)

#### Scenario: Template applied at company creation
- **WHEN** an owner creates a company and selects a file tree template
- **THEN** the folder structure is created ready to receive documents

#### Scenario: Template defines where generated files land
- **WHEN** a feature writes a document into the data room
- **THEN** it resolves the destination from the templated structure rather than choosing its own

### Requirement: Data retrieve wizard entry point

The data room SHALL provide the entry point for the Data Retrieve Wizard, visible to users with upload
permission on that company. Its behavior is specified in full by the `data-retrieve-wizard` capability.
(`DR - 0003`)

#### Scenario: Entry point is permission-gated
- **WHEN** a user without upload permission opens the data room
- **THEN** the retrieve wizard entry point is not present

### Requirement: AI redaction on upload

The system SHALL let a user redact specific items from an uploaded document using AI assistance — most
commonly identifiers such as the PIN on a tax return — and SHALL retain the redacted output as the
shared artifact. (`DR - 0004`)

#### Scenario: Redaction applied before sharing
- **WHEN** a user redacts items on an uploaded document
- **THEN** parties with access to the shared version see the redacted output, not the original

#### Scenario: Redaction is reviewable before it is committed
- **WHEN** AI proposes redactions
- **THEN** the user reviews and confirms them rather than having them applied unreviewed

### Requirement: Lender requirements checklist

The system SHALL maintain a listing of the items a bank will require, tracked per deal against the
documents present, and SHALL surface outstanding items so a broker can prepare them in advance.
(`DR - 0005`, ties to `BR - 0001`)

#### Scenario: Outstanding items are visible
- **WHEN** a broker opens the lender requirements for a deal
- **THEN** each required item shows as satisfied or outstanding, with satisfied items linked to the
  document that satisfies them

#### Scenario: Uploading a document satisfies its item
- **WHEN** a document matching a requirement is added
- **THEN** the corresponding checklist item is marked satisfied and linked

### Requirement: Dynamic per-user watermarking

The system SHALL support watermarking that stamps the viewing user's name, email, company, and access
timestamp onto every page **at render time** rather than into the stored file, so each recipient's copy
is uniquely identifiable and a leaked page is traceable to the individual who obtained it. (`DR - 0006`)

#### Scenario: Two viewers receive distinguishable copies
- **WHEN** two users view the same file
- **THEN** each rendered copy carries that user's identity and access timestamp

#### Scenario: Stored file is unmodified
- **WHEN** a watermarked file is inspected in storage
- **THEN** the stored bytes carry no watermark

### Requirement: Watermarking and restrictions are configurable and can be turned off

Watermark and restriction defaults SHALL be configurable per brokerage and per file category rather than
set file by file, and SHALL be switchable off — brokers may reasonably decide the friction is not worth
it, including because watermarking can force spreadsheets to be delivered as PDFs. (`DR - 0006`)

#### Scenario: Broker disables watermarking
- **WHEN** a broker turns watermarking off for a deal or category
- **THEN** files render unwatermarked, and the setting change is logged

#### Scenario: Category defaults apply
- **WHEN** a file is added to a category configured as view-only with watermark
- **THEN** those controls apply without per-file configuration

### Requirement: View-only rendering with separately granted download

The system SHALL support view-only rendering in a secure browser viewer with download, print, and copy
disabled where required, and SHALL treat download as an explicit permission granted per folder or per
file rather than a blanket right. (`DR - 0006`)

#### Scenario: View-only file cannot be downloaded
- **WHEN** a user without download permission opens a view-only file
- **THEN** it renders in the viewer and no download or print path is available

#### Scenario: Sensitive categories default to view-only
- **WHEN** a customer list, employee or compensation detail, contract, or tax return is added
- **THEN** it defaults to view-only with watermark, while general marketing material remains freely
  downloadable

### Requirement: Access expiration, revocation, and restriction

The system SHALL support access expiration with automatic revocation on a date or on a stage change —
such as a buyer being passed over — immediate revocation of access to a previously distributed file
where the format supports it, and IP or geography restriction for sensitive files. (`DR - 0006`)

#### Scenario: Passed buyer loses access automatically
- **WHEN** a buyer's stage changes to passed
- **THEN** their data room access is revoked without a manual step, and further attempts are denied and
  logged

#### Scenario: Expiry revokes on schedule
- **WHEN** a grant reaches its configured expiration
- **THEN** access ends automatically

### Requirement: Document activity feeds the log and analytics

Every view, download, print, and failed access attempt SHALL write to the activity log, providing both
the buyer engagement telemetry used by `BR - 0010` and the evidentiary record needed if a
confidentiality breach is alleged. (`DR - 0006`, feeds `SE - 0004`, `BR - 0010`)

#### Scenario: Denied attempt is recorded
- **WHEN** a party attempts to open a file they may not access
- **THEN** the denial is logged with user, file, and time

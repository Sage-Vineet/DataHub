## Purpose

The document surface of a deal: where files live, how they are organized, who may do what with them once
opened, and who is on the deal. Covers `DR - 0001` (Core Data Room), `DR - 0002` (Templated File
Structure), `DR - 0004` (Redaction), `DR - 0005` (Lender Requirements), `DR - 0006` (Document Control &
Watermarking), and `DR - 0009` (Deal Team). `DR - 0003` (Data Retrieve Wizard) is referenced here and
specified in full by the separate `data-retrieve-wizard` change. `DR - 0007` / `DR - 0008` are external
integrations and live in `external-integrations`.

**Fidelity: specified**, except `DR - 0005` (Lender Requirements), which has no feature specification
document and remains at sketch fidelity from the product-list summary. Requirements are drawn from the
`DR - 0001`, `DR - 0002`, `DR - 0004`, `DR - 0006`, and `DR - 0009` feature specifications (Josh
Tonnesen, 14 Aug 2026).

**ID note.** `DR - 0009` (Deal Team) was previously numbered `SE - 0003` and specified under
`access-control`; it now sits in the Data Room module and is specified here. The `DR - 0006`
product-list summary still refers to the permission model as `SE - 0002` (now `SY - 0002`), the activity
log as `SE - 0004` (now `SY - 0003`), and buyer engagement analytics as `BO - 0004` (now `BR - 0010`).

## ADDED Requirements

### Requirement: Per-deal file-explorer data room

The system SHALL provide a per-deal data room of folders and files presented as a file-explorer-style
interface — tree or breadcrumb navigation with a list/grid view of folder contents — and SHALL allow
authorized users to create, rename, move, and delete folders within it. (`DR - 0001`)

#### Scenario: Broker organizes a deal's documents
- **WHEN** a broker creates folders and uploads files into a deal
- **THEN** they appear organized in a file-explorer-style view scoped to that deal

### Requirement: Upload, download, and preview

The system SHALL allow authorized users to upload one or more files at a time, including by
drag-and-drop, into any folder they hold write access to, and to download individual files or a selected
folder as a zip where they hold download permission. The system SHALL support in-browser preview for
PDF, Word, Excel, PowerPoint, and standard image formats without requiring download, and SHALL fall back
to download-only for file types that do not support preview. (`DR - 0001`)

#### Scenario: Drag-and-drop upload
- **WHEN** a user drags several files onto a folder they can write to
- **THEN** all of them upload into that folder

#### Scenario: Preview with a download fallback
- **WHEN** a user opens a PDF, Word, Excel, PowerPoint, or image file
- **THEN** it renders in an in-browser preview; an unsupported type falls back to download

### Requirement: OCR runs on upload

The system SHALL run OCR extraction as part of the upload pipeline for scanned or image-based documents,
so uploaded content is text-searchable. (`DR - 0001`)

#### Scenario: A scanned PDF becomes searchable
- **WHEN** a scanned, image-based PDF is uploaded
- **THEN** OCR extraction runs and its content is searchable

### Requirement: Re-upload versions rather than overwrites

The system SHALL create a new version — not an overwrite — whenever a file with the same name is
re-uploaded to the same folder, and SHALL display prior versions with the ability to view or restore
them. (`DR - 0001`)

#### Scenario: Prior version survives a re-upload
- **WHEN** a file is re-uploaded under an existing name in the same folder
- **THEN** a new version is created, the prior version remains viewable, and it can be restored

### Requirement: Manage Access panel with two deal-level rights

The system SHALL display a persistent "Manage Access" control visible to the deal owner, opening a panel
that allows the owner to add a user — selecting an existing user or inviting one — and assign one of two
deal-level rights: View, or View + Download. The owner SHALL be able to remove a user's access or change
their assigned right at any time, with the change taking effect immediately. (`DR - 0001`, extends
`SY - 0002`)

#### Scenario: Rights apply and revoke immediately
- **WHEN** an owner adds a user with View + Download and later removes their access
- **THEN** the right takes effect immediately on grant and access is revoked immediately on removal

### Requirement: Related data-room actions are surfaced in the data room

The system SHALL surface entry points to related data-room actions as visible controls within the data
room screen, at minimum the Data Retrieve Wizard (`DR - 0003`) and Templated File Structure
(`DR - 0002`). (`DR - 0001`)

#### Scenario: Wizard and templates are reachable
- **WHEN** a user opens a deal's data room
- **THEN** the Data Retrieve Wizard and Templated File Structure actions are visible and reachable

### Requirement: Data room search and strict deal isolation

The system SHALL allow a user to search files by file name within the current deal's data room, and
SHALL restrict all data room contents, folders, and search results to the single deal/company they
belong to, with no cross-deal or cross-company visibility under any circumstance. (`DR - 0001`)

#### Scenario: Ungranted deals are invisible in search
- **WHEN** a user without access to a deal searches
- **THEN** none of that deal's folders, files, or results appear

### Requirement: Data room events are logged

The system SHALL log every upload, download, view, delete, and access-change event in the data room to
the platform activity log with user, timestamp, and action. (`DR - 0001`, feeds `SY - 0003`)

#### Scenario: Document actions are attributable
- **WHEN** any upload, download, view, delete, or access change occurs
- **THEN** the activity log records the user, timestamp, and action

### Requirement: Folder-structure templates at three scopes

The system SHALL allow a user to create a named folder-structure template of nested folders, with no
system-enforced depth limit but a soft warning beyond a reasonable depth (approximately six levels).
Templates SHALL be savable at either individual (personal) or brokerage (firm-wide) scope, chosen at save
time. Firm-wide template creation and editing SHALL be restricted to users holding an admin or owner role
at the brokerage; individual brokers SHALL be able to view and apply firm-wide templates but not edit
them. The system SHALL provide Centuriuum pre-built system templates available to all users regardless of
brokerage, and SHALL allow a user to mark one personal template as their default, which pre-selects but
does not auto-apply it. (`DR - 0002`)

#### Scenario: Firm-wide editing is restricted
- **WHEN** a broker without an admin or owner role attempts to edit a firm-wide template
- **THEN** the edit is refused while viewing and applying remain available

#### Scenario: Default template pre-selects only
- **WHEN** a user with a default personal template opens the template picker
- **THEN** that template is pre-selected and is not applied until confirmed

### Requirement: Template selection is required at deal creation

The system SHALL present a template picker at company/deal creation listing the user's personal
templates, their brokerage's firm-wide templates, and Centuriuum system templates, grouped and labeled
by source, plus an explicit "start blank" option. A selection SHALL be required before the deal's data
room is initialized. On confirmation the system SHALL create the full folder tree from the selected
template with zero documents populated. (`DR - 0002`)

#### Scenario: Picker blocks initialization until chosen
- **WHEN** a user creates a company/deal
- **THEN** the picker is presented, grouped by source with a Start Blank option, and the data room is not
  initialized until a selection is made

#### Scenario: Applied template yields empty folders
- **WHEN** a template is selected
- **THEN** the corresponding folder tree is created with no documents in it

### Requirement: Applied structures and source templates are independent

The system SHALL allow the applied folder structure to be edited per deal after creation — adding,
renaming, reordering, deleting, and nesting folders — without altering the source template, and SHALL
allow a user to save an edited deal-specific structure back as a new template at personal or firm-wide
scope per their permissions. A user SHALL be able to edit or delete their own saved templates
independently of any deal the template was applied to; existing deals SHALL retain their already-created
folders unaffected by later template edits. (`DR - 0002`)

#### Scenario: Editing a deal does not edit the template
- **WHEN** a user restructures folders inside a deal
- **THEN** the source template is unchanged

#### Scenario: Editing a template does not reach live deals
- **WHEN** a user edits or deletes a saved template
- **THEN** deals it was already applied to keep their existing folders

### Requirement: Non-empty folders cannot be deleted

The system SHALL prevent deletion of a folder within an active deal's structure while it contains
documents, requiring the user to move or delete the contents first. (`DR - 0002`)

#### Scenario: Deletion is blocked while contents remain
- **WHEN** a user attempts to delete a folder containing documents
- **THEN** the deletion is refused until the contents are moved or removed

### Requirement: Template functionality is broker-side only

Bank, Buyer, and Company user roles SHALL NOT have access to template creation, editing, or selection.
Template creation, edits, deletions, and the template applied to each company/deal SHALL be written to
the activity/audit log. (`DR - 0002`, feeds `SY - 0003`)

#### Scenario: Counterparty roles have no template surface
- **WHEN** a Bank, Buyer, or Company user navigates the platform
- **THEN** no template creation, editing, or selection functionality is reachable

### Requirement: AI-proposed redaction with human confirmation

The system SHALL present a "Redact" action on any file the current user uploaded, from the file's row or
detail view. On invocation the system SHALL run automated AI detection for likely PII — at minimum
Social Security Numbers, EINs, and bank/financial account numbers — and visually highlight each detected
item as a proposed redaction area before anything is applied. The user SHALL be able to accept, reject,
or adjust the boundaries of each proposal, manually draw additional areas the AI did not detect, and
remove or undo any proposed or added area, before confirming. (`DR - 0004`)

#### Scenario: Proposals are editable before applying
- **WHEN** a file owner opens Redact on a document containing PII
- **THEN** detected items are highlighted as proposals, and each can be accepted, rejected, adjusted,
  added to, or removed before confirmation

### Requirement: Redaction is destructive and requires explicit acknowledgement

The system SHALL require an explicit confirmation step before applying redaction, displaying a warning
that states the action modifies the core file, that it is permanent and cannot be undone, and that the
user must choose whether to retain a copy of the original. At that step the system SHALL present a
checkbox defaulted to "Destroy the original file", so retaining a copy is an explicit opt-in against the
destructive default. (`DR - 0004`)

#### Scenario: No redaction without acknowledgement
- **WHEN** a user confirms redaction
- **THEN** the destructive-action warning must be acknowledged first, with the destroy-original default
  presented

### Requirement: Destroy and retain paths are both absolute

Where the destroy option is used, the system SHALL permanently and irrecoverably delete the original
unredacted file from active storage and backups within the standard retention/deletion window, such that
no user, broker, administrator, or Centuriuum staff member can retrieve the original content thereafter.
Where the retain option is used, the system SHALL store the original in a separate restricted-access
location that is not visible in the data room file tree and is not exposed to any deal participant other
than the uploading owner. (`DR - 0004`)

#### Scenario: Destroyed originals are unrecoverable
- **WHEN** destroy-original was selected and the deletion window has elapsed
- **THEN** no user or administrator can retrieve the original content through the application

#### Scenario: Retained originals are owner-only and hidden
- **WHEN** retain-a-copy was selected
- **THEN** the original is inaccessible to every user but the file owner and does not appear in the data
  room file tree

### Requirement: Redacted output is flattened, re-OCR'd, and flagged

The system SHALL render the redacted document by flattening the affected pages to a rasterized image
layer, so no selectable or recoverable text remains beneath the redacted areas, and SHALL immediately
re-run the document through the OCR pipeline to regenerate a searchable text layer over the flattened
image — so search, extraction, and downstream table population (`DB - 0008`, `DB - 0009`) continue to
work without ever exposing pre-redaction text. The redacted version SHALL replace the file in the data
room, preserving folder location, name with a visible "(Redacted)" indicator, and permission settings,
and SHALL be visually flagged in the UI so any viewer can see the file has been redacted. (`DR - 0004`)

#### Scenario: Nothing recoverable under the redaction
- **WHEN** a redacted file is inspected or searched
- **THEN** no pre-redaction text or image content beneath the redacted areas is recoverable

#### Scenario: Redacted files stay searchable and extractable
- **WHEN** a redacted file feeds the tax return or bank statement tables
- **THEN** the re-generated OCR layer continues to populate them correctly

### Requirement: Redaction serves the buyer KYC upload path and is audited

The system SHALL support the same redaction workflow for the bank/brokerage statement upload path in
`BY - 0007`, and SHALL log every redaction event — who redacted, which file, timestamp, areas redacted
at summary level, and whether the original was destroyed or retained — to the audit trail. (`DR - 0004`,
feeds `SY - 0003`)

#### Scenario: Same workflow from the KYC path
- **WHEN** redaction is triggered from a `BY - 0007` buyer statement upload
- **THEN** the workflow behaves identically

#### Scenario: Destroy/retain outcome is recorded
- **WHEN** a redaction completes
- **THEN** the audit log records user, file, timestamp, and the destroy-or-retain outcome

### Requirement: Watermarking is per-deal and per-file-type, and broker-controlled

The system SHALL allow a Broker to enable or disable watermarking independently for each deal/company
file, and, when enabled, to select which file types are in scope — PDF, Word, Excel, image — rather than
applying it uniformly. The setting SHALL be scoped to that deal only and SHALL persist. (`DR - 0006`)

#### Scenario: Scope is per deal and per type
- **WHEN** a broker enables watermarking for a deal and selects a subset of file types
- **THEN** the setting persists, applies to that deal only, and covers only the selected types

### Requirement: Watermarks are applied at export, never to the stored file

The system SHALL apply the watermark dynamically at export time — download or print — stamping it onto
the rendered output rather than into the stored source file, and SHALL store the original uploaded file
in its native format regardless of the setting. The watermark SHALL include at minimum the exporting
user's name, email address, company/organization, and the date and time of export. Conversion to PDF
SHALL occur only at export and SHALL NOT overwrite or replace the stored original. (`DR - 0006`)

#### Scenario: Export is stamped, original is untouched
- **WHEN** an in-scope file is downloaded or printed
- **THEN** the output carries the exporting user's name, email, company, and timestamp, and the stored
  original is unchanged

### Requirement: Format-conversion consequences are warned about before enabling

The system SHALL display a confirmation warning to the Broker before watermarking is enabled for any
file type requiring format conversion to render a watermark (Excel and other non-PDF-native formats),
stating explicitly that matching files will be converted to PDF on export, and that preview/view-only
mode will no longer be available for files in scope. The setting SHALL NOT be saved until the Broker
acknowledges the warning. (`DR - 0006`)

#### Scenario: Setting waits on acknowledgement
- **WHEN** a broker enables watermarking for a file type requiring PDF conversion
- **THEN** the warning modal appears and the setting is not saved until acknowledged

### Requirement: Watermarking disables in-app preview for files in scope

When watermarking is enabled for a deal, the system SHALL disable in-app preview / view-only mode for
files of the matching types, requiring export to view content. When watermarking is disabled for a deal
or for a given file type within it, the system SHALL permit normal preview and export with no watermark
applied. Disabling SHALL NOT alter previously exported watermarked copies. (`DR - 0006`)

#### Scenario: Preview follows the scope boundary
- **WHEN** watermarking is enabled for a subset of file types
- **THEN** preview is unavailable for those types and remains available for the rest

#### Scenario: Disabling restores preview without rewriting history
- **WHEN** a broker disables watermarking for a deal
- **THEN** normal preview and unwatermarked export resume, and already-exported watermarked copies are
  unchanged

### Requirement: Watermarking covers generated output, not only uploads

The watermarking setting SHALL apply to the company file broadly, covering data room documents as well
as reports and workbook exports generated within the platform for that deal — financial reports, QoE
workbook exports — not only uploaded source documents. (`DR - 0006`, affects `QE - 0013` and the `RP`
module)

#### Scenario: Generated exports are watermarked too
- **WHEN** a QoE workbook or financial report is exported on a deal with watermarking enabled
- **THEN** the output is watermarked by the same service

### Requirement: A watermark that cannot be applied blocks the export

The system SHALL log every watermarked export (user, file, file version, timestamp, and watermark
content applied) and every attempt to export a file where watermarking is required but fails to apply,
and SHALL block that export rather than releasing an unwatermarked copy. (`DR - 0006`, feeds `SY - 0003`)

#### Scenario: Failure blocks rather than leaks
- **WHEN** watermarking is required for a file but cannot be applied
- **THEN** the export is blocked and the failed attempt is logged

### Requirement: Deal Team tab on the company profile

The system SHALL display a "Deal Team" tab on the company profile, scoped to a single deal/company,
capturing for each entry: name, role/title, role type (Broker, Company, Accountant, Bank, Buyer, Buyer
Advisor, Other), firm/company affiliation, and contact info (email/phone) where available from the
user's profile. (`DR - 0009`)

#### Scenario: Roster carries identity and affiliation
- **WHEN** a user with access opens the Deal Team tab
- **THEN** each entry shows name, role/title, role type, firm affiliation, and available contact info

### Requirement: Data room access and Deal Team listing are independent controls

The system SHALL auto-populate a candidate Deal Team entry whenever a broker grants a user access to that
deal's data room per `SY - 0002`, but SHALL allow the broker to control independently, per user, whether
that user (a) has data room access, (b) appears on the Deal Team tab, or both. These two settings SHALL
NOT be linked or inferred from one another. The broker SHALL be able to add a Deal Team entry manually
for a person with no platform or data room access, and to remove or hide any user from the tab at any
time regardless of their access status. (`DR - 0009`)

#### Scenario: Access grant creates a candidate, not a listing
- **WHEN** a broker grants a user data room access
- **THEN** a candidate Deal Team entry is created and is not visible to other parties until the broker
  explicitly enables visibility

#### Scenario: Off-platform participants can be listed
- **WHEN** a broker adds a name, role, and contact for someone with no platform access
- **THEN** the entry appears on the Deal Team tab

#### Scenario: Hiding an entry does not revoke access
- **WHEN** a broker hides a user from the Deal Team tab
- **THEN** that user's data room access is unchanged

### Requirement: Buyer-side entries are private by default and opaque to other buyers

The system SHALL default all new buyer-side data room access grants to NOT appear on the Deal Team tab
for any other party until the broker explicitly marks the entry visible, so no buyer relationship is
exposed by default. The system SHALL render the tab per viewing role: Company, Accountant, and
internal Broker-side viewers see the entries the broker has marked visible to that role; a Buyer-side
viewer sees only entries the broker has explicitly marked visible to that specific buyer's side. A
Buyer-role viewer SHALL NEVER see another Buyer-role entry, or another buyer's advisors, regardless of
broker configuration — this is a hard rule, not a togglable default. (`DR - 0009`)

#### Scenario: Buyers cannot see buyers, under any configuration
- **WHEN** a Buyer-role user views the Deal Team tab with any broker configuration applied
- **THEN** no other buyer and no other buyer's advisors appear

#### Scenario: Non-buyer roles see only what is marked for them
- **WHEN** a Company or Accountant user views the tab
- **THEN** only entries the broker marked visible to their role appear

### Requirement: Deal Team changes are audited

The system SHALL log every addition, removal, and visibility change to the Deal Team list to the
activity/audit log. (`DR - 0009`, feeds `SY - 0003`)

#### Scenario: Roster edits are recorded
- **WHEN** a Deal Team entry is added, removed, or has its visibility changed
- **THEN** the activity/audit log captures it

### Requirement: Lender requirements checklist feeds the deal tracker

The system SHALL maintain a listing of the items a bank will require on a deal and SHALL surface it
against the deal tracker, so a broker is notified of the items they can begin preparing ahead of a
financing request. (`DR - 0005`)

**Fidelity: sketch** — `DR - 0005` has no feature specification document; this requirement restates the
product-list summary and needs the same treatment the other data room features have received.

#### Scenario: Broker is prompted with what a lender will need
- **WHEN** a deal reaches a stage where financing is in view
- **THEN** the outstanding lender-required items are surfaced to the broker against the deal tracker

## Purpose

The seller-side marketing document set: the Confidential Information Memorandum, the templates and
question libraries that make one repeatable, the loader that brings an existing deck in, and the
anonymous teaser released before an NDA. Covers `CM - 0001` (CIM Helper), `CM - 0002` (CIM Template),
`CM - 0003` (CIM Loader), `CM - 0004` (Guided Q&A), and `CM - 0005` (Teaser / Blind Profile).

**Fidelity: specified.** Requirements are drawn from the five `CM` feature specifications (Josh
Tonnesen, 14 Aug 2026). Distribution of the released teaser is owned by the buyer-outreach features in
`deal-marketing`; the source documents refer to that consumer as `BO - 0002`, which is `BR - 0008`
(Teaser Distribution & NDA Gating) in the current product list.

## ADDED Requirements

### Requirement: A CIM is an ordered deck of two slide classes

The system SHALL allow a broker to create one or more CIM documents per deal, each with a name and a
status of Draft, In Review, Seller Approved, Published, or Archived. Each CIM SHALL be assembled from an
ordered list of slides belonging to one of two classes: System Financial Exhibits (data-bound,
layout-locked) and Qualitative Slides (user-authored). The system SHALL provide a default section
outline on creation — Executive Summary, Business Overview, Products & Services, Market & Competition,
Customers, Operations & Facilities, Management & Employees, Growth Opportunities, Financial Summary,
Transaction Overview, Appendix — which the broker MAY reorder, rename, or remove, and the broker SHALL
be able to add, delete, duplicate, and reorder slides. (`CM - 0001`)

#### Scenario: Default outline is editable
- **WHEN** a broker creates a CIM
- **THEN** the default section outline is present and its sections and slides can be reordered, renamed,
  and removed

### Requirement: Financial exhibits are layout-locked; qualitative slides are block-based

Financial exhibit slides SHALL be layout-locked: the user may configure exhibit parameters — period,
granularity, chart type, units, anonymization — but SHALL NOT move, resize, or directly edit any
rendered figure or label. Qualitative slides SHALL use a block-based canvas supporting slide title, body
text with bold/italic/bullets, one- and two-column layouts, image blocks, and a simple table block;
free-form absolute positioning SHALL NOT be supported. The system SHALL warn when text entered in a
block exceeds the space available in the rendered layout, rather than silently truncating or
overflowing. (`CM - 0001`)

#### Scenario: Exhibit figures are not editable anywhere
- **WHEN** a user attempts to edit a figure on a financial exhibit
- **THEN** no UI path permits it

#### Scenario: Overflow is warned, not swallowed
- **WHEN** block text exceeds the rendered space
- **THEN** the user is warned rather than the content being truncated or overflowed

### Requirement: The launch financial exhibit library

The system SHALL provide a financial exhibit library at launch covering three groups. **Core Earnings**
SHALL include a multi-year Revenue / Gross Profit / Adjusted EBITDA trend; a normalized P&L summary
covering annual periods plus TTM with a common-size (% of revenue) presentation; and an Adjusted EBITDA
and SDE bridge including the supporting add-back schedule detail. **Revenue Analytics** SHALL include
customer concentration showing the top 10 customers by revenue with each customer's percentage of total;
revenue by product/service line; revenue by location/segment; and monthly revenue seasonality with a
trailing-twelve-month trend. **Balance Sheet & Cash** SHALL include a balance sheet summary; net working
capital trend; capital expenditure history; debt schedule; and AR and AP aging summary. (`CM - 0001`)

#### Scenario: Core Earnings ties to the QoE output
- **WHEN** the Core Earnings exhibits are added
- **THEN** the Revenue, Gross Profit, and Adjusted EBITDA trend and the SDE/EBITDA bridge render with
  figures tying exactly to `QE - 0004` for the same period, with no manual number entry

### Requirement: Exhibits bind to adjusted figures, falling back to reported basis

Each financial exhibit SHALL bind to QoE-adjusted figures (`QE - 0004` and the adjusted P&L) where they
exist for the selected period. Where no QoE adjustment exists, the exhibit SHALL bind to reported
GL-derived figures from `RP - 0001` and SHALL display an explicit "reported basis — unadjusted"
indicator on the slide. The system SHALL NOT permit manual override of any rendered figure; corrections
SHALL be made at source — GL ingestion, COA mapping, or the add-back schedule — and the exhibit
re-rendered. (`CM - 0001`)

#### Scenario: Unadjusted periods are labelled
- **WHEN** no QoE adjustment exists for a selected period
- **THEN** the exhibit renders on reported basis with a visible unadjusted indicator

### Requirement: Deck-level period and presentation conventions with per-exhibit override

The broker SHALL set a CIM-level reporting period default — a fiscal year range and a TTM cutoff date —
which all financial exhibits inherit, and an individual exhibit SHALL be able to override it. Where any
exhibit's period differs from the deck default, the system SHALL display a deck-level consistency
warning identifying each differing exhibit. The broker SHALL set deck-level presentation conventions
applied uniformly to all financial exhibits: currency units (actual / thousands / millions), decimal
places, and negative-number format. (`CM - 0001`)

#### Scenario: Period change propagates, override warns
- **WHEN** the deck-level reporting period changes and one exhibit carries an override
- **THEN** every inheriting exhibit updates and a consistency warning names the overriding exhibit

### Requirement: Missing data dimensions render as unavailable, never as empty charts

Where an exhibit requires a data dimension not present in the ingested data — product line, location,
customer — the system SHALL render the exhibit as unavailable with a message naming the missing
dimension, and SHALL NOT render an empty or partially populated chart. (`CM - 0001`)

#### Scenario: Absent dimension is named
- **WHEN** an exhibit requires a dimension the ingested data lacks
- **THEN** it renders unavailable with the missing dimension named, and no partial chart is drawn

### Requirement: Draft exhibits re-render; published exhibits freeze

Financial exhibits SHALL re-render against current platform data each time the CIM is opened while its
status is Draft or In Review. On publish, the system SHALL freeze a rendered snapshot of every financial
exhibit into the published version, stamped with a financial "as of" date, so figures already presented
to buyers cannot change retroactively. Where underlying source data changes after publication — GL
re-ingestion, add-back edits, COA remapping — the system SHALL flag the published CIM "source data
changed — republish to update" without altering the published version. (`CM - 0001`)

#### Scenario: Re-ingestion flags rather than rewrites
- **WHEN** GL data is re-ingested after a version is published
- **THEN** the CIM is flagged stale and no figure in the published version changes

### Requirement: Source lineage is internal only

For each financial exhibit the system SHALL display to internal users the source lineage — originating
feature ID and adjusted/reported basis. This lineage SHALL NOT be printed on buyer-facing output.
(`CM - 0001`)

#### Scenario: Lineage does not reach the buyer
- **WHEN** a CIM is rendered or exported for a buyer
- **THEN** no source lineage appears

### Requirement: Anonymize is a deck-level toggle that relabels identifying data

Each CIM SHALL have a deck-level Anonymize toggle. When enabled the system SHALL suppress the company's
legal and trade name and logo, substituting a broker-defined descriptor, and SHALL relabel identifying
data within financial exhibits — customer names rendering as "Customer A / B / C…" in descending revenue
order, and specific locations as a generalized region. The broker SHALL be able to override any
system-generated anonymous label, and those overrides SHALL persist across exhibit re-renders. Anonymize
state SHALL be stored as an attribute of each published version, the version list SHALL indicate which
versions were published anonymized, and toggling SHALL NOT alter underlying platform data or any
previously published version. (`CM - 0001`)

#### Scenario: Anonymized publication leaks no true names
- **WHEN** an anonymized version is published
- **THEN** no true company or customer name is exposed through the slide render, the PDF, the .pptx
  export, or any API response

#### Scenario: Label overrides survive re-render
- **WHEN** a broker overrides a system-generated anonymous label and the exhibit re-renders
- **THEN** the override persists

### Requirement: A structured questionnaire populates qualitative slides

The system SHALL provide a structured questionnaire organized by CIM section whose responses map to
defined content blocks on the corresponding qualitative slides. The broker SHALL be able to assign the
questionnaire, whole or by individual section, to a company/seller user. Submitted responses SHALL
populate their mapped blocks, after which the broker MAY edit the slide content directly; where a broker
has edited a block populated from the questionnaire, a later questionnaire edit SHALL NOT overwrite it
without explicit confirmation. The system SHALL display questionnaire completion status per section —
Not started / In progress / Submitted — and identify which slides remain unpopulated. (`CM - 0001`)

#### Scenario: Broker edits are protected from later questionnaire edits
- **WHEN** a questionnaire response changes after the broker edited the block it populated
- **THEN** the block is not overwritten without explicit confirmation

### Requirement: Firm theme is configured once and inherited

A firm-level CIM theme — logo, color palette, heading and body typeface, cover layout, footer text, and
confidentiality legend — SHALL be configured once per brokerage and inherited by every CIM created under
that firm. The broker SHALL be able to override the cover image for an individual CIM; no other theme
element SHALL be overridable at deck level in v1. All slides SHALL render using the inherited theme,
with financial exhibit chart colors derived from the firm palette, and the system SHALL auto-generate
the cover page, table of contents, page numbers, footer, and confidentiality legend on every page.
Image blocks SHALL be populatable either by selecting an existing document or image from the deal's data
room or by direct upload. (`CM - 0001`)

#### Scenario: Theme and front matter are automatic
- **WHEN** a CIM is rendered
- **THEN** the firm theme applies to all slides and cover, table of contents, page numbers, footer, and
  confidentiality legend are generated automatically

### Requirement: Publication requires recorded seller approval and is immutable

CIM status SHALL progress Draft → In Review → Seller Approved → Published, and Published versions SHALL
be immutable. A CIM SHALL NOT be publishable until a designated company/seller user has recorded
approval of that specific version's content, recorded with the approving user's identity, a timestamp,
and the version approved. Editing a Published CIM SHALL create a new Draft version, with all prior
published versions remaining retrievable. The system SHALL maintain a version history showing version
number, status, publish date, anonymize state, financial "as of" date, and publishing user.
(`CM - 0001`)

#### Scenario: Publish is gated on approval
- **WHEN** a broker attempts to publish a version with no recorded seller approval for it
- **THEN** publication is blocked

### Requirement: Concurrent CIM editing is prevented by an edit lock

The system SHALL prevent two users editing the same CIM simultaneously by applying an edit lock and
displaying the identity of the lock holder to any other user attempting to edit. (`CM - 0001`)

#### Scenario: Second editor is told who holds the lock
- **WHEN** a second user attempts to edit a CIM already open for editing
- **THEN** they are blocked and shown the lock holder's identity

### Requirement: PDF and PowerPoint export, with draft watermarking and attribution

The system SHALL export the CIM to PDF, rendered server-side, visually consistent with the on-screen
deck and including cover, table of contents, page numbers, footer, and confidentiality legend; and to
editable PowerPoint (.pptx) with financial exhibits as native editable tables and charts, qualitative
slides as editable text and image objects, and the firm theme applied. Exports taken while status is
Draft or In Review SHALL be watermarked "DRAFT — NOT FOR DISTRIBUTION" on every page. Every financial
exhibit SHALL carry a visible "prepared from Centuriuum platform data — as of [date]" attribution line
in both outputs. Only users holding the Broker role SHALL be permitted to export .pptx. (`CM - 0001`)

#### Scenario: Draft exports are watermarked
- **WHEN** an export is taken in Draft or In Review status
- **THEN** every page carries the DRAFT — NOT FOR DISTRIBUTION watermark

#### Scenario: .pptx opens editable with the firm theme
- **WHEN** the .pptx export is opened in PowerPoint
- **THEN** the firm theme is applied, qualitative text and images are editable, and financial exhibits
  are native tables and charts

### Requirement: Published CIMs become tracked data room documents

On publish, the system SHALL write the rendered PDF into the deal's data room as a tracked document,
inheriting data room access control, per-buyer watermarking, and view/download tracking. Publishing a
new version SHALL supersede the prior CIM document in the data room while retaining prior versions per
the platform document versioning convention. (`CM - 0001`, depends on `DR - 0001` / `DR - 0006`)

#### Scenario: Published PDF is governed like any data room document
- **WHEN** a CIM version is published
- **THEN** the PDF appears in the data room with access control, per-buyer watermarking, and
  view/download tracking applied

### Requirement: CIM lifecycle events are logged, with .pptx flagged distinctly

The system SHALL log to the Activity & Audit Log: CIM created, questionnaire assigned, questionnaire
submitted, seller approval recorded, version published, export generated with format, version and user,
and any change to Anonymize state. .pptx export events SHALL be logged and flagged distinctly, on the
basis that the exported deck is editable outside the platform and its figures can subsequently diverge
from the platform record. (`CM - 0001`, feeds `SY - 0003`)

#### Scenario: Editable-export risk is visible in the log
- **WHEN** a .pptx export is generated
- **THEN** the log entry is flagged distinctly from other export formats

#### Scenario: CIM access is deal-isolated
- **WHEN** a user without assigned role or deal access requests the CIM, its questionnaire responses, its
  drafts, or any published version
- **THEN** access is refused, and a buyer can reach no unpublished version under any circumstance

### Requirement: Templates exist at exactly three scopes with strict visibility

The system SHALL support exactly three template scopes: System (maintained by Centuriuum), Firm (visible
to all users of one firm), and User (private to one user). A user SHALL see, in any template list or
gallery, only System templates, their own firm's templates, and their own User templates, and SHALL NOT
be able to view, apply, or discover another firm's or another user's templates by any route including
direct reference. Only a firm administrator SHALL create, update, publish, or archive a Firm template;
only a Centuriuum internal administrator SHALL create, update, or archive a System template.
(`CM - 0002`)

#### Scenario: Cross-firm templates are unreachable
- **WHEN** a user attempts to view or apply another firm's or another user's template, including by
  direct reference
- **THEN** the attempt fails

#### Scenario: Firm template administration is restricted
- **WHEN** a non-administrator broker attempts to create, edit, publish, or archive a Firm template
- **THEN** the attempt is refused

### Requirement: A template carries structure and boilerplate, never deal data or branding

Each template record SHALL carry: name, description, scope, owning user or firm, optional industry tag,
status (Draft / Published / Archived), version number, created-by and created-at, last-updated-at, and
an internal reference to the CIM it was derived from. A template SHALL contain an ordered slide manifest
with slide type per slide; the financial exhibit selection and each exhibit's configured parameters;
deck-level presentation conventions (currency units, decimal places, negative-number format, default
period type); and content blocks classified as Firm boilerplate. A template SHALL NOT contain branding
elements — logo, palette, typeface, cover layout — which are inherited at render time from the
`CM - 0001` firm theme. A template SHALL NOT contain any deal or company data: no financial figures, no
rendered exhibit snapshots, no customer names, no anonymization label map, no questionnaire responses,
and no content blocks classified as Deal content; and template records SHALL carry no deal or company
foreign key of any kind. (`CM - 0002`)

#### Scenario: Template is free of deal data
- **WHEN** a template is created from a CIM
- **THEN** it contains no financial figures, rendered exhibit output, customer names, company name or
  descriptor, questionnaire responses, or Deal content blocks

### Requirement: System templates ship generically branded

The system SHALL ship a set of style-matched System templates at launch reproducing the structure and
general presentation approach common to large brokerage networks, named generically, containing no
third-party firm name, logo, trademark, or other brand asset. (`CM - 0002`)

#### Scenario: No third-party brand assets ship
- **WHEN** the System template set is inspected
- **THEN** it contains no third-party firm name, logo, trademark, or brand asset

### Requirement: Save-as-template strips deal content server-side, after a reviewed confirmation

A broker SHALL be able to save an existing CIM as a new User template. Save-as-template SHALL copy the
source CIM's slide manifest, slide types, financial exhibit selection and parameters, deck-level
presentation conventions, and every content block classified as Firm boilerplate; and SHALL strip, and
not persist, all financial figures and rendered exhibit output, all Deal content blocks, all
deal-sourced images, the company name and anonymous descriptor, the anonymization label map, and all
questionnaire responses. Stripping SHALL be enforced server-side at the point the template record is
written, not by client-side filtering. Before creation the system SHALL present a review screen
enumerating every slide and content block with its carry-or-strip disposition, requiring explicit
confirmation to proceed. (`CM - 0002`)

#### Scenario: Stripping is enforced at the server
- **WHEN** a request is crafted to include Deal content blocks in a template write
- **THEN** it is rejected rather than merely hidden in the UI

#### Scenario: Disposition is reviewed before creation
- **WHEN** a broker saves a CIM as a template
- **THEN** every slide and block is listed with its carry-over or strip disposition and the template is
  not created until confirmed

### Requirement: Content class governs what can become boilerplate

Qualitative slide content blocks SHALL carry a content class attribute valued Deal content or Firm
boilerplate, settable by the block's author, defaulting to Deal content. A block SHALL only be eligible
to carry into a template if explicitly set to Firm boilerplate. A Firm boilerplate block SHALL reference
only firm-level assets; where such a block references a deal-scoped asset it SHALL be stripped rather
than carried with a broken or deal-scoped reference. (`CM - 0002`, `CM - 0001`)

#### Scenario: Default class keeps content out of templates
- **WHEN** a block is left at its default content class and its CIM is saved as a template
- **THEN** that block does not appear in the template

#### Scenario: Explicit boilerplate carries
- **WHEN** a block is explicitly marked Firm boilerplate
- **THEN** it carries into a template created from its CIM

### Requirement: Templates clone, promote, version, archive, and soft-delete

Any user SHALL be able to clone a System or Firm template into their own User templates and modify the
clone without altering the source. A firm administrator SHALL be able to promote a User template
belonging to a user in their firm to Firm scope. Updating an existing template SHALL be performed by
saving a CIM over that template, creating a new template version and retaining the prior version record;
template metadata — name, description, industry tag — SHALL be editable directly without creating a
version. Archiving SHALL remove a template from all galleries and prevent new use while retaining the
record and having no effect on any CIM previously created from it. Templates SHALL be soft-deleted only,
the record retained for audit and traceability. (`CM - 0002`)

#### Scenario: Cloning does not disturb the source
- **WHEN** a user clones a System or Firm template and edits the clone
- **THEN** the source template is unchanged

#### Scenario: Archiving does not reach existing CIMs
- **WHEN** a template is archived
- **THEN** it disappears from every gallery and all previously created CIMs are unchanged

### Requirement: Template gallery, firm default, and preview

On CIM creation the system SHALL present a template gallery offering Blank CIM, System templates, Firm
templates, and My templates. A firm administrator SHALL be able to designate one Firm template as the
firm default, preselected on CIM creation for every user in that firm, and the user SHALL be able to
select any template visible to them, or Blank CIM, regardless of that default. Each gallery entry SHALL
display name, description, scope badge (System / Firm / Mine), slide count, the list of financial
exhibits it includes, industry tag where set, and a cover thumbnail; the user SHALL be able to open a
read-only preview of a template's full slide sequence before applying it; and the gallery SHALL support
filtering and text search by scope, name, and industry tag. (`CM - 0002`)

#### Scenario: Firm default is preselected but not forced
- **WHEN** a user in a firm with a designated default creates a CIM
- **THEN** that template is preselected and any other visible template or Blank CIM may be chosen instead

### Requirement: Template application is a one-time copy at creation

Applying a template SHALL copy its slide manifest, exhibit configuration, presentation conventions, and
Firm boilerplate blocks into the new CIM once, at creation. A CIM created from a template SHALL retain
no live link to it; subsequent edits, new versions, archiving, or deletion of the template SHALL have no
effect on any existing CIM. The CIM record SHALL store the source template ID and version for
traceability, visible to internal users only and appearing on no rendered or exported output. The broker
SHALL be able to modify, reorder, or remove any slide, exhibit, or block a template contributed — no
template element is locked or mandatory in v1 — and a template SHALL be applicable only at CIM creation,
not to an existing CIM. Applying a template SHALL grant the applying user no access of any kind to the
deal, company, or data of the CIM it was derived from. (`CM - 0002`)

#### Scenario: Template edits do not reach created CIMs
- **WHEN** a template is edited, archived, or deleted after a CIM was created from it
- **THEN** that CIM is unchanged

#### Scenario: Contributed slides are fully editable
- **WHEN** a broker deletes or reorders a slide a template contributed, including a firm disclaimer slide
- **THEN** the change succeeds

#### Scenario: Template traceability stays internal
- **WHEN** a CIM created from a template is exported to PDF or .pptx
- **THEN** the source template ID and version appear nowhere in the output

### Requirement: Template application degrades gracefully

Where a template references a financial exhibit type no longer available, or whose required parameters
have changed, the system SHALL create the CIM omitting that exhibit and SHALL present a warning naming
each omitted exhibit, rather than failing template application. Where a template references a Firm
boilerplate asset not available to the applying user's firm, the corresponding block SHALL be created
empty with a visible placeholder note identifying what is missing. (`CM - 0002`)

#### Scenario: Missing exhibit warns rather than fails
- **WHEN** a template references an unavailable financial exhibit
- **THEN** the CIM is created without it and a warning names the omitted exhibit

#### Scenario: Unresolvable asset leaves a visible placeholder
- **WHEN** a template references a boilerplate asset the applying firm lacks
- **THEN** the block is created empty with a visible placeholder note

### Requirement: Template events are logged with strip counts

The system SHALL log to the Activity & Audit Log: template created, template version saved, template
cloned, template promoted to Firm scope, template archived or deleted, firm default changed, and
template applied to a CIM recording template ID and version. The template-created entry SHALL record the
count of content blocks carried and the count stripped, so a confidentiality review can confirm
stripping behaved as specified. (`CM - 0002`, feeds `SY - 0003`)

#### Scenario: Strip counts are auditable
- **WHEN** a template is created from a CIM
- **THEN** the log entry records how many blocks were carried and how many stripped

### Requirement: The loader accepts only safe .pptx into a Draft CIM, under attestation

The system SHALL allow a broker to upload a PowerPoint (.pptx) file to a CIM for loading, accepting
.pptx only and rejecting .ppt, .pptm, .pdf, .docx and all other formats with a message naming the
supported format, and rejecting macro-enabled and password-protected files. All uploads SHALL be scanned
for malware using the platform's existing document upload controls before extraction begins. The loader
SHALL be available only while CIM status is Draft. At upload the system SHALL require the user to
affirm, by explicit action, that they have the right to use the content for this deal, without which the
upload SHALL NOT proceed, and SHALL record the attestation with the affirming user's identity,
timestamp, file name, and a file content hash. The system SHALL enforce configurable maximum file size
and slide count, reporting the limit in the error message. (`CM - 0003`)

#### Scenario: Attestation gates the upload
- **WHEN** a broker uploads a .pptx without affirming the rights attestation
- **THEN** the upload does not complete

#### Scenario: Unsupported and oversized files are rejected clearly
- **WHEN** a .ppt, .pptm, .pdf, .docx, password-protected, or oversized file is uploaded
- **THEN** it is rejected with a message naming the supported format or the limit

#### Scenario: Loader is unavailable past Draft
- **WHEN** a CIM is In Review, Seller Approved, or Published
- **THEN** the loader action is unavailable

### Requirement: Uploaded source files live outside the data room

Uploaded source files SHALL be stored in a private store attached to the CIM. They SHALL NOT be created
as data room documents, SHALL NOT appear in any `DR - 0001` listing, and SHALL NEVER be visible to a
Buyer or Bank role under any circumstance. They SHALL be retained so extraction can be re-run and SHALL
be deletable by the broker at any time. (`CM - 0003`)

#### Scenario: Source deck is unreachable by counterparties
- **WHEN** a Buyer or Bank role searches any surface or API for the uploaded source file
- **THEN** it cannot be retrieved, and it appears in no data room listing

### Requirement: Extraction imports narrative structure only, and stages its result

Extraction SHALL run server-side and produce a staged extraction result; no content SHALL be written to
the CIM as a result of extraction alone. For each source slide the system SHALL extract the slide title
from the title placeholder, body text from text placeholders and text boxes, bullet hierarchy to two
levels, and the source slide index. The system SHALL preserve bold and italic inline formatting and
bullet nesting, and SHALL discard all source fonts, colors, sizes, and element positions — visual
presentation being governed by the `CM - 0001` firm theme. Extraction status SHALL be reported as
Queued, Processing, Ready for review, or Failed, with a reason on failure. (`CM - 0003`)

#### Scenario: Extraction alone changes nothing
- **WHEN** extraction completes and before the broker commits
- **THEN** the CIM is unchanged

### Requirement: Financial content is excluded from import by construction

The system SHALL NOT extract or import: numeric financial figures, financial tables, charts and graphs,
embedded spreadsheets or OLE objects, images and logos, speaker notes, headers and footers, slide master
content, and animations. The system SHALL exclude any text block originating in a table shape, a chart
shape, or a grouped shape containing a chart, and any text block whose content is predominantly numeric
per a defined and documented threshold rule. Extraction SHALL NEVER write to any financial exhibit —
exhibits remain generated solely from platform data. The system SHALL record every excluded block with
the reason for its exclusion and present that list to the broker in the review screen. (`CM - 0003`)

#### Scenario: No financial content survives import
- **WHEN** a source deck containing figures, tables, charts, images, logos, notes, and embedded objects
  is imported
- **THEN** none of them appear anywhere in the CIM

#### Scenario: Exclusions are explained
- **WHEN** a table-originated block and a predominantly numeric block are encountered
- **THEN** both are excluded and appear in the review screen's excluded list with a stated reason

#### Scenario: Exhibits are untouched by the loader
- **WHEN** any loader operation runs
- **THEN** no financial exhibit is altered and exhibit figures continue to resolve from platform data

### Requirement: Deterministic mapping proposals with confidence, reviewed before commit

For each extracted text block the system SHALL propose a target section and qualitative slide in the
current CIM, using rule-based matching against slide titles, the CIM section outline, and maintained
keyword and synonym sets. Matching SHALL be deterministic and rule-based; this capability SHALL NOT
perform generative rewriting, summarization, or narrative drafting. The system SHALL assign each
proposal a confidence level and SHALL group blocks it could not confidently match into a separate
unmatched set rather than assigning them arbitrarily. The review screen SHALL present, per block, the
source slide and text alongside the proposed destination, allowing Accept, Reassign, or Discard. The
broker SHALL be able to accept all high-confidence proposals in one action; low-confidence and unmatched
blocks SHALL require an individual decision. No content SHALL be written until the broker commits.
(`CM - 0003`)

#### Scenario: Unmatched blocks are not auto-assigned
- **WHEN** a block cannot be confidently matched
- **THEN** it appears in a separate unmatched group requiring an individual decision

#### Scenario: Commit writes only what was accepted
- **WHEN** the broker commits a reviewed set
- **THEN** discarded and skipped blocks appear nowhere in the CIM

### Requirement: Existing content is never silently overwritten by import

Where a target content block already contains text, the system SHALL offer Replace, Append, or Skip for
that block, defaulting to Skip, and SHALL NEVER overwrite existing content without an explicit choice.
Where an extracted block duplicates text already in the CIM, the system SHALL flag it as a duplicate and
default it to Skip. Where the CIM contains no slide corresponding to a block's matched section, the
system SHALL offer to create a new qualitative slide in that section rather than discarding the content.
(`CM - 0003`)

#### Scenario: Skip is the default on collision
- **WHEN** a target block already contains text
- **THEN** Replace, Append, or Skip is offered with Skip as the default

#### Scenario: Missing section offers a new slide
- **WHEN** no slide exists for a matched section
- **THEN** creation of a new qualitative slide is offered rather than the content being lost

### Requirement: The loader runs repeatably, with provenance, and its output can never become boilerplate

The broker SHALL be able to run the loader more than once against the same CIM, including with different
source files, each run staged, reviewed, and committed independently. On commit the system SHALL record
per imported block its source file, source slide index, and import timestamp as internal provenance,
which SHALL NOT appear on any rendered or exported output. Every block created or populated by the
loader SHALL be permanently classified Deal content, and SHALL NOT be reclassifiable as Firm boilerplate
by any user, role, or API route — so loader-originated content SHALL never carry into a `CM - 0002`
template. (`CM - 0003`)

#### Scenario: Independent runs do not disturb each other
- **WHEN** a second loader run with a different source file is committed
- **THEN** content committed by the first run is unchanged

#### Scenario: Imported content cannot be laundered into a template
- **WHEN** a CIM containing imported blocks is saved as a template
- **THEN** the template contains none of that imported content

### Requirement: Loader events are logged

The system SHALL log to the Activity & Audit Log: file uploaded with attestation, extraction started,
extraction completed or failed, review committed with counts of blocks accepted, reassigned, discarded
and skipped, and source file deleted. (`CM - 0003`, feeds `SY - 0003`)

#### Scenario: Commit counts are recorded
- **WHEN** a loader review is committed
- **THEN** the log records accepted, reassigned, discarded, and skipped counts

#### Scenario: Loader surfaces are deal-isolated
- **WHEN** a user without assigned role or deal access seeks the loader, an uploaded file, a staged
  extraction, or a mapping proposal
- **THEN** access is refused, and no uploaded file from one deal can be applied to a CIM in another

### Requirement: A scoped question library backs guided information requests

The system SHALL maintain a question library supporting exactly three scopes consistent with
`CM - 0002`: System, Firm, and User. Each question record SHALL carry question text, optional help or
example text, the CIM section it belongs to, the target slide type and content block it is intended to
populate, scope, owner, display order, and an active or archived state. A user SHALL see only System
questions, their own firm's questions, and their own User questions. Only a firm administrator SHALL
create, edit, publish, or archive Firm-scope questions; only a Centuriuum internal administrator SHALL
maintain System-scope questions. A broker SHALL be able to save a new or reworded question into their
own User library, and a firm administrator SHALL be able to promote a User question to Firm scope.
Archiving a question SHALL remove it from future generation without altering any request already sent or
answer already received. The library SHALL contain questions only — never an answer, a company name, or
any other deal data. (`CM - 0004`)

#### Scenario: Custom questions are reusable and promotable
- **WHEN** a broker saves a custom question to their User library and a firm administrator promotes it
- **THEN** it is reusable on a later deal and then appears for all users in that firm

#### Scenario: Question scopes are isolated
- **WHEN** a user browses the question library
- **THEN** no other firm's and no other user's questions are visible

### Requirement: Request generation targets only unpopulated blocks

The broker SHALL be able to generate a draft information request for a CIM in a single action.
Generation SHALL inspect the CIM's qualitative slides and content blocks and include questions only for
blocks currently unpopulated, excluding any block already populated by broker authoring, by an accepted
answer from a prior request, or by the `CM - 0003` loader, and excluding any question previously
answered and accepted for this CIM unless the broker explicitly re-adds it. Where an unpopulated block
has no library question mapped to it, the system SHALL list that block as an unmapped gap so the broker
can add a custom question rather than the gap passing unnoticed. (`CM - 0004`)

#### Scenario: Populated blocks generate no question
- **WHEN** a block was populated by authoring, a prior accepted answer, or the loader
- **THEN** generation produces no question for it

#### Scenario: Unmapped gaps are surfaced
- **WHEN** an unpopulated block has no mapped library question
- **THEN** it appears in the draft request as an unmapped gap

### Requirement: Draft requests are editable without mutating the library

The broker SHALL be able to add, reword, reorder, and remove questions in a draft request before
sending; rewording or removing a question within a request SHALL NOT modify the underlying library
question. The broker SHALL be able to regenerate a draft at any time, reflecting the CIM's current
populated state, and SHALL be able to create more than one request per CIM over the life of the deal.
(`CM - 0004`)

#### Scenario: Request edits leave the library alone
- **WHEN** a broker rewords a question inside a request
- **THEN** the library question is unchanged

### Requirement: Requests are assigned by section, with due dates and authenticated recipients

The broker SHALL be able to assign each section of a request to a different company recipient and set a
due date per assigned section. Recipients SHALL be company users holding access to the deal; where the
intended recipient has no platform account, the system SHALL issue an invitation through the platform's
standard invitation flow and the request SHALL become visible only once that account is active. The
system SHALL provide no unauthenticated route to view or answer a request, and every answer SHALL be
attributable to an authenticated user identity. (`CM - 0004`)

#### Scenario: Per-section assignment with independent status
- **WHEN** different sections of one request are assigned to different recipients with their own due
  dates
- **THEN** per-section status is reported independently

#### Scenario: No anonymous answering
- **WHEN** any party attempts to view or answer a request without authenticating
- **THEN** no route permits it, and every stored answer carries an authenticated respondent identity

### Requirement: Request status, reminders, and closure

Request status SHALL be one of Draft, Sent, Partially Answered, Complete, or Closed, with per-section
and per-question status additionally reported. The broker SHALL be able to close or cancel a request at
any time, including one only partly answered. The system SHALL send automated reminders to a recipient
with outstanding questions on a defined schedule until answered or the request is closed; the broker
SHALL be able to disable automated reminders and send a manual reminder on demand; and overdue status
SHALL be displayed to the broker for any section past its due date. All reminder and notification
delivery SHALL route through the platform notifications hub and SHALL NOT be implemented locally.
(`CM - 0004`)

#### Scenario: Reminders run until answered or closed
- **WHEN** questions remain outstanding
- **THEN** automated reminders are sent on schedule until answered or the request is closed, and overdue
  sections are visibly flagged

### Requirement: Recipients see only their own questions and answer in free text

A recipient SHALL see only the questions assigned to them for their own deal, and SHALL NOT see
questions assigned to other recipients, other recipients' answers, the CIM itself, any slide, the
question library, or any financial data. A recipient SHALL be able to answer each question with free
text and attach one or more supporting files; attachments SHALL be stored as deal documents in the data
room tagged to the originating request and question, SHALL NOT be visible to a Buyer or Bank role by
default, and SHALL pass malware scanning before storage. The system SHALL NOT provide numeric, date,
currency, or multiple-choice answer fields, so no value entered here can populate a financial exhibit. A
recipient SHALL be able to save partial progress and return later, and to submit per question or per
section rather than completing the request in one sitting. (`CM - 0004`)

#### Scenario: Respondent view is narrow
- **WHEN** a recipient opens their request
- **THEN** they see only their assigned questions and can reach no slide, exhibit, library, or other
  recipient's questions or answers

#### Scenario: No structured answer fields exist
- **WHEN** the respondent experience is inspected
- **THEN** no numeric, currency, date, or multiple-choice answer field exists anywhere in it

### Requirement: Answers reach the CIM only through broker acceptance

Submitted answers SHALL arrive in a broker review queue showing the question, the answer text, any
attachment, the respondent's identity, the submission timestamp, and the target slide and content block.
No answer SHALL write to any content block until the broker accepts it. The broker SHALL be able to
accept an answer as submitted, edit it and then accept, or discard it; discarded answers SHALL be
retained against the request record for audit and not deleted. Where the target block already contains
text, the system SHALL offer Replace, Append, or Skip, defaulting to Skip, and SHALL NEVER overwrite
without an explicit choice. On acceptance the system SHALL record against the block the originating
request, question, respondent identity, and answer timestamp as internal provenance, which SHALL NOT
appear on rendered or exported output. Every block populated by an accepted answer SHALL be permanently
classified Deal content, not reclassifiable as Firm boilerplate by any route, and SHALL therefore never
carry into a `CM - 0002` template. (`CM - 0004`)

#### Scenario: Nothing is written before acceptance
- **WHEN** an answer is submitted
- **THEN** it appears in the review queue and writes to no content block until accepted

#### Scenario: Discarded answers are retained but invisible
- **WHEN** a broker discards an answer
- **THEN** it is retained against the request record and appears nowhere in the CIM

### Requirement: Guided Q&A is entirely optional and never blocks publication

The capability SHALL be entirely optional: a CIM SHALL be completable, approvable, and publishable with
no request ever created. The broker SHALL be able to answer any question themselves, with the system
recording that the answer was broker-supplied rather than company-supplied, and to mark any question not
applicable, retaining it in the request record rather than deleting it. An open, overdue, or partially
answered request SHALL NEVER block CIM approval or publication; outstanding items MAY be surfaced in the
`CM - 0001` pre-publish deck health panel as informational only. (`CM - 0004`)

#### Scenario: Publication proceeds with an open request
- **WHEN** a request is open, overdue, or partially answered
- **THEN** CIM approval and publication are not blocked

#### Scenario: Broker-supplied answers are distinguishable
- **WHEN** a broker answers a question themselves
- **THEN** the record distinguishes it from a company-supplied answer

### Requirement: Guided Q&A events are logged

The system SHALL log to the Activity & Audit Log: request generated, request sent, section assigned or
reassigned, due date set or changed, reminder sent, answer submitted, answer accepted, edited or
discarded, attachment uploaded, question marked not applicable, request closed or cancelled, and library
question created, edited, promoted, or archived. (`CM - 0004`, feeds `SY - 0003`)

#### Scenario: The request lifecycle is auditable
- **WHEN** any request or library event occurs
- **THEN** it appears in the Activity & Audit Log

### Requirement: The teaser is its own document object, not a CIM variant

The teaser SHALL be a distinct document object with its own record, content model, versioning, and
approval state, and SHALL NOT be implemented as a CIM version, a CIM export mode, or a CIM rendering
variant. A teaser SHALL be creatable and releasable for a deal on which no CIM exists; absence of a CIM
SHALL only mean content suggestions are unavailable. Teaser status SHALL progress Draft, In Review,
Seller Approved, Released, Archived, with Released versions immutable; editing a Released teaser SHALL
create a new Draft version with all prior released versions retrievable. The system SHALL maintain a
version history showing version number, status, release date, financial as-of date, approving user,
releasing user, and the scan result and override record for that version. (`CM - 0005`)

#### Scenario: Teaser without a CIM
- **WHEN** a deal has no CIM
- **THEN** a teaser can still be created and released, with content suggestions unavailable

### Requirement: The teaser is two pages, with bounded narrative fields

The rendered teaser SHALL NOT exceed two pages; the system SHALL report projected page overflow while
editing and SHALL block release of a teaser rendering to more than two pages. Each narrative field SHALL
enforce a defined maximum character count, so content must be summarized rather than pasted from the CIM
at full length. (`CM - 0005`)

#### Scenario: Overflow blocks release
- **WHEN** a teaser renders to more than two pages
- **THEN** release is blocked and overflow is reported during editing

### Requirement: The teaser's structured field set carries no indication of value

The teaser SHALL have its own structured field set comprising: business description, value proposition,
industry, end markets served, region, years in operation, employee count band, customer mix and
concentration statement, growth drivers, investment highlights, reason for sale, and real estate status.
The teaser SHALL NOT present an asking price, a price expectation, a valuation, a multiple, or any other
indication of value, and no field capturing or rendering such a value SHALL exist. (`CM - 0005`)

#### Scenario: No price field exists
- **WHEN** the teaser field set is inspected
- **THEN** no field captures or renders an asking price, expectation, valuation, or multiple

### Requirement: CIM content is offered as a suggestion, never auto-populated

Where corresponding CIM content exists, the system SHALL offer it as a suggestion for the relevant
teaser field; suggestions SHALL require explicit broker acceptance and SHALL NEVER auto-populate a
field. Accepted suggestion text SHALL be copied in as independent content, the teaser field retaining no
live link to the CIM block, and later CIM edits SHALL NOT alter teaser content. The system SHALL run the
confidentiality scan against a suggestion at the moment it is offered and SHALL visually flag any
identifying term within it before the broker accepts. (`CM - 0005`)

#### Scenario: Suggestions are scanned before acceptance
- **WHEN** a CIM suggestion is offered for a teaser field
- **THEN** the confidentiality scan runs and identifying terms are flagged before acceptance

### Requirement: Identifying fields come from controlled vocabularies and bands

Industry SHALL be selected from a controlled taxonomy with a defined minimum breadth level enforced,
rejecting any node below that level. End markets served SHALL be selected from a controlled multi-select
list. No free-text industry or end-market descriptor SHALL be permitted. Region SHALL be selected from a
controlled geographic list at region or metropolitan-area granularity, and the system SHALL NOT accept
or render a city, street address, or postal code in any location field. Years in operation SHALL render
as a rounded or banded value, never an exact founding year. Employee count SHALL render as a band from a
defined set, never an exact headcount. Real estate status SHALL be selected from a fixed enumerated set
covering owned and leased, each as included in or excluded from the transaction, plus not applicable.
Fields with no platform source — employee count band, years in operation, real estate status, reason for
sale — MAY be prefilled from accepted `CM - 0004` answers where a mapping exists and are otherwise
broker-entered. (`CM - 0005`)

#### Scenario: Granularity floors are enforced
- **WHEN** a broker attempts to select a taxonomy node below the minimum breadth level, or enter a city,
  address, postal code, exact founding year, or exact headcount
- **THEN** the entry is rejected or rendered as a band

### Requirement: Teaser financials present one earnings basis and freeze on release

The teaser SHALL render revenue and either Adjusted EBITDA or SDE for the trailing period plus one or
two prior annual periods at the broker's selection, SHALL label which earnings basis is presented
consistent with `QE - 0004`, and SHALL NOT present both bases simultaneously. Where one or more
published CIM versions exist, teaser financial figures SHALL bind to the most recently published
version's frozen snapshot and display that version's financial as-of date; where none exists, they SHALL
bind to current `QE - 0004` and adjusted-P&L data and freeze into a teaser-specific snapshot with its
own as-of date on release. Teaser financial figures SHALL NOT be manually editable — corrections are
made at source. Where a CIM version is published after a teaser is released and its figures for a
presented period differ, the system SHALL flag the released teaser inconsistent with the current
published CIM and prompt the broker to issue a new teaser version. (`CM - 0005`)

#### Scenario: Later CIM publication flags the released teaser
- **WHEN** a CIM version is published whose figures differ from a released teaser's presented period
- **THEN** the teaser is flagged inconsistent and a new version is prompted

### Requirement: Customer concentration renders as a band with no names

The customer concentration statement SHALL be derived by the system from GL-based concentration data
(`DB - 0002`) and expressed as a banded qualitative statement drawn from a defined band set, and SHALL
NEVER render a customer name nor an exact percentage attributed to an individual customer. The broker
MAY edit its wording subject to the confidentiality scan and SHALL NOT be able to introduce a customer
name. Where GL data is insufficient to derive concentration, the statement SHALL be broker-entered
subject to scan and the system SHALL indicate that automatic derivation was unavailable. (`CM - 0005`)

#### Scenario: No customer identity survives the statement
- **WHEN** the concentration statement is derived or edited
- **THEN** no customer name and no individual customer percentage appears

### Requirement: A per-deal identifying-term list drives the confidentiality scan

The system SHALL maintain a per-deal identifying-term list auto-derived from the company's legal name,
trade names and DBAs; the top customer names present in GL data; the company's website domain and email
domains; its street address, city, and postal code; and any key personnel names on the deal record. The
broker SHALL be able to add and remove terms, with every addition and removal audited. (`CM - 0005`)

#### Scenario: Term list edits are audited
- **WHEN** a broker adds or removes an identifying term
- **THEN** the change is recorded in the audit log

### Requirement: The confidentiality scan runs at four points and blocks release

The confidentiality scan SHALL run on demand, on save of any narrative field, at the moment a CIM
suggestion is offered, and mandatorily immediately before release. It SHALL check every element
appearing in the rendered output, including all field content, the industry and end-market labels, the
region label, the footer and disclaimer legend, and the exported PDF's file name and document metadata.
Matching SHALL be case-insensitive, SHALL detect whole-word matches together with possessive and plural
variants, and SHALL normalize repeated whitespace and punctuation before matching. Release SHALL be
blocked while any scan flag remains unresolved. The scan SHALL flag only — it SHALL NEVER automatically
alter, redact, or rewrite teaser content — and scan results including all flags, resolutions, and
overrides SHALL be retained against the version record. (`CM - 0005`)

#### Scenario: Unresolved flags block release
- **WHEN** a scan flag remains unresolved
- **THEN** release is blocked

#### Scenario: The scan never edits
- **WHEN** the scan flags an identifying term
- **THEN** teaser content is unchanged and the broker resolves it

### Requirement: Flag overrides are justified, logged, and version-scoped

The broker SHALL be able to override an individual flag by entering a typed justification, recorded with
user, timestamp, matched term, field, and justification to the Activity & Audit Log. An override SHALL
apply to one flag on one version only; creating a new version SHALL re-run the scan and prior overrides
SHALL NOT carry forward. (`CM - 0005`, feeds `SY - 0003`)

#### Scenario: Overrides do not carry to the next version
- **WHEN** a new teaser version is created
- **THEN** the scan re-runs and prior overrides do not apply

### Requirement: Teaser preview, theme, and export

The broker SHALL be able to preview the teaser exactly as an outside recipient would see it, with no
internal indicators, source lineage, scan markings, or platform interface elements present. The teaser
SHALL render using the `CM - 0001` firm theme including the firm's confidentiality and disclaimer
legend, SHALL support no business photographs — providing no image upload capability and rendering only
firm branding and theme graphics — and SHALL export to PDF rendered server-side, visually identical to
the recipient preview. Exports taken before release SHALL be watermarked "DRAFT — NOT FOR DISTRIBUTION"
on every page, and the exported PDF's file name and document metadata SHALL contain no identifying term
and SHALL be scanned before the export is produced. (`CM - 0005`)

#### Scenario: Preview matches the recipient view exactly
- **WHEN** a broker previews the teaser
- **THEN** no internal indicator, lineage, scan marking, or platform chrome is present

#### Scenario: File name and metadata are scanned too
- **WHEN** a teaser PDF is exported
- **THEN** its file name and document metadata are scanned and contain no identifying term

### Requirement: Teaser release requires approval and hands off to distribution

A teaser SHALL NOT be releasable until a designated company/seller user has approved that specific
version, recorded with the approving user's identity, timestamp, and version number. Any change to
content after approval SHALL invalidate that approval and require re-approval before release. On release
the system SHALL freeze into an immutable version: the rendered teaser, its financial snapshot and
as-of date, its scan results and overrides, and its approval record; SHALL make the released version
available to buyer outreach (`BR - 0008`) as the document to be distributed and tracked; and SHALL mark
the prior released version superseded when a new one is released. Distribution, recipient lists,
per-recipient watermarking, and view and download tracking SHALL be owned by `BR - 0008` and SHALL NOT
be implemented here. (`CM - 0005`)

#### Scenario: Post-approval edits invalidate approval
- **WHEN** teaser content changes after approval
- **THEN** the approval is invalidated and re-approval is required before release

#### Scenario: Release hands one document to outreach
- **WHEN** a teaser version is released
- **THEN** it is frozen immutably and made available to buyer outreach, superseding the prior released
  version

### Requirement: Teaser events are logged

The system SHALL log to the Activity & Audit Log: teaser created, field content changed, suggestion
accepted, term list changed, scan run and its result, flag overridden with justification, seller
approval recorded, approval invalidated, version released, version superseded, export generated, and
teaser archived. (`CM - 0005`, feeds `SY - 0003`)

#### Scenario: The teaser lifecycle is auditable
- **WHEN** any teaser lifecycle event occurs
- **THEN** it appears in the Activity & Audit Log

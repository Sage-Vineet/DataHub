## Purpose

The CIM builder (`CM - 0001`) at the depth this change delivers: a versioned, block-structured
narrative deck whose qualitative content is gathered through guided Q&A, exported to PDF, and
published into the data room as an immutable tracked document. Data-bound financial exhibits,
templates, the `.pptx` loader and the teaser are specified in
`openspec/product/specs/cim/spec.md` and are **not** part of this capability — see `proposal.md`
Non-goals for the full deferral list and its reasoning.

## ADDED Requirements

### Requirement: A CIM is a versioned deck of sections, slides and blocks

The system SHALL represent a CIM as a deck belonging to exactly one company, carrying one or more
versions, each version an ordered set of sections containing ordered slides, each slide containing
addressable content blocks. Each block SHALL be individually identifiable, so that content can be
written to a specific block by something other than a person typing into it. (`CM - 0001`)

#### Scenario: A new deck is created with a section outline
- **WHEN** a broker creates a CIM for a company
- **THEN** a deck is created with a first version, a default section outline, and its slides and
  blocks

#### Scenario: A block is individually addressable
- **WHEN** content is written to one block of a slide
- **THEN** only that block changes and it is identifiable independently of its slide

### Requirement: A slide is either qualitative or a financial exhibit

Each slide SHALL record whether it is a user-authored qualitative slide or a system-generated
financial exhibit. Qualitative slides SHALL be editable through their content blocks. Exhibit slides
are declared by this capability but not populated by it.

#### Scenario: Slide class is recorded
- **WHEN** a slide is created
- **THEN** its class is recorded as qualitative or financial exhibit

### Requirement: Every content block carries a content class

Each content block SHALL carry a content class of either deal content or firm boilerplate,
defaulting to deal content. Content written by an accepted answer or by an import SHALL be
permanently classified as deal content and SHALL NOT be reclassifiable as firm boilerplate by any
user, role or route. (`CM - 0001`, required by `CM - 0002`)

#### Scenario: Blocks default to deal content
- **WHEN** a block is created
- **THEN** its content class is deal content

#### Scenario: Answer-derived content cannot become boilerplate
- **WHEN** any user attempts to reclassify a block populated by an accepted answer
- **THEN** the attempt is refused

### Requirement: Existing CIM work is carried across, not stranded

Applying this capability SHALL migrate existing stored CIM content into the deck, version, slide and
block structure, preserving each field's existing identity so that the rendered deck is unchanged
from the user's point of view. The prior storage SHALL be read rather than destroyed, so the prior
path remains a working fallback.

#### Scenario: An existing CIM renders identically after migration
- **WHEN** a company with existing CIM content is migrated
- **THEN** its deck renders the same content as before, in the same places

#### Scenario: The prior storage survives migration
- **WHEN** migration completes
- **THEN** the previously stored content is still present and the prior path still works

### Requirement: A question library maps questions to the blocks they fill

The system SHALL maintain a library of questions, each bound to the section and content block it is
intended to populate, and each scoped as system-wide, firm-wide, or private to a user. A user SHALL
see only system questions, their own firm's questions, and their own. (`CM - 0004`)

#### Scenario: A question knows which block it fills
- **WHEN** a library question is read
- **THEN** it names the section and target block it populates

#### Scenario: Library scope is respected
- **WHEN** a user lists library questions
- **THEN** they see system, own-firm and own questions, and no other user's or firm's

### Requirement: Generation targets only unpopulated blocks

The system SHALL, on a single action, inspect the deck's qualitative blocks and produce a draft
information request containing questions only for blocks that are currently unpopulated, excluding
any block already populated by authoring or by a previously accepted answer. Where an unpopulated
block has no mapped library question, the system SHALL surface it as an unmapped gap rather than
omitting it silently. (`CM - 0004`)

#### Scenario: Populated blocks are not asked about again
- **WHEN** a broker generates a request for a partly completed deck
- **THEN** the request contains questions only for blocks that are still empty

#### Scenario: An unmapped gap is surfaced
- **WHEN** an unpopulated block has no library question mapped to it
- **THEN** it appears in the draft as an unmapped gap

### Requirement: Generated questions are created in the Q&A capability

Generated questions SHALL be created as items in the platform Q&A capability, tagged with guided CIM
Q&A as their source of origin and carrying an opaque reference identifying the block each question
fills. This capability SHALL NOT implement its own question, answer, assignment or threading
storage. (`CM - 0004`, delegating to `QA - 0003`)

#### Scenario: Generation produces Q&A items
- **WHEN** a broker sends a generated request
- **THEN** Q&A items are created carrying the guided CIM Q&A origin and a reference to their target
  block

#### Scenario: The Q&A capability need not know what a CIM is
- **WHEN** a generated item is read through the Q&A capability
- **THEN** it is a normal Q&A item, and the block reference it carries is opaque to that capability

### Requirement: A draft request is editable without mutating the library

The broker SHALL be able to add, reword, reorder and remove questions in a draft request before
sending, and doing so SHALL NOT modify the underlying library question. (`CM - 0004`)

#### Scenario: Rewording a question in a request leaves the library alone
- **WHEN** a broker rewords a question in a draft request
- **THEN** the request carries the new wording and the library question is unchanged

### Requirement: No answer reaches a slide without broker acceptance

A submitted answer SHALL arrive in a review queue showing the question, the answer, the respondent
and the target block, and SHALL NOT write to any content block until the broker accepts it. The
broker SHALL be able to accept as submitted, edit and then accept, or discard. A discarded answer
SHALL be retained rather than deleted. (`CM - 0004`)

#### Scenario: A submitted answer waits for review
- **WHEN** a respondent submits an answer
- **THEN** it appears in the broker's review queue and no block has changed

#### Scenario: Acceptance writes the block
- **WHEN** the broker accepts an answer
- **THEN** the target block is populated

#### Scenario: A discarded answer is retained
- **WHEN** the broker discards an answer
- **THEN** the block is unchanged and the answer remains on the record

### Requirement: Existing content is never silently overwritten

Where the target block already contains content, the system SHALL require an explicit choice between
replacing, appending and skipping, defaulting to skip. (`CM - 0004`)

#### Scenario: Accepting onto a filled block requires a decision
- **WHEN** an answer is accepted onto a block that already has content and no choice is supplied
- **THEN** the block is left unchanged

### Requirement: Accepted content records its provenance

On acceptance the system SHALL record against the block the originating question, the respondent,
the answer timestamp, and the answer as originally submitted, preserved even where the broker edited
it before accepting. Provenance SHALL NOT appear on any rendered or exported output. (`CM - 0004`)

#### Scenario: The respondent's original words are preserved
- **WHEN** a broker edits an answer before accepting it
- **THEN** the block carries the edited text and the provenance carries what was originally
  submitted

#### Scenario: Provenance is internal
- **WHEN** the deck is exported
- **THEN** no provenance appears in the output

### Requirement: Guided Q&A is optional and never blocks the deck

A CIM SHALL be completable and publishable without any request having been created, and an open or
unanswered request SHALL NOT prevent publication. (`CM - 0004`)

#### Scenario: A broker who types the slides themselves is not obstructed
- **WHEN** a broker authors every block directly and publishes
- **THEN** publication succeeds with no request ever created

### Requirement: The deck exports to PDF with its standard furniture

The system SHALL export the deck to PDF including a cover page, a table of contents, page numbers, a
footer and a confidentiality legend on every page. An export taken while the version is not
published SHALL be watermarked as a draft not for distribution. (`CM - 0001`)

#### Scenario: A draft export is watermarked
- **WHEN** a deck is exported before publication
- **THEN** every page carries a draft-not-for-distribution watermark

#### Scenario: Standard furniture is present
- **WHEN** a deck is exported
- **THEN** the output carries a cover, a table of contents, page numbers, a footer and a
  confidentiality legend

### Requirement: Publishing freezes the version and lands it in the data room

On publish the system SHALL store the exported document, record a content hash of it, write it into
the deal's data room as a tracked document subject to data room access control and versioning, and
mark the version published. (`CM - 0001`)

#### Scenario: A published CIM appears in the data room
- **WHEN** a broker publishes a CIM
- **THEN** the exported document is present in the deal's data room as a tracked document

#### Scenario: The published artifact is content-addressed
- **WHEN** a version is published
- **THEN** a hash of the stored document is recorded against that version

### Requirement: A published version is immutable

Once published, a version's sections, slides and blocks SHALL NOT be modified through any route.
Editing a published CIM SHALL create a new draft version, and every prior published version SHALL
remain retrievable with its own published document and hash. (`CM - 0001`)

#### Scenario: Writing to a published version is refused
- **WHEN** any user attempts to change content on a published version
- **THEN** the attempt is refused

#### Scenario: Editing a published CIM forks a draft
- **WHEN** a broker edits a published CIM
- **THEN** a new draft version is created and the published version is unchanged and still
  retrievable

### Requirement: Deck lifecycle events are recorded on the audit trail

The system SHALL record deck creation, request generation, answer acceptance, export and publication
on the platform activity log with the acting user and a timestamp. (`CM - 0001`)

#### Scenario: The path from question to published deck is auditable
- **WHEN** a deck is created, a request generated, an answer accepted and a version published
- **THEN** each event is present on the activity log with actor and timestamp

### Requirement: Disabling the capability leaves the prior path working

Where this capability is disabled, its endpoints and interface surfaces SHALL be absent, and the
prior CIM path SHALL continue to function unchanged.

#### Scenario: Flag off falls back cleanly
- **WHEN** the capability is disabled
- **THEN** no CIM navigation entry or route surface is rendered, and the prior CIM path still works

CENTURIUUM
Feature Specification

| Feature ID | CM - 0003 |
|---|---|
| Feature Name | CIM Loader |
| Module | CM - CIM |
| Status | Draft |
| Related / Recycled IDs | CM - 0001 (CIM Helper); CM - 0002 (CIM Template) |
| Author | Valentin Secchi |
| Date | August 17, 2026 |

# 1. Purpose & Business Context
A broker bringing a deal onto Centuriuum often already has a CIM — one they built in PowerPoint for this company, or a prior deck whose narrative largely still applies. Retyping that content into the CIM builder is the single largest piece of friction standing between a broker and their first Centuriuum CIM. CM-0003 lets the broker upload an existing PowerPoint CIM, extracts its qualitative narrative, proposes where each block belongs in the CIM they are building, and — after the broker reviews and confirms every proposal — writes the accepted content into the matching qualitative slides. The result is a deck that arrives substantially populated rather than empty.
The loader deliberately imports nothing financial. No figure, table, chart, or financial graphic from the uploaded file is ever written into the CIM, because CM-0001 guarantees that every number a buyer sees on a Centuriuum CIM traces to the platform's own GL and QoE data with no manual override. Preserving that guarantee is more valuable than the convenience of importing a financial page, and it is also the honest framing of this feature: it removes the qualitative retyping, not the financial work — which CM-0001 has already automated. Imported content is additionally locked to the deal it was loaded into and can never travel into a firm template, so the loader does not become a route by which one company's narrative reaches another company's CIM.
# 2. User Stories
One story per user type that touches this feature. Format: "As a [role], I want to [action], so that [benefit]."
- As a broker, I want to upload the PowerPoint CIM I already built for this company, so that my Centuriuum CIM starts substantially written instead of as an empty template.
- As a broker, I want the system to propose where each block of my old deck belongs, so that I am confirming placements rather than copying and pasting forty slides.
- As a broker, I want to see exactly what was excluded from the import and why, so that I am not surprised later to find a financial page missing and do not assume the import failed.
- As a broker, I want nothing written into my CIM until I confirm it, so that a bad match cannot damage work I have already done on the deck.
- As a broker, I want to load a second file or re-run the import later, so that content I find in another deck can still be brought in without starting over.
- As a compliance-minded firm owner, I want an attested, audited record of every document loaded, so that we can show who uploaded what and on what basis.
- As a platform administrator, I want imported content permanently marked as deal content, so that a third party's narrative cannot reach a firm template and reappear on another company's CIM.
# 3. Functional Requirements
Numbered, testable statements the dev team can build against directly. Avoid prose — each line should be independently verifiable.
- The system shall allow a broker to upload a PowerPoint (.pptx) file to a CIM for loading.
- The system shall accept .pptx only, and shall reject .ppt, .pptm, .pdf, .docx, and all other formats with a message naming the supported format.
- The system shall reject macro-enabled and password-protected files.
- All uploaded files shall be scanned for malware using the platform's existing document upload controls before extraction begins.
- The loader shall be available only while the CIM status is Draft. It shall not be available on a CIM in In Review, Seller Approved, or Published status.
- At upload, the system shall require the user to affirm, by explicit action, that they have the right to use the content of the uploaded document for this deal. Upload shall not proceed without that affirmation.
- The attestation shall be recorded with the affirming user's identity, timestamp, file name, and a file content hash.
- Uploaded source files shall be stored in a private store attached to the CIM. They shall not be created as data room documents, shall not appear in any DR-0001 listing, and shall never be visible to a Buyer or Bank role under any circumstance.
- Uploaded source files shall be retained so that extraction can be re-run, and shall be deletable by the broker at any time.
- The system shall enforce configurable limits on maximum file size and maximum slide count per upload, and shall report the limit in the error message when a file exceeds it.
- Extraction shall run server-side and shall produce a staged extraction result. No content shall be written to the CIM as a result of extraction alone.
- For each slide in the source file, the system shall extract: the slide title from the title placeholder, body text from text placeholders and text boxes, bullet hierarchy to a depth of two levels, and the source slide index.
- The system shall preserve bold and italic inline formatting and bullet nesting, and shall discard all source fonts, colors, sizes, and element positions. Visual presentation in the target CIM is governed by the CM-0001 firm theme.
- The system shall not extract or import any of the following: numeric financial figures, financial tables, charts and graphs, embedded spreadsheets or OLE objects, images and logos, speaker notes, headers and footers, slide master content, and animations.
- The system shall exclude from import any text block that originates in a table shape, a chart shape, or a grouped shape containing a chart.
- The system shall exclude from import any text block whose content is predominantly numeric, per a defined and documented threshold rule.
- Extraction shall never write to any financial exhibit. Financial exhibits remain generated solely from platform data in accordance with CM-0001.
- The system shall record every excluded block with the reason for its exclusion, and shall present that list to the broker in the review screen.
- The system shall report extraction status as Queued, Processing, Ready for review, or Failed, and shall report a reason on failure.
- For each extracted text block, the system shall propose a target section and qualitative slide in the current CIM, using rule-based matching against slide titles, the CIM section outline, and maintained keyword and synonym sets.
- Matching shall be deterministic and rule-based. This feature shall not perform generative rewriting, summarization, or narrative drafting of imported content, which remains deferred to a separate AI feature per CM-0001.
- The system shall assign each proposal a confidence level, and shall group blocks it could not confidently match into a separate unmatched set rather than assigning them to an arbitrary slide.
- The review screen shall present, for each extracted block, the source slide and text alongside the proposed destination slide and block, and shall allow the broker to Accept, Reassign to a different slide or block, or Discard.
- The broker shall be able to accept all high-confidence proposals in a single action. Low-confidence and unmatched blocks shall require an individual decision.
- No content shall be written into the CIM until the broker commits the reviewed set.
- Where a target content block already contains text, the system shall offer Replace, Append, or Skip for that block, defaulting to Skip, and shall never overwrite existing content without an explicit choice.
- Where an extracted block duplicates text already present in the CIM, the system shall flag it as a duplicate and default it to Skip.
- Where the CIM contains no slide corresponding to an extracted block's matched section, the system shall offer to create a new qualitative slide in that section rather than discarding the content.
- The broker shall be able to run the loader more than once against the same CIM, including with different source files. Each run shall be staged, reviewed, and committed independently.
- On commit, the system shall record for each imported block its source file, source slide index, and import timestamp as internal provenance. Provenance shall not appear on any rendered or exported output.
- Every content block created or populated by the loader shall be permanently classified as Deal content under the CM-0001 content class attribute.
- The system shall not permit a loader-originated block to be reclassified as Firm boilerplate by any user, role, or API route.
- Loader-originated content shall therefore never be carried into a CM-0002 template, and this shall be verifiable by attempting the save-as-template operation on a CIM containing imported blocks.
- The system shall log to the Activity & Audit Log (SY-0003): file uploaded with attestation, extraction started, extraction completed or failed, review committed with counts of blocks accepted, reassigned, discarded and skipped, and source file deleted.
# 4. Data Requirements
What tables/fields does this feature read from or write to? Reference the relevant Database module table blocks (DB-0001 through DB-0010) wherever applicable so every feature traces back to the reconciled data structure.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Uploaded source file (.pptx binary) | Write | Private CIM-attached file store — not DR-0001, not a data room document (see Open Questions on ownership of this store) |
| Upload record (file name, size, hash, uploading user, timestamp, attestation flag) | Write | New CM-module table block; no DB-0001 to DB-0010 block is reserved for CIM content |
| Staged extraction result (extracted blocks, source slide index, bullet structure, inline formatting) | Write | New CM-module staging table; discarded or retained per run once committed |
| Exclusion record (excluded block, exclusion reason) | Write | New CM-module staging table; surfaced in the review screen |
| Mapping proposals (source block, proposed target slide/block, confidence level, broker decision) | Write | New CM-module staging table |
| Section matching keyword and synonym sets | Read | Platform-maintained configuration (ownership to be confirmed — see Open Questions) |
| CIM sections, qualitative slides, and content blocks | Read / Write | CM-0001 — read to build mapping proposals; written on commit of accepted blocks |
| Content block class attribute (Deal content / Firm boilerplate) | Write | CM-0001 block attribute — loader-created blocks written as Deal content and locked |
| Import provenance (source file, source slide index, import timestamp) per block | Write | CM-0001 content block record; internal only, never rendered |
| Financial exhibits and financial data | Not written | Deliberately absent — the loader writes to no financial exhibit and imports no figure; exhibits remain generated from QE-0004 / RP-0001 / DB-0002 per CM-0001 |
| Upload, extraction, commit, and deletion events | Write | SY-0003 — Activity & Audit Log, including attestation and per-run block disposition counts |

# 5. Access & Security
Confirm roles and deal isolation explicitly on every spec — never assume it.
- Roles with access: Broker (deal owner/admin) — may upload a source file, run extraction, review proposals, commit accepted content, and delete a source file. Firm administrator — same rights as broker on deals they have access to.
- Roles explicitly excluded: Company / Seller user — no upload or loader access in v1 (see Open Questions, as the seller may legitimately hold the prior deck). Accountant / QoE preparer — no loader access; their CM-0001 read access does not extend to this feature. Buyer — no access to the loader, to any uploaded source file, or to any staged extraction result under any circumstance. Bank — no access.
- Uploaded source files are stored outside the data room specifically so that no data room permission grant, buyer invitation, or bulk share can expose them. They shall not be retrievable through any DR-0001 surface or API.
- All uploaded files shall pass the platform's malware scanning controls before extraction, on the basis that this feature accepts arbitrary binary files authored outside the platform.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. The uploaded source file, its upload record, all staged extraction results, exclusion records, mapping proposals, and per-block provenance are scoped to one CIM within one deal, and are not visible or retrievable from any other deal. There is no cross-deal browsing of previously uploaded files, and a file uploaded to one deal cannot be applied to a CIM in another deal.
- Cross-deal content leakage is additionally closed by construction: because every loader-originated block is permanently classified as Deal content and cannot be reclassified, imported content is structurally incapable of entering a CM-0002 firm or user template and therefore cannot reach another company's CIM.
- The upload attestation is treated as a compliance control, not a convenience prompt: it is mandatory, non-dismissible, and audited with the file hash so that the affirmed document can be identified after the fact.
# 6. UI / UX Notes
Layout, interaction notes, or wireframe reference. State platform scope explicitly per feature.
- Platform: Web only. Upload, extraction review, and commit are web-only. There is no loader access on mobile in v1.
- Wireframe reference: N/A
The loader is entered from the CIM editor as a “Load from an existing CIM” action, visible only while the CIM is in Draft. The upload step carries the attestation as a required, explicit action rather than a pre-ticked box, and states plainly what the loader will and will not import before the file is selected — setting that expectation before extraction is cheaper than explaining it afterward.
The review screen is a two-pane comparison: source slide content on the left, proposed destination on the right, with per-block Accept / Reassign / Discard controls. Blocks are grouped by confidence — high-confidence proposals collapsed under a single bulk-accept action, low-confidence and unmatched blocks listed individually so the broker's attention goes only where a decision is genuinely needed. On a forty-slide deck, the difference between grouping and not grouping is the difference between a five-minute task and an abandoned one.
The excluded-content list is a required part of the review screen, not an optional detail view. A broker whose financial pages did not import will conclude the feature is broken unless the exclusion is stated, with the reason, and paired with a short explanation that financial slides are generated from platform data. This is the single most likely source of support tickets on this feature.
Extraction is asynchronous: the UI should show Queued / Processing / Ready for review / Failed status and allow the broker to leave and return rather than holding a blocking spinner on a large deck. Any slides omitted or content unresolved after commit should surface in the CM-0001 pre-publish deck health panel rather than only as a transient message.
# 7. Dependencies
Upstream features that must exist first. This is the single most valuable section for sequencing the build.

| Related Feature | Relationship | Notes |
|---|---|---|
| CM-0001 — CIM Helper | Depends on | Supplies the CIM section outline, qualitative slides and content blocks the loader writes into, the Draft status gate, the content class attribute, and the deck health panel. The loader cannot exist before the builder. |
| CM-0002 — CIM Template | Depends on | Defines the content class semantics this feature relies on. CM-0002's deferral of PowerPoint import as a template source is unaffected: the loader imports into a CIM only, and loader-originated blocks are locked to Deal content so they can never become template boilerplate. |
| DR-0001 — Core Data Room | Depends on | Supplies the file upload pipeline and malware scanning controls. Explicitly not the storage destination — source files are held in a private CIM-attached store outside the data room. |
| Private CIM file store (unresolved) | Depends on | A document store outside the data room, with its own retention, encryption, and deletion behavior. No such store is known to exist today (see Open Questions). |
| SY-0003 — Activity & Audit Log | Depends on | Upload with attestation, extraction lifecycle, commit dispositions, and file deletion must all be logged. Platform-wide audit trail is a known cross-cutting gap. |
| Legal / compliance (cross-cutting gap) | Depends on | Owns the wording of the upload attestation and the platform's position on user-uploaded third-party documents. |
| Document retention (cross-cutting gap) | Depends on | Governs how long an uploaded source file is retained and what happens to it when the deal closes or the CIM is deleted. |
| OCR pipeline (cross-cutting gap) | Related | Not used in v1 because PDF input is out of scope. It is the prerequisite for any future scanned-PDF support. |
| Notifications hub (cross-cutting gap) | Related | Extraction is asynchronous; completion of a long-running extraction is a notifiable event. |
| AI narrative drafting (Feature ID to be confirmed) | Related | Out of scope here. The loader places imported text verbatim; rewriting or summarizing it belongs to that feature. |

# 8. Out of Scope / Deferred
- PDF input, including text-based PDF — deferred, and noted in Open Questions as the most significant coverage limitation of this feature.
- Scanned or image-only decks and any OCR-based extraction — dependent on the platform OCR pipeline, not solved locally.
- Word (.docx), legacy PowerPoint (.ppt), macro-enabled (.pptm), Google Slides, and Keynote input.
- Import of images, photographs, logos, charts, graphs, tables, embedded spreadsheets, and any numeric financial figure.
- Import of design and layout — source fonts, colors, sizes, element positions, slide masters, animations, and transitions are discarded; presentation is governed by the CM-0001 firm theme.
- Import of speaker notes, headers, and footers.
- Using an uploaded deck as the source of a CM-0002 template — that deferral stands, and loader-originated content is locked out of templates by design.
- Populating the CM-0001 seller questionnaire from an uploaded deck — the loader writes to slide content blocks only.
- Generative rewriting, summarization, tone adjustment, or translation of imported content.
- Extraction of financial data from an uploaded deck into the GL, QoE, or any reporting module.
- Loading into a CIM that is not in Draft status, and bulk loading across multiple deals or multiple CIMs in one operation.
- A cross-deal library of previously uploaded source files.
# 9. Open Questions
- Reference file access: the project knowledge files (Centuriuum_Product_List.xlsx, Centuriuum_Spec_Conventions_and_Decisions.docx) could not be read when this spec was drafted. Confirm the CM module label and Feature ID formatting, and confirm nothing here contradicts a locked decision in the conventions doc.
- PowerPoint-only input is the largest product risk in this feature. A substantial share of brokers hold only the PDF of a prior CIM — the editable source often sits with a designer, a former colleague, or another firm. If that proves true of the target user base, the loader will be unusable for the very brokers it is meant to onboard. Recommend confirming this limitation with real brokers before build, and logging text-based PDF as the first follow-on.
- Private file store: storing uploads outside the data room requires a second document store with its own retention, encryption, access, and deletion-on-deal-close behavior. Does that store exist? If not, is building it in scope here, or should uploads instead be data room documents with restricted visibility and a no-share flag?
- Numeric exclusion threshold: “predominantly numeric” must be defined concretely to be testable. Proposal for confirmation — exclude a block where digits and currency or percentage symbols exceed a set proportion of its non-whitespace characters, in addition to excluding all table- and chart-originated text. The threshold value needs to be set, and the rule needs a review against a few real CIMs.
- Text-only import combined with permanently-Deal-content classification means a broker cannot use the loader to bring their own firm's prior CIM in and then save it as a firm template — arguably a natural motivation for uploading in the first place. Confirm this trade-off is accepted, or decide whether a broker importing their own firm's deck should be able to promote imported text to boilerplate.
- Chart images: because images are excluded entirely, an embedded revenue chart cannot enter the deck. Confirm that excluding all images (rather than importing photographs while excluding charts) is the intended v1 behavior, since facility and product photos are content a broker would otherwise have to re-source manually.
- Attestation wording and the platform's stated position on user-uploaded third-party documents require legal review. Should the attestation appear once per file, or once per deal?
- Should a Company / Seller user be able to upload a prior CIM? The seller frequently holds the prior deck, and requiring the broker to relay the file adds a step. Current spec is broker-only.
- Section matching sets: who maintains the keyword and synonym dictionaries used for mapping, and should they be configurable per firm — for example a firm that calls a section “Growth Runway” rather than “Growth Opportunities”?
- Limits: what are the maximum file size, maximum slide count, and maximum extracted block count per import, and does extraction need a queue and timeout policy for large decks?
- Failure fallback: when extraction succeeds technically but matches almost nothing, should the system offer a plain-text dump of extracted content the broker can copy from manually, rather than leaving them with an empty review screen?
- Assumption to confirm: staged extraction results are retained after commit for troubleshooting and re-review, rather than discarded. If retained, they fall under the same retention question as the source file.
# 10. Acceptance Criteria
- A broker can upload a .pptx file to a Draft CIM, and the upload cannot complete until the rights attestation has been explicitly affirmed.
- Uploading .ppt, .pptm, .pdf, .docx, a password-protected file, or a file exceeding the configured size or slide limit is rejected with a message naming the supported format or the limit.
- The uploaded file is stored outside the data room: it does not appear in any DR-0001 listing, and it cannot be retrieved by a Buyer or Bank role through any surface or API.
- The loader action is unavailable on a CIM whose status is In Review, Seller Approved, or Published.
- Extraction produces slide titles, body text, and two-level bullet structure from the source deck, with bold and italic preserved and source fonts, colors, and positions discarded.
- No numeric figure, financial table, chart, image, logo, speaker note, or embedded object from the source file appears anywhere in the CIM after import.
- A text block originating in a table or chart shape is excluded, and a predominantly numeric text block is excluded, and both appear in the review screen's excluded list with a stated reason.
- No financial exhibit in the CIM is altered by any loader operation, and exhibit figures continue to resolve from platform data.
- Extraction alone writes nothing to the CIM: after extraction completes and before commit, the CIM is byte-for-byte unchanged.
- Each extracted block is presented with a proposed destination and a confidence level; unmatched blocks appear in a separate group and are not auto-assigned.
- The broker can bulk-accept high-confidence proposals, and low-confidence and unmatched blocks each require an individual decision before commit.
- Committing writes only the accepted blocks; discarded and skipped blocks appear nowhere in the CIM.
- Where a target block already contains text, the broker is offered Replace, Append, or Skip, the default is Skip, and no existing content is overwritten without an explicit choice.
- A block duplicating text already in the CIM is flagged as a duplicate and defaults to Skip.
- Where no slide exists for a matched section, the broker is offered creation of a new qualitative slide rather than losing the content.
- A second loader run on the same CIM, with a different source file, stages and commits independently without disturbing content committed by the first run.
- Every block created or populated by the loader carries the Deal content class, and no user, role, or API route can reclassify it as Firm boilerplate.
- Saving a CIM containing imported blocks as a CM-0002 template produces a template containing none of that imported content.
- Upload with attestation, extraction start, extraction completion or failure, commit with accepted/reassigned/discarded/skipped counts, and source file deletion all appear in the Activity & Audit Log (SY-0003).
- A user without assigned role/deal access cannot reach the loader, any uploaded source file, any staged extraction result, or any mapping proposal for that deal, and no uploaded file from one deal can be applied to a CIM in another deal.

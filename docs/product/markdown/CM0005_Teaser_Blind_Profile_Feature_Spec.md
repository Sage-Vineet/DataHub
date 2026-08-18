CENTURIUUM
Feature Specification

| Feature ID | CM - 0005 |
|---|---|
| Feature Name | Teaser / Blind Profile |
| Module | CM - CIM |
| Status | Draft |
| Related / Recycled IDs | CM - 0001 (CIM Helper) — deferred teaser generation to this feature; CM - 0004 (Guided Q&A); BO - 0002 (distribution and tracking) |
| Author | Valentin Secchi |
| Date | August 17, 2026 |

# 1. Purpose & Business Context
The teaser is the document that actually goes to market. It reaches every buyer on the outreach list, it reaches them before any NDA is signed, and it is the only deal document a broker distributes to people who have made no confidentiality commitment at all. That inverts the risk profile of everything else in this module: where the CIM is judged on how completely it describes a business, the teaser is judged on how much it can convey while remaining impossible to trace back to a specific company. A single retained identifying term — most commonly the company's own name inside a paragraph copied from the CIM — turns a controlled process into a market rumor, and the seller's staff, customers, and competitors learn the business is for sale from the wrong source.
CM-0005 therefore treats the teaser as a distinct deliverable rather than a short version of the CIM. It has its own structured field set with enforced length limits; CIM content is offered only as a suggestion the broker must explicitly accept, with identifying terms highlighted before acceptance; location, industry, headcount, and tenure are captured through controlled values rather than free prose; no business photograph can be added at all; and an automated confidentiality scan runs against every rendered element — including the exported PDF's file name and metadata — and hard-blocks release until every flag is resolved or overridden with a recorded justification.
Financially, the teaser binds to the frozen snapshot of the most recently published CIM version where one exists, so the two documents cannot show different figures for the same period. Where no CIM has been published yet — the normal case, since the teaser goes out first — it binds to current QE-0004 data and freezes its own snapshot on release. Released teasers are immutable, versioned, seller-approved, and handed to BO-0002, which owns distribution, recipient lists, and per-recipient tracking. This spec fulfills the deferral recorded in CM-0001 Section 8 and reuses that feature's anonymization thinking rather than duplicating it.
# 2. User Stories
One story per user type that touches this feature. Format: "As a [role], I want to [action], so that [benefit]."
- As a broker, I want to produce a one to two page anonymous profile from data the platform already holds, so that I can go to market quickly without rebuilding the numbers by hand.
- As a broker, I want the system to stop me from releasing a teaser that still contains the company's name, address, website, or a customer's name, so that a moment of haste cannot become a confidentiality breach.
- As a broker, I want to preview the teaser exactly as an outside recipient will see it, so that I am checking the actual document rather than an internal view of it.
- As a broker, I want the teaser's revenue and earnings figures to come from the same source as the CIM, so that a buyer who receives both never finds two different EBITDA numbers for the same year.
- As a broker, I want to describe customer concentration without naming anyone, so that I can convey diversification quality without exposing the customer base.
- As a broker, I want to release the teaser before any CIM exists, so that the marketing process is not gated on finishing the full memorandum.
- As a company/seller user, I want to review and approve the teaser before it is distributed, so that I can see how my business will be described to the market anonymously.
- As a firm owner, I want an audited record of every confidentiality flag, override, justification, approval, and release, so that we can demonstrate the process we followed if a leak is ever alleged.
- As a platform administrator, I want released teasers to be immutable and versioned, so that we can establish precisely which document a given recipient received.
# 3. Functional Requirements
Numbered, testable statements the dev team can build against directly. Avoid prose — each line should be independently verifiable.
- The teaser shall be a distinct document object with its own record, content model, versioning, and approval state. It shall not be implemented as a CIM version, a CIM export mode, or a CIM rendering variant.
- A teaser shall be creatable and releasable for a deal on which no CIM exists. Absence of a CIM shall only mean that content suggestions are unavailable.
- Teaser status shall progress Draft, In Review, Seller Approved, Released, Archived. Released versions shall be immutable.
- Editing a Released teaser shall create a new Draft version, and all prior released versions shall remain retrievable.
- The system shall maintain a version history per teaser showing version number, status, release date, financial as-of date, approving user, releasing user, and the scan result and override record for that version.
- The rendered teaser shall not exceed two pages. The system shall report projected page overflow while editing and shall block release of a teaser that renders to more than two pages.
- Each narrative field shall enforce a defined maximum character count, so that content must be summarized for the teaser rather than pasted from the CIM at full length.
- The teaser shall have its own structured field set comprising: business description, value proposition, industry, end markets served, region, years in operation, employee count band, customer mix and concentration statement, growth drivers, investment highlights, reason for sale, and real estate status.
- The teaser shall not present an asking price, a price expectation, a valuation, a multiple, or any other indication of value. No field capturing or rendering such a value shall exist on the teaser.
- Where corresponding CIM content exists, the system shall offer it as a suggestion for the relevant teaser field. Suggestions shall require explicit broker acceptance and shall never auto-populate a teaser field.
- Accepted suggestion text shall be copied into the teaser field as independent content. The teaser field shall retain no live link to the CIM block, and later CIM edits shall not alter teaser content.
- The system shall run the confidentiality scan against a suggestion at the moment it is offered, and shall visually flag any identifying term within the suggestion before the broker accepts it.
- Industry shall be selected from a controlled taxonomy. The system shall enforce a defined minimum breadth level and shall reject selection of any taxonomy node below that level.
- End markets served shall be selected from a controlled multi-select list. No free-text industry or end-market descriptor shall be permitted.
- Region shall be selected from a controlled geographic list at region or metropolitan-area granularity. The system shall not accept or render a city, street address, or postal code in any location field.
- Years in operation shall be rendered as a rounded or banded value. The system shall not render an exact founding year.
- Employee count shall be rendered as a band from a defined band set. The system shall not render an exact headcount.
- Real estate status shall be selected from a fixed enumerated set covering owned and leased, each as included in or excluded from the transaction, plus not applicable.
- Fields with no platform source — employee count band, years in operation, real estate status, and reason for sale — may be prefilled from accepted CM-0004 answers where a mapping exists, and shall otherwise be broker-entered.
- The teaser shall render revenue and either Adjusted EBITDA or SDE for the trailing period plus one or two prior annual periods, at the broker's selection.
- The system shall label which earnings basis is presented, consistent with QE-0004 output, and shall not present both bases simultaneously.
- Where one or more published CIM versions exist for the deal, teaser financial figures shall bind to the most recently published version's frozen snapshot and shall display that version's financial as-of date.
- Where no published CIM version exists, teaser financial figures shall bind to current QE-0004 and adjusted-P&L data, and shall freeze into a teaser-specific snapshot with its own as-of date on release.
- Teaser financial figures shall not be manually editable. Corrections shall be made at source in accordance with CM-0001.
- Where a CIM version is published after a teaser has been released and its figures for a presented period differ from the released teaser, the system shall flag the released teaser as inconsistent with the current published CIM and prompt the broker to issue a new teaser version.
- The customer concentration statement shall be derived by the system from GL-based concentration data (DB-0002) and expressed as a banded qualitative statement drawn from a defined band set.
- The customer concentration statement shall never render a customer name, nor an exact percentage attributed to an individual customer.
- The broker may edit the wording of the derived concentration statement subject to the confidentiality scan, and shall not be able to introduce a customer name.
- Where GL data is insufficient to derive concentration, the statement shall be broker-entered subject to scan, and the system shall indicate to the broker that automatic derivation was unavailable.
- The system shall maintain a per-deal identifying-term list, auto-derived from: the company's legal name, trade names and DBAs; the top customer names present in GL data; the company's website domain and email domains; its street address, city, and postal code; and any key personnel names held on the deal record.
- The broker shall be able to add terms to and remove terms from the list. Every addition and removal shall be audited.
- The confidentiality scan shall run on demand, on save of any narrative field, at the moment a CIM suggestion is offered, and mandatorily immediately before release.
- The scan shall check every element that appears in the rendered output, including all field content, the industry and end-market labels, the region label, the footer and disclaimer legend, and the exported PDF's file name and document metadata.
- Matching shall be case-insensitive and shall detect whole-word matches together with possessive and plural variants, and shall normalize repeated whitespace and punctuation before matching.
- Release shall be blocked while any scan flag remains unresolved.
- The broker shall be able to override an individual flag by entering a typed justification. The override shall record the user, timestamp, matched term, field, and justification to the Activity & Audit Log (SY-0003).
- Overrides shall apply to one flag on one version only. Creating a new version shall re-run the scan, and prior overrides shall not carry forward.
- The scan shall flag only. It shall never automatically alter, redact, or rewrite teaser content.
- Scan results, including all flags, resolutions, and overrides, shall be retained against the version record.
- The broker shall be able to preview the teaser exactly as an outside recipient would see it, with no internal indicators, source lineage, scan markings, or platform interface elements present in the preview.
- The teaser shall render using the firm theme defined in CM-0001, including the firm's confidentiality and disclaimer legend.
- The teaser shall support no business photographs. The system shall provide no image upload capability on the teaser, and shall render only firm branding and theme graphics.
- The teaser shall export to PDF, rendered server-side, visually identical to the recipient preview.
- Exports taken before release shall be watermarked “DRAFT — NOT FOR DISTRIBUTION” on every page.
- The exported PDF's file name and document metadata shall contain no identifying term, and shall be scanned before the export is produced.
- A teaser shall not be releasable until a designated company/seller user has approved that specific version.
- Approval shall be recorded with the approving user's identity, timestamp, and version number.
- Any change to teaser content after approval shall invalidate that approval and require re-approval before release.
- On release, the system shall freeze into an immutable version: the rendered teaser, its financial snapshot and as-of date, its scan results and overrides, and its approval record.
- On release, the system shall make the released version available to Buyer Outreach (BO-0002) as the document to be distributed and tracked.
- Distribution, recipient lists, per-recipient watermarking, and view and download tracking shall be owned by BO-0002 and shall not be implemented within this feature.
- On release of a new version, the system shall provide that version to BO-0002 and shall mark the prior released version as superseded.
- The system shall log to the Activity & Audit Log (SY-0003): teaser created, field content changed, suggestion accepted, term list changed, scan run and its result, flag overridden with justification, seller approval recorded, approval invalidated, version released, version superseded, export generated, and teaser archived.
# 4. Data Requirements
What tables/fields does this feature read from or write to? Reference the relevant Database module table blocks (DB-0001 through DB-0010) wherever applicable so every feature traces back to the reconciled data structure.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Teaser record (name, status, version, created/approved/released by and at) | Write | New CM-module table block — DB-0001 to DB-0010 are financial data blocks and none is reserved for CIM or teaser content |
| Teaser content fields (description, value proposition, growth drivers, investment highlights, reason for sale, concentration statement) | Write | New CM-module table block; independent of CIM content blocks, with enforced character limits |
| Controlled values (industry taxonomy node, end markets, region, employee band, years band, real estate status) | Read / Write | Controlled reference lists read at authoring; selected values written to the teaser record |
| Industry taxonomy and minimum breadth rule | Read | Platform reference data — ownership and maintenance to be confirmed (see Open Questions) |
| Adjusted EBITDA / SDE figures | Read | QE-0004 — SDE/EBITDA Tab, where no published CIM version exists |
| Revenue and adjusted P&L figures | Read | RP-0001 and the QoE adjusted P&L, where no published CIM version exists |
| Published CIM version frozen financial snapshot and as-of date | Read | CM-0001 CIM version record — primary financial binding whenever a published CIM version exists |
| Teaser financial snapshot and as-of date | Write | New CM-module version table; frozen on release |
| Customer concentration data | Read | DB-0002 — GL Data; used to derive a banded qualitative statement only, never customer names or per-customer percentages |
| Asking price, valuation, or price expectation | Not read or written | Deliberately absent — no price or value indication is captured on or rendered by the teaser |
| Company identity data (legal name, trade names, DBAs, address, website and email domains, key personnel) | Read | Company/deal record — consumed only to build the identifying-term list, never rendered |
| Identifying-term list and broker additions/removals | Write | New CM-module table block; internal only and never included in any payload serving rendered teaser output |
| Scan results, flags, resolutions, and overrides with justifications | Write | New CM-module table block, retained per version |
| Accepted CM-0004 answers | Read | CM-0004 — optional prefill for teaser-only facts where a mapping exists |
| Firm theme and confidentiality legend | Read | Brokerage/firm settings owned by the admin console (cross-cutting gap) |
| Released teaser PDF and version reference | Write | Provided to BO-0002 for distribution and tracking; BO-0002 owns recipient lists and watermarking |
| Teaser lifecycle, scan, override, approval, and release events | Write | SY-0003 — Activity & Audit Log |

# 5. Access & Security
Confirm roles and deal isolation explicitly on every spec — never assume it.
- Roles with access: Broker (deal owner/admin) — create, edit, manage the identifying-term list, run scans, override flags with justification, request approval, release, and archive. Firm administrator — same rights on deals they have access to. Company / Seller user — read-only view of the draft teaser and the ability to record approval of a version; no access to the identifying-term list, scan internals, or override records.
- Roles explicitly excluded: Accountant / QoE preparer — no access in v1. Bank — no access. Buyer / outreach recipient — no access to this feature at all. A recipient receives only the released PDF through BO-0002 and has no access to any draft, any field, any suppressed value, the identifying-term list, scan results, or the existence of overrides.
- The identifying-term list is itself confidential: it contains the company's legal name, address, website, and customer names by construction. It shall be stored as internal data, shall never be included in any response, payload, or artifact that serves rendered teaser output, and shall never be exported.
- Rendering and export shall occur server-side. No suppressed source value — company name, address, customer names, exact headcount, exact founding year — shall be present in any client-delivered payload, file, or metadata associated with a released teaser, on the basis that recipients are pre-NDA and unbound.
- The confidentiality scan is a security control, not a convenience feature: it is mandatory before release, blocking, non-bypassable without a recorded justification, re-run on every new version, and never carried forward from a prior version's overrides.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. Teasers, versions, content fields, financial snapshots, identifying-term lists, scan results, overrides, and approval records are scoped to one deal and are not visible or retrievable from any other deal. There is no cross-deal reuse of teaser content, no cross-deal term list, and no cross-deal visibility of any teaser at any status.
- Teaser content shall not be reusable as CM-0002 template boilerplate. Teaser fields are a distinct content model outside the CIM block structure, and templating them is out of scope, so no route exists by which one company's teaser copy could appear in another company's teaser.
# 6. UI / UX Notes
Layout, interaction notes, or wireframe reference. State platform scope explicitly per feature.
- Platform: Web only. Teaser authoring, scanning, override, approval, and release are web-only, consistent with CM-0001. The released PDF is viewable on any device through whatever BO-0002 provides for recipients.
- Wireframe reference: N/A
The editor should be a two-pane layout: a left field form grouped by teaser section with a visible character counter on every narrative field, and a right pane showing the live one-to-two page render. Because the constraint that matters here is length and the risk that matters is disclosure, both should be visible at all times rather than discovered at release.
The teaser editor must look and feel visibly different from the CIM builder. A broker who confuses which document they are editing will apply CIM habits to a pre-NDA document, and that is precisely the failure mode this feature exists to prevent. Different chrome, a persistent “pre-NDA — anonymous document” banner, and a distinct entry point are all warranted.
Confidentiality status should be persistent rather than a release-time interruption: a always-visible indicator reading Clear or showing the number of open flags, with a panel listing each flag, the matched term, the field it appears in, and the option to edit the text or override with justification. Suggestions offered from CIM content should show flagged terms highlighted inline before the broker accepts, so the broker sees the leak in the suggestion rather than after adopting it.
“Preview as recipient” should be a prominent, first-class action producing a clean render with no internal markings whatsoever — it is the only way a broker can verify what they are actually sending. Release should present the scan result as the explicit gate, with the flag list as the blocker and no path past it other than resolution or a justified override.
Where a released teaser becomes inconsistent with a newly published CIM, that state should be surfaced on the teaser record and in the deal view, not only as a transient notification, since the stale document is already in the market.
# 7. Dependencies
Upstream features that must exist first. This is the single most valuable section for sequencing the build.

| Related Feature | Relationship | Notes |
|---|---|---|
| CM-0001 — CIM Helper | Depends on | Supplies the firm theme and confidentiality legend, the published-version frozen financial snapshot the teaser binds to, the seller approval pattern, and the CIM content offered as suggestions. CM-0001 Section 8 deferred teaser generation to this feature; that reference should now name CM-0005. |
| QE-0004 — SDE/EBITDA Tab | Depends on | Source of Adjusted EBITDA and SDE where no published CIM version exists to bind to. |
| RP-0001 — Profit & Loss | Depends on | Source of revenue and adjusted P&L figures where no published CIM version exists. |
| DB-0002 — GL Data | Depends on | Source of customer concentration used to derive the banded qualitative statement, and of the customer names used to build the identifying-term list. |
| BO - 0002 — Buyer outreach distribution | Depends on | Owns distribution, recipient lists, per-recipient watermarking, and view/download tracking of the released teaser. This feature produces and versions the document; BO-0002 sends and tracks it. Confirm the ID and that BO-0002 accepts a released teaser version as its tracked document. |
| CM-0004 — Guided Q&A | Related | Accepted answers may prefill teaser-only facts (employee band, years in operation, real estate status, reason for sale) where a mapping exists. |
| Deal record (unresolved) | Depends on | Source of key personnel names used to build the identifying-term list. Existence of this field is unconfirmed (see Open Questions). No price or valuation is read from the deal record, as the teaser presents none. |
| Industry taxonomy reference data (unresolved) | Depends on | The controlled industry list and the minimum breadth rule that prevents niche-descriptor reverse identification. Ownership and maintenance are unassigned. |
| Admin console / firm settings (cross-cutting gap) | Depends on | Owns the firm theme and confidentiality legend applied to the rendered teaser. |
| Legal / compliance (cross-cutting gap) | Depends on | Owns the teaser's disclaimer and pre-NDA legend language, and the policy governing who may override a confidentiality flag and on what grounds. |
| SY-0003 — Activity & Audit Log | Depends on | All lifecycle, scan, override, approval, and release events. Platform-wide audit trail is a known cross-cutting gap. |
| Document versioning (cross-cutting gap) | Depends on | Governs how a newly released teaser supersedes the prior released version in distribution while history is retained. |
| Notifications hub (cross-cutting gap) | Related | Approval requests, and the alert raised when a released teaser becomes inconsistent with a newly published CIM. |

# 8. Out of Scope / Deferred
- Distribution itself — recipient lists, sending, per-recipient watermarking, and view and download tracking are owned by BO-0002.
- NDA execution and the gating of CIM access on a signed NDA — a separate concern touching the e-signature cross-cutting gap.
- Business photographs of any kind, and any image upload capability on the teaser.
- Free-text industry or end-market descriptors, and any location value more precise than region or metropolitan area.
- Exact headcount, exact founding year, and any other precise identifying quantity.
- Manual override or manual entry of financial figures — corrections are made at source per CM-0001.
- Asking price, price expectation, valuation, and multiples — deliberately excluded from the teaser. Price is communicated outside this document, so the teaser carries no field for it and none can be added by a broker.
- Teaser templates and firm-level teaser boilerplate — deferred; teaser content is not reusable across deals.
- Export formats other than PDF. There is no PowerPoint or Word export of the teaser.
- AI drafting, summarizing, or tone adjustment of teaser copy.
- Automatic redaction or rewriting by the confidentiality scan — the scan flags only.
- Image-based or OCR-based leak detection, which is unnecessary while no images are permitted.
- Reverse-identification risk scoring beyond the enforced taxonomy breadth rule (see Open Questions).
- Multi-language teasers and translation.
- Buyer-facing questions, expressions of interest, or any interactive element on the teaser.
- Blind profiles for buy-side mandates or any document type other than the sell-side teaser.
# 9. Open Questions
- Reference file access: the project knowledge files (Centuriuum_Product_List.xlsx, Centuriuum_Spec_Conventions_and_Decisions.docx) could not be read when this spec was drafted. Confirm the CM module label and Feature ID formatting, confirm BO-0002 is the correct ID for the distribution and tracking feature, and confirm nothing here contradicts a locked decision in the conventions doc.
- Minimum industry breadth rule: “broad enough that the business cannot be reverse-identified” must become a concrete, testable rule. Proposal for confirmation — restrict selection to a fixed rollup level of a standard taxonomy (for example NAICS three-digit) rather than a judgment call. Who owns and maintains the taxonomy, and is the breadth level global or configurable by market?
- Reverse identification the scan cannot catch: a term list cannot detect “the only firm of its kind in this metro.” The combination of a narrow industry node, a small region, and a specific revenue figure can identify a business even with every name removed. Should the system raise a heuristic warning on narrow combinations, or is this documented broker judgment supported by a pre-release checklist in v1? Recommend the checklist for v1 and treat scoring as a follow-on.
- Exact financial figures: the brief specifies exact revenue and Adjusted EBITDA or SDE. In a narrow industry and small region, an exact revenue figure is itself identifying. Should banded revenue and earnings presentation be available as a broker option for highly identifiable businesses, and if so does the band set need to be standardized?
- Years in operation is specified here as rounded or banded rather than an exact founding year, because founding year plus industry plus region is frequently identifying. Confirm, since the brief lists it as a plain fact.
- Deal record fields: does a deal record exist today holding key personnel names? If not, key personnel must be broker-added to the identifying-term list manually — which weakens the auto-derived list precisely where a broker is most likely to forget, since an owner's name in a narrative block is a common leak.
- Asking price is excluded from the teaser by decision. Confirm the corresponding process assumption: price expectation reaches buyers through broker conversation or through BO-0002 outreach content rather than the document. If any other platform surface publishes an asking price, that surface — not this one — becomes the single source, and the two should not be allowed to disagree.
- Customer concentration bands: confirm the band thresholds to be used in the derived statement, and the minimum GL data quality and period coverage required before the system will derive rather than defer to broker entry.
- Override authority: who may override a confidentiality flag — any broker with deal access, or only the deal owner or a firm administrator? Given that an override is the only path to releasing a document containing a flagged identifying term, recommend restricting it to the deal owner and requiring the justification be retained permanently.
- Approval invalidation: this spec voids seller approval on any content change after approval. That is the control preventing a post-approval edit from reaching the market unreviewed, but it will create friction on small wording fixes. Confirm, or define a narrow class of change (formatting only) that preserves approval.
- Post-release inconsistency: when a later CIM publication changes a figure the released teaser already shows, should the system automatically withdraw the released teaser from BO-0002 distribution, or only flag it for the broker to act on? Automatic withdrawal is safer and more disruptive.
- Multiple teasers per deal: should a broker be able to maintain more than one active teaser (for example a strategic-buyer and a financial-buyer version), or is one active teaser per deal the v1 rule? Recommend one active teaser per deal, with versions rather than variants.
- PDF metadata and file name scanning is specified here because it is a common real-world leak — a file named with the company's name defeats an otherwise clean document. Confirm in scope, and decide the naming convention for released teaser files.
- Assumption to confirm: a teaser may be created and released with no CIM in existence, since the teaser precedes the CIM in a normal sell-side process. In that case financial figures bind to live QE-0004 data and freeze on release.
- Assumption to confirm: where multiple published CIM versions exist, the teaser binds to the most recent published version rather than to the version a given recipient may hold.
# 10. Acceptance Criteria
- A broker can create a teaser on a deal with no CIM, populate it, and release it, with financial figures bound to live QE-0004 data and frozen on release with a teaser as-of date.
- Where a published CIM version exists, teaser financial figures match that version's frozen snapshot exactly and display the same as-of date; where several exist, the most recent published version is used.
- No teaser financial figure can be edited manually through any UI path.
- CIM content is never written into a teaser field without explicit broker acceptance, and a suggestion containing an identifying term shows that term flagged before acceptance.
- Accepted suggestion text is independent thereafter: editing the source CIM block does not change the teaser field.
- Every narrative field enforces its character limit, and a teaser rendering to more than two pages cannot be released.
- Industry cannot be set to a taxonomy node below the configured minimum breadth level, and no free-text industry or end-market value can be entered.
- No location field accepts or renders a city, street address, or postal code; region resolves only to a region or metropolitan area.
- The rendered teaser shows an employee band and a rounded or banded tenure, and never an exact headcount or founding year.
- The customer concentration statement is derived from GL data as a banded qualitative statement, contains no customer name and no per-customer percentage, and cannot be edited to introduce a customer name.
- Where GL data is insufficient, the concentration statement falls back to broker entry and the broker is told derivation was unavailable.
- The identifying-term list is auto-populated with the company's legal and trade names, top customer names, website and email domains, address components, and any key personnel on the deal record, and broker additions and removals are audited.
- Placing the company's legal name inside any narrative field produces a scan flag, and release is blocked while that flag is unresolved.
- A flag can be cleared either by editing the text or by an override requiring a typed justification, and the override is logged with user, timestamp, term, field, and justification.
- Creating a new teaser version re-runs the scan from scratch, and overrides recorded on a prior version do not suppress the same flag on the new version.
- The scan checks the exported PDF's file name and document metadata, and an export whose file name contains an identifying term is not produced.
- “Preview as recipient” renders the teaser with no internal indicator, lineage, scan marking, or platform element present, and a pre-release export is watermarked DRAFT on every page.
- The teaser offers no image upload capability, and no business photograph appears in any rendered output.
- No asking price, valuation, multiple, or price expectation field exists on the teaser, and no such value appears in any rendered or exported output.
- Release is blocked until a designated company/seller user approves the version, and any content change after approval invalidates it and requires re-approval.
- On release the version becomes immutable, freezing the render, financial snapshot and as-of date, scan results and overrides, and approval record, and it is made available to BO-0002 for distribution.
- Releasing a new version marks the prior released version superseded in BO-0002 while the prior version remains retrievable.
- Publishing a CIM version whose figures differ from a released teaser flags that teaser as inconsistent and prompts a new version, without altering the released version.
- No suppressed value — company name, address, website, customer name, exact headcount, exact founding year — appears in any client-delivered payload, file, or metadata for a released teaser, and the identifying-term list is not exportable or retrievable through any recipient-facing surface.
- Every teaser creation, content change, suggestion acceptance, term list change, scan run, override, approval, approval invalidation, release, supersession, export, and archive event appears in the Activity & Audit Log (SY-0003).
- A user without assigned role/deal access cannot view the teaser at any status, its fields, its term list, its scan results, or its versions, and a buyer or outreach recipient cannot reach any of these under any circumstance.

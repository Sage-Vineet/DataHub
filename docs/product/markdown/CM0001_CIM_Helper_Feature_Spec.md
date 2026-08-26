CENTURIUUM
Feature Specification

| Feature ID | CM - 0001 |
|---|---|
| Feature Name | CIM Helper |
| Module | CM - CIM |
| Status | Draft |
| Related / Recycled IDs | N/A |
| Author | Valentin Secchi |
| Date | August 17, 2026 |

# 1. Purpose & Business Context
The Confidential Information Memorandum (CIM) is the primary marketing document a broker places in front of buyers, and today it is built entirely outside any system — in PowerPoint, by hand, with financial figures retyped out of Excel. That manual retyping is where CIMs break: figures drift from the underlying books, the Adjusted EBITDA presented to buyers does not tie to the QoE add-back schedule, and every period refresh means rebuilding charts from scratch. CM-0001 moves CIM production inside Centuriuum so the financial section is generated directly from platform data — QoE-adjusted P&L figures, the SDE/EBITDA bridge (QE-0004), and GL-derived revenue analytics (DB-0002) — with zero manual number entry, while qualitative content is collected from broker and seller through a structured questionnaire that maps to slides. The output is a versioned, brand-consistent deck exported to PDF and PowerPoint and published into the data room as a tracked document, so buyer access control, watermarking, and view tracking apply to the CIM exactly as they do to every other deal document. The competitive value of this feature concentrates in the financial exhibits: they must be accurate, must tie to the platform's own QoE output, and must never require a broker to type a number.
# 2. User Stories
One story per user type that touches this feature. Format: "As a [role], I want to [action], so that [benefit]."
- As a broker, I want to assemble a CIM from a default section outline and a library of financial exhibits, so that I can produce a complete, professional deck without starting from a blank PowerPoint file.
- As a broker, I want every financial slide populated directly from the platform's own data, so that the figures I present to buyers tie to the QoE and I never retype a number.
- As a broker, I want firm branding applied automatically to every CIM, so that output is consistent across my team without anyone rebuilding a template.
- As a broker, I want to publish the finished CIM into the data room, so that buyer access, watermarking, and view tracking are handled by the platform rather than by email.
- As a company/seller user, I want to answer a guided questionnaire per CIM section, so that I can contribute the qualitative content about my business without facing a blank slide.
- As a company/seller user, I want to review and formally approve the CIM before it is released, so that I have signed off on the representations made about my business.
- As an accountant / QoE preparer, I want CIM financial exhibits bound to the adjusted figures I have already reconciled, so that the marketing document and the QoE deliverable cannot disagree.
- As a buyer, I want to access the current published CIM through the data room, so that I am always reading the version the broker intends me to see.
- As a platform administrator, I want every publish, export, and approval event logged, so that we can prove exactly which version of the CIM a given buyer received and when.
# 3. Functional Requirements
Numbered, testable statements the dev team can build against directly. Avoid prose — each line should be independently verifiable.
- The system shall allow a broker to create one or more CIM documents per deal, each with a name and a status of Draft, In Review, Seller Approved, Published, or Archived.
- Each CIM shall be assembled from an ordered list of slides belonging to one of two classes: System Financial Exhibits (data-bound, layout-locked) and Qualitative Slides (user-authored).
- The system shall provide a default CIM section outline on creation — Executive Summary, Business Overview, Products & Services, Market & Competition, Customers, Operations & Facilities, Management & Employees, Growth Opportunities, Financial Summary, Transaction Overview, Appendix — which the broker may reorder, rename, or remove.
- The broker shall be able to add, delete, duplicate, and reorder slides within a CIM.
- Financial exhibit slides shall be layout-locked: the user may configure exhibit parameters (period, granularity, chart type, units, anonymization) but shall not move, resize, or directly edit any rendered figure or label.
- Qualitative slides shall use a block-based canvas supporting slide title, body text with bold/italic/bullets, one- and two-column layouts, image blocks, and a simple table block. Free-form absolute positioning of elements shall not be supported.
- The system shall warn the user when text entered in a block exceeds the space available in the rendered layout, rather than silently truncating or overflowing the page.
- The system shall provide a financial exhibit library at launch covering three groups: Core Earnings, Revenue Analytics, and Balance Sheet & Cash.
- Core Earnings exhibits shall include: (a) a multi-year Revenue / Gross Profit / Adjusted EBITDA trend; (b) a normalized P&L summary covering annual periods plus TTM with a common-size (% of revenue) presentation; and (c) an Adjusted EBITDA and SDE bridge including the supporting add-back schedule detail.
- Revenue Analytics exhibits shall include: (a) customer concentration showing the top 10 customers by revenue with each customer's percentage of total revenue; (b) revenue by product/service line; (c) revenue by location/segment; and (d) monthly revenue seasonality with a trailing-twelve-month trend.
- Balance Sheet & Cash exhibits shall include: (a) balance sheet summary; (b) net working capital trend; (c) capital expenditure history; (d) debt schedule; and (e) accounts receivable and accounts payable aging summary.
- Each financial exhibit shall bind to QoE-adjusted figures (QE-0004 and the adjusted P&L) where those exist for the selected period.
- Where no QoE adjustment exists for the selected period, the exhibit shall bind to reported GL-derived figures from RP-0001 and shall display an explicit “reported basis — unadjusted” indicator on the slide.
- The system shall not permit manual override of any figure rendered by a financial exhibit. Corrections shall be made at the source (GL ingestion, COA mapping, or the QoE add-back schedule) and the exhibit re-rendered.
- The broker shall set a CIM-level reporting period default consisting of a fiscal year range and a TTM cutoff date, which all financial exhibits inherit.
- An individual exhibit shall be able to override the deck-level reporting period.
- Where any exhibit's period differs from the deck-level default, the system shall display a deck-level consistency warning identifying each differing exhibit.
- The broker shall set deck-level presentation conventions applied uniformly to all financial exhibits: currency units (actual / thousands / millions), decimal places, and negative-number format.
- Where an exhibit requires a data dimension not present in the ingested data (for example product line, location, or customer), the system shall render the exhibit as unavailable with a message naming the missing dimension, and shall not render an empty or partially populated chart.
- Financial exhibits shall re-render against current platform data each time the CIM is opened while its status is Draft or In Review.
- On publish, the system shall freeze a rendered snapshot of every financial exhibit into the published version, stamped with a financial “as of” date, so that figures already presented to buyers cannot change retroactively.
- Where underlying source data changes after a version is published (GL re-ingestion, add-back edits, or COA remapping), the system shall flag the published CIM as “source data changed — republish to update” without altering the published version.
- For each financial exhibit, the system shall display to internal users the source lineage (originating feature ID and adjusted/reported basis). This lineage shall not be printed on buyer-facing output.
- Each CIM shall have a deck-level Anonymize toggle.
- When Anonymize is enabled, the system shall suppress the company's legal and trade name and logo, substituting a broker-defined descriptor (for example “Midwest HVAC Services Company”).
- When Anonymize is enabled, the system shall relabel identifying data within financial exhibits — customer names shall render as “Customer A / B / C…” in descending revenue order, and specific locations shall render as a generalized region.
- The broker shall be able to override any system-generated anonymous label, and those overrides shall persist across exhibit re-renders.
- Anonymize state shall be stored as an attribute of each published version, and the version list shall indicate which versions were published in anonymized form.
- Toggling Anonymize shall not alter underlying platform data or any previously published version.
- The system shall provide a structured questionnaire organized by CIM section, whose responses map to defined content blocks on the corresponding qualitative slides.
- The broker shall be able to assign the questionnaire, in whole or by individual section, to a company/seller user for completion.
- Submitted questionnaire responses shall populate their mapped slide blocks, after which the broker may edit the content on the slide directly.
- Where a broker has edited a slide block populated from the questionnaire, a later questionnaire edit shall not overwrite that block without explicit user confirmation.
- The system shall display questionnaire completion status per section (Not started / In progress / Submitted) and identify which CIM slides remain unpopulated.
- The broker shall be able to populate image blocks either by selecting an existing document/image from the deal's data room (DR-0001) or by direct upload.
- A firm-level CIM theme — logo, color palette, heading and body typeface, cover layout, footer text, and confidentiality legend — shall be configured once per brokerage and inherited by every CIM created under that firm.
- The broker shall be able to override the cover image for an individual CIM. No other theme element shall be overridable at deck level in v1.
- All slides, financial and qualitative, shall render using the inherited firm theme, and financial exhibit chart colors shall derive from the firm palette.
- The system shall auto-generate the cover page, table of contents, page numbers, footer, and confidentiality legend on every page of the rendered document.
- CIM status shall progress Draft → In Review → Seller Approved → Published, and Published versions shall be immutable.
- A CIM shall not be publishable until a designated company/seller user has recorded approval of that specific version's content.
- Seller approval shall be recorded with the approving user's identity, a timestamp, and the version approved.
- Editing a Published CIM shall create a new Draft version, and all prior published versions shall remain retrievable.
- The system shall maintain a version history per CIM showing version number, status, publish date, anonymize state, financial “as of” date, and publishing user.
- The system shall prevent two users from editing the same CIM simultaneously by applying an edit lock and displaying the identity of the lock holder to any other user attempting to edit.
- The system shall export the CIM to PDF, rendered server-side, visually consistent with the on-screen deck and including cover, table of contents, page numbers, footer, and confidentiality legend.
- The system shall export the CIM to editable PowerPoint (.pptx), with financial exhibits as native editable tables and charts, qualitative slides as editable text and image objects, and the firm theme applied.
- Exports taken while the CIM status is Draft or In Review shall be watermarked “DRAFT — NOT FOR DISTRIBUTION” on every page.
- Every financial exhibit shall carry a visible “prepared from Centuriuum platform data — as of [date]” attribution line in both PDF and .pptx output.
- Only users holding the Broker role shall be permitted to export .pptx.
- On publish, the system shall write the rendered PDF into the deal's data room (DR-0001) as a tracked document, inheriting data room access control, per-buyer watermarking, and view/download tracking.
- Publishing a new version shall supersede the prior CIM document in the data room while retaining prior versions in accordance with the platform document versioning convention.
- The system shall log to the Activity & Audit Log (SY-0003): CIM created, questionnaire assigned, questionnaire submitted, seller approval recorded, version published, export generated (with format, version, and user), and any change to the Anonymize state.
- .pptx export events shall be logged and flagged distinctly, on the basis that the exported deck is editable outside the platform and its figures can subsequently diverge from the platform record.
# 4. Data Requirements
What tables/fields does this feature read from or write to? Reference the relevant Database module table blocks (DB-0001 through DB-0010) wherever applicable so every feature traces back to the reconciled data structure.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| CIM document, slide list, and slide content blocks | Write | New CIM-module table block — no DB-0001 to DB-0010 block currently reserved for CIM content (see Open Questions) |
| CIM version snapshots (frozen exhibit renders, “as of” date, anonymize state) | Write | New CIM version table; referenced by the data room document record on publish |
| QoE-adjusted P&L / normalized financials | Read | QoE module adjusted P&L; primary binding for Core Earnings exhibits |
| SDE / Adjusted EBITDA bridge and add-back schedule | Read | QE-0004 — SDE/EBITDA Tab |
| Reported P&L (unadjusted) | Read | RP-0001 — Profit & Loss; fallback basis where no QoE adjustment exists |
| GL transaction detail (date, account, amount, customer) | Read | DB-0002 — GL Data; source for customer concentration and monthly seasonality exhibits |
| Chart of Accounts, hierarchy and rollups | Read | DB-0003 — Chart of Accounts; DB-0006 / DB-0007 — hierarchy configuration and rollups, used to group exhibit line items |
| Trial balance / balance sheet data | Read | DB-0004 — Trial Balance; source for balance sheet summary and net working capital trend |
| Product line / location / segment dimension | Read | Not present in the DB-0002 standard field set (explicitly deferred there) — source unresolved, see Open Questions |
| Debt schedule, capital expenditure history, AR/AP aging | Read | Source unresolved — not clearly carried in DB-0002 standard fields; may derive from DB-0004 or require a supporting-schedule input (see Open Questions) |
| Questionnaire definitions and seller responses | Write | New CIM questionnaire tables, scoped to the deal |
| Anonymization label map and broker overrides | Write | New CIM-scoped label override table |
| Company and deal profile (name, industry, locations, anonymous descriptor) | Read | Deal / company record |
| Firm-level CIM theme configuration | Read | Brokerage/firm settings — owned by the admin console (cross-cutting gap) |
| Image and photo assets used on qualitative slides | Read | DR-0001 — Core Data Room, or direct upload into the deal |
| Published CIM PDF | Write | DR-0001 — Core Data Room, stored as a tracked document subject to buyer permissions, watermarking, and view tracking |
| Seller approval record | Write | CIM version table, and SY-0003 — Activity & Audit Log |
| Lifecycle, export, and anonymization events | Write | SY-0003 — Activity & Audit Log |

# 5. Access & Security
Confirm roles and deal isolation explicitly on every spec — never assume it.
- Roles with access: Broker (deal owner/admin) — full create, edit, configure, export, and publish rights; Company / Seller user (as granted by the broker) — questionnaire completion, read access to draft content, and version approval; Accountant / QoE preparer — read access to the CIM and its financial exhibit bindings, no publish rights.
- Roles explicitly excluded: Buyer — no access to the CIM builder, the questionnaire, or any unpublished version under any circumstance. Buyer access is limited to the published CIM PDF delivered through the data room, governed by DR-0001 permissions and per-buyer watermarking. Bank — no access to the CIM builder; may receive a published CIM only if separately granted through the data room post-underwriting (BK-0001).
- Only the Broker role may export .pptx, on the basis that the exported file leaves the platform's audit boundary.
- Anonymization enforcement: for any version published in anonymized form, the system shall not expose the true company name, logo, or true customer names through any slide render, PDF, .pptx export, or API response served in the context of that version. Anonymization shall be enforced server-side at render time, not by client-side masking.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. A CIM, its slides, questionnaire responses, exhibit bindings, image assets, anonymization label map, and version history are visible only within their own deal. There is no cross-deal or cross-company visibility, and no cross-deal reuse of CIM content or templates in v1.
# 6. UI / UX Notes
Layout, interaction notes, or wireframe reference. State platform scope explicitly per feature.
- Platform: Web only. CIM building, questionnaire administration, configuration, export, and publishing are web-only. Consumption of the published CIM PDF is mobile-capable through the existing data room document viewer; no CIM editing or approval on mobile in v1.
- Wireframe reference: N/A
The editor should use a three-pane layout: a left slide navigator showing thumbnails grouped by CIM section with per-slide completion indicators; a center slide canvas; and a right context panel that shows exhibit parameters when a financial slide is selected and block properties when a qualitative slide is selected. A persistent top bar carries the deck status chip, the deck-level reporting period, the Anonymize toggle, and Preview / Export / Publish actions.
Financial exhibits must visually announce that they are system-generated and locked — a data-bound badge showing the source basis (Adjusted or Reported) and the period — so a broker never wonders why a number cannot be typed over. The reported-basis indicator should be visually distinct enough that a broker notices before publishing an unadjusted exhibit by accident.
A pre-publish “deck health” panel should consolidate everything blocking a clean release in one place: unpopulated qualitative slides, exhibits unavailable due to a missing data dimension, exhibits whose period differs from the deck default, stale-source flags, and outstanding seller approval. The broker should never have to click through every slide to discover the deck is not ready.
The questionnaire is a separate task-style surface rather than part of the slide canvas, so a seller can complete it without being exposed to the deck layout or to financial exhibits still in progress.
# 7. Dependencies
Upstream features that must exist first. This is the single most valuable section for sequencing the build.

| Related Feature | Relationship | Notes |
|---|---|---|
| QE-0004 — SDE/EBITDA Tab | Depends on | Primary source for Adjusted EBITDA, SDE, and the add-back schedule detail rendered in the Core Earnings exhibits. |
| RP-0001 — Profit & Loss | Depends on | Reported-basis fallback for all P&L-derived exhibits where no QoE adjustment exists. |
| DB-0002 — GL Data | Depends on | Transaction-level source for customer concentration, monthly seasonality, and TTM calculations. |
| DB-0003 / DB-0006 / DB-0007 — Chart of Accounts, hierarchy, rollups | Depends on | Determines how exhibit line items are grouped and labeled; unmapped accounts will surface as exhibit exceptions. |
| DB-0004 — Trial Balance | Depends on | Source for balance sheet summary and net working capital trend exhibits. |
| DR-0001 — Core Data Room | Depends on | Stores image assets used on qualitative slides, and receives the published CIM PDF as a tracked document with buyer permissions, watermarking, and view tracking. |
| SY-0003 — Activity & Audit Log | Depends on | All lifecycle, approval, publish, and export events must be logged. Platform-wide audit trail is a known cross-cutting gap. |
| Admin console / firm settings (cross-cutting gap) | Depends on | Owns firm-level CIM theme configuration — logo, palette, typeface, cover layout, footer, confidentiality legend. Not solved locally in this spec. |
| Notifications hub (cross-cutting gap) | Depends on | Questionnaire assignment, approval requests, and stale-source alerts all require notification delivery. Not solved locally in this spec. |
| Document versioning (cross-cutting gap) | Depends on | Governs how a newly published CIM supersedes the prior version in the data room while retaining history. |
| Legal / compliance (cross-cutting gap) | Depends on | Owns confidentiality legend and CIM disclaimer language applied to every rendered page. |
| Onboarding (cross-cutting gap) | Related | Seller intake may already capture business overview content the CIM questionnaire would otherwise re-ask; overlap must be reconciled. |
| E-signature (cross-cutting gap) | Related | Seller approval is recorded as a platform action in v1, not a signed document. If approval must be signed, it routes through the e-signature convention. |
| AI narrative drafting (Feature ID to be confirmed) | Related | Out of scope here; would consume questionnaire responses and financial context to draft qualitative slide narrative. |
| Teaser / blind profile (Feature ID to be confirmed) | Related | Confirm whether a separate teaser feature exists in the product list; if so, it should reuse this feature's anonymization layer rather than duplicating it. |

# 8. Out of Scope / Deferred
- Free-form slide authoring — absolute element positioning, arbitrary shapes, z-order control, and general PowerPoint-equivalent editing are explicitly not built. Qualitative slides use a constrained block canvas.
- AI-generated or AI-polished narrative content — covered by a separate feature; referenced here as a dependency only.
- Forward-looking and operational exhibits — projections/forecast slides, custom KPI dashboard slides, and headcount/payroll summary are deferred from the v1 exhibit library.
- Teaser or one-page blind profile generation — handled by a separate feature; this spec provides the anonymization layer such a feature would reuse.
- Slide-level comments and real-time multi-user co-editing — v1 uses a single-editor lock; commenting is deferred to a platform-wide collaboration convention rather than solved locally here.
- Broker-savable custom CIM templates and cross-deal content or template reuse — v1 supports firm-level theming only.
- Manual override of any system-generated financial figure — corrections are made at source, never on the slide.
- Multi-entity consolidation and multi-currency presentation — consistent with the deferral already recorded in DB-0002.
- Direct email distribution of the CIM from within the platform — distribution occurs through the data room.
- Buyer-side CIM annotation, Q&A, or in-document questions.
- Industry-specific CIM template variants and industry benchmark comparison exhibits.
# 9. Open Questions
- Reference file access: the project knowledge files (Centuriuum_Product_List.xlsx, Centuriuum_Spec_Conventions_and_Decisions.docx, Centuriuum_Feature_Spec_Template.docx) could not be read when this spec was drafted. Confirm the exact Module label for CM, the correct Feature ID formatting, and whether any Related / Recycled IDs apply — and confirm nothing here contradicts a locked decision in the conventions doc.
- Data home for CIM content: DB-0001 through DB-0010 appear to be financial data table blocks. Where do CIM documents, slides, content blocks, version snapshots, questionnaire responses, and anonymization label maps live — a new DB block, or a table block owned by the CM module outside the DB numbering?
- Source for Balance Sheet & Cash exhibits: the debt schedule, capital expenditure history, and AR/AP aging summary are selected for v1, but it is not clear these are derivable from the DB-0002 standard field set. Are they derived from DB-0004, extracted from separate supporting schedules the seller uploads, or pulled from a QoE workpaper? This is a build blocker for three of the five exhibits in that group.
- Dimensional exhibits: revenue by product/service line and revenue by location/segment depend on GL dimensions that DB-0002 explicitly defers (class, department, location). Do we (a) cut these two exhibits from v1, (b) expand the DB-0002 standard field set to carry them, or (c) support a broker-maintained account-to-segment mapping local to the reporting layer?
- Fully editable .pptx export creates an untracked fork: a broker can change Adjusted EBITDA in PowerPoint and send that file to a buyer with no platform record. Confirm this risk is accepted as specified, or decide whether financial exhibits should export as locked images instead of native editable objects. The “prepared from Centuriuum platform data — as of [date]” attribution line mitigates but does not prevent this.
- Approval authority: is any company user with deal access permitted to record seller approval, or must a specific named seller/signatory be designated at deal setup? And may a broker waive or override the approval gate on a time-pressured deal — if so, is that waiver itself an audited event?
- Questionnaire overlap with onboarding: if platform onboarding already collects business overview, ownership, and management information, the CIM questionnaire should read from it rather than re-ask the seller. Confirm the boundary once the onboarding gap is resolved.
- Confidentiality legend and CIM disclaimer language: firm-editable free text, or platform-controlled boilerplate reviewed by counsel? Recommend platform-controlled with firm-level fields, but this is a legal/compliance decision.
- Anonymized customer label stability: should the “Customer A / B / C” assignment be locked at first publish so labels stay stable across versions, or re-derived on each render? Re-deriving means Customer A in version 1 may be a different company in version 2, which is confusing and potentially misleading to a buyer comparing versions.
- QoE tie-out enforcement: should publishing be hard-blocked by a reconciliation check confirming the CIM's Adjusted EBITDA ties exactly to the current QoE deliverable, or is shared data binding considered sufficient assurance?
- Assumption to confirm: brokers may create multiple CIMs per deal (for example an anonymized version and a named version, or variants for different buyer types). Confirm this is intended, or restrict to a single active CIM per deal.
- Output constraints: is there a maximum page count or file size for the rendered PDF, and does the data room impose a document size limit that CIM output must respect?
# 10. Acceptance Criteria
- A broker can create a CIM, receives the default section outline, and can reorder, rename, and remove sections and slides.
- Adding the Core Earnings exhibits renders Revenue, Gross Profit, and Adjusted EBITDA trend plus the SDE/EBITDA bridge with figures that tie exactly to QE-0004 for the same period, with no manual number entry at any point.
- Where no QoE adjustment exists for a selected period, exhibits render on reported basis from RP-0001 with a visible unadjusted indicator on the slide.
- Changing the deck-level reporting period updates every inheriting exhibit; setting an exhibit-level override triggers the deck consistency warning naming that exhibit.
- An exhibit requiring an absent data dimension renders as unavailable with a message naming the missing dimension, and never renders an empty or partially populated chart.
- Attempting to edit a figure on a financial exhibit is not possible through any UI path.
- Enabling Anonymize suppresses company name and logo, substitutes the broker descriptor, and relabels the top 10 customers as Customer A/B/C in descending revenue order; broker label overrides persist across a re-render.
- A published anonymized version exposes no true company or customer name through the slide render, PDF, .pptx export, or any API response.
- A questionnaire assigned to a seller user, once submitted, populates the mapped qualitative slide blocks; a subsequent questionnaire edit does not overwrite a broker-edited block without explicit confirmation.
- Firm theme is applied automatically to all slides, and cover page, table of contents, page numbers, footer, and confidentiality legend are auto-generated on every page.
- Publish is blocked until seller approval is recorded for that version, and the stored approval includes approving user, timestamp, and version number.
- A published version's financial exhibits are frozen with an “as of” date; re-ingesting GL data afterward flags the CIM as stale without changing any figure in the published version.
- The published PDF appears in the data room as a tracked document, with data room access control, per-buyer watermarking, and view/download tracking applied.
- An export taken in Draft or In Review status is watermarked “DRAFT — NOT FOR DISTRIBUTION” on every page.
- The .pptx export opens in PowerPoint with the firm theme applied, editable qualitative text and images, and native financial tables and charts.
- A second user attempting to edit a CIM already open for editing is blocked and shown the identity of the lock holder.
- Every CIM created, questionnaire assigned and submitted, approval recorded, version published, export generated, and Anonymize state change appears in the Activity & Audit Log (SY-0003) with user and timestamp.
- A user without assigned role/deal access cannot view the CIM, its questionnaire responses, its drafts, or any published version, and a buyer cannot access any unpublished version under any circumstance.

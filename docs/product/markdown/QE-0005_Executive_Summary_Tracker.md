CENTURIUUM
Feature Specification

| Feature ID | QE - 0005 |
|---|---|
| Feature Name | Executive Summary / Tracker |
| Module | QE - Quality of Earnings |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 15, 2026 |

# 1. Purpose & Business Context
The Executive Summary / Tracker is the landing view for a Quality of Earnings engagement, giving the paying user (and anyone they choose to grant access to) a single place to see engagement-level status and a rollup of the narrative content built across the QoE module. It answers two questions at a glance: “where am I in this engagement?” and “what does the story of this company's financial performance look like right now?” It surfaces deal-level metadata (industry, location, client name), a completion tracker across QoE sub-modules, and mirrored narrative summaries (Adjusted EBITDA/SDE, Bank Statement Review, Tax Return Reconciliation, Working Capital, and Risks & Opportunities) that are authored at their source tab and reflected here for at-a-glance review and light editing.
A developer with no M&A background should understand: a Quality of Earnings (QoE) engagement recasts a company's historical financials to determine a normalized, ongoing level of earnings (Adjusted EBITDA or Seller's Discretionary Earnings/SDE) used to value the business in an M&A transaction. This feature does not perform that recasting itself — it summarizes and narrates results that are calculated and stored elsewhere (see Section 7, Dependencies).
# 2. User Stories
- As the QoE provider (the paying user), I want to see a single tracker of engagement completion status, so that I know what remains before I can deliver the engagement.
- As the QoE provider, I want an AI-drafted narrative summarizing profit and revenue changes over the period, so that I don't have to hand-write the executive summary from scratch.
- As the QoE provider, I want to expand, summarize, or manually edit any AI-drafted narrative and have my edits saved, so that the final language matches my voice and judgment.
- As a broker or other user granted view access, I want to see the Executive Summary without being able to edit it, so that I can check engagement status without needing full QoE module access.
- As the QoE provider, I want narrative sections to cite specific Q&A entries that explain a financial change, so that the reader can trace a claim (e.g., “sales doubled”) back to its source.
# 3. Functional Requirements
- The system shall display engagement-level metadata at the top of the Executive Summary: industry, location, and client name, sourced from the company/deal profile.
- The system shall display a completion tracker (checklist or status indicator) showing the status of each QoE sub-module: Tax Reconciliation (QE-0001), Bank Statement Review (QE-0003), SDE/EBITDA Tab (QE-0004), Working Capital (QE-0006), and Risks & Opportunities (QE-0007).
- The system shall represent each sub-module's status using at minimum the states: Not Started, In Progress, Complete.
- The system shall allow the user to navigate directly from a tracker item to the corresponding QoE sub-module tab.
- The system shall display an AI-generated narrative describing the change in revenue, margin, and Adjusted EBITDA/SDE over the reviewed period, sourced from stored flux analysis figures and the adjusted P&L conceptualization maintained in QE-0004; the system shall not have the AI recalculate any financial figures.
- The system shall allow the AI-generated narrative to cite specific Q&A entries (e.g., inline citation tag) where a Q&A response explains a financial change, using the citation/traceability pattern established in QA-0002.
- The system shall provide a control (“wizard”) allowing the user to request the AI narrative be expanded (more detail) or condensed (shorter summary) on demand.
- The system shall allow the user to directly edit any AI-generated narrative text and save the user's changes as the authoritative version.
- The system shall persist the most recent saved version of each narrative (AI-drafted or user-edited) as the version displayed by default.
- The system shall display a mirrored summary for the Bank Statement Review, sourced from and kept in sync with the summary maintained on the QE-0003 tab.
- The system shall display a mirrored summary for the Tax Return Reconciliation, sourced from and kept in sync with the summary maintained on the QE-0001 tab.
- The system shall display a mirrored summary for Working Capital, sourced from and kept in sync with the summary maintained on the QE-0006 tab.
- The system shall ensure that editing a mirrored summary from the Executive Summary updates the same underlying record shown on its source tab, and vice versa (single source of truth per summary, not a duplicated copy).
- The system shall display a Risks & Opportunities section reflecting entries stored in QE-0007, including both AI-drafted (context-file-informed) and user-authored entries.
- The system shall allow the user to upload one or more context files (e.g., firm narrative style guide, prior engagement examples) that inform AI narrative tone and framework at the QoE-module level.
- The system shall exclude non-EBITDA/SDE-relevant add-back detail (e.g., officer wage add-backs) from the narrative discussion, since narrative commentary discusses the business at a normalized/net Adjusted EBITDA or SDE basis, not individual add-back line items.
- The system shall use the term “the company” rather than “the seller” in all AI-generated and template narrative language.
- The system shall allow the Executive Summary to be viewed by any user granted access per SE-0002, independent of whether that user has edit rights to the underlying QoE tabs.
- The system shall restrict narrative editing (AI wizard actions, manual edits, context file uploads) to users with edit-level access to the QoE module, as governed by SE-0002.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Engagement metadata (industry, location, client name) | Read | DB - 0001 Company Profile / Deal record |
| Adjusted EBITDA / SDE narrative (text, version) | Read / Write | QE - 0004 SDE/EBITDA Tab (adjusted P&L values); narrative text stored at QE - 0005 level |
| Flux analysis figures (revenue/margin deltas by period) | Read | RP - 0001 Reports (P&L); DB - 0007 GL detail |
| Bank Statement Review summary (text, version) | Read / Write | QE - 0003 Bank Statement Review tab |
| Tax Return Reconciliation summary (text, version) | Read / Write | QE - 0001 Tax Reconciliation tab |
| Working Capital narrative (text, version) | Read / Write | QE - 0006 Working Capital tab |
| Risks & Opportunities entries | Read / Write | QE - 0007 Risks and Opportunities (shared store) |
| Q&A citations referenced in narratives | Read | QA - 0001 / QA - 0002 Q&A module |
| Module completion status flags (per tab) | Read / Write | QE module tabs (QE - 0001, 0003, 0004, 0006, 0007) |
| Access grants (who can view this engagement summary) | Read | SE - 0002 Access Control |

# 5. Access & Security
- Roles with access: QoE provider/paying user (full edit access); Broker, Company, Buyer, Accountant, or Bank user roles — view-only access if explicitly granted via SE-0002 module/tab-level grant.
- Roles explicitly excluded: any role not explicitly granted view access to the QoE module/tabs under SE-0002; default visibility is limited to the paying QoE user.
- Edit access (narrative wizard, manual edits, context file uploads, tracker status overrides) is restricted to users with QoE module edit-level grants; view-only grantees see a read-only rendering of the same page.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web + Mobile (light) — full narrative editing and the AI wizard are web-only; mobile supports viewing engagement status and summaries (consistent with the general mobile scope defined in conventions).
- Wireframe reference: N/A — Josh to provide reference from existing QoE workbook example.
Layout is a single scrollable page: engagement metadata banner at top, completion tracker/checklist immediately below, followed by narrative sections in this order — Adjusted EBITDA/SDE Narrative, Bank Statement Review Summary, Tax Return Reconciliation Summary, Working Capital Narrative, Risks & Opportunities.
Each narrative section presents the current saved text with an inline “Wizard” affordance (expand / summarize / regenerate) available wherever edit access exists; the same wizard also appears on the corresponding source tab (QE-0001, QE-0003, QE-0004, QE-0006) so the user can make quick adjustments without leaving that tab.
Q&A citations render as clickable inline tags (e.g., [QA-014]) that jump to the referenced Q&A entry, consistent with the QA-0002 citation pattern.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| QE - 0001 Tax Reconciliation | Depends on | Tax return reconciliation summary mirrors content from this tab |
| QE - 0003 Bank Statement Review | Depends on | Bank statement review summary mirrors content from this tab |
| QE - 0004 SDE/EBITDA Tab | Depends on | Adjusted EBITDA/SDE values and adjusted P&L conceptualization live here; narrative references these figures, does not recalculate them |
| QE - 0006 Working Capital | Depends on | Working capital narrative mirrors content from this tab |
| QE - 0007 Risks and Opportunities | Depends on | Risks & Opportunities section pulls from the shared store owned by this feature (separate spec) |
| QA - 0001 / QA - 0002 Q&A Module | Depends on | Narrative citations (e.g., referencing why sales changed) link to specific Q&A entries using the structured tagging/citation pattern established in QA - 0002 |
| RP - 0001 Reports | Depends on | Flux analysis (revenue/margin change data) is sourced from P&L reporting, not recalculated locally |
| SE - 0002 Access Control | Depends on | Module/tab-level grant model governs who can view this Executive Summary independent of Data Room access |
| AI Narrative Drafting Engine (shared/future capability) | Depends on | Not yet specced as its own feature; expand/summarize wizard and AI-authored narrative generation described here assume this shared engine exists. See Open Questions. |
| CM - 0001 / QE - 0014 PowerPoint Creator | Blocks | This summary is a likely source panel for slide-deck generation |

# 8. Out of Scope / Deferred
- Calculation of Adjusted EBITDA/SDE itself — owned by QE-0004; this feature only displays and narrates stored values.
- Design and data model of the Risks & Opportunities store itself — owned by QE-0007 (separate spec, per Josh).
- Design of the shared AI narrative drafting engine (prompt architecture, retrieval-pool bounding, model selection) — treated here as a dependency; to be formally specced as its own capability.
- PowerPoint/export generation of this summary — owned by CM-0001 / QE-0014 PowerPoint Creator.
- Workbook export of this summary — owned by QE-0013 Workbook Export.
- Customer/vendor concentration, AR/AP aging, and CIM comparison content — owned by their respective QE feature specs (QE-0008 through QE-0012), not summarized on this page unless a future revision adds them to the tracker.
# 9. Open Questions
- Where should the Adjusted EBITDA/SDE narrative canonically live — authored on the Executive Summary (as described by Josh) or on the QE-0004 SDE/EBITDA tab, with the Executive Summary purely mirroring it? Conventions require a single source of truth; a decision is needed before QE-0004 is specced.
- What are the exact tracker states and transition rules per sub-module (e.g., does “Complete” require explicit user sign-off, or is it inferred from data presence)?
- Is the shared AI narrative drafting engine (expand/summarize wizard, context-file ingestion) a standalone feature spec, or built once and referenced by every QoE narrative-bearing tab? Recommend specifying it as its own feature once QE-0001/0003/0004/0006 scope is finalized.
- Should context files uploaded for narrative tone/framework be scoped per-firm (Tonnesen Accounting Services-wide) or per-engagement?
- Does view-only access to the Executive Summary imply automatic view access to the underlying QoE tabs it mirrors, or can a user see the summary without being able to open the source tab? (Affects SE-0002 default permission matrix, currently an open question there as well.)
# 10. Acceptance Criteria
- A QoE provider with edit access can view engagement metadata, a completion tracker for all five QoE sub-modules, and all narrative sections on a single Executive Summary page.
- An AI-drafted Adjusted EBITDA/SDE narrative can be generated referencing stored flux analysis figures (not recalculated), including at least one Q&A citation where applicable, and can be expanded, summarized, manually edited, and saved.
- Editing a mirrored summary (Bank Statement Review, Tax Return Reconciliation, or Working Capital) from the Executive Summary updates the same record visible on its source QoE tab.
- A user granted view-only access via SE-0002 can view the Executive Summary but cannot access the AI wizard, manual edit controls, or context file upload.
- A user without any QoE module grant cannot view the Executive Summary for that deal.
- The completion tracker correctly reflects Not Started / In Progress / Complete status per sub-module and links through to each corresponding tab.

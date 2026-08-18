CENTURIUUM
Feature Specification

| Feature ID | QE - 0007 |
|---|---|
| Feature Name | Risk and Opportunities |
| Module | QE - Quality of Earnings |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 15, 2026 |

# 1. Purpose & Business Context
The Risk and Opportunities section (housed on the Executive Summary tab per QE-0005) gives the QoE reviewer a single, curated place to capture the risks and opportunities identified during an engagement, sourced from Q&A commentary, financial data patterns, and other qualitative or quantitative signals across the workbook. Rather than requiring the reviewer to manually re-read and summarize every Q&A thread and financial schedule, the system uses AI to draft candidate risk and opportunity narratives from a deliberately narrow, scoped context (not a scan of the entire data room), which the reviewer then reviews, edits, and approves before anything is included in the client-facing deliverable. This gives buyers, sellers, and lenders a defensible, well-supported view of the deal's key qualitative issues, each traceable back to its underlying source via inline citation links.
# 2. User Stories
- As a QoE reviewer (accountant), I want to click a button to generate AI-drafted risk and opportunity items based on Q&A responses and financial data, so that I don't have to manually re-derive them from scratch.
- As a QoE reviewer, I want AI to only draft items that are not already reflected on the list, so that I don't have to re-review duplicate suggestions every time I regenerate.
- As a QoE reviewer, I want to manually add my own risk or opportunity items, so that I can capture something I noticed independently of the AI's suggestions.
- As a QoE reviewer, I want to review, edit, approve, or reject each AI-drafted item individually, so that only vetted content reaches the deliverable.
- As a QoE reviewer, I want each item to link back to the specific Q&A response or financial data point that supports it, so that anyone reading the report can drill in and see exactly where the commentary came from.
- As a firm administrator, I want to set a firm-level default tone/style (e.g., more formal vs. more conversational) for generated narrative, so that all engagements start from a consistent house style.
- As an individual accountant, I want to override the firm's default tone/style setting for my own engagements, so that the output matches my personal drafting preference.
- As a buyer or lender reviewing the deliverable, I want to see only approved risk and opportunity items, so that I'm not shown unvetted draft commentary.
# 3. Functional Requirements
- The system shall display a Risk and Opportunities section within the Executive Summary tab (QE - 0005), organized as two lists: Risks and Opportunities.
- The system shall store each risk/opportunity item as a free-form narrative text block (not a discrete structured record of severity/category fields), with support for one or more inline citation links embedded within the narrative text.
- The system shall support inline citation links that reference a specific Q&A item (QA - 0001 / QA - 0002) or a specific financial data point/account/period (DB - 0002 through DB - 0004, or a QE tab such as QE - 0009 Customer Concentration).
- The system shall render inline citations as clickable links that navigate the user to the underlying source (the Q&A thread or the relevant financial schedule) in click-through fashion.
- The system shall provide a "Generate" action that, when clicked, invokes AI to draft new risk and/or opportunity items based on a scoped context window.
- The scoped context window for generation shall include, at minimum: Q&A responses and their structured Module/Section/Account tags (per QA - 0002), the SDE/EBITDA adjustment detail (QE - 0004), and relevant quantitative flags from financial data (DB - 0002 through DB - 0004) — the system shall not run generation against the full data room or unscoped document set.
- The system shall only generate items not already substantively represented on the current list (whether previously approved, rejected, or still pending), avoiding duplicate suggestions on repeated generation runs.
- The system shall treat all AI-generated items as "Pending" upon generation; a pending item shall not appear in any exported or client-facing deliverable until a user explicitly approves it.
- The system shall allow the reviewer to Approve, Reject, or Edit-then-Approve each pending item individually.
- The system shall allow the reviewer to manually add a new risk or opportunity item directly (bypassing AI generation), with the same support for inline citation links as an AI-generated item.
- The system shall allow the reviewer to edit or delete any item (AI-generated and approved, or manually added) at any time prior to final report lock.
- Rejected items shall be retained in a hidden/collapsed state (not deleted) so that a future generation run does not re-suggest the same item, and so the reviewer has an audit trail of what was considered and dismissed.
- The system shall support a configurable tone/style/verbosity setting (e.g., concise vs. wordy, casual vs. formal) with a firm-level default and an optional user-level override for AI-generated narrative drafting.
- The system shall apply the user's override setting when present, falling back to the firm default otherwise, and shall apply a system-defined default (documented as the platform's baseline style) when neither is configured.
- The system shall use "the company" terminology (never "the seller") in all AI-generated and template-provided narrative text, consistent with platform-wide QoE terminology conventions.
- The system shall log every generation event (who initiated, when, which items were produced) and every approval/rejection/edit event to the platform Activity & Audit Log (SY - 0003).
- The system shall meter each AI generation call against the platform's AI usage metering (SY - 0001).
- The system shall include only Approved items in any exported workbook (QE - 0013), PowerPoint deck (QE - 0014 / CM - 0001), or Valuation Summary commentary pull (VL - 0005).
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Risk/Opportunity Item (narrative text, rich text) | Read/Write | QE - 0007 native table |
| Item Status (AI-Suggested / Approved / Rejected / Manually Added) | Read/Write | QE - 0007 native table |
| Item Type (Risk / Opportunity) | Read/Write | QE - 0007 native table |
| Inline Citation Links (Q&A reference IDs) | Read | QA - 0001, QA - 0002 |
| Inline Citation Links (financial data reference, e.g. account/period) | Read | DB - 0002, DB - 0003, DB - 0004 |
| SDE/EBITDA Adjustment Detail (for context scoping, not displayed) | Read | QE - 0004 |
| Working Capital Commentary (for context scoping) | Read | QE - 0006 |
| Customer Concentration Data (for context scoping) | Read | QE - 0009 |
| Style/Tone Configuration - Firm Default | Read | SE - 0001 (firm-level settings) |
| Style/Tone Configuration - User Override | Read | US - 0004 (accountant profile settings) |
| Generation Event (who generated, when, which items produced) | Write | SY - 0003 Activity & Audit Log |
| Approval/Rejection Event (who approved/rejected, when) | Write | SY - 0003 Activity & Audit Log |

# 5. Access & Security
- Roles with access: Accountant/QoE reviewer (full read/write — generate, add, edit, approve, reject), Broker (read-only view of approved items, per deal permission grant), Company/Seller (read-only view of approved items, if and where the broker has granted visibility per SE - 0002).
- Roles explicitly excluded: Buyer and Bank users see only Approved items surfaced through downstream deliverables (e.g., CIM, valuation summary) they have been granted access to — they do not have direct access to the QE - 0007 working tab, pending items, or rejected items.
- Only users with QoE reviewer-level access (or higher) may trigger AI generation, approve, or reject items; view-only roles cannot alter item status.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results. AI generation context is limited strictly to the current deal's Q&A and financial data.
# 6. UI / UX Notes
- Platform: Web only.
- Wireframe reference: N/A (referencing Josh's Cloud project file structure stored in SharePoint as the design basis — to be linked once available).
The section presents two columns or stacked lists — Risks and Opportunities — each showing narrative-block items with inline citation links rendered as clickable text within the paragraph. Pending (AI-generated, unapproved) items are visually distinguished from Approved items (e.g., a "Pending" badge or highlighted background) so the reviewer never confuses draft content with finalized content. A single "Generate" button triggers AI drafting; a per-item action row (Approve / Reject / Edit) appears on each pending item. A "+ Add Item" control supports manual entry. Rejected items are collapsed by default under a "Dismissed" toggle rather than shown inline with active items.
Tone/style configuration is exposed as a settings control at the firm level (administrator settings, likely under SE - 0001 firm profile settings) and as a personal override at the individual user level (accountant profile, US - 0004), with the default clearly indicated as the well-supported system starting point (per Josh's direction) when neither is customized.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| QA - 0001 | Depends on | User-based tracking of Q&A requestor/requestee needed for citation attribution and traceability of source commentary. |
| QA - 0002 | Depends on | Q&A linking architecture (structured Module/Section/Account tagging) is the mechanism this feature relies on to scope Q&A context and generate inline citation links. |
| QE - 0004 | Depends on | SDE/EBITDA adjustment detail is a primary quantitative input to the context window used for AI-generated risk/opportunity drafting. |
| QE - 0006 | Depends on | Working capital commentary is a scoped input source for risk/opportunity generation. |
| QE - 0009 | Depends on | Customer concentration data is a scoped input source (e.g., customer concentration risk items) for generation. |
| QE - 0005 | Related | Executive Summary/Tracker houses this feature's tab; Risk and Opportunities is a sub-section of the Executive Summary area. |
| DB - 0002 / DB - 0003 / DB - 0004 | Depends on | Financial data (GL, COA, Trial Balance) is a scoped input source for identifying quantitative risk/opportunity flags. |
| VL - 0005 | Blocks | Valuation Summary / Football Field pulls a risk and opportunity commentary section from this feature to explain positioning within the concluded value range. |
| SE - 0001 | Depends on | Firm-level profile/settings framework is where the firm-default tone/style configuration is expected to live. |
| SY - 0001 | Depends on | AI metering must account for AI-generated draft calls from this feature. |
| SY - 0003 | Depends on | All generation, approval, and rejection actions must write to the platform Activity & Audit Log. |
| Notifications Hub (cross-cutting gap) | Depends on | No dedicated feature ID yet. Needed to notify the QoE reviewer when new AI-generated items are pending approval. |

# 8. Out of Scope / Deferred
- Structured/tagged risk categorization (e.g., a fixed taxonomy of risk categories or severity scoring) is out of scope for this version — items are free-form narrative only. A future spec may revisit structured tagging if reporting or analytics needs emerge.
- Automated scanning of the full, unscoped data room or all uploaded documents is explicitly out of scope — generation is limited to the defined context window (Q&A, financial data, related QoE tabs) described in Section 3.
- Multi-user real-time collaborative editing of items (e.g., simultaneous editing by two reviewers) is deferred; standard single-editor-at-a-time behavior is assumed for this version.
- A dedicated notification alerting the reviewer that new pending items are ready is dependent on the platform Notifications Hub (cross-cutting gap, no feature ID yet) and is not designed locally within this feature.
- Firm-level and user-level tone/style configuration UI itself (the settings screen where these preferences are set) is assumed to live within SE - 0001 / US - 0004 profile settings, not built as a standalone control within this feature.
# 9. Open Questions
- What does the "well-supported" system default tone/style actually consist of (e.g., a specific reading level, sentence length, or voice)? Josh's Cloud project file in SharePoint is referenced as the intended structure/basis for this default — needs to be reviewed and translated into a concrete default prompt/style specification before development.
- Should Rejected items be permanently excluded from future generation, or should there be a mechanism to "un-reject" / resurface an item if circumstances change later in the engagement?
- Is there a limit on how many items can be generated per click (e.g., top 5 candidate items per run), or does the system return all items it identifies within the scoped context in a single pass?
- Should approved items support versioning/edit history (e.g., if a reviewer edits an already-approved item, should the prior approved version be retained), or is a single current-state edit sufficient for this version?
- How should the system behave if the same underlying fact could support both a risk and an opportunity framing (e.g., customer concentration flagged as a risk, but also framed as an opportunity for buyer relationship expansion) — should generation surface both, or must the reviewer add the second framing manually?
- Notifications Hub is a known cross-cutting gap (see Section 8) — when it is specced, should it push a notification to the reviewer every time a generation run produces new pending items, or only on a digest/summary basis?
# 10. Acceptance Criteria
- Clicking Generate produces only new AI-drafted risk/opportunity items not already reflected among existing pending, approved, or rejected items on the current list.
- Newly generated items are marked Pending and do not appear in any exported deliverable (workbook, PPT, valuation summary) until explicitly approved.
- A reviewer can manually add a risk or opportunity item with the same citation-linking capability as an AI-generated item.
- Each item supports at least one inline citation link that, when clicked, navigates the user to the specific underlying Q&A response or financial data point.
- A firm-level default tone/style setting is applied to generated narrative when no user-level override exists; a user-level override, when set, takes precedence for that user's generation runs.
- Rejecting an item removes it from the active list view but prevents it from being re-suggested on a subsequent Generate run.
- All generation, approval, rejection, and edit actions are recorded in the platform Activity & Audit Log (SY - 0003) with user, timestamp, and action type.
- Only Approved items are visible to Broker and Company/Seller roles and are the only items pulled into downstream deliverables (QE - 0013, QE - 0014/CM - 0001, VL - 0005).

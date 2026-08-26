CENTURIUUM
Feature Specification

| Feature ID | QA - 0002 |
|---|---|
| Feature Name | Linking to Other Modules |
| Module | QA - Q&A |
| Status | Draft |
| Related / Recycled IDs | Depends on QA-0001, QA-0003, QE-0015; consumed by QE-0005, QE-0006, QE-0007, QE-0008, VL-0005, CM-0001, CM-0004 |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
The Q&A module is where the company provides commentary, explanations, and supporting detail on financial data throughout a deal — reconciling variances, explaining working capital swings, describing customer concentration, and so on. That commentary is the single richest source of “the company's own words” in the system, and multiple downstream deliverables (QoE narrative sections, the executive summary, the CIM, valuation commentary) need to draft written narrative grounded in it rather than inventing language from raw numbers alone.
This feature defines the backend linking, tagging, and retrieval architecture that connects individual Q&A items to the module sections they are relevant to, so that when a downstream feature drafts a narrative, it can pull a small, precise, citable set of Q&A responses instead of scanning the entire Q&A history for the deal. It also defines how a drafted narrative cites back to the specific Q&A response(s) it relied on, so every AI-assisted narrative sentence remains traceable to a source the company actually said, and a reviewer can click through and verify it.
This feature does not draft narratives itself and does not use AI to generate or suggest Q&A answers — company answers remain fully human-authored. It only makes those answers discoverable, taggable, and citable by the features that do the drafting.
# 2. User Stories
- As a QoE reviewer, I want the system to automatically know which Q&A responses relate to a given financial statement line or topic, so that I don't have to manually search the full Q&A log every time I draft commentary.
- As a broker or QoE reviewer reviewing an AI-drafted narrative, I want every factual claim sourced from the company's commentary to show an inline citation, so that I can verify it against the original Q&A response before it goes external.
- As a company user answering questions, I want my original answer to stay locked once posted, so that the history a narrative cited from can never silently change underneath it.
- As a platform architect, I want Q&A retrieval scoped by structured tags rather than a full-text dump, so that narrative-drafting AI calls stay within a tight, low-hallucination context window.
# 3. Functional Requirements
- The system shall tag every Q&A item, at creation, with structured metadata: Module (e.g., QE, VL, CM, RP), Section/Topic (e.g., Working Capital, Customer Concentration, EBITDA Bridge), and, where applicable, an Account/COA reference traceable to DB-0003.
- The system shall auto-populate this metadata on the backend without requiring the requestor or respondent to manually tag the item in the Q&A UI.
- Where a Q&A item originates from a system-generated question (e.g., the variance-driven questions in QE-0015), the system shall inherit that question's originating module, section, and account reference directly rather than re-deriving it.
- Where a Q&A item is manually created by a user with no system-supplied module/account context, the system shall assign a best-effort Module/Section tag using the structured taxonomy, defaulting to an “Unclassified / General” tag if no confident match exists, so no item is silently dropped from the tagging pipeline.
- The system shall expose an internal retrieval service that, given a target module and section/topic, returns the set of Q&A items (question + answer + respondent + timestamp + Q&A ID) tagged to that module/section for the current deal only, ranked by relevance within that tagged pool.
- The retrieval service shall restrict candidate ranking/scoring to items already narrowed by structured tag match; it shall not perform an untagged full-corpus semantic search across all Q&A items on the deal.
- Once a Q&A response is posted, the system shall not allow that response's text to be edited or deleted by any user, including the original respondent.
- The system shall allow additional follow-up responses to be posted to the same Q&A thread after the original response, each retaining its own immutable identity and timestamp.
- The system shall assign a unique, permanent citation ID to every individual Q&A response (e.g., QA-014) at the moment it is posted, independent of the question's own ID, so a specific response — not just a thread — can be cited.
- Any downstream feature that drafts narrative text using one or more Q&A responses shall render an inline citation tag (e.g., “[QA-014]”) at the point in the text the sourced content supports, and shall attach a source list mapping each citation tag to its Q&A response ID.
- Each citation tag in a rendered narrative shall be a clickable link that opens the originating Q&A thread at the cited response.
- The system shall log every citation event (which narrative, which section, which Q&A response ID, when, generated by whom/what) to the platform activity log (SY-0003).
- The system shall not block, invalidate, or force re-generation of an existing narrative if a Q&A thread it cited later receives a new follow-up response; since original responses are immutable, no retroactive change to cited content is possible by construction.
- The system shall apply the same deal/company isolation to Q&A retrieval as every other module: retrieval results shall never include Q&A items from a different deal or company.
- The system shall respect existing role-based visibility rules (SY-0001, SY-0002) when returning Q&A items to a retrieval call, so a narrative-drafting feature cannot surface a Q&A response to a role that would not otherwise be permitted to see it.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Q&A item (question, thread ID) | Read | QA-0001 / QA-0003 Q&A store |
| Q&A response (answer text, respondent, timestamp, response ID) | Read/Write (write = create only, no edit) | QA-0001 / QA-0003 Q&A store |
| Module/Section/Account tag metadata | Write | New tagging table, this feature |
| Account/COA reference on tag | Read | DB-0003 Chart of Accounts |
| Citation record (narrative ID, section, Q&A response ID, generated-by, timestamp) | Write | New citation registry table, this feature |
| Retrieval query log / activity event | Write | SY-0003 Activity & Audit Log |
| Deal/company scope on all of the above | Read | DB-0001 Table Structure (company/deal key) |

# 5. Access & Security
- Roles with access: any role permitted to view the underlying Q&A thread under its existing visibility rules (Broker, Company, Accountant, and others as configured per SY-0002); retrieval never expands visibility beyond what a role could already see directly in the Q&A module.
- Roles explicitly excluded: Bank and Buyer roles are excluded from citation click-through to source Q&A threads unless independently granted Q&A visibility for that deal stage.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web only. This is a backend linking/retrieval and citation-rendering capability with no dedicated end-user configuration screen; the only user-facing surface is the inline citation tag and click-through inside narratives produced by other features.
- Wireframe reference: N/A — no standalone screen. Citation tag rendering (e.g., “[QA-014]”) should be visually consistent wherever it appears across QoE, VL, and CM narrative outputs.
No manual tagging UI is introduced in the Q&A module itself per this spec; all tagging happens on the backend. If a future spec finds structured auto-tagging insufficient for a given case, a manual override UI should be scoped separately rather than added here.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| QA-0001 | Depends on | Provides the Q&A requestor/requestee tracking this feature tags and links. |
| QA-0003 | Depends on | Provides the underlying Q&A housing/store this feature reads from. |
| QE-0015 | Depends on | System-generated Q&A items carry originating module/account context this feature inherits directly. |
| DB-0003 | Depends on | Chart of Accounts is the reference set for account-level tagging. |
| SY-0003 | Depends on | Citation and retrieval events write to the platform activity log. |
| SY-0001 / SY-0002 | Depends on | Retrieval must respect existing role- and company-based access rules. |
| QE-0005, QE-0006, QE-0007, QE-0008, VL-0005, CM-0001, CM-0004 | Blocks | These narrative-producing features consume this feature's retrieval and citation service; each should be specced to call it rather than building its own linking logic. |

# 8. Out of Scope / Deferred
- AI-generated or AI-suggested Q&A answers — company responses remain fully human-authored; not addressed here or anywhere in the Q&A module.
- The narrative-drafting AI features themselves (executive summary, working capital commentary, risk & opportunities commentary, CIM narrative sections, valuation commentary) — each is specced separately and consumes this feature's retrieval/citation service.
- A manual tagging UI inside the Q&A module — tagging is backend-only per this spec; revisit as its own feature if auto-tagging proves insufficient.
- Editing or retracting a posted Q&A response — responses are permanently immutable once posted; correction happens only via a new follow-up response.
# 9. Open Questions
- What is the initial controlled taxonomy of Module/Section/Topic tags per module (QE, VL, CM, RP), and who owns maintaining it as new report sections are added?
- Should the “Unclassified / General” fallback tag surface anywhere for a human (e.g., broker or QoE reviewer) to periodically reclassify, or remain purely internal?
- Should retrieval results be capped at a fixed maximum number of Q&A items per narrative-drafting call to bound context window size, and if so, what's the cap and tie-breaking rule when more tagged items exist than the cap allows?
# 10. Acceptance Criteria
- A Q&A item created through the QE-0015 generator is automatically tagged with the correct Module/Section/Account without any user action, and that tag is visible in the retrieval service's response for a matching query.
- A manually created Q&A item with no system-supplied context receives an “Unclassified / General” tag rather than being omitted from the tagging pipeline.
- Calling the retrieval service for a given module/section returns only Q&A items tagged to that module/section on the current deal, and returns nothing from any other deal or company.
- A test narrative generated by a downstream feature (e.g., a working capital commentary draft) displays at least one inline citation tag, and clicking it opens the correct, specific Q&A response.
- Attempting to edit a previously posted Q&A response is blocked at the system level; posting a new follow-up response to the same thread succeeds and receives its own citation ID.
- Every citation event and every retrieval call is present in the SY-0003 activity log with narrative ID, section, Q&A response ID, and timestamp.

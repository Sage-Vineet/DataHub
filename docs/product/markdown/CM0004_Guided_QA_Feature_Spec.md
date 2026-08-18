CENTURIUUM
Feature Specification

| Feature ID | CM - 0004 |
|---|---|
| Feature Name | Guided Q&A |
| Module | CM - CIM |
| Status | Draft |
| Related / Recycled IDs | CM - 0001 (CIM Helper) — owns the questionnaire requirements provisionally recorded there; CM - 0002 (CIM Template); CM - 0003 (CIM Loader) |
| Author | Valentin Secchi |
| Date | August 17, 2026 |

# 1. Purpose & Business Context
The financial half of a CIM is generated from platform data. The qualitative half is not, and it is the half that stalls: a broker cannot write the business overview, the growth thesis, the customer story, or the management background without information only the seller holds. Today that information is gathered by phone and email, in fragments, over weeks. CM-0004 replaces that with a single action — the broker clicks once, the system reads the CIM being built, and generates a request containing only the questions needed to fill the slides that are still empty. Each section of the request can go to whoever at the company actually holds the answer, with a due date and automatic reminders. Answers come back into a review queue where the broker accepts, edits, or discards each one before anything reaches the deck.
The feature is deliberately optional in every respect. A broker who already knows the answers types them straight onto the slides; a broker who prefers a phone call holds the call and enters what they learn. No request is ever required, and an open or unanswered request never blocks a CIM from being published. The value is in removing the blank-page problem and the follow-up burden for brokers who want that help, not in forcing a workflow on brokers who do not.
This spec takes ownership of the questionnaire behavior provisionally recorded in CM-0001 Section 3, and it changes one of those decisions: answers are reviewed by the broker before they populate slides rather than populating on submission. That change is consistent with how CM-0003 handles imported content, and it exists because a seller's raw answer is unedited prose that may carry confidential detail or a tone unsuited to a buyer-facing document. The required CM-0001 amendment is logged in Section 9.
# 2. User Stories
One story per user type that touches this feature. Format: "As a [role], I want to [action], so that [benefit]."
- As a broker, I want to generate an information request in one click from the CIM I am building, so that I ask the seller only for what is actually still missing rather than sending a generic questionnaire.
- As a broker, I want to add, reword, or remove questions before sending, so that the request sounds like me and fits this particular business.
- As a broker, I want to save a question I wrote for reuse, so that the second deal is easier than the first.
- As a broker, I want to send each section of the request to the person at the company who actually knows the answer, so that the owner is not a bottleneck on operational detail.
- As a broker, I want to review every answer before it appears on a slide, so that nothing unedited or inappropriate for buyers reaches the document.
- As a broker, I want to skip this entirely and just write the slides myself, so that a workflow designed to help me never becomes an obstacle.
- As a firm administrator, I want to publish our firm's standard questions, so that every broker in the office asks the questions we have learned to ask.
- As a company user, I want to answer only the questions assigned to me, from my phone if necessary, without being shown the deck or anyone else's answers, so that contributing is quick and I am not exposed to information outside my remit.
- As a platform administrator, I want every request, answer, and review decision logged, so that we can trace who supplied any statement that ended up in a buyer-facing CIM.
# 3. Functional Requirements
Numbered, testable statements the dev team can build against directly. Avoid prose — each line should be independently verifiable.
- The system shall maintain a question library supporting exactly three scopes, consistent with CM-0002: System (maintained by Centuriuum), Firm (visible to all users of one firm), and User (private to one user).
- Each question record shall carry: question text, optional help or example text, the CIM section it belongs to, the target slide type and content block it is intended to populate, scope, owner, display order, and an active or archived state.
- A user shall see, in any question library view, only System questions, their own firm's questions, and their own User questions.
- Only a firm administrator shall be able to create, edit, publish, or archive Firm-scope questions. Only a Centuriuum internal administrator shall be able to maintain System-scope questions.
- A broker shall be able to save a new or reworded question into their own User library, and a firm administrator shall be able to promote a User question to Firm scope.
- Archiving a question shall remove it from future generation without altering any request already sent or any answer already received.
- The question library shall contain questions only. It shall never store an answer, a company name, or any other deal data.
- The broker shall be able to generate a draft information request for a CIM in a single action.
- Generation shall inspect the CIM's qualitative slides and content blocks and shall include questions only for blocks that are currently unpopulated.
- Generation shall exclude any block already populated by broker authoring, by an accepted answer from a prior request, or by the CM-0003 loader.
- Generation shall exclude any question previously answered and accepted for this CIM, unless the broker explicitly re-adds it.
- Where an unpopulated block has no library question mapped to it, the system shall list that block as an unmapped gap in the draft request so the broker can add a custom question rather than the gap passing unnoticed.
- The broker shall be able to add, reword, reorder, and remove questions in a draft request before sending.
- Rewording or removing a question within a request shall not modify the underlying library question.
- The broker shall be able to regenerate a draft request at any time, and regeneration shall reflect the CIM's current populated state.
- The broker shall be able to create more than one request per CIM over the life of the deal.
- The broker shall be able to assign each section of a request to a different company recipient.
- The broker shall be able to set a due date per assigned section.
- Recipients shall be company users holding access to the deal. Where the intended recipient has no platform account, the system shall issue an invitation through the platform's standard user invitation flow, and the request shall become visible to that recipient only once their account is active.
- The system shall not provide any unauthenticated route to view or answer a request. Every answer shall be attributable to an authenticated user identity.
- Request status shall be one of Draft, Sent, Partially Answered, Complete, or Closed, and the system shall additionally report per-section and per-question status.
- The broker shall be able to close or cancel a request at any time, including one that is only partly answered.
- The system shall send automated reminders to a recipient with outstanding questions on a defined schedule until the questions are answered or the request is closed.
- The broker shall be able to disable automated reminders for a request and to send a manual reminder on demand.
- The system shall display overdue status to the broker for any section past its due date.
- All reminder and notification delivery shall route through the platform notifications hub and shall not be implemented locally within this feature.
- A recipient shall see only the questions assigned to them for their own deal. They shall not see questions assigned to other recipients, other recipients' answers, the CIM itself, any slide, or any financial data.
- A recipient shall be able to answer each question with free text, and shall be able to attach one or more supporting files to an answer.
- Attachments shall be stored as deal documents in the data room (DR-0001), tagged to the originating request and question, and shall not be visible to a Buyer or Bank role by default.
- Attachments shall pass the platform's malware scanning controls before being stored.
- The system shall not provide numeric, date, currency, or multiple-choice answer fields. Answers are free text only, so that no value entered through this feature can populate a financial exhibit.
- A recipient shall be able to save partial progress and return later without submitting.
- The system shall allow a recipient to submit answers per question or per section, and shall not require the entire request to be completed in one sitting.
- Submitted answers shall arrive in a broker review queue showing the question, the answer text, any attachment, the respondent's identity, the submission timestamp, and the target slide and content block.
- No answer shall write to any content block until the broker accepts it.
- The broker shall be able to accept an answer as submitted, edit it and then accept, or discard it.
- Where the target content block already contains text, the system shall offer Replace, Append, or Skip, defaulting to Skip, and shall never overwrite existing content without an explicit choice.
- Discarded answers shall be retained against the request record for audit and shall not be deleted.
- On acceptance, the system shall record against the content block the originating request, question, respondent identity, and answer timestamp as internal provenance. Provenance shall not appear on any rendered or exported output.
- Every content block populated by an accepted answer shall be permanently classified as Deal content under the CM-0001 content class attribute, and shall not be reclassifiable as Firm boilerplate by any user, role, or route. Answer-originated content shall therefore never be carried into a CM-0002 template.
- The feature shall be entirely optional. A CIM shall be able to be completed, approved, and published without any request having been created.
- The broker shall be able to answer any question themselves, and the system shall record that the answer was broker-supplied rather than company-supplied.
- The broker shall be able to mark any question as not applicable, with the question retained in the request record as not applicable rather than deleted.
- An open, overdue, or partially answered request shall never block CIM approval or publication. Outstanding items may be surfaced in the CM-0001 pre-publish deck health panel as informational only.
- The system shall log to the Activity & Audit Log (SY-0003): request generated, request sent, section assigned or reassigned, due date set or changed, reminder sent, answer submitted, answer accepted, edited, or discarded, attachment uploaded, question marked not applicable, request closed or cancelled, and library question created, edited, promoted, or archived.
# 4. Data Requirements
What tables/fields does this feature read from or write to? Reference the relevant Database module table blocks (DB-0001 through DB-0010) wherever applicable so every feature traces back to the reconciled data structure.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Question library record (text, help text, section, target slide/block, scope, owner, order, state) | Write | New CM-module table block — DB-0001 to DB-0010 are financial data blocks and none is reserved for CIM content |
| Request record (CIM reference, status, created by, created at, closed at) | Write | New CM-module table block; modeled without CIM-only assumptions so a future QoE or diligence request feature can reuse it |
| Request section assignment (section, recipient user, due date, status, reminder configuration) | Write | New CM-module table block |
| Question instance (question text as sent, target block, status, not-applicable flag, answered-by-broker flag) | Write | New CM-module table block; snapshot of the question as sent, independent of later library edits |
| Answer record (text, respondent, submitted at, review decision, reviewer, decided at) | Write | New CM-module table block; discarded answers retained |
| Answer attachments | Write | DR-0001 — Core Data Room, stored as deal documents tagged to request and question, not buyer-visible by default |
| CIM sections, qualitative slides, content blocks, and populated state | Read / Write | CM-0001 — read to determine which blocks are unpopulated during generation; written on acceptance of an answer |
| Content block class attribute (Deal content / Firm boilerplate) | Write | CM-0001 block attribute — answer-originated blocks written as Deal content and locked, consistent with CM-0003 |
| Answer provenance per content block (request, question, respondent, timestamp) | Write | CM-0001 content block record; internal only, never rendered |
| Firm membership and firm administrator role | Read | Firm/user account structure — owned by the admin console (cross-cutting gap) |
| Company user invitation | Read / Write | Platform user invitation flow — overlaps the onboarding cross-cutting gap |
| Reminder and notification scheduling | Write | Notifications hub (cross-cutting gap) — this feature schedules, the hub delivers |
| Financial data and financial exhibits | Not read or written | Deliberately absent — no answer or attachment may populate a financial exhibit; exhibits remain generated from QE-0004 / RP-0001 / DB-0002 per CM-0001 |
| Request, answer, review, and library events | Write | SY-0003 — Activity & Audit Log |

# 5. Access & Security
Confirm roles and deal isolation explicitly on every spec — never assume it.
- Roles with access: Broker (deal owner/admin) — generate, edit, assign, and send requests; manage their own User question library; review, accept, edit, or discard answers; answer on their own behalf; mark questions not applicable; close requests. Firm administrator — all broker rights plus management of the Firm question library. Centuriuum internal administrator — maintains the System question library only, with no access to any deal's requests or answers.
- Company / Seller user — may view and answer only the request sections assigned to them, within their own deal. They shall not be able to view questions assigned to another recipient, another recipient's answers, the CIM or any slide, any financial exhibit or figure, or the question library.
- Roles explicitly excluded: Accountant / QoE preparer — no access to requests, answers, or the library in v1. Buyer — no access to any request, answer, attachment, or the existence of a request, under any circumstance. Bank — no access.
- There shall be no unauthenticated access path. Every respondent is an authenticated platform user, and every answer is attributable to a user identity — which matters because accepted answers become statements in a buyer-facing document that the seller approves at publication under CM-0001.
- Attachments submitted through this feature are stored as deal documents and shall not be buyer-visible by default; exposing them to a buyer requires a deliberate data room permission action under DR-0001.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. Requests, section assignments, question instances, answers, attachments, review decisions, and per-block provenance are scoped to one CIM within one deal and are not visible or retrievable from any other deal. The question library is firm- and user-scoped rather than deal-scoped, and is bounded by construction: it stores questions only, never an answer, a company name, or any other deal data.
- Cross-deal leakage of answers is additionally closed by construction: because every answer-originated content block is permanently classified as Deal content and cannot be reclassified, seller-supplied content is structurally incapable of entering a CM-0002 template and therefore cannot reach another company's CIM.
# 6. UI / UX Notes
Layout, interaction notes, or wireframe reference. State platform scope explicitly per feature.
- Platform: Web + Mobile (light). The broker-side experience — generation, editing, assignment, review, and library management — is web only. The company respondent experience is mobile-capable: viewing assigned questions, entering text answers, and attaching a file must work on a phone, because a seller answering three questions from a job site is the difference between a completed request and an abandoned one. Mobile respondent support is a scope addition relative to CM-0001 through CM-0003 and is flagged for confirmation in Section 9.
- Wireframe reference: N/A
The generate action belongs in the CIM editor next to the deck health panel, labeled with the number of unpopulated blocks it would ask about — a broker deciding whether to send a request wants to know how much of the deck it covers before they click. The resulting draft opens grouped by CIM section, with each question editable inline, an add-custom-question control per section, and a per-section recipient and due date. A preview of exactly what the recipient will receive should be one click away, because the broker is sending this to their client and will not send something they cannot see first.
The request must read as the broker's request rather than a platform form: the broker's name and firm, and an editable short introductory message, should appear at the top of what the recipient sees. Brokers protect their client relationships, and a request that reads as machine-generated will be replaced by a phone call.
The respondent view should present one question per card with its help text, a text field, and an optional attachment control, with save-and-continue throughout and clear progress against the section. Nothing about the deck, the financials, or other recipients' contributions should be reachable from this surface.
The review queue should let the broker move quickly: question, answer, respondent, and target block visible together, with accept, edit-then-accept, and discard on each item, and the ability to work through a section without returning to a list between items. Section-level progress should also appear in the CM-0001 slide navigator so the broker can see which parts of the deck are waiting on someone else.
Because the feature is optional, none of these surfaces should ever gate CIM work. A broker who never opens the Q&A should see no incomplete state, no warning, and no nag anywhere in the CIM builder.
# 7. Dependencies
Upstream features that must exist first. This is the single most valuable section for sequencing the build.

| Related Feature | Relationship | Notes |
|---|---|---|
| CM-0001 — CIM Helper | Depends on | Supplies the section outline, qualitative slides, content blocks and their populated state, the content class attribute, and the deck health panel. Requires amendment: the questionnaire requirements provisionally recorded in CM-0001 Section 3 move here, and CM-0001's statement that responses populate mapped blocks on submission must change to review-and-accept. |
| Notifications hub (cross-cutting gap) | Depends on | Hard dependency. Automated reminders, due-date alerts, and request-sent and answer-received notifications all require the hub. Without it this feature ships with manual reminders only (see Open Questions). |
| Admin console / firm settings (cross-cutting gap) | Depends on | Owns the firm administrator role required for Firm-scope questions, and the internal surface for maintaining the System question library. |
| Onboarding (cross-cutting gap) | Depends on | Recipients without an account must be invited through the platform invitation flow. Overlap must be reconciled: if onboarding already collects business overview information, those questions should not be re-asked here. |
| DR-0001 — Core Data Room | Depends on | Stores answer attachments as deal documents and supplies malware scanning on upload. Attachments must default to not buyer-visible. |
| CM-0002 — CIM Template | Related | Supplies the System / Firm / User scope model reused by the question library, and the firm administrator concept. Question sets attached to templates are deferred (see Out of Scope). |
| CM-0003 — CIM Loader | Related | Blocks populated by the loader are excluded from question generation, so an imported deck reduces the request automatically. Both features share the review-before-commit and Replace/Append/Skip collision patterns, which should be implemented once and reused. |
| SY-0003 — Activity & Audit Log | Depends on | All request, answer, review, and library events must be logged. Platform-wide audit trail is a known cross-cutting gap. |
| Legal / compliance (cross-cutting gap) | Related | Accepted answers become statements in a buyer-facing document that the seller approves under CM-0001. Whether respondent attribution must be surfaced at approval is a compliance question (see Open Questions). |
| QoE and diligence request features (Feature IDs to be confirmed) | Related | Out of scope here, but the request and answer model is to be built without CIM-only assumptions so those features can reuse it rather than creating a second seller inbox. |

# 8. Out of Scope / Deferred
- Structured answer fields — numeric, currency, date, and multiple-choice inputs are excluded, specifically so that no value captured here can populate a financial exhibit.
- Any path by which an answer or attachment populates a financial exhibit, or feeds the GL, QoE, or any reporting module.
- Per-question assignment to different recipients — v1 assigns by section.
- Unauthenticated or tokenized no-login answering. Every respondent must hold a platform account.
- Attaching question sets to CM-0002 templates so that a template and its intake questions travel together — deferred.
- A general-purpose request engine serving QoE information requests and diligence checklists. The data model is built to allow it; the feature is deferred until those requirements are defined.
- AI-generated questions, and AI rewriting, summarizing, or tone-adjusting of answers — deferred to the separate AI feature referenced in CM-0001.
- Conditional or branching question logic, and dynamic follow-up questions based on a prior answer.
- Multi-language questionnaires and translation of questions or answers.
- Threaded discussion or clarification exchange against an individual question — v1 supports one answer per question, revised by resubmission.
- Seller e-signature or formal attestation on individual answers — approval of the resulting content occurs at the CM-0001 publication gate.
- Automatic placement of answer attachments onto slides — attachments are stored as documents and used by the broker manually.
- Buyer-facing question and answer exchange.
- Answer version history beyond what the audit log records.
# 9. Open Questions
- Reference file access: the project knowledge files (Centuriuum_Product_List.xlsx, Centuriuum_Spec_Conventions_and_Decisions.docx) could not be read when this spec was drafted. Confirm the CM module label and Feature ID formatting, and confirm nothing here contradicts a locked decision in the conventions doc — in particular the authentication approach assumed for company recipients.
- CM-0001 amendment required: the questionnaire requirements provisionally recorded in CM-0001 Section 3 (provide a structured questionnaire, assign it to a company user, populate mapped blocks on submission, protect broker edits, report completion status) are owned by this spec and should be replaced in CM-0001 with a reference to CM-0004. Critically, CM-0001 states that responses populate mapped slide blocks on submission, which contradicts the review-and-accept model decided here. Confirm the amendment and who owns updating that document.
- Mobile respondent scope: this is the first CM feature to specify Web + Mobile (light). It should materially improve completion rates, but it is a scope addition relative to CM-0001 through CM-0003. Confirm mobile respondent support is in v1, or defer it and accept desktop-only answering.
- Reminders hard-depend on the notifications hub, which is an unresolved cross-cutting gap. If the hub is not ready when this feature is built, does it ship with manual reminders only and add automation later, or wait for the hub? Recommend shipping with manual reminders rather than blocking, since the feature is optional by design.
- System question library governance: who curates it, how many questions per CIM section ship at launch, and is there a review step before a Firm-scope question becomes visible to every broker in an office?
- Unmapped blocks: where an unpopulated block has no library question, should the system auto-suggest a generic question derived from the slide title, or require the broker to write one? Auto-suggesting risks sending a seller a vague question; requiring authoring risks the gap being skipped.
- Respondent authority: answers become representations in a buyer-facing document that the seller approves at publication. Should the CM-0001 approval screen show who answered each contributing question, so an owner approving the CIM can see that a general manager supplied a given statement? This may be a compliance requirement rather than a nicety.
- Attachment visibility: attachments land in the data room. Should the company user who uploaded a file be able to see it there afterward, and is exclusion from buyer access permanent or only a default a broker can change?
- Declining a question: should a recipient be able to decline with a reason, or only leave a question blank? A declined-with-reason answer is more useful to the broker than silence, but it adds a state.
- Re-asking: assumption to confirm — the system never automatically re-asks a question once its answer has been accepted, even if the broker later empties or rewrites that block. Re-asking should always be an explicit broker action.
- Assumption to confirm: answer-originated blocks are permanently Deal content, consistent with CM-0003. This means a genuinely reusable answer can never become firm boilerplate. Correct for seller-supplied content, but confirm the constraint is understood.
- Limits: maximum questions per request, maximum open requests per CIM, maximum attachment size and count per answer, and reminder frequency and cap.
# 10. Acceptance Criteria
- A broker can generate a draft request in one action, and the generated request contains questions only for qualitative content blocks that are currently unpopulated.
- A block populated by broker authoring, by a previously accepted answer, or by the CM-0003 loader produces no question on generation.
- An unpopulated block with no mapped library question appears in the draft request as an unmapped gap rather than being silently omitted.
- The broker can add, reword, reorder, and remove questions in a draft request, and rewording a question in the request leaves the library question unchanged.
- A broker can save a custom question to their User library and reuse it on a later deal; a firm administrator can promote it to Firm scope and it then appears for all users in that firm.
- A non-administrator broker cannot create, edit, or archive a Firm-scope question, and no user can view another firm's or another user's questions.
- The broker can assign different sections of one request to different company recipients, each with its own due date, and per-section status is reported independently.
- Where an intended recipient has no platform account, an invitation is issued and the request becomes visible to them only once their account is active.
- There is no route by which an unauthenticated party can view or answer a request, and every stored answer carries an authenticated respondent identity.
- A recipient sees only the questions assigned to them and cannot reach any slide, any financial exhibit, the question library, another recipient's questions, or another recipient's answers.
- A recipient can submit a free-text answer, attach a file, save partial progress and return later, and submit per question or per section.
- An attachment is stored as a deal document in the data room, tagged to its request and question, passes malware scanning, and is not visible to a Buyer or Bank role.
- No numeric, currency, date, or multiple-choice answer field exists anywhere in the respondent experience.
- A submitted answer appears in the broker review queue and writes nothing to any content block until the broker accepts it.
- The broker can accept an answer as submitted, edit it before accepting, or discard it; a discarded answer is retained against the request record and appears nowhere in the CIM.
- Where the target block already contains text, the broker is offered Replace, Append, or Skip with Skip as the default, and no existing content is overwritten without an explicit choice.
- Every block populated by an accepted answer carries the Deal content class, cannot be reclassified as Firm boilerplate by any route, and does not appear in a CM-0002 template created from that CIM.
- A CIM can be completed, approved, and published with no request ever created, and an open, overdue, or partially answered request does not block approval or publication.
- A broker can answer a question themselves and the record distinguishes a broker-supplied answer from a company-supplied one; a question marked not applicable is retained in the request rather than deleted.
- Automated reminders are sent on schedule until answered or closed, the broker can disable them or send a manual reminder, and overdue sections are visibly flagged to the broker.
- Request generated, sent, assigned, due date changed, reminder sent, answer submitted, accepted, edited or discarded, attachment uploaded, question marked not applicable, request closed, and every library question change all appear in the Activity & Audit Log (SY-0003).
- A user without assigned role/deal access cannot view any request, question instance, answer, or attachment for that deal, and no answer from one deal is reachable from another deal by any route.

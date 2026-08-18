CENTURIUUM
Feature Specification

| Feature ID | DR - 0004 |
|---|---|
| Feature Name | Redaction Ability |
| Module | DR - Data Room |
| Status | Draft |
| Related / Recycled IDs | Referenced by BY - 0007 (Buyer Qualification & KYC) for bank/brokerage statement redaction |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
M&A data rooms routinely contain tax returns, bank statements, payroll records, and other source documents that carry personally identifying information (PII) such as Social Security Numbers, Employer Identification Numbers (EINs), account numbers, and similar sensitive identifiers. This feature gives the document owner a way to permanently remove that information from a file before or after it is placed in the data room, so the underlying financial substance can still be shared with brokers, buyers, lenders, and QoE providers without exposing PII to parties who have no legitimate need to see it. Because a data breach or an accidental over-disclosure of PII carries direct legal and reputational risk to Centuriuum, brokers, and the company being sold, redaction must be dependable, permanent, and auditable.
# 2. User Stories
- As a company (seller) user, I want to redact PII (e.g., SSNs, EINs, account numbers) from a tax return or bank statement I've uploaded, so that I can share the document in the data room without exposing sensitive personal information.
- As a broker managing the data room, I want confidence that a redacted document cannot be reverse-engineered to reveal the original PII, so that I can safely grant buyer and lender access to that folder.
- As a buyer completing qualification (BY - 0007) uploading a bank or brokerage statement, I want the same redaction option, so that I can prove funds without exposing my full account number.
- As a file owner, I want a clear warning before redacting, so that I understand the action is destructive and cannot be undone before I confirm it.
# 3. Functional Requirements
- The system shall present a "Redact" action on any file the current user owns (uploaded), available from the file's row/detail view in the data room.
- The system shall run automated AI detection to identify likely PII on the document (at minimum: Social Security Numbers, EINs, and bank/financial account numbers) and visually highlight each detected item as a proposed redaction area before anything is applied.
- The system shall allow the user to accept, reject, or adjust the boundaries of each AI-proposed redaction area prior to confirming.
- The system shall allow the user to manually draw and add additional redaction areas the AI did not detect, and to manually remove/undo a proposed or added area, prior to confirming.
- The system shall require an explicit confirmation step before applying redaction, displaying a warning that states: (a) this action modifies the core file, (b) the action is permanent and cannot be undone, and (c) the user must choose whether to retain a copy of the original unredacted file (see requirement below).
- The system shall, at the confirmation step, present a checkbox defaulted to "Destroy the original file" (unchecked = retain a copy) so the user can explicitly opt to retain a copy of the pre-redaction original instead of the destructive default.
- The system shall, when the destroy option is used, permanently and irrecoverably delete the original unredacted file from active storage and backups within Centuriuum's standard data retention/deletion window, such that no user, broker, administrator, or Centuriuum staff member can retrieve the original content thereafter.
- The system shall, when the retain-a-copy option is used, store the original unredacted file in a separate, restricted-access location that is not visible in the data room file tree and is not exposed to any deal participant other than the uploading owner, consistent with the access model defined in Section 5.
- The system shall render the redacted document by flattening the affected page(s) to a rasterized image layer so that no selectable or recoverable text/data remains underneath the redacted areas.
- The system shall, immediately after flattening, automatically re-run the document through the platform's OCR pipeline to regenerate a searchable text layer over the redacted (flattened) image, so search, extraction, and downstream data-table population (e.g., DB - 0008 Tax Return Table) continue to work without ever exposing the pre-redaction text.
- The system shall replace the file in the data room with the redacted version, preserving the file's folder location, name (with a visible "(Redacted)" suffix or equivalent indicator), and permission settings.
- The system shall visually flag redacted files in the data room UI (e.g., a badge or icon) so any viewer can see at a glance that a file has been redacted.
- The system shall support the same redaction workflow for the bank/brokerage statement upload path in BY - 0007 (Buyer Qualification & KYC).
- The system shall log every redaction event (who redacted, which file, timestamp, areas redacted at a summary level, and whether the original was destroyed or retained) to the platform's audit trail per SY - 0003.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Uploaded source file (tax return, bank statement, etc.) | Read/Write | Data Room file store; tax return content maps to DB - 0008 (Tax Return Table); bank statement content maps to DB - 0009 (Bank Statement Table) |
| Redaction event record (file ID, user, timestamp, areas, destroy/retain flag) | Write | Activity & Audit Log, SY - 0003 |
| Retained original file (if user opts to keep a copy) | Write | Restricted-access original-file store, not part of the visible data room file tree |
| Redacted (flattened + re-OCR'd) file | Write | Data Room file store, same folder/permission scope as original |

# 5. Access & Security
- Roles with access to trigger redaction: the uploading owner of the file only.
- Roles explicitly excluded from triggering redaction: all other roles (broker, buyer, bank, accountant) may view a redacted file per normal folder permissions, but may not initiate or reverse a redaction on a file they do not own.
- Access to any retained original (unredacted) copy is restricted to the uploading owner; no other role, including the broker who administers the data room, has visibility into or access to the retained original by default.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web only.
- Wireframe reference: N/A
The redaction workflow should open in a document viewer overlay showing the file with AI-proposed redaction boxes rendered directly on the page. The user can click to accept/reject each box, drag to reposition or resize, and draw new boxes freehand. A persistent "Confirm Redaction" button opens the destructive-action warning modal described in Section 3, containing the retain/destroy checkbox, before any change is applied. Given the mobile experience is a lighter companion (per platform conventions), this workflow is not expected on mobile; mobile users can view redacted files but should be directed to web to perform redaction.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DR - 0001 Core Data Room | Depends on | Redaction acts on a file already stored in the data room. |
| SY - 0003 Activity & Audit Log | Depends on | Every redaction event must be logged per the audit trail requirements. |
| DB - 0008 Tax Return Table / DB - 0009 Bank Statement Table | Depends on | Re-OCR after redaction must continue to populate these tables correctly. |
| BY - 0007 Buyer Qualification & KYC | Blocks / Shared with | BY - 0007 explicitly references this feature's redaction option for buyer bank/brokerage statement uploads. |
| Document Versioning (cross-cutting gap) | Depends on | No dedicated versioning feature exists yet; see Open Questions. |

# 8. Out of Scope / Deferred
- Redacting a document that has already been distributed/downloaded outside the platform — this feature only affects the copy stored in the Centuriuum data room; it cannot retract copies already shared elsewhere.
- Dynamic per-viewer watermarking of documents — that is covered separately in DR - 0006 (Document Control & Watermarking).
- Bulk/batch redaction across multiple files at once — this spec covers single-file redaction only; batch redaction may be considered as a future enhancement.
- Redaction category/type management beyond PII detection (e.g., redacting competitively sensitive business terms) — out of scope for this spec, which is focused on PII.
# 9. Open Questions
- This feature depends on a general document versioning capability that does not yet have its own feature ID (see Known Cross-Cutting Gaps in the conventions doc). Should the retained "original copy" option in this spec be treated as a special case of that future versioning feature, or remain a standalone restricted store as specced here?
- What is Centuriuum's defined data retention/deletion window for permanently destroyed files (referenced in Functional Requirements), including backup purge timing? This should be answered once a platform-wide data retention policy exists (see Legal / Compliance cross-cutting gap).
- Should there be any limited emergency-access path (e.g., legal hold) to a destroyed original, or is destruction intended to be absolute with zero exceptions?
# 10. Acceptance Criteria
- A file owner can select a file, review AI-suggested PII redaction areas, adjust them manually, and confirm redaction, only after acknowledging the destructive-action warning.
- Upon confirmation, the redacted file replaces the original in the data room, is visually flagged as redacted, and remains searchable via OCR without exposing any pre-redaction text or images of the redacted areas.
- If "destroy original" was selected, no original file content is retrievable by any user or administrator through the application after the standard deletion window.
- If "retain a copy" was selected, the original is stored in a location inaccessible to any user other than the file owner, and does not appear in the data room file tree.
- Every redaction event appears correctly in the audit log with user, file, timestamp, and destroy/retain outcome.
- The same workflow functions correctly when triggered from the BY - 0007 buyer statement upload path.

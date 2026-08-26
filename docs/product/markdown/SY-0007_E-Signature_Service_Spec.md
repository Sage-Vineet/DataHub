CENTURIUUM
Feature Specification

| Feature ID | SY - 0007 |
|---|---|
| Feature Name | E-Signature Service |
| Module | SY - System |
| Status | Draft |
| Related / Recycled IDs | Shared service consumed by BR - 0002 (NDA), BR - 0007 (Engagement Letter / Listing Agreement), BR - 0013 (IOI / LOI execution), BY - 0007 (Buyer Qualification Attestation) |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
The platform currently implies e-signature capability inside individual features (e.g., NDA execution in BR - 0002) without a shared foundation, which would mean rebuilding the same capability separately for every module that needs an executed document. This feature specifies a single, reusable e-signature service that any module — NDAs, engagement letters and listing agreements, IOIs/LOIs, buyer attestations, and future closing documents — can call to generate, route, track, and execute a signed document, with the result automatically filed to the correct data room location. Centralizing this now avoids inconsistent signing experiences and duplicated integration work across the broker, accountant, and buyer workflows.
# 2. User Stories
- As a broker, I want an NDA to be automatically generated from my saved template and sent for signature when a buyer requests data room access, so that access can be gated on execution without me manually tracking the document.
- As an accountant (via Tonnesen Accounting Services or another firm on the platform), I want to send an engagement letter to a buyer for e-signature using my firm's own template, so that I can formally engage the client before starting work.
- As a broker or accountant, I want to define signer roles and routing order (e.g., company signs first, then buyer, then broker countersigns) on any document I send, so that multi-party documents execute in the correct sequence.
- As a firm administrator, I want to connect my firm's own Docusign, Dropbox Sign, or Adobe Acrobat Sign account, so that signature volume is billed to my firm's account rather than the platform's.
- As a user awaiting a signature, I want to see the real-time status of a document I sent (sent, viewed, partially signed, executed, declined, expired, voided) on the record that triggered it, so that I know when to follow up.
# 3. Functional Requirements
- The system shall support template management with merge fields, allowing a template's placeholder fields (e.g., party name, deal name, date, dollar amount) to be automatically populated from platform data at send time.
- The system shall allow templates to be created and managed at two levels: firm/brokerage level (visible to all users at that firm) and individual user level (visible only to that user), with firm-level templates taking precedence as the default unless a user selects their own.
- The system shall abstract the signature provider so that Docusign, Dropbox Sign, and Adobe Acrobat Sign can each be connected via their official API, with no browser automation or credential scraping, consistent with the platform's integration standard.
- The system shall allow a firm to connect its own corporate account with any supported provider; where no firm account is connected, the system shall use a platform-level default provider account.
- The system shall allow the initiating user to define signer roles, signer order (sequential or parallel), and signer type (individual, entity representative, guarantor/spouse) for each signature request.
- The system shall support in-person and remote signing workflows.
- The system shall support delegated or authorized-representative signing for entity signers.
- The system shall support counter-signature workflows (e.g., buyer signs first, broker countersigns after).
- The system shall track and expose signature request status at all times: Draft, Sent, Viewed, Partially Signed, Executed, Declined, Expired, Voided.
- The system shall surface the current signature status directly on the record of the module that initiated the request (e.g., the NDA record in BR - 0002, the engagement letter record in BR - 0007), not in a separate central log screen.
- The system shall send configurable automated reminders to outstanding signers on a schedule set by the initiating user or firm default.
- The system shall support a configurable expiration period after which an unsigned request automatically moves to Expired status.
- Upon full execution, the system shall automatically retrieve the executed document and its completion certificate and file both to the data room folder associated with the originating module and deal/company, per the folder structure defined in DR - 0002.
- The system shall retain the audit certificate (signer identity, IP address, and timestamp for each signing event) immutably, and this record shall not be editable or deletable by any user, consistent with ESIGN/UETA evidentiary requirements.
- The system shall write every status change event (sent, viewed, signed, declined, expired, voided) to the platform Activity & Audit Log (SY - 0003), including the deal/company association.
- The system shall trigger downstream automation on execution where applicable — most notably, execution of an NDA shall trigger data room access provisioning per BR - 0002 / BO - 0002.
- The system shall enforce deal/company isolation: a user may only initiate, view, or manage signature requests for deals/companies they have been granted access to.
- The system shall allow re-sending or amending an unsigned request to generate a new version rather than overwriting the original, pending the platform's general document versioning capability (see Dependencies).
- The system shall allow a user to void an in-flight request, with the reason optionally logged and the status updated to Voided across all views referencing it.
# 4. Data Requirements
This feature introduces new tables since no signature-specific structure exists yet in the Database module (DB - 0001 through DB - 0010). Placement of these new tables within the DB module block structure is flagged as an Open Question below.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Signature Request record (requesting module, deal/company ID, provider used, template ID, status, created by, created date) | Write | New table: Signature Requests (System module) — see Open Questions re: DB block assignment |
| Signer records (name, email, role, routing order, signing status, signed timestamp, IP address) | Write | New table: Signature Request Signers, child of Signature Requests |
| Template record (name, source file, merge field map, owner scope: firm or user, active/inactive) | Read/Write | New table: Signature Templates (System module) |
| Merge field values (deal name, company name, party names, dates, dollar amounts, etc.) | Read | Originating module's own record — e.g., BR - 0002 NDA config, BR - 0007 engagement letter terms, BR - 0013 LOI terms |
| Executed document (final signed PDF) and completion certificate | Write | Data Room (DR - 0001), filed to the folder defined for the originating module/deal per DR - 0002 structure |
| Provider connection credentials (OAuth tokens per brokerage account, where applicable) | Read/Write | New table: E-Signature Provider Connections, scoped to firm |
| Signature status change events (sent, viewed, signed, declined, expired, voided) | Write | Activity & Audit Log (SY - 0003) |
| Company/deal association for isolation checks | Read | DB - 0001 Table Structure (company/deal linkage) |

# 5. Access & Security
- Roles with access: Broker, Accountant, Company (as initiator or signer depending on the document), Buyer (as signer), Bank (as signer where a guarantee or lender document requires it).
- Roles explicitly excluded: no role may view or manage a signature request for a deal/company they have not been granted access to, regardless of profile type.
- Firm-level templates are visible only to users within that firm; user-level templates are visible only to their creator.
- Provider connection credentials (OAuth tokens) are stored per firm and are never visible to or editable by users outside that firm's admin role.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of signature requests, signer information, or executed documents.
# 6. UI / UX Notes
- Platform: Web only for template creation, provider connection setup, and initiating/configuring a signature request.
- Platform: Web + Mobile (light) for reviewing status of an in-flight request and receiving/acting on a reminder notification, consistent with mobile's role as a lighter companion experience.
- Wireframe reference: N/A
Signature status should render as a compact status badge (Draft / Sent / Viewed / Partially Signed / Executed / Declined / Expired / Voided) embedded directly on the originating module's record — for example, inline on the NDA row in the buyer's data room access panel, or on the engagement letter line in the accountant's client record — rather than requiring navigation to a separate signature dashboard. Firm admins should have a dedicated settings screen (web only) for connecting/disconnecting provider accounts and managing firm-level templates.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| SY - 0001 (Role Based Access Setup) | Depends on | Signer/routing permissions and who may initiate a signature request must respect platform role definitions. |
| SY - 0002 (Company Access Setup) | Depends on | Deal isolation for signature requests must follow the same per-company access grants. |
| SY - 0003 (Activity & Audit Log) | Depends on | All status changes (sent/viewed/signed/declined/expired/voided) write here for the legal and evidentiary record. |
| DR - 0001 / DR - 0002 (Data Room / Templated File Structure) | Depends on | Executed documents and certificates are filed to the data room using the folder structure defined per deal. |
| BR - 0002 (NDA) | Blocks | NDA signing flow is a consumer of this service; cannot be built until this spec is implemented. |
| BR - 0007 (Engagement & Fee Management) | Blocks | Engagement letter / listing agreement execution is a consumer of this service. |
| BR - 0013 (IOI / LOI Intake & Version Control) | Blocks | LOI/IOI execution is a consumer of this service. |
| BY - 0007 (Buyer Qualification & KYC) | Blocks | Buyer attestations, where they require a signature, are a consumer of this service. |
| Document Versioning (cross-cutting gap, unassigned Feature ID) | Depends on | Re-sending or amending a document generates a new version; general versioning behavior is not yet specced as its own feature. |

# 8. Out of Scope / Deferred
- The specific NDA/MNDA workflow logic, redline tracking, and toggle-on/off requirement behavior — that belongs to BR - 0002 as the consumer of this service.
- Engagement letter and listing agreement content, fee terms, and expiration/renewal tracking — that belongs to BR - 0007.
- LOI/IOI content, version control of negotiated terms, and redline comparison between offer drafts — that belongs to BR - 0013.
- Buyer qualification attestation content and KYC logic — that belongs to BY - 0007.
- A general-purpose document versioning system — this spec assumes re-sending creates a new signature request version, but does not define platform-wide document versioning (cross-cutting gap, not yet its own feature).
- Billing/metering of provider costs to a firm's account — covered separately under Metered Usage (SY - 0004) if applicable.
# 9. Open Questions
- Where should the new Signature Requests, Signature Request Signers, Signature Templates, and E-Signature Provider Connections tables sit within the DB module's table block structure (DB - 0001 through DB - 0010), given that DB - 0010 (Table Blocks) notes this is still an open architecture item?
- Should firm-level template edits require an approval step, or can any firm-designated admin publish changes immediately (relevant given templates like engagement letters carry legal/compliance weight)?
- Should there be a minimum/default provider (e.g., a platform Docusign account) available immediately for firms that have not yet connected their own account, and if so, who bears that cost?
- This spec references the platform Activity & Audit Log as SY - 0003; the product listing's cross-reference notes on other features (e.g., BR - 0008, BR - 0013) cite it as SE - 0004. Please confirm SY - 0003 is the correct, current ID so downstream specs are consistent.
- Document versioning is listed as a known cross-cutting gap without its own Feature ID. Should this spec block on that feature being specced first, or proceed with a minimal versioning behavior (new version per re-send) as a placeholder?
# 10. Acceptance Criteria
- A user can create a firm-level or user-level template with at least one merge field, and the merge field is correctly populated when a document is generated from that template.
- A firm admin can connect and disconnect a Docusign, Dropbox Sign, or Adobe Acrobat Sign account, and signature requests initiated by that firm route through the connected account.
- A signature request with two or more signers in a defined sequential order sends to each signer only after the prior signer completes their action.
- Signature status visible on the originating module's record updates in real time (or on next page load) to reflect Sent, Viewed, Partially Signed, Executed, Declined, Expired, or Voided as appropriate.
- Upon full execution, the signed document and its completion certificate appear in the correct data room folder for that deal/company within an acceptable processing window.
- Every status change for a given signature request appears in the Activity & Audit Log with correct deal/company association, timestamp, and user/signer identity.
- A user without access to a given deal/company cannot view, initiate, or act on any signature request tied to that deal/company.
- Executing an NDA-type request correctly triggers automatic data room access provisioning for the signing buyer.

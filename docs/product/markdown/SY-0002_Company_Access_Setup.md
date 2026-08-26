CENTURIUUM
Feature Specification

| Feature ID | SY - 0002 |
|---|---|
| Feature Name | Company Access Setup |
| Module | SY - System |
| Status | Draft |
| Related / Recycled IDs | Depends on SY - 0001 (Role Based Access Setup); references BR - 0002 (NDA), DR - 0001 (Core Data Room), |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
When a broker (or other company owner) creates a company/deal in Centuriuum, that owner needs to bring other parties onto the deal — an accountant, another broker, a lawyer, a buyer — without giving them blanket visibility into everything in the data room or every module. This feature lets the company owner grant and configure access to a specific company on a per-user, per-deal basis, independent of that user's system-wide login role (set up in SE - 0001). The same person may need different access on different deals (e.g., sell-side accountant on one deal, buy-side on another), so access must be scoped to the company, not to the user's account globally. This matters because the data room holds sensitive financial and personally identifiable information, and getting this wrong either blocks deal work or exposes data that shouldn't be seen.
# 2. User Stories
- As a company owner (e.g., Broker), I want to invite a user and grant them access to my company, so that they can work in the data room and relevant modules without seeing anything I haven't approved.
- As a company owner, I want to configure access separately for each user on each company, so that the same accountant can be sell-side on one deal and buy-side on another without their access carrying over.
- As a company owner, I want to save a set of access settings as a reusable template (e.g., “Sell-side Accountant”), so that I don't have to reconfigure the same permissions every time I bring on a similar user.
- As a company owner, I want a new grantee to start with a sensible default set of permissions based on their role, so that I only have to adjust exceptions rather than build access from zero every time.
- As a granted user (e.g., Accountant, Lawyer, Buyer), I want to see only the folders, documents, and modules I've been given access to on this specific company, so that I'm not exposed to unrelated or restricted information.
- As a company owner, I want to revoke or modify a user's access at any time, so that I can respond to a change in deal team composition or deal stage.
# 3. Functional Requirements
- The system shall allow only the current company owner to grant, modify, or revoke another user's access to that company.
- The system shall scope every access grant to a single company; a grant made on one company shall have no effect on any other company.
- The system shall allow a company owner to grant access to a user by selecting the user's system role (per SE - 0001) as the basis for a default permission set.
- The system shall pre-populate a new grant with a default, role-based permission set (e.g., a typical Accountant view) that the company owner can then adjust before or after the user gains access.
- The system shall support access grants at two levels of granularity: (a) folder/document-level within the Data Room, and (b) module/tab-level for functional areas (e.g., QoE, Reports, Projections, Q&A, CIM).
- The system shall allow a company owner to independently toggle visibility for each Data Room folder (and its sub-folders/documents) per grantee.
- The system shall allow a company owner to independently toggle visibility for each functional module (or sub-section of a module, where applicable) per grantee.
- The system shall allow a company owner to save a given combination of folder- and module-level settings as a named, reusable permission template.
- The system shall allow a company owner to apply a saved permission template to a new or existing grantee, with the ability to further adjust individual settings after applying the template.
- The system shall allow a company owner to update an existing user's access on a company at any time, and changes shall take effect on the user's next page load/session refresh.
- The system shall allow a company owner to fully revoke a user's access to a company, immediately removing that user's ability to view any data room content or module tied to that company.
- The system shall prevent a user from viewing, searching, or otherwise discovering any company to which they have not been granted access, consistent with the platform-wide deal isolation rule.
- The system shall support a single user holding different, independently-configured access profiles on different companies simultaneously.
- The system shall support exactly one owner per company at a time, with the ability for the current owner to transfer ownership to another user who already has (or is granted) access to the company.
- The system shall log the identity of the company owner and the transfer history when ownership is transferred (full activity logging beyond this is covered by the Audit Trail dependency in Section 7).
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Company record (owner_user_id) | Read / Write | DB - 0001 (Table Structure) — core company/deal entity |
| Access Grant (user_id, company_id, module/folder flags) | Read / Write | New table; references DB - 0001 company and document/table structure; see Open Questions |
| Permission Template (owner_id, template_name, settings JSON) | Read / Write | New table; owned by the company owner's account, reusable across companies |
| User system role (per SE - 0001) | Read | SE - 0001 role assignment — used to determine default permission set on new grants |
| Data Room folder/document tree | Read | DR - 0001 (Core Data Room), DR - 0002 (Templated File Structure) |
| Ownership transfer log entry | Write | New table; minimal record pending full Audit Trail (see Section 7/9) |

# 5. Access & Security
- Roles with access: Company owner has full grant/revoke/configure rights on their own company. Any granted user (Broker, Bank, Buyer, Accountant/QoE, Lawyer, Company/Seller) can view only what has been explicitly enabled for them on that specific company.
- Roles explicitly excluded: No user, regardless of system role, has any visibility into a company until the company owner has explicitly granted access; there is no implicit or role-based automatic access to any specific company.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results. A user's access settings on one company have no bearing on, and are not visible from, any other company.
- Permission templates are scoped to the owner's account; applying a template only ever affects the single company/grant it is applied to at that time — it does not create an ongoing link between companies.
- All access-grant changes (grant, modify, revoke, ownership transfer) should be captured by the platform's Audit Trail once that capability exists (see Section 7).
# 6. UI / UX Notes
- Platform: Web + Mobile (light). Full grant configuration (folder-level and module-level permission editing, template creation) is web-only. Mobile supports lighter-weight actions: viewing current deal team/access at a glance and granting a quick role-based default (no granular editing) per the platform's mobile scope rule.
- Wireframe reference: N/A
Owner-facing view: an “Access” tab on the company profile listing all users with access, their role, and a summary of their permission scope (ties into SE - 0003 Deal Team tab). Selecting a user opens a permission editor showing the Data Room folder tree (toggle per folder/document) and a module list (toggle per module/tab). A “Save as Template” action and a “Apply Template” dropdown appear in the editor. Granted-user-facing view: Data Room and module navigation simply omit/hide anything not enabled — no disabled/greyed-out items that reveal the existence of hidden content.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| SY - 0001 | Depends on | Company Access Setup uses the user's system role from SE - 0001 as the basis for the default permission set on a new grant. |
|  |  |  |
| DR - 0001 / DR - 0002 | Depends on | Folder-level permission toggles require the Data Room's folder/document structure to exist. |
| Onboarding / Invite Flow (cross-cutting gap) | Depends on | Granting access to a user who is not yet on the platform requires an invite/activation mechanism, which does not yet have its own feature ID. |
| Audit Trail (cross-cutting gap) | Depends on | Full logging of every grant/revoke/modify/ownership-transfer event should live in the Audit Trail capability once specced, rather than being built one-off here. |
| BR - 0002 (NDA) | Related | NDA-gating on data room access is a related but separate access-control mechanism (signature-based rather than role/permission-based). |

# 8. Out of Scope / Deferred
- Defining the system-wide role list itself and what a role determines outside of a specific company (base dashboard, nav, account-level permissions) — that belongs to SE - 0001.
- Custom/admin-configurable roles beyond the fixed enum (Broker, Bank, Buyer, Accountant/QoE, Company/Seller, Lawyer, Admin) — deferred to backlog.
- Full activity/audit logging of access changes — belongs to the Audit Trail cross-cutting gap, referenced here as a dependency.
- Invite/activation mechanics for bringing a brand-new (not-yet-registered) user onto a company — belongs to the Onboarding/Invite Flow cross-cutting gap.
- NDA-gated access enforcement mechanics — covered under BR - 0002.
- Field-level redaction within a document (e.g., masking a PII field inside an otherwise-visible file) — covered under DR - 0004 (Redaction ability), not this feature.
# 9. Open Questions
- What is the exact default permission set per role (e.g., what does a brand-new “Accountant” grant see by default)? Needs a reference matrix before dev can build the default-population logic.
- Can permission templates be shared across owners (e.g., a brokerage-wide “Sell-side Accountant” template), or are they strictly private to the individual owner's account for now?
- When ownership is transferred, does the outgoing owner retain any residual access (e.g., as a regular grantee), or is their access removed entirely unless separately re-granted?
- Should there be a limit on the number of simultaneous grantees per company, or any tiering tied to the referral-based monetization model?
- Does revoking access need a grace/notice period (e.g., for an active QoE engagement), or is it always immediate?
# 10. Acceptance Criteria
- A company owner can grant a new user access to their company, selecting a system role, and the user receives a default permission set based on that role.
- A company owner can independently toggle Data Room folder/document visibility and module/tab visibility for a specific grantee on a specific company.
- A company owner can save a set of permission settings as a named template and apply that template to a different grant, with the ability to adjust individual settings afterward.
- The same user has independently configured, non-conflicting access on two different companies (e.g., sell-side on Company A, buy-side on Company B), confirmed by testing both simultaneously.
- A revoked user immediately loses all access to the company's Data Room and modules upon revocation.
- A user with no grant on a company cannot view, search, or discover that company anywhere in the platform.
- Company ownership can be transferred to another existing user on the company, and the new owner immediately gains full grant/revoke/configure rights.

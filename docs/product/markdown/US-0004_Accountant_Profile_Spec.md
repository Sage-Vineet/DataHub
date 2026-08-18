CENTURIUUM
Feature Specification

| Feature ID | US - 0004 |
|---|---|
| Feature Name | Accountant Profile |
| Module | US - User Set Up |
| Status | Draft |
| Related / Recycled IDs | References SY - 0001 (Role Based Access Setup), SY - 0002 (Company Access Setup) |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
Every user on Centuriuum must have a defined profile and role, and the accountant is a distinct user type from Broker, Bank, Buyer, and Company — but functionally lightweight compared to those profiles. An accountant's role on a deal is limited to performing Quality of Earnings (QoE) work and/or assisting the company with financial data uploads; they do not track deals, submit proof of funds, or search listings. This feature establishes the Accountant Profile as its own role in the system-wide role model (SY - 0001) with a narrow default permission set, so brokers and companies can grant accountants exactly the access they need — QoE and data upload related — without exposing functionality (deal tracker, buyer tools, listings, financing) that is irrelevant to how an accountant uses the platform.
# 2. User Stories
- As an accountant, I want to log in and see only the deals I've been granted access to, so that I can move directly into my QoE or data-upload work without deal-tracking or buy/sell-side clutter.
- As an accountant working across multiple engagements, I want a single login that lists every deal I'm on, so that I can switch between clients without needing separate credentials per deal.
- As a broker, I want to control exactly which modules and tabs an accountant can see on a given deal, so that an accountant only has access to what that specific engagement requires.
- As a company (seller), I want to invite my own accountant onto my deal, so that they can assist with data uploads or QoE work without going through the broker for every access request.
# 3. Functional Requirements
- The system shall provide an "Accountant" role, distinct from Broker, Bank, Buyer, and Company, within the role model defined in SY - 0001.
- The system shall allow an accountant to be onboarded to a deal either by direct invite (from a broker or company user on that deal) or by self-registering on the platform and then requesting access to a specific deal/company, per the onboarding mechanics defined in SY - 0005 and the not-yet-specced Onboarding / Invite flow gap.
- The system shall require an explicit access grant, per SY - 0002 (Company Access Setup), before an accountant can view any deal — an accountant record with no active grant shall have no visible deals.
- The system shall support a single accountant account being granted access to multiple, separate deals/companies, and shall present the accountant with a list/dashboard of all deals they are currently granted access to.
- The system shall enforce full deal isolation for accountants exactly as for every other role: an accountant on Deal A shall see no data, documents, or activity from Deal B, even though both appear on their multi-deal dashboard.
- The system shall NOT enable, by default, the Deal Tracker, Proof of Funds, or Deal/Business Search functionality for the Accountant role.
- The system shall allow the broker or company (whichever party controls access on that deal, per SY - 0002) to configure, per deal, which specific modules/tabs an accountant can see (e.g., Data Room upload, QoE workbook, specific QoE tabs, Reports).
- The system shall treat the QoE module's paid/active status as a property of the company/deal engagement, not of the accountant role — an accountant's access to the QoE module shall depend on (a) whether QoE is an active, paid engagement on that deal, and (b) whether the broker/company has made the QoE module visible to that accountant, with both conditions required.
- The system shall allow an accountant with an active data-room grant to upload documents to the deal's data room, consistent with the templated file structure in DR - 0002 and the OCR pipeline assumption for scanned uploads.
- The system shall log all accountant logins, uploads, and document views to the platform-wide Activity & Audit Log (SY - 0003).
- The system shall NOT display Broker-only tools (Buyer List Builder, Teaser Distribution, Outreach Pipeline, Fee Management, etc.) or Buyer/Bank-only tools to any user under the Accountant role, regardless of per-deal module visibility settings.
# 4. Data Requirements
What tables/fields does this feature read from or write to? Reference the relevant Database module table blocks (DB - 0001 through DB - 0010) wherever applicable.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| User account & role type (Accountant) | Read/Write | DB - 0001 (Table Structure) / SY - 0001 (Role Based Access Setup) |
| Company/deal access grant (which deals this accountant can see) | Read/Write | SY - 0002 (Company Access Setup) |
| Per-deal feature-visibility flags (e.g., QoE tab visible/hidden, Data Room visible/hidden) | Read | SY - 0002 (Company Access Setup) — set by broker/company per deal |
| QoE engagement paid/active status for the deal | Read | QE module (Executive Summary/Tracker, QE - 0005) — set at the company/deal level, not per accountant |
| GL data, Trial Balance, uploaded source documents | Read/Write (upload only; no reclass authority) | DB - 0002 (GL Data), DB - 0004 (Trial Balance), DR - 0001 (Core Data Room) |
| QoE workbook tabs (SDE/EBITDA, Working Capital, Concentration, etc.) | Read/Write where access is granted | QE module (QE - 0004 through QE - 0015) |
| Activity log entries for accountant logins, uploads, and document views | Write | SY - 0003 (Activity & Audit Log) |

# 5. Access & Security
- Roles with access: Accountant (subject to per-deal grant from Broker or Company).
- Roles explicitly excluded from managing an accountant's access: Bank, Buyer — neither can grant or configure accountant access to a deal.
- Per-deal module/tab visibility for an accountant is configured by whichever party controls access on that deal (Broker or Company) via SY - 0002; the accountant cannot self-elevate their own visibility.
- QoE module access additionally requires that QoE be an active, paid engagement on that specific deal; this status is not something the broker toggles on/off per accountant — it is a property of the deal/company engagement itself.
- Deal isolation confirmed: this feature is scoped to a single company/deal per access grant. An accountant with grants on multiple deals sees a list of those deals, but no cross-deal or cross-company visibility of data, documents, or search results is permitted between them.
# 6. UI / UX Notes
- Platform: Web + Mobile (light) — full QoE workbook and data-room upload/review work is web-only, consistent with the mobile-as-companion decision in the conventions doc; mobile may support lighter actions such as viewing deal status or receiving an access invite.
- Wireframe reference: N/A — to be added when available.
On login, an accountant with grants on more than one deal lands on a simple deal-list/dashboard view (deal name, company, and their role on that engagement — e.g., "QoE support") rather than the fuller deal-tracker style dashboard used by brokers. Selecting a deal takes the accountant directly into whichever modules have been made visible to them for that deal (e.g., straight into the Data Room upload screen or the QoE workbook), rather than a generic company profile landing page. Modules not enabled for the accountant on a given deal should not appear in navigation at all, rather than appearing disabled/greyed out, to avoid implying access that doesn't exist.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| SY - 0001 | Depends on | Role Based Access Setup must exist first to define the Accountant role and its default permission set within the system-wide role model. |
| SY - 0002 | Depends on | Company Access Setup is what actually grants an accountant access to a specific deal and controls which modules/tabs the broker or company has toggled visible for that accountant on that deal. |
| SY - 0005 | Depends on | User Creation covers both onboarding paths (invite-based and self-registration) referenced in this spec. |
| Onboarding / Invite flow (cross-cutting gap) | Depends on | The mechanics of how an invite is issued, how a self-registered accountant requests access, and how that request is approved are not yet specced as their own feature. Logged as an Open Question below. |
| QE module (QE - 0001 through QE - 0015) | Depends on | Accountant's QoE-related work (data uploads, workbook access) operates inside the existing QoE module features; this spec does not redefine QoE functionality, only the accountant's access to it. |
| DR - 0001 | Depends on | Core Data Room must exist for the accountant's upload/view permissions to have somewhere to apply. |
| SY - 0003 | Blocks (feeds into) | Accountant activity (logins, uploads, views) must be captured in the platform-wide Activity & Audit Log. |

# 8. Out of Scope / Deferred
- Deal Tracker functionality (BR - 0001) — not applicable to the Accountant role.
- Proof of Funds / Buyer Qualification (BY - 0007) — not applicable; accountants are not buyers.
- Deal/business search and listings (BY - 0001, BY - 0004, BR - 0003) — not applicable to the Accountant role.
- The specific approval workflow for a self-registered accountant's access request (who approves it, notification mechanics, timeout/expiration of a pending request) — this belongs to the Onboarding / Invite flow cross-cutting gap and is not defined here.
- The mechanics of turning the QoE engagement itself on/off (billing, payment collection, engagement activation) — this belongs to the QoE module and/or Referral / Commission tracking gap, not this profile spec.
- The specific list of QoE sub-tabs a broker can toggle individually — assumed to follow whatever tab structure the QoE module (QE - 0001 through QE - 0015) ultimately ships with; not enumerated here.
# 9. Open Questions
- The Onboarding / Invite flow gap (per the conventions doc) needs to define exactly how a self-registered accountant's access request reaches the broker/company for approval, and what the accountant sees while a request is pending.
- Should an accountant be able to belong to the same deal in two different capacities simultaneously (e.g., invited by the company for QoE support, but the broker separately wants to restrict certain financial detail from them), or is one grant per accountant per deal sufficient?
- When QoE is not an active/paid engagement on a deal, should the accountant see a disabled/upsell state for the QoE module, or should the module simply not appear at all?
# 10. Acceptance Criteria
- An Accountant role exists in the system, distinct from Broker, Bank, Buyer, and Company, with no Deal Tracker, Proof of Funds, or Deal Search functionality enabled by default.
- An accountant can be onboarded to a deal via broker/company invite or via self-registration plus an access request, and gains no visibility into any deal until a grant exists.
- An accountant with grants on multiple deals sees a single dashboard listing all their deals, with full data isolation enforced between them.
- A broker or company can configure, per deal, which modules/tabs (e.g., Data Room, QoE) are visible to a given accountant, and the accountant's navigation reflects only what's enabled.
- An accountant's access to the QoE module is gated both by the per-deal visibility setting and by whether QoE is an active, paid engagement on that deal.
- All accountant logins, uploads, and document views are captured in the Activity & Audit Log.

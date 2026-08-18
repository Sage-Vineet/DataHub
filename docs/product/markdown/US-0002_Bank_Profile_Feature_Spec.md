CENTURIUUM
Feature Specification

| Feature ID | US - 0002 |
|---|---|
| Feature Name | Bank Profile |
| Module | US - User Set Up |
| Status | Draft |
| Related / Recycled IDs | Related to BK - 0001 (Bank Profile module purpose); Dependency on future deal-referral, notifications, and buyer-network features |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
The Bank Profile establishes a dedicated, deal-scoped login for bank/lending representatives who have been given access to a specific deal for underwriting purposes. Rather than banks browsing the platform generally, access originates from an explicit financing-assistance request triggered by a broker or buyer on a deal, which then provisions the bank user (new or existing) into that deal only. This matters because Centuriuum's monetization model depends on controlling and tracking lead flow to lending partners so referral fees can be attributed correctly, and because bank users must never see deal data beyond what they've been explicitly granted.
This spec covers only the account setup, role definition, and deal-scoped access model for the Bank profile. The dashboard/feed of referred deals, the underlying financing-request trigger, and the buyer contact/network capability are named as dependencies and open questions, but are not designed here — they will be specced separately once their own architectural questions are resolved.
# 2. User Stories
- As a bank representative, I want to log in and see only the deal(s) I've been explicitly granted access to, so that I never see confidential data from deals unrelated to me.
- As a bank representative, I want to be notified when a broker or buyer requests financing assistance on a deal, so that I can respond promptly and capture the lead.
- As a broker, I want bank users to only see the deal I've referred them to, so that referral fee attribution and confidentiality are protected.
- As a bank representative, I want to add individual buyer contacts I already know to a private list, so that I can keep track of my own relationships without seeing the platform's full buyer directory.
# 3. Functional Requirements
- The system shall create a distinct "Bank" role at account creation, separate from Broker, Buyer, Accountant, and Company roles, per SY - 0001.
- The system shall provision a bank user's access to a deal only through an explicit grant event (e.g., a financing-assistance request or an equivalent invite action), never through open browsing or self-registration into a deal.
- The system shall restrict a bank user's visible deals to only those companies/deals for which they hold an active access grant under SY - 0002.
- The system shall capture, at minimum, the following fields on the Bank Profile: representative name, email, institution name, and primary contact phone (all other lending-specific fields are out of scope for this spec).
- The system shall log every bank user login and every deal view event to the Activity & Audit Log (SY - 0003).
- The system shall allow a bank user to add an individual buyer as a private contact by entering that buyer's email or name; if a matching platform buyer profile exists, the system shall surface the match for the bank user to confirm before any connection or messaging is enabled.
- The system shall NOT expose a searchable or browsable directory of platform buyers to bank users under any circumstance.
- The system shall NOT display a bank user's added buyer contacts to any other bank, broker, or buyer account.
- The system shall revoke a bank user's access to a deal when the corresponding access grant is revoked or expires, consistent with SY - 0002.
# 4. Data Requirements
Traces to Database module table blocks (DB - 0001 through DB - 0010) wherever applicable.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| User account record (name, email, role = Bank, credentials) | Write | DB - 0001 Table Structure (platform user table); provisioned via SY - 0005 User Creation |
| Company/Deal access grant (bank ↔ deal, scope, granting user, timestamp) | Read/Write | SY - 0002 Company Access Setup |
| Bank institution profile (institution name, NMLS/license info if captured, primary contact) | Write | DB - 0001 Table Structure (platform user/profile table) |
| Financing request record (deal, requesting party, date, status) | Read | Future BK dependency - see Dependencies and Open Questions |
| Buyer contact match record (bank-entered identifier ↔ matched platform buyer profile) | Read/Write | DB - 0001 Table Structure (platform user table, for match lookup only) |
| Access & audit events (login, deal view, grant/revoke) | Write | SY - 0003 Activity & Audit Log |

# 5. Access & Security
- Roles with access: Bank (this profile). Broker retains administrative control over which deals a bank user can see.
- Roles explicitly excluded: Buyer, Company, Accountant users cannot view or manage another party's Bank Profile or its deal grants.
- A bank user's access to any given deal must be explicitly and individually granted — there is no default or inherited visibility across deals, even for repeat referrals from the same broker.
- Deal isolation confirmed: this feature is scoped to a single company/deal per grant. No cross-deal or cross-company visibility of data, documents, or search results. A bank user working multiple referred deals sees each as an isolated context with no ability to compare or cross-reference confidential data between them.
- Buyer contact matching (Section 3) must not leak the existence, activity, or profile data of any platform buyer who has not been explicitly matched and confirmed by name/email lookup — no fuzzy search or suggestion list.
# 6. UI / UX Notes
- Platform: Web + Mobile (light). Full deal review and document access remain web-only; mobile covers lighter actions such as checking deal status or responding to a financing request notification, consistent with the platform-wide mobile scope decision.
- Wireframe reference: N/A
On login, a bank user should land on a simple list/dashboard of the deal(s) they currently have access to, with status and any pending action clearly flagged. The specific layout, sorting, and "new/recommended" treatment of that dashboard is deferred to the dependency noted below rather than designed here.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| SY - 0005 (User Creation) | Depends on | Bank users are created via data room invite (triggered by a financing request) or platform sign-up; this spec assumes SY - 0005 governs the creation mechanics. |
| SY - 0002 (Company Access Setup) | Depends on | Deal-level access grants for bank users are governed by this module; US - 0002 only defines the bank-side profile and view. |
| SY - 0001 (Role Based Access Setup) | Depends on | Bank is a distinct platform role; permissions/dashboard differences by role are defined there. |
| SY - 0003 (Activity & Audit Log) | Depends on | All bank logins, deal views, and access events must be logged here. |
| Financing Request / Referral flow (cross-cutting gap - not yet a feature ID) | Depends on | The 'request financing assistance' trigger described in BK - 0001 that populates the bank's referred-deal feed does not yet have its own spec. Logged as an Open Question below. |
| Notifications Hub (known cross-cutting gap) | Depends on | Email/in-app notification to a bank user when a new deal is referred to them relies on the platform-wide notifications system, not a local notification built into this feature. |
| Buyer Network / Contact Matching (future feature ID, out of scope here) | Blocks | The bank-side buyer relationship/contact feature described by Josh is deferred to its own spec; this document only reserves the dependency. |

# 8. Out of Scope / Deferred
- The financing-assistance request/referral trigger itself (who can initiate it, what data is passed to the bank, notification mechanics) — deferred to a future spec; this document assumes the trigger exists and only defines what happens to the Bank Profile once a grant occurs.
- The bank's deal dashboard, including any "recommended" or "new deal" surfacing logic — explicitly deferred; Josh confirmed only referred (inbound) deals apply, but the dashboard UI/UX itself is a separate spec.
- Buyer network / matching logic beyond simple private contact-adding — no CRM-style directory, no platform-wide buyer search, and no automated buyer-deal matching are part of this spec.
- SBA/lender-ready valuation output and lender requirement checklists — covered separately in VL - 0007 and DR - 0005.
- Referral fee calculation and payment tracking — covered separately under SY - 0006 (Referral Tracking).
# 9. Open Questions
- The financing-assistance request flow referenced in BK - 0001 (who can trigger it, from where, and what deal data is passed to the bank) has no feature ID yet. Should this be scoped as its own spec before or alongside the bank dashboard?
- Can a single bank institution have multiple representatives on the same deal (e.g., a loan officer and an underwriter), and if so, do they share one access grant or each require an individual one?
- Should there be a minimum verification step (e.g., confirming the representative's employment at the named institution) before a bank account is activated, given the sensitivity of the financial data they'll access?
- When a bank user adds a buyer contact and a match is confirmed, what specific communication capability should exist between them (in-platform messaging vs. simply exposing shared visibility on a deal)? This affects whether Notifications Hub is a hard dependency for this spec or the future network spec.
# 10. Acceptance Criteria
- A user can be created with the Bank role and cannot see any deal until an access grant exists for that specific deal.
- A bank user with access to Deal A cannot see, search, or infer the existence of Deal B, even if referred by the same broker.
- All bank logins and deal views appear correctly in the Activity & Audit Log with timestamp and user identity.
- A bank user can add a buyer contact by email/name; if no match exists, no error or directory data is exposed; if a match exists, the bank user sees only a confirmation prompt, not the buyer's profile details, until confirmed.
- No bank user, under any account state, can browse a list of all platform buyers.

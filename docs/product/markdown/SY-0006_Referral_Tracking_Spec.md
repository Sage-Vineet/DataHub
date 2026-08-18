CENTURIUUM
Feature Specification

| Feature ID | SY - 0006 |
|---|---|
| Feature Name | Referral Tracking |
| Module | SY - System |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
Centuriuum's monetization model is referral-based rather than subscription-per-seat: revenue comes from fees paid by third-party referral providers (accountants, business brokers, banks, insurance brokers, and other value-stream partners) when the platform connects them to a deal or a user. Today there is no system-level mechanism to record who introduced whom, on which deal, or to confirm that a paid referral relationship exists — meaning referral revenue is fully dependent on manual memory and informal tracking, which does not scale and is not auditable.
This feature establishes the backend data model and tracking mechanism that lets any user with the appropriate role log a referral connection to a referral-provider profile, tie it to a specific company/deal, and follow its status over time. It is the record-keeping layer only: it establishes on a system level who contacted whom, for what purpose, and under what referral status. Payment collection, escrow handling, and any standardized public-facing referral-provider profile page are explicitly out of scope for this spec and are called out as dependencies below.
# 2. User Stories
- As a broker, I want to log that I referred the company to an accountant, bank, or insurance broker on a specific deal, so that Centuriuum can track and later collect the associated referral fee.
- As an accountant, bank representative, or insurance broker (referral provider), I want my referral relationships to be visible on the deals I've been connected to, so that I can see which introductions are attributable to me.
- As a Centuriuum admin, I want to see all referral records across the platform with their status and (where entered) fee amount, so that I can reconcile who is owed a referral fee and follow up for collection.
- As a broker, I want to update the status of a referral I logged (e.g., contacted, engaged, closed, fee collected), so that the record reflects where that relationship actually stands.
# 3. Functional Requirements
- The system shall allow a user holding an eligible role (Broker, Company, Bank, Accountant, or Admin — see Section 5) to create a Referral record from within a deal, selecting a Referring User, a Referred-To Provider (an existing platform user/profile flagged as a referral provider), and a Referral Type (Accountant, Business Broker, Bank/Lender, Insurance Broker, Other).
- The system shall require every Referral record to be associated with exactly one Company/Deal at creation; a referral cannot be logged without a deal context.
- The system shall capture a Referral Status field with, at minimum, the values: Logged, Contacted, Engaged, Closed, Fee Collected, and Cancelled/Void, and shall record a timestamp and the acting user for every status change.
- The system shall record, for every Referral, a creation timestamp, the creating user, and an immutable log of all edits (status changes, fee amount changes) consistent with the platform-wide activity log.
- The system shall include an optional Referral Fee Amount field (numeric, currency) and an optional Fee Basis/Notes free-text field on each Referral record, for future use; no payment processing, invoicing, or escrow functionality is triggered by populating this field in this version.
- The system shall allow a user to mark a Referral as the reason a given provider was granted access to a deal, linking the Referral record to the corresponding access grant made under SY - 0002, where applicable.
- The system shall prevent duplicate active Referral records for the same Referring User + Referred-To Provider + Company/Deal combination, and shall warn the user if a matching record already exists before allowing a new one to be created.
- The system shall allow filtering and searching of Referral records by Company/Deal, Referring User, Referred-To Provider, Referral Type, and Status, scoped to what the requesting user's role and deal access permit (see Section 5).
- The system shall notify the Referred-To Provider (via the notifications mechanism referenced in Section 7) when a new Referral naming them is logged, and shall notify the Referring User whenever the Referral's status changes.
- The system shall NOT process, hold, or transfer any funds; referral payment and escrow are out of scope for this feature (see Section 8).
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Referral ID (PK) | Write | New Referral table — proposed extension to DB - 0001 table structure |
| Referring User ID | Read/Write | User table (SY - 0001 role-based access setup) |
| Referred-To Provider ID | Read/Write | User/Profile table (US - 0001 through US - 0005 profiles) |
| Company/Deal ID | Read/Write | Company Profile module (CP - 0001) / deal record |
| Referral Type | Write | New Referral table (enumerated: Accountant, Broker, Bank, Insurance Broker, Other) |
| Referral Status | Read/Write | New Referral table |
| Status Change History | Write | New Referral Status Log table, tied to platform Activity & Audit Log (SY - 0003) |
| Referral Fee Amount (optional) | Read/Write | New Referral table — placeholder field, no linkage to a payments/ledger table in this version |
| Fee Basis / Notes (optional) | Read/Write | New Referral table |
| Linked Access Grant (optional) | Read | Company Access Setup (SY - 0002) |

# 5. Access & Security
- Roles with access: Broker, Company, Bank, Accountant, and Admin/internal ops may create and view Referral records for deals they are already permitted to access.
- A user may only create a Referral naming themselves as the Referring User, or, for Admin, on behalf of another user with that user's role recorded accurately in the record.
- A Referred-To Provider may view Referral records that name them, but may not edit the Referral Type, Fee Amount, or delete the record — only the Referring User or an Admin may edit those fields; status may be updated by either party with the change attributed to the acting user.
- Roles explicitly excluded: Buyer users do not have access to Referral records unless also holding a Broker or Admin role on that deal.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of Referral records or referral history is permitted through this feature.
# 6. UI / UX Notes
- Platform: Web only. Referral logging and management is an administrative/back-office workflow and is not part of the mobile-light feature set defined in the conventions doc.
- Wireframe reference: N/A
Referral creation should be accessible from within a deal (e.g., a "Log Referral" action from the deal team or activity view referenced in DR - 0009), rather than as a standalone top-level menu item, so the deal context is always attached at creation. An Admin-facing Referral list/reconciliation view is expected but its detailed layout is deferred to the Admin/internal ops console spec (see Dependencies).
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| SY - 0002 (Company Access Setup) | Depends on | Referral records may link to the access grant a referral resulted in. |
| SY - 0003 (Activity & Audit Log) | Depends on | All Referral creation, edits, and status changes should write to the platform-wide audit log. |
| Notifications Hub (cross-cutting gap) | Depends on | Referral-created and status-change notifications require the unified notifications system, which does not yet have a Feature ID. |
| Onboarding / Invite Flow (cross-cutting gap) | Depends on | A user cannot be selected as a Referred-To Provider unless they already exist on the platform; how an un-onboarded referral provider gets invited is not yet specced. |
| Referral / Commission Payment & Escrow (future feature) | Blocks | Payment collection, escrow holding, and fee release logic described by Josh are explicitly deferred to a separate, not-yet-specced feature. |
| Admin / Internal Ops Console (cross-cutting gap) | Depends on | The reconciliation view Admin needs to see all referrals platform-wide belongs in the internal ops console, not yet specced. |

# 8. Out of Scope / Deferred
- Payment processing, invoicing, and escrow holding/release of referral fees — deferred to a separate Referral Payment & Escrow feature. This spec only stores an optional fee amount as a data placeholder.
- A standardized public-facing referral-provider "profile" page (credentials, bio, service area) — deferred to a separate profile feature; this spec only requires that a Referred-To Provider already exist as a platform user.
- Automatic detection of referral events from platform activity (e.g., inferring a referral from an access grant without a user explicitly logging it) — this version is manual-tagging only, per Josh's direction.
- Cross-brokerage or platform-wide referral leaderboards/analytics — may be addressed later as part of firm-level reporting (RP module).
# 9. Open Questions
- Should Referral Type be a fixed enumerated list, or should it be configurable by an Admin as new referral-provider categories are added?
- When the Notifications Hub is specced, confirm whether referral notifications should be email-only, in-app-only, or both by default.
- When the Onboarding/Invite flow is specced, confirm whether logging a referral to a not-yet-onboarded provider should auto-trigger an invite, or require the provider to already have an account.
- Confirm whether a referral fee should ever be expressed as a percentage/formula (e.g., tied to a closing fee per BR - 0012) rather than only a flat placeholder amount, once the payment feature is specced.
# 10. Acceptance Criteria
- A Broker, Company, Bank, or Accountant user can create a Referral record on a deal they have access to, specifying Referring User, Referred-To Provider, Referral Type, and Company/Deal.
- A Referral cannot be created without a Company/Deal association, and duplicate active referrals for the same user/provider/deal combination are flagged before creation.
- Referral Status can be updated by the Referring User, the Referred-To Provider, or an Admin, with every change timestamped and attributed in the audit log.
- An optional Fee Amount and Fee Basis/Notes can be entered and edited on a Referral record without triggering any payment action.
- Referral records are visible only to users with deal access and an eligible role, per Section 5, with no cross-deal visibility.
- Referral records can be filtered by Deal, Referring User, Referred-To Provider, Type, and Status.

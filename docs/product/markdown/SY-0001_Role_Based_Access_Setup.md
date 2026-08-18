CENTURIUUM
Feature Specification

| Feature ID | SY - 0001 |
|---|---|
| Feature Name | Role Based Access Setup |
| Module | SY - System |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
Centuriuum serves several distinct user types — brokers, accountants, buyers, banks, and companies — each of whom needs a different lens into the platform. Without knowing why a user is on the system, Centuriuum has no way to steer them toward relevant workflows or away from irrelevant ones (e.g., an accountant doing QoE work has no reason to see a marketplace of businesses for sale).
Role Based Access Setup captures a user's self-identified purpoSY - their profile type — at signup, and uses it to configure their default dashboard and navigation. This is a UI/navigation convenience layer: it does not itself grant or restrict access to any deal, company, or document. Actual data-level security is governed separately by SE-0002 (Company Access Setup).
This feature applies to both self-service signup (a member of the public registers directly on Centuriuum's website) and invited signup (a user is brought onto a specific deal by a broker or other deal owner).
# 2. User Stories
- As a new user signing up on the public site, I want to identify my profile type (Broker, Accountant, Buyer, Bank, or Company) during signup, so that the system shows me a dashboard relevant to what I'm trying to do.
- As an invited user joining a specific deal, I want to confirm my profile type as part of accepting my invitation, so that my experience on the platform matches my role even though I didn't sign up independently.
- As a broker, I want to see deal tracking, listing, and referral-oriented navigation by default, so that I'm not wading through irrelevant screens built for other profile types.
- As an accountant, I want my default dashboard to surface data-room and financial analysis tools rather than a marketplace of businesses for sale, so that my workflow stays focused.
- As a user whose role has changed (e.g., a broker who becomes primarily a buyer), I want to update my profile type in account settings, so that my default navigation stays relevant without needing a new account.
# 3. Functional Requirements
- The system shall require every new user to select exactly one Profile Type from a fixed list (Broker, Accountant, Buyer, Bank, Company) as part of account creation, whether via public self-signup or an invitation-based signup flow.
- The system shall not allow account creation to complete without a Profile Type being selected.
- The system shall store the selected Profile Type on the user's account record.
- The system shall use the stored Profile Type to determine the user's default landing dashboard and default navigation/menu configuration upon login.
- The system shall allow a user to change their own Profile Type at any time via account settings.
- The system shall apply a changed Profile Type's default navigation starting from the user's next login or next navigation refresh, without requiring account recreation.
- The system shall log each Profile Type change with the prior value, new value, changed-by user, and timestamp.
- The system shall treat Profile Type strictly as a navigation/UI default and shall not use it as the basis for granting or restricting access to any specific company, deal, document, or record — that is governed exclusively by SE-0002.
- The system shall allow exactly one Profile Type per user account at a time (no multi-select).
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| User.ProfileType (enum: Broker, Accountant, Buyer, Bank, Company) | Read / Write | DB - 0001 (User / Account table) |
| User.ProfileTypeHistory (prior value, changed by, timestamp) | Write | DB - 0001 (User / Account table) or Audit Trail store (see Dependencies) |
| NavigationConfig (profile type → dashboard/menu mapping) | Read | Application config / lookup table, not deal-specific data |

# 5. Access & Security
- Roles with access: All profile types (Broker, Accountant, Buyer, Bank, Company) — every user completes this setup regardless of type.
- Roles explicitly excluded: None — this is a universal account-setup step, not a deal-scoped or role-gated feature.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
Note: Profile Type itself is account-level, not deal-level, and carries no inherent data access. The deal-isolation statement above is retained per house rules and is satisfied trivially here since this feature grants no company/deal data access — that is fully governed by SE-0002.
# 6. UI / UX Notes
- Platform: Web + Mobile (light) — profile type selection must be completable during mobile-based invite acceptance, per the platform's mobile-light scope; changing profile type later is expected primarily on web but should not be blocked on mobile.
- Wireframe reference: N/A
Profile Type selection is presented as a single required dropdown (or equivalent single-select control) labeled with a plain-language purpose statement per option, e.g. “I am a broker who will use the system,” “I am an accountant who will use the system,” “I am a business buyer,” etc. — rather than raw role labels alone, to keep the choice legible to non-technical users.
Once selected, the choice drives which default dashboard/navigation set loads at login. Editing the Profile Type later should live in Account Settings, clearly labeled (e.g., “What brings you to Centuriuum?”) so the user understands they're changing their experience, not their access.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| Onboarding / Invite Flow (cross-cutting gap, no Feature ID yet) | Depends on | SE-0001 must plug into both the public self-signup path and the invited-user path once that flow is specced; profile type selection happens inside whichever flow the user enters through. |
| SY - 0002 (Company Access Setup) | Blocks | SE-0001 establishes the user's login-level profile type and default navigation only. SE-0002 governs actual data/company-level access grants, which can override or narrow what a profile type would otherwise show. |
| Admin / Internal Ops Console (cross-cutting gap, no Feature ID yet) | Depends on | Support staff will need a way to view or override a user's profile type (e.g., correcting a mis-selected signup) until self-service editing covers all cases. |

# 8. Out of Scope / Deferred
- Actual data/document/company-level access control — belongs to SE-0002 (Company Access Setup).
- Deal-team visibility and roles within a specific company profile — belongs to SE-0003 (Deal Team).
- The mechanics of the invitation flow itself (how an invited user receives and accepts an invite) — belongs to the Onboarding / Invite Flow cross-cutting gap, not yet specced.
- Support/admin override of a user's Profile Type — belongs to the Admin / Internal Ops Console cross-cutting gap, not yet specced.
- Support for a user holding multiple simultaneous profile types on one account — explicitly excluded per product decision; a user needing to act in more than one capacity uses separate accounts or relies on SE-0002 grants for deal-specific role variation.
# 9. Open Questions
- The Onboarding / Invite Flow gap needs its own spec to define exactly how/when Profile Type is presented to an invited user (at invite acceptance vs. first login) — logged here per house rules rather than assumed.
- Should any Profile Type change trigger a notification to the user or to platform admins, once the Notifications Hub (cross-cutting gap) exists? Deferred until that hub is specced.
- Is there a need for a sixth Profile Type option, or a way to add new profile types later, without a code release (e.g., an admin-managed lookup table vs. a hardcoded enum)? Recommend hardcoded enum for MVP but flagging for confirmation.
# 10. Acceptance Criteria
- A new user cannot complete self-service signup without selecting exactly one Profile Type from the required list.
- An invited user is presented with the same Profile Type selection as part of their invitation-acceptance flow.
- Upon first login, each Profile Type routes the user to its correct default dashboard/navigation set, verified for all five types (Broker, Accountant, Buyer, Bank, Company).
- A logged-in user can change their Profile Type from Account Settings, and the new default navigation takes effect without requiring a new account.
- Every Profile Type change is recorded with prior value, new value, changed-by user, and timestamp, and is retrievable for audit purposes.
- Changing a user's Profile Type does not grant, remove, or alter access to any specific company or deal record — confirmed by testing that SE-0002-governed access is unaffected by a Profile Type change.

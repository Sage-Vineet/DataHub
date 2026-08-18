CENTURIUUM
Feature Specification

| Feature ID | US - 0003 |
|---|---|
| Feature Name | Business Buyer Profile |
| Module | US - User Set Up |
| Status | Draft |
| Related / Recycled IDs | Touches BY - 0001, BY - 0002, BY - 0004, BY - 0007, BR - 0003, BR - 0008 |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
Business buyers currently have no home base on the platform for the two things that actually drive whether they close a deal: proving they can pay for one, and finding one that fits. This feature builds the Business Buyer Profile — the dashboard a buyer sees on login — around three jobs: strengthening their funding case (a lending profile that feeds the buyer qualification grading in BY - 0007), finding active listings that match their stated acquisition criteria (a Buy Box), and tracking the deals they already have data room access to. Getting buyers to self-populate a credible lending profile also strengthens Centuriuum's bank-referral pipeline, since a document-verified buyer is a materially more qualified lead than a self-reported one.
# 2. User Stories
- As a business buyer, I want to build one or more Buy Boxes describing the industries, size range, and geography I'm targeting, so that I can filter deals down to only what's actually relevant to me.
- As a business buyer, I want to fill out my lending/funding profile and upload supporting documents, so that I appear as a more credible, qualified buyer to brokers and can get pre-qualified by a bank faster.
- As a business buyer, I want to see my qualification progress as a simple visual indicator, so that I know what's left to strengthen my funding case.
- As a business buyer, I want to browse all active marketplace listings and see a separate 'Matched for You' section based on my Buy Box, so that I can find deals efficiently without a broker having to reach out first.
- As a business buyer, I want to see a list of deals I'm actively involved in with a link into the data room, so that I have one place to track everything I currently have access to.
# 3. Functional Requirements
- The system shall allow a buyer to create, edit, deactivate, and delete one or more named Buy Boxes, each capturing industry/NAICS, revenue range, EBITDA/SDE range, geography, and deal structure preference.
- The system shall allow a buyer to mark each Buy Box as active or inactive; only active Buy Boxes shall be used for listing matches and BY - 0003 notification triggers.
- The system shall provide a lending/funding profile form capturing, at minimum: liquid capital available, source of equity, financing type (personal, fund, SBA-backed, seller-financed expectation), and — for sponsors — fund name, vintage, committed capital, and dry powder.
- The system shall allow a buyer to upload supporting documents to the lending profile, including bank/brokerage statements and a lender pre-qualification letter, routed through the redaction capability in DR - 0004.
- The system shall NOT independently compute a qualification grade; it shall display the qualification status (unverified / self-reported / document-verified / lender pre-qualified) as computed by BY - 0007, rendered as a progress-wheel visual on the buyer dashboard.
- The system shall display a 'Browse Active Listings' view showing all public marketplace deal listings sourced from BR - 0003, filterable by the buyer's active Buy Box criteria.
- The system shall display a separate 'Matched for You' view showing curated deals surfaced to this specific buyer by a broker's matching/suggestion logic (BR - 0007), visually distinct from the open marketplace view.
- The system shall display a 'My Active Deals' view listing every deal for which this buyer currently holds an executed NDA and active data room access, sourced directly from existing permission grants (BR - 0008 / SE - 0002).
- The system shall NOT grant, modify, or revoke data room access from within the Business Buyer Profile; all access changes shall originate from the broker-side NDA/access-grant workflow in BR - 0008.
- The system shall display, for each deal in 'My Active Deals,' a buyer-safe subset of the pipeline stage from BR - 0009 (e.g., NDA executed, CIM delivered, in diligence) — never internal-only stages or broker notes.
- The system shall trigger a Buy Box match event whenever a new marketplace listing or curated match satisfies an active Buy Box's criteria, for consumption by the Notifications Hub (dependency, not built here).
- The system shall enforce that a buyer can view only their own Buy Boxes, lending profile, and deal lists — no buyer shall be able to view another buyer's profile data.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Buy Box criteria (industry, revenue/EBITDA range, geography, deal structure preference) | Write | Buyer Profile record (see DB - 0001 table structure); multiple buy boxes per buyer |
| Buy Box: saved/named label, active/inactive flag | Write | Buyer Profile record |
| Lending profile fields (liquid capital, source of equity, financing type) | Write | Buyer Profile record; feeds BY - 0007 qualification grade |
| Uploaded lending documents (bank/brokerage statement, lender pre-qual letter, fund details) | Write | Data Room storage, tagged to buyer profile; redaction per DR - 0004 |
| Qualification status (unverified / self-reported / document-verified / lender pre-qualified) | Read | Computed by BY - 0007; displayed as progress wheel |
| Marketplace deal listings (public) | Read | BR - 0003 Deal Listing |
| Curated / matched deal listings for this buyer | Read | Matching engine output against Buy Box criteria; sourced from BR - 0003 and broker-side buyer suggestions in BR - 0007 |
| Active deal access grants (data room) | Read | Existing permission grants from BR - 0008 / SE - 0002; no new grant logic introduced here |
| Deal stage per active deal (for buyer-facing display) | Read | BR - 0009 Outreach Pipeline stage, filtered to buyer-visible stages only |

# 5. Access & Security
- Roles with access: Business Buyer (own profile only).
- Roles explicitly excluded: Broker, Company, Bank, and Accountant users have no access to a buyer's Buy Box or lending profile data through this feature; broker visibility into buyer qualification status is handled separately within BY - 0007 and BR - 0003 pipeline records, not through this profile view.
- Deal isolation confirmed: this feature is scoped to a single company/deal only where applicable (My Active Deals). No cross-deal or cross-company visibility of data, documents, or search results beyond what the buyer's own access grants and public marketplace listings permit.
- Lending profile documents (bank/brokerage statements) are sensitive financial data and shall be stored with the same redaction and access controls defined in DR - 0004; they shall not be visible to any other buyer or to brokers outside the qualification-review context in BY - 0007.
# 6. UI / UX Notes
- Platform: Web + Mobile (light). Full Buy Box creation/editing and document upload occur on web; mobile supports reviewing existing Buy Boxes, checking qualification status, and browsing matched/marketplace listings, consistent with the mobile-light scope defined in project conventions.
- Wireframe reference: N/A — to be created.
Dashboard layout should present three clear zones on login: (1) a lending profile completeness progress wheel with a direct call-to-action to finish remaining items, (2) a listings zone split into 'Matched for You' and 'Browse All Active Listings' tabs, and (3) 'My Active Deals' showing deal name/alias, current buyer-safe stage, and a link into the data room. The qualification progress wheel should visually communicate the four BY - 0007 grade tiers rather than a plain percentage, since the tiers (not raw completeness) are what the platform and brokers act on.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| BY - 0007 (Buyer Qualification & KYC) | Depends on | The lending profile progress wheel is the buyer-facing front end for BY - 0007's document upload, verification, and qualification grading logic. This spec does not re-define the grading engine. |
| BR - 0003 (Deal Listing) | Depends on | Open marketplace listings that populate the 'Browse Active Listings' view come from this feature. |
| BR - 0007 (Buyer List Builder & Tiering) | Depends on | Curated 'Matched for You' listings originate from broker-side buyer matching/suggestion logic in this feature; this spec only renders the buyer-facing result. |
| BR - 0008 (Teaser Distribution & NDA Gating) | Depends on | Data room access shown in 'My Active Deals' is granted exclusively through this feature's NDA-execution flow. This spec has no independent access-granting mechanism. |
| BR - 0009 (Outreach Pipeline & Follow-Up Cadence) | Depends on | Deal stage shown to the buyer is read from the pipeline stage set here, filtered to a buyer-safe subset. |
| SE - 0002 (Permission Model) / DR - 0001 (Core Data Room) | Depends on | Underlying access control and document storage for any deal the buyer can see. |
| Onboarding / Invite Flow (cross-cutting gap) | Depends on | Buyer account creation and initial activation is not yet specced; referenced per house rule rather than designed locally. |
| Notifications Hub (cross-cutting gap) | Blocks | Buy Box match alerts (BY - 0003 Deal Notifications) require the unified notification system to actually deliver alerts; this spec defines the matching trigger but not delivery. |

# 8. Out of Scope / Deferred
- Qualification grading logic itself (document verification workflow, sanctions/PEP screening, grade computation) — belongs to BY - 0007.
- Buy Box-to-listing matching algorithm internals and broker-side buyer suggestion logic — belongs to BR - 0007.
- Granting, modifying, or revoking data room access — belongs to BR - 0008 / SE - 0002.
- Actual delivery of Buy Box match alerts (push/email) — belongs to BY - 0003 and the Notifications Hub cross-cutting gap.
- Buyer account creation/activation and invite flow — belongs to the Onboarding / Invite Flow cross-cutting gap.
- Bank pre-approval decisioning itself — belongs to the Bank Profile module (BK).
# 9. Open Questions
- Notifications Hub does not yet exist as a spec'd feature — Buy Box match triggers are defined here, but delivery mechanism and user notification preferences are unresolved until that gap is addressed.
- Onboarding / Invite Flow is not yet spec'd — how a business buyer's account is first created and activated needs to be resolved before this profile's initial-login state can be fully defined.
- Should a buyer be able to mark a Buy Box as shared/visible to a specific broker directly (versus only being discoverable through BR - 0007's platform-wide matching), or is direct buyer-to-broker Buy Box sharing out of scope entirely?
- Is there a cap on the number of active Buy Boxes a single buyer can maintain, or is this unlimited?
# 10. Acceptance Criteria
- A buyer can create, edit, activate/deactivate, and delete multiple Buy Boxes, and only active Buy Boxes are used in listing matches.
- A buyer can complete their lending profile fields and upload at least one supporting document, and the resulting qualification status displayed matches the status computed by BY - 0007.
- The dashboard displays distinct 'Matched for You' and 'Browse Active Listings' sections, with matched results correctly reflecting the buyer's active Buy Box criteria.
- 'My Active Deals' shows only deals for which the buyer currently holds an executed NDA and active data room access, with no ability to grant or alter access from this view.
- A buyer cannot view another buyer's Buy Box, lending profile, or active deal list under any condition.
- Mobile view supports reviewing Buy Boxes, qualification status, and listings; document upload and Buy Box creation/editing are confirmed as web-only or web+mobile per final UI decision.

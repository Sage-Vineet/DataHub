CENTURIUUM
Feature Specification

| Feature ID | CP - 0002 |
|---|---|
| Feature Name | Post Close |
| Module | CP - Company Profile |
| Status | Draft |
| Related / Recycled IDs | Depends on SY - 0006 (Referral Tracking); related to BY - 0006 (Buyer Profile Post Close) |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
Once a broker closes a deal (marks the company as sold in the Deal Tracker), the former company owner and other company-side stakeholders lose their primary reason to engage with the platform — but they now sit at a high-value moment for follow-on referrals (wealth management, tax planning, estate planning, and other post-liquidity services). This feature introduces a Post Close state on the Company Profile that captures who the closed company's representative(s) are, and gives them a self-service, opt-in path to request an introduction to a wealth manager or other referral partner in the Centuriuum network. This directly supports the platform's referral-based monetization model by extending the referral relationship past the close of the deal rather than ending it at closing.
# 2. User Stories
- As a broker, I want to mark a deal as Closed/Sold, so that the company profile transitions into a Post Close state and the seller can be connected to relevant post-close partners.
- As a company representative (former owner or other designated stakeholder), I want to see suggested referral partners (e.g., wealth managers) after my deal closes, so that I can request an introduction if I choose to.
- As a company representative, I want to explicitly opt in before my contact information is shared with any referral partner, so that I retain control over my post-close privacy.
- As a Centuriuum admin, I want every post-close referral request logged, so that referral fees can be tracked and attributed correctly.
# 3. Functional Requirements
- The system shall allow a broker to manually mark a deal as Closed/Sold from the Deal Tracker (BR - 0001), recording a close date.
- The system shall transition the associated Company Profile (US - 0005) to a Post Close state immediately upon the deal being marked Closed/Sold.
- The system shall support one or more company-side contacts (owner and/or other designated stakeholders) carried forward into the Post Close state.
- The system shall notify the company representative(s) that the deal has closed and that post-close partner options are available, once a notification mechanism exists (see Dependencies).
- The system shall display a list of suggested referral partners (e.g., wealth managers) sourced from the referral network maintained in SY - 0006, filterable or matched by partner type.
- The system shall require the company representative to give explicit, logged opt-in consent before any of their contact information is shared with a specific referral partner.
- The system shall NOT share company representative contact information with any partner absent that explicit opt-in.
- The system shall allow the company representative to request an introduction to a selected partner, generating a referral/introduction request record in SY - 0006.
- The system shall notify the broker when a deal is marked Closed/Sold that the data room's access settings may need to be reviewed, without automatically changing data room permissions.
- The system shall retain the company's existing data room access unchanged upon transition to Post Close, unless the broker manually updates permissions.
- The system shall log the consent event, the partner suggested, and the introduction request event to the Activity & Audit Log (SY - 0003).
# 4. Data Requirements
What tables/fields does this feature read from or write to? Reference the relevant Database module table blocks (DB - 0001 through DB - 0010) wherever applicable so every feature traces back to the reconciled data structure.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Deal status (Closed/Sold flag, close date) | Write | DB - 0001 (Table Structure) — deal record; set by broker via BR - 0001 Deal Tracker |
| Company representative contact(s) (name, role, email, phone) | Read/Write | DB - 0001 — company/user table; sourced from US - 0005 Company Profile |
| Referral partner directory (wealth managers, other value-stream partners) | Read | SY - 0006 (Referral Tracking) — partner/network table |
| Referral opt-in consent record (who consented, what partner type, timestamp) | Write | DB - 0001 — new consent log table; referenced by SY - 0003 Activity & Audit Log |
| Referral / introduction request (requestor, partner, status) | Write | SY - 0006 (Referral Tracking) — referral request queue |
| Post-close notification event | Write | SY - 0004 (Metered Usage / task-notification queue) — triggers company-facing alert |

# 5. Access & Security
- Roles with access: Company (representative/owner and any additional designated stakeholders), Broker (read access to Post Close status and referral activity on their deal).
- Roles explicitly excluded: Bank, Buyer, and Accountant users do not see Post Close referral activity for a company they are not the designated representative of.
- Referral partners (e.g., wealth managers) do not gain any data room or company profile access as a result of this feature — they receive only what is explicitly shared via an opted-in introduction request.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web + Mobile (light) — reviewing Post Close status and requesting an introduction are lightweight actions consistent with the mobile companion scope; managing referral partner detail and consent history is web-only.
- Wireframe reference: N/A
On transition to Post Close, the Company Profile displays a distinct 'Post Close' tab or banner replacing the active-deal view. This surfaces: close date, designated company representative(s), and a card-style list of suggested referral partners with a clear 'Request Introduction' action gated behind an explicit consent checkbox/toggle per partner. The broker's Deal Tracker view shows a passive reminder to review data room access when a deal is marked closed, rather than an automated permission change.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| BR - 0001 (Deal Tracker) | Depends on | Broker manually marks a deal Closed/Sold in the Deal Tracker; this is the sole trigger for CP - 0002 to activate Post Close state on the company profile. |
| SY - 0006 (Referral Tracking) | Depends on | Owns the referral/commission tracking mechanism and the partner directory. CP - 0002 surfaces suggested partners from and writes intro requests to SY - 0006 rather than maintaining its own referral logic. |
| BY - 0006 (Buyer Profile — Post Close) | Related — naming conflict to resolve | VL - 0009's notes reference a 'wealth-manager cross-sell in BY - 0006,' but BY - 0006 as currently described is buyer-side post-close support/cross-sell, not wealth-manager referral specifically. See Open Questions. |
| SY - 0003 (Activity & Audit Log) | Depends on | Consent capture, partner suggestion, and introduction-request events must write to the audit log. |
| US - 0005 (Company Profile) | Depends on | Post Close is a state/tab within the existing Company Profile; assumes company representative records already exist here. |
| Onboarding / Invite flow (cross-cutting gap) | Depends on | Referral partners (wealth managers, etc.) need to be onboarded/invited to the platform before they can receive introduction requests. Not yet specced. |
| Notifications hub (cross-cutting gap) | Depends on | Post-close notification to the company representative and to matched partners should route through the unified notification system once it exists, rather than a one-off local notification. |

# 8. Out of Scope / Deferred
- Automated triggering of Post Close status from a closing funds flow, executed LOI, or other system event — this version is broker-initiated only.
- Referral fee calculation, invoicing, or payment processing — owned entirely by SY - 0006.
- Onboarding/invitation flow for referral partners themselves (wealth managers, etc.) to join the Centuriuum network — belongs to the Onboarding / Invite Flow cross-cutting gap.
- Automated or forced changes to data room permissions upon Post Close — broker retains manual control.
- Buyer-side post-close cross-sell — owned by BY - 0006 (Buyer Profile Post Close), pending resolution of the BY - 0006 / wealth-manager naming conflict noted above.
# 9. Open Questions
- VL - 0009's notes reference a 'wealth-manager cross-sell in BY - 0006,' but BY - 0006 as currently scoped is buyer-side, not seller/company-side. Should the wealth-manager referral live only in CP - 0002 (company/seller side), only in BY - 0006 (buyer side), or both — and if both, do they share the same underlying SY - 0006 partner directory and request flow?
- Should there be a time limit or expiration on how long a company profile remains active/reachable in Post Close state, or does it persist indefinitely?
- Who curates the referral partner directory in SY - 0006 (Centuriuum admin, broker's own network, or both), and does that affect which partners a given company sees?
- Should the broker be notified when a company representative requests an introduction, or does that stay strictly between the company and the partner?
# 10. Acceptance Criteria
- Broker can mark a deal Closed/Sold from the Deal Tracker, and the associated Company Profile immediately reflects a Post Close state with the recorded close date.
- Company Profile in Post Close state correctly displays all designated company-side representatives, supporting more than one contact.
- Company representative can view suggested referral partners and cannot request an introduction without first giving explicit, logged consent.
- No partner contact-sharing occurs without a logged opt-in consent record tied to that specific partner and representative.
- Introduction request creates a record in SY - 0006 and an entry in the Activity & Audit Log (SY - 0003).
- Data room access for the company remains unchanged after transition to Post Close unless the broker manually modifies it, and the broker sees a passive reminder prompting that review.
- Users outside the Company and Broker roles on that deal cannot view Post Close referral activity (deal isolation holds).

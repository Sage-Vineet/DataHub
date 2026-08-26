CENTURIUUM
Feature Specification

| Feature ID | US - 0005 |
|---|---|
| Feature Name | Company Profile User Setup |
| Module | US - User Set up |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
The Company Profile is the account type for the business owner/seller side of a deal. Most company users arrive through a broker-issued invite tied to a company/deal the broker has already set up in the data room, but the platform must also support a company owner who signs up directly, without a prior invite, and either lists the business independently or invites their own broker afterward. This feature defines both entry paths, how a standalone signup reconciles (or doesn't) with a broker-driven company record, and the rule that any deal activity or insight data shown to the company user is strictly broker-gated — visible only for the categories the broker has explicitly chosen to share, and cleanly absent (not shown as locked/blank) otherwise.
# 2. User Stories
- As a company owner who was invited by a broker, I want to accept the invite and land directly in the company/deal record the broker already created, so that I don't have to re-enter information the broker has already set up.
- As a company owner without a broker relationship yet, I want to sign up directly and create my own company profile, so that I can list my business for sale independently or invite a broker of my choosing later.
- As a company owner who just signed up directly, I want to see any pending invite requests sent to my email address, so that I can accept an existing broker-initiated company record instead of creating a duplicate.
- As a company owner, I want to see only the deal activity and insights my broker has chosen to share with me, so that I have visibility without exposing information the broker wants to control.
- As a broker, I want to control, per category, whether the company user can see notifications and deal insights (e.g., NDA activity, view counts, buyer interest), so that I retain control over what the client sees at each stage of the process.
# 3. Functional Requirements
- The system shall allow a new user to select "I'm a company owner" during signup, independent of whether they arrived via an invite link or the general signup page.
- The system shall support account creation via a broker-issued invite link (per SY - 0005), which shall associate the new Company Profile user with the specific company/deal record the broker already established.
- The system shall support account creation without an invite (self-serve), during which the user creates a new company record from scratch.
- Upon self-serve signup, the system shall check for any pending broker-issued invite(s) addressed to the email address used to sign up, and if found, shall present those invites to the user as an option to accept.
- The system shall allow a self-serve company user to proceed without accepting any invite and instead list their business independently, with no broker attached to the company record.
- The system shall allow a self-serve company user to invite a broker of their choosing to the company record they created.
- If a self-serve company record and a separately broker-created company record exist for what is in fact the same underlying business, the system shall NOT automatically merge or link them; each shall remain a fully separate company record, and reconciliation (if any) shall be handled manually by the parties involved.
- The system shall allow the broker who owns/administers a company record to toggle, per insight category (e.g., deal activity summary, NDA signing status, listing view counts, buyer interest indicators), whether that category is visible to the associated Company Profile user.
- The system shall render an insight category as fully absent from the Company Profile user's view when the broker has not enabled it for that category — not as a visible-but-locked or placeholder element.
- The system shall re-evaluate and immediately reflect visibility changes when a broker toggles an insight category on or off, without requiring the company user to re-log in.
- The system shall notify the Company Profile user (via the notification mechanism defined by the future Notifications hub) of events such as a pending question awaiting their response, gated by the same broker-controlled visibility rules where applicable.
- The system shall log all invite issuance, invite acceptance, company record creation, and broker visibility-flag changes to the platform activity/audit log.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination | Notes |
|---|---|---|---|
| Company record (name, industry, region, entity type) | Read/Write | DB - 0001 (Table Structure) — core company record |  |
| Broker-to-company link (which broker owns/established this company) | Read | SY - 0002 (Company Access Setup) | Set at invite acceptance or self-serve broker assignment |
| Company Profile user account (contact info, credentials, role = Company) | Read/Write | SY - 0001 (Role Based Access Setup), SY - 0005 (User Creation) |  |
| Invite record (token, inviting broker, target email, status, expiration) | Read/Write | SY - 0005 (User Creation) — invite/onboarding gap (see Dependencies) | Also used for standalone-signup invite lookup by email |
| Sharing permission flags (per insight category: activity, NDA status, view counts, interest) | Read/Write | SY - 0002 (Company Access Setup) — broker-configured visibility flags scoped to this company/deal | Simple on/off per category, not per metric |
| Deal activity summary (views, NDAs signed, buyer interest indicators) | Read | BR - 0001 (Deal Tracker), BR - 0010 (Buyer Engagement Analytics), BR - 0011 (Client Status Report) — surfaced only when the corresponding flag is on | Company Profile never queries raw buyer-level data directly |
| Notification preferences/events (e.g., ready to answer questions) | Read/Write | Notifications hub (cross-cutting gap — see Dependencies) |  |

# 5. Access & Security
- Roles with access: Company (Company Profile user), Broker (owns/administers the company record and controls sharing flags).
- Roles explicitly excluded: Bank, Buyer, and Accountant roles have no visibility into another party's Company Profile account or its sharing settings.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
- A Company Profile user shall only ever see data for the company record(s) they are explicitly associated with (via invite acceptance or self-serve creation) — never a listing of other companies on the platform.
- Broker-controlled sharing flags are set and changed only by the broker (or other role explicitly granted administrative rights over that company record); the company user has no ability to self-grant additional visibility.
# 6. UI / UX Notes
- Platform: Web + Mobile (light). Full listing setup, company record creation, and detailed insight views are web-first; mobile supports accepting an invite, checking basic deal status, and viewing whatever insight categories the broker has enabled.
- Wireframe reference: N/A
Signup flow: user selects account type ("I'm a company owner") → system asks whether they arrived via invite link (auto-detected if the link is present) or are signing up directly → invite path routes straight into the existing company/deal record; direct-signup path checks for pending invites to the signup email and offers to accept one, or proceeds to "create a company" with the choice to list independently or invite a broker.
Insight/notification section on the company user's dashboard should behave as a dynamically-populated area: categories the broker has not enabled simply do not render a row/card for that category, rather than showing a disabled or grayed-out state that would reveal the category exists.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| SY - 0005 (User Creation) | Depends on | This feature specs the Company Profile signup/invite paths; SY-0005 covers the general invite-vs-signup mechanism this relies on. |
| SY - 0002 (Company Access Setup) | Depends on | Broker-controlled visibility flags and company-to-user access grants are defined and enforced there; this spec assumes that model exists. |
| SY - 0001 (Role Based Access Setup) | Depends on | Company Profile is one of the platform roles; role definition and dashboard routing happen there. |
| BR - 0001 (Deal Tracker) | Depends on | Source of deal stage/status data shown to the company user when the broker grants access. |
| BR - 0010 (Buyer Engagement Analytics) / BR - 0011 (Client Status Report) | Depends on | Source of the aggregate insight data (views, NDA counts, interest) surfaced to the company user, always broker-gated and typically anonymized/aggregated per those specs. |
| Onboarding / Invite flow (cross-cutting gap) | Depends on | General invite issuance, token handling, and activation flow is not yet its own feature; this spec assumes it and should not invent a one-off version. |
| Notifications hub (cross-cutting gap) | Depends on | In-app/email notifications (e.g., "ready to answer a question") route through the future unified hub, not a local notification mechanism. |

# 8. Out of Scope / Deferred
- Automated matching, merging, or conflict resolution between a self-serve company record and a later broker-created record for the same business — explicitly not handled by the system; belongs to a possible future admin/reconciliation tool if this becomes a recurring problem.
- Design and mechanics of the general invite/onboarding flow itself (token generation, expiration rules, resend logic) — belongs to the future Onboarding / Invite flow cross-cutting feature.
- Design of the Notifications hub itself (delivery channels, batching, preferences UI) — belongs to the future Notifications hub cross-cutting feature.
- Detailed content and layout of the deal activity/insight views themselves (e.g., what a "views" or "NDA status" card looks like) — belongs to CP - 0001 (Active Deal) and related Broker Profile analytics specs (BR - 0010, BR - 0011).
- Broker-side UI for finding/matching a broker during self-serve "invite your broker" flow, beyond sending a direct invite — a broker marketplace/directory is a possible future feature, not covered here.
# 9. Open Questions
- Should the platform surface any signal to a broker when a company they've invited has separately self-signed-up and created a duplicate company record (even without auto-merging), to make the eventual manual reconciliation easier? Logged pending decision.
- What is the minimum viable version of the Onboarding / Invite flow required to support invite issuance/acceptance for this feature, and when will that cross-cutting feature be specced?
- What is the minimum viable version of the Notifications hub required to support the "ready to answer questions" notification referenced here, and when will that cross-cutting feature be specced?
- Should there be any limit on the number of self-serve company records a single individual/email can create, to reduce clutter from abandoned or duplicate listings?
# 10. Acceptance Criteria
- A user can sign up via a broker-issued invite link and lands directly in the broker-created company/deal record, with no duplicate company created.
- A user can sign up directly (no invite), is shown any pending invites addressed to their signup email, and can choose to accept one of those invites instead of creating a new company.
- A user who signs up directly and does not accept an invite can successfully create a new company record and either list independently or send an invite to a broker.
- A self-serve company record and a broker-created record for the same business remain fully separate in the system, with no automatic merge or linkage.
- A broker can toggle each insight category (activity, NDA status, view counts, interest indicators) on/off per company, and the company user's dashboard reflects only the enabled categories, with disabled categories fully absent (not shown as locked).
- All invite issuance/acceptance, company creation, and broker visibility-flag changes appear in the activity/audit log.

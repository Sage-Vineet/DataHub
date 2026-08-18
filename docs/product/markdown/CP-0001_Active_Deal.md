CENTURIUUM
Feature Specification

| Feature ID | CP - 0001 |
|---|---|
| Feature Name | Active Deal |
| Module | CP - Company Profile |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
Active Deal is the company user's in-app view of how their deal is progressing — a periodic, broker-gated snapshot of deal stage, aggregate buyer activity, and upcoming milestones. It exists so a company owner has a self-serve source of visibility between broker updates, without ever seeing more than the broker has chosen to share, and without ever seeing individual buyer identities. A company owner associated with more than one active deal (e.g., an owner of multiple businesses, or a company user added to a second deal) can switch between them. This feature builds on the account/access layer defined in US - 0005 and the sharing-flag mechanism defined in SY - 0002; it does not redefine either.
# 2. User Stories
- As a company owner, I want to see a snapshot of where my deal currently stands, so that I have visibility into progress without having to ask my broker directly.
- As a company owner, I want to see aggregate buyer interest and engagement trends without seeing individual buyer names, so that I understand market response while the broker's buyer relationships stay confidential.
- As a company owner with more than one active deal, I want to switch between the deals I'm associated with, so that I can check on each business separately.
- As a company owner, I want to be notified when there's a question waiting for my answer, so that I don't hold up the process.
- As a broker, I want the company user's Active Deal view to only ever show what I've enabled, so that I retain control over what the client sees and when.
# 3. Functional Requirements
- The system shall generate an Active Deal snapshot for each company/deal on a defined cadence (daily or weekly, configurable by the broker), consistent with the cadence model used for the broker's Client Status Report (BR - 0011).
- The system shall NOT present Active Deal as a live/real-time dashboard; displayed data shall reflect the most recent snapshot, with the snapshot generation timestamp shown to the company user.
- The system shall include in the snapshot only the categories of information the broker has enabled via the sharing flags defined in US - 0005 / SY - 0002 (e.g., deal stage, aggregate activity counts, NDA execution counts, buyer interest trend, upcoming milestones).
- The system shall render a disabled category as fully absent from the snapshot — not as a locked, grayed-out, or placeholder element.
- The system shall present all buyer interest and engagement data in aggregate form only (counts, trends, rankings by stage) and shall never expose individual buyer names, contact details, or other buyer-identifying information to the company user, regardless of sharing-flag settings.
- The system shall allow a company user associated with more than one company/deal to switch between them via a deal switcher, with each deal's snapshot and sharing-flag settings evaluated independently.
- The system shall restrict the deal switcher to only the companies/deals the user is explicitly associated with, per the access model in SY - 0002.
- The system shall notify the company user (via the future Notifications hub) when a question is pending their response in Q&A (QA - 0001), gated by whether the broker has enabled question/notification visibility for that deal.
- The system shall log snapshot generation and any company-user view of the Active Deal page to the platform activity/audit log.
- The system shall display upcoming milestones/deadlines (e.g., exclusivity expiration, diligence items) only when the corresponding sharing flag is enabled, sourced from BR - 0015 and BR - 0001.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination | Notes |
|---|---|---|---|
| Company-to-deal-switcher list (companies this user is associated with) | Read | SY - 0002 (Company Access Setup) — set of companies granted to this user | Drives the deal switcher when a user has more than one company |
| Sharing permission flags (per insight category) | Read | US - 0005 (Company Profile User Setup), SY - 0002 (Company Access Setup) — broker-configured, on/off per category | This spec reads the flags; it does not define how they're set |
| Deal stage / status | Read | BR - 0001 (Deal Tracker) | Snapshot as of last refresh cycle |
| Aggregate activity counts (views, NDAs executed, questions received/answered, offers received) | Read | BR - 0010 (Buyer Engagement Analytics), BR - 0011 (Client Status Report) | Always aggregate — no per-buyer breakdown surfaced here |
| Buyer interest / engagement trend (aggregate, anonymized) | Read | BR - 0010 (Buyer Engagement Analytics) | Buyer identity fields explicitly excluded from this feature's read scope |
| Snapshot generation timestamp / cadence setting | Read/Write | DB - 0001 (Table Structure) — new snapshot record scoped to company/deal | Cadence (daily/weekly) configurable per broker, consistent with BR - 0011 |
| Milestones / upcoming deadlines | Read | BR - 0015 (Exclusivity & Post-LOI Milestone Tracking), BR - 0001 (Deal Tracker) | Only shown if the corresponding sharing flag is enabled |
| Pending question / Q&A notification event | Read | QA - 0001 (Q&A User Based Tracking), Notifications hub (cross-cutting gap — see Dependencies) |  |

# 5. Access & Security
- Roles with access: Company (Company Profile user, viewing their own deal's snapshot), Broker (owns/administers the deal and controls which categories appear via the sharing flags).
- Roles explicitly excluded: Bank, Buyer, and Accountant roles have no access to the company user's Active Deal view.
- Deal isolation confirmed: this feature is scoped to a single company/deal at a time. A company user with multiple deals can switch between them, but each deal's data is evaluated and displayed in isolation — no cross-deal or cross-company visibility of data, documents, or search results within a single view.
- Buyer-identifying information is out of scope for this feature's read access entirely — the underlying queries this feature relies on (BR - 0010) shall return only aggregate data to this feature, never buyer-level records.
- Sharing flags are read-only from this feature's perspective; they are set and changed only by the broker via US - 0005 / SY - 0002.
# 6. UI / UX Notes
- Platform: Web + Mobile (light). Full snapshot detail and milestone views are web-first; mobile supports viewing the current snapshot summary and switching between deals.
- Wireframe reference: N/A
The Active Deal page shows a deal switcher (visible only when the user has more than one associated company/deal) at the top, followed by the current snapshot: deal stage, snapshot date, and a dynamically-populated set of cards/sections for each enabled category (aggregate activity, NDA count, buyer interest trend, milestones). Disabled categories simply do not render a card — the layout should not reveal that a hidden category exists.
Because this is a periodic snapshot rather than a live view, the UI should clearly display "as of [snapshot date/time]" so the company user does not mistake it for real-time data.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| US - 0005 (Company Profile User Setup) | Depends on | Defines how the company user is created/invited and how they become associated with a company record. This spec assumes that account/access layer exists and only reads the resulting sharing flags. |
| SY - 0002 (Company Access Setup) | Depends on | Source of the broker-configured per-category sharing flags this spec reads, and the set of companies a user is associated with (feeds the deal switcher). |
| BR - 0001 (Deal Tracker) | Depends on | Source of deal stage/status data included in the snapshot. |
| BR - 0010 (Buyer Engagement Analytics) | Depends on | Source of aggregate, anonymized buyer engagement data shown in the snapshot. |
| BR - 0011 (Client [Seller] Status Report) | Depends on | This feature's snapshot cadence and much of its content overlap with the broker's client status report; snapshot generation logic should be shared/reused rather than rebuilt, with this feature acting as the always-available in-app view of a similar data set. |
| BR - 0015 (Exclusivity & Post-LOI Milestone Tracking) | Depends on | Source of milestone/deadline data when the corresponding sharing flag is enabled. |
| QA - 0001 (Q&A User Based Tracking) | Depends on | Source of the pending-question event that triggers a company-user notification. |
| Notifications hub (cross-cutting gap) | Depends on | In-app/email delivery of notifications (e.g., a pending question) routes through the future unified hub, not a local notification mechanism. |

# 8. Out of Scope / Deferred
- The mechanism for setting/toggling broker sharing flags — defined in US - 0005 and SY - 0002, not redefined here.
- Onboarding/invite flow and initial company-user-to-deal association — defined in US - 0005.
- Design of the Notifications hub itself (delivery channels, batching, preferences UI) — belongs to the future Notifications hub cross-cutting feature; this spec only defines the trigger condition.
- Broker's own Deal Tracker view and the full detail behind aggregate figures (e.g., per-buyer engagement detail) — those remain broker-only per BR - 0001 and BR - 0010 and are never exposed to the company user, in any form, through this feature.
- Real-time/live activity display — explicitly out of scope; this feature is snapshot-based only.
- Any change to the underlying Client Status Report (BR - 0011) itself — this feature reuses its cadence/data concept but is a separate, always-available in-app surface, not a replacement for the broker-authored report.
# 9. Open Questions
- Should the snapshot cadence (daily/weekly) be a single global default, or independently configurable per deal by the broker? Assumed independently configurable per deal, pending confirmation.
- Should the company user be able to request an on-demand refresh of the snapshot outside the normal cadence, or is that inconsistent with the intentional non-real-time design?
- What is the minimum viable version of the Notifications hub required to support the pending-question notification referenced here, and when will that cross-cutting feature be specced?
- When a company user has multiple deals, should notifications (e.g., pending question) be aggregated across deals or shown per-deal only within that deal's Active Deal page?
# 10. Acceptance Criteria
- The Active Deal page displays a snapshot generated on the configured cadence, with a visible "as of" timestamp, and does not update in real time.
- Only categories the broker has enabled for that deal appear in the snapshot; disabled categories are fully absent, with no locked or placeholder element.
- Buyer interest/engagement data displayed is always aggregate; no buyer name or other buyer-identifying detail is ever shown to the company user.
- A company user associated with multiple deals can switch between them, and each deal's snapshot reflects only that deal's own sharing-flag settings and data.
- A company user is notified when a question is pending their response, gated by the broker's notification sharing flag for that deal.
- Snapshot generation and company-user views of the Active Deal page are recorded in the activity/audit log.

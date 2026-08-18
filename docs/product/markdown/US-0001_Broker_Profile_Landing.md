CENTURIUUM
Feature Specification

| Feature ID | US - 0001 |
|---|---|
| Feature Name | Broker Profile — Login Landing & Deal Summary View |
| Module | US - User Set Up |
| Status | Draft |
| Related / Recycled IDs | Depends on BR - 0001 (Deal Tracker); references BR - 0003 (Deal Listing), DR - 0001 (Core Data Room), CM - 0001 (CIM Helper / SIM Builder) |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
When a business broker logs into Centuriuum, they need to immediately see the state of their active engagements without navigating to find it. This feature defines the broker's login landing experience: a summarized view of the deals they own or are assigned to as deal team members, plus outstanding action items and key dates, with a single click into the full Deal Tracker (BR - 0001) or directly into a specific deal's data room and related tools (SIM/CIM Builder, etc.). It matters because a broker manages many concurrent mandates, and the platform's value is diminished if getting from login to "what needs my attention today" takes more than one screen.
# 2. User Stories
- As a broker, I want to see all deals I own or am assigned to immediately after login, so that I don't have to navigate to find my active work.
- As a broker, I want to switch between list, table, and card views of my deals, so that I can scan them in the format that suits how I work.
- As a broker, I want to see outstanding action items and key upcoming dates across all my deals in one place, so that I know what needs attention today without opening each deal individually.
- As a broker, I want to click directly from a deal on my landing view into that deal's data room, SIM/CIM builder, or other tools, so that I can get to work without extra navigation steps.
- As a broker managing deals as a co-broker, I want deals I'm assigned to (not just deals I own) to appear on my landing view, so that I have full visibility into everything I'm working on.
# 3. Functional Requirements
- The system shall present the broker's landing view immediately upon successful login, with no intermediate screen.
- The system shall populate the landing view with all deals for which the logged-in broker is either the deal owner or an assigned deal team member, per the access model in SY - 0002.
- The system shall allow the broker to toggle the deal display between list view, table view, and card view.
- The system shall persist the broker's last-selected view format as a user-level preference and apply it on subsequent logins.
- The system shall display, per deal, at minimum: deal/company name, current stage (sourced from BR - 0001), broker's role on the deal (owner vs. co-broker), and last activity date.
- The system shall allow the broker to click into any deal shown on the landing view and land in that deal's Core Data Room (DR - 0001).
- The system shall provide navigation from within a deal to the SIM/CIM Builder (CM - 0001) and other deal-specific tools without returning to the landing view.
- The system shall provide a link or control from the landing view to open the full Deal Tracker (BR - 0001) for detailed deal management.
- The system shall display a summarized action items / key dates panel on the landing view, sourced from the platform notification/task system (see Dependencies — Notifications Hub); this spec does not define that underlying system.
- The system shall exclude from the landing view any deal the broker does not own and is not assigned to as a deal team member, regardless of brokerage affiliation.
- The system shall log broker entry into a deal from the landing view to the Activity & Audit Log (SY - 0003).
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Deal / engagement record (name, stage, status) | Read | BR - 0001 Deal Tracker; DB - 0001 Table Structure |
| Deal team assignment (broker owner + co-broker roles) | Read | SY - 0002 Company Access Setup |
| Deal listing summary (for landing card/table) | Read | BR - 0003 Deal Listing |
| User role & profile type | Read | SY - 0001 Role Based Access Setup |
| Action items / tasks / key dates | Read | Notifications Hub (cross-cutting gap — not yet a feature ID); see Dependencies |
| Landing view display preference (list/table/card, last selected) | Read/Write | SY - 0001 user preference store |
| Activity/audit event on deal entry from landing view | Write | SY - 0003 Activity & Audit Log |

# 5. Access & Security
- Roles with access: Broker.
- Roles explicitly excluded: Bank, Buyer, Company, Accountant — each of these profiles has its own distinct landing experience defined in a separate US - 000X spec.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
- A broker sees only deals where they are the designated owner or an assigned deal team member per SY - 0002; brokerage-wide visibility across all of a firm's brokers is out of scope for this spec (see Section 8).
# 6. UI / UX Notes
- Platform: Web + Mobile (light) — the summarized landing view (deal list and action items) is viewable on mobile per the platform's mobile-companion scope; entering the Core Data Room, SIM/CIM Builder, and other full workflows remains Web only.
- Wireframe reference: N/A
Landing view should read as a lightweight dashboard, not a duplicate of BR - 0001's full Deal Tracker — it surfaces enough per deal to decide where to click next (list/table/card toggle, summarized stage and activity), while detailed stage management, outstanding requests, and full deal metadata remain in BR - 0001. Action items panel should be visually distinct from the deal list (e.g., a side panel or top strip) so brokers can scan "what needs attention" separately from "which deal to open."
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| BR - 0001 | Depends on | Deal Tracker is the system of record for deal stage/status; this landing view is a summarized read of the same data, not a duplicate tracker. |
| BR - 0003 | Depends on | Active business listings shown on the landing view are sourced from Deal Listing. |
| DR - 0001 | Blocks | Clicking into a deal from the landing view enters the Core Data Room for that deal/company. |
| CM - 0001 | Blocks | SIM/CIM Builder is one of the destinations reached after clicking into a deal. |
| SY - 0001 | Depends on | Role-based access determines that this landing experience is shown specifically to the Broker role. |
| SY - 0002 | Depends on | Determines which deals a given broker is entitled to see (owner vs. deal-team member). |
| Notifications Hub (unspecified) | Depends on | Action items / key dates widget on the landing view assumes a unified task & notification system that does not yet have its own feature ID. |

# 8. Out of Scope / Deferred
- Detailed deal stage management, outstanding request tracking, and full deal metadata — belongs to BR - 0001 (Deal Tracker), not this landing view.
- Brokerage-wide (firm-level) visibility across all brokers at a firm — not addressed here; would require a separate admin/firm-level view, potentially tied to the Admin / Internal Ops Console gap.
- Definition of the action items / notifications system itself (generation rules, cross-module sourcing, read/unread state) — belongs to the future Notifications Hub feature, logged as an Open Question below.
- Deal Listing marketplace behavior (posting, cross-posting) — belongs to BR - 0003 and BR - 0004.
# 9. Open Questions
- The Notifications Hub does not yet have a feature ID. This spec assumes the action items / key dates panel consumes that system once built — should a placeholder/local version be scoped as a stopgap, or should this panel remain unbuilt until the Notifications Hub is specced?
- Should a co-broker have the same click-through permissions into a deal's data room as the deal owner, or a reduced permission set? (SY - 0002 governs this generally, but worth confirming no special case applies to landing-view entry.)
- Is there a maximum number of concurrent deals after which the landing view should paginate, filter, or archive closed/dead deals by default?
# 10. Acceptance Criteria
- A broker logging in lands on the summarized deal view with no intermediate screen, showing only deals they own or are assigned to.
- Broker can toggle between list, table, and card views, and the selection persists across sessions.
- Broker can click any deal on the landing view and land directly in that deal's Core Data Room.
- A link to the full Deal Tracker (BR - 0001) is present and functional from the landing view.
- Action items / key dates panel displays on the landing view (content sourced per the Notifications Hub dependency once available).
- Deals the broker does not own and is not assigned to never appear on their landing view.
- Landing view and action items panel render correctly on both web and the mobile-light experience; data room and SIM/CIM Builder access is confirmed web-only.

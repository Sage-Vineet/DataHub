CENTURIUUM
Feature Specification

| Feature ID | QA - 0001 |
|---|---|
| Feature Name | User Based Tracking |
| Module | QA - Q&A |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
In active deals, questions raised during diligence, QoE review, or data room review need a clear owner on both sides — someone asking and someone (or several people) accountable for answering. Today the product lists Q&A items generically without any concept of who requested an item or who is responsible for resolving it. This feature introduces user-based assignment on every Q&A item: a requestor (who raised it) and one or more requestees (who are responsible for the answer). This gives brokers, accountants, and the company's team a clear, filterable view of “what's on me” versus “what am I waiting on,” and is the foundation the rest of the Q&A module (QA - 0002, QA - 0003) builds on.
# 2. User Stories
- As a broker, I want to assign a Q&A item to a specific person on the company's team, so that it doesn't sit unanswered because ownership was unclear.
- As an accountant (QoE), I want to be assigned as a requestee on the items relevant to my workstream, so that I only see and act on what's mine.
- As the company's representative, I want to see every Q&A item where I'm the requestee in one place, so that I know exactly what I still owe the deal team.
- As any deal member, I want to reassign an item to someone else if I'm not the right person to answer it, so that items don't stall waiting on the wrong owner.
# 3. Functional Requirements
- The system shall allow any user with access to a deal to create a Q&A item and designate exactly one requestor and one or more requestees at creation time.
- The system shall default the requestor to the creating user, with the option to reassign requestor to a different user on the same deal before or after creation.
- The system shall support assigning multiple requestees to a single Q&A item.
- The system shall allow any user with access to the deal to reassign the requestee(s) on an existing Q&A item at any time, regardless of who created it.
- The system shall log every assignment and reassignment event, capturing prior requestee(s), new requestee(s), the user who made the change, and a timestamp.
- The system shall restrict requestor and requestee selection to users who are active members of the same deal (no cross-deal assignment).
- The system shall allow filtering and viewing of Q&A items by “items where I am requestor” and “items where I am requestee.”
- The system shall display all current requestee(s) and the requestor on every Q&A item view, including current assignment status.
- The system shall trigger a notification event on assignment, reassignment, and answer/resolution, routed through the Notifications Hub (see Dependencies) rather than a standalone email mechanism built specifically for Q&A.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| QA Item ID | Read/Write | Q&A module item record (DB-000X – Q&A Items table) |
| Requestor User ID | Read/Write | Q&A Items table → User/Profile table (DB-0002) |
| Requestee User ID(s) | Read/Write | Q&A Items table → User/Profile table (DB-0002); supports one-to-many via join/link table |
| Assignment History (prior requestees, reassigned-by, timestamp) | Write | Q&A Assignment History table (DB-000X) |
| Assignment Status (Open/Answered/Resolved) | Read/Write | Q&A Items table |
| Deal/Company ID | Read | Deal record (DB-0001) – used for isolation scoping |

# 5. Access & Security
- Roles with access: Broker, Company, Accountant, Buyer, Bank — any role already granted access to the deal's Q&A module.
- Roles explicitly excluded: none beyond standard deal-stage visibility rules already governing Q&A module access (see QA - 0002 for stage-based visibility).
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results. Requestor/requestee assignment is restricted to users active on that same deal.
# 6. UI / UX Notes
- Platform: Web + Mobile (light) — viewing assigned items and reassigning requestee(s) is a lightweight action suitable for mobile; creating/editing full Q&A items with attachments remains web-only per platform conventions.
- Wireframe reference: N/A
Each Q&A item card/row should show requestor (single) and requestee(s) (avatar stack or list if more than one) with an at-a-glance assignment status. Reassignment should be a lightweight inline action (e.g., dropdown or avatar-click) rather than a full edit form, to encourage items getting redirected quickly rather than stalling.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| QA - 0002 (Linking to other modules) | Depends on | User tracking must exist before Q&A items can be linked/surfaced across reporting, QoE, and data room modules. |
| QA - 0003 (Purpose / Q&A housing) | Depends on | This feature assigns users to items that live within the broader Q&A record structure defined there. |
| Notifications Hub (cross-cutting gap) | Depends on | Assignment/reassignment and status-change alerts should route through the future unified notification system (e.g., daily digest), not a standalone email trigger built here. |
| Onboarding / Invite Flow (cross-cutting gap) | Depends on | A user must be onboarded/activated on the deal before they can be assigned as a requestor or requestee. |
| Audit Trail / Activity Log (cross-cutting gap) | Depends on | Assignment and reassignment events should feed the future unified audit trail rather than a local log only. |

# 8. Out of Scope / Deferred
- The actual design of notification delivery (e.g., daily digest vs. real-time vs. user-configurable frequency) — belongs to the Notifications Hub spec, not here.
- The overall Q&A item data model, statuses, and linkage to other modules — belongs to QA - 0002 and QA - 0003.
- Bulk reassignment (e.g., reassigning all open items from one departing user to another) — not addressed in this version; may be a future enhancement once the Onboarding/Invite flow (offboarding case) is specced.
# 9. Open Questions
- What should the default notification cadence be once the Notifications Hub exists — immediate, daily digest, or user-configurable? (Flagged for that spec, but assignment/reassignment events in this feature will need to plug into whatever model is chosen.)
- Should a requestee be able to remove themselves from an item they were assigned to (self-unassign), or can only the requestor / another deal member reassign them?
- Is there a maximum practical number of requestees per item, or any UI guidance needed once a handful of people are assigned to avoid diffusion of ownership?
# 10. Acceptance Criteria
- A Q&A item can be created with one requestor and one or more requestees, all selected from users active on that deal.
- Any deal member can reassign the requestee(s) on an existing item, and the change is visible in the assignment history with who/when/from→to.
- A user can filter their Q&A view by “assigned to me” and “raised by me.”
- Attempting to assign a user who is not an active member of the deal is blocked.
- Assignment, reassignment, and resolution events generate a notification event routed to the Notifications Hub integration point (not a bespoke email sent directly from the Q&A module).

CENTURIUUM
Feature Specification

| Feature ID | DR - 0009 |
|---|---|
| Feature Name | Deal Team |
| Module | DR - Data Room |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
A deal involves several distinct parties working the same company at once — the broker, the company's own designated users, accountants, and potentially banks or buyers — and none of them currently has a reliable, in-platform way to see who else is actively part of the deal. This feature adds a Deal Team tab to the company profile that lists the people involved in a given deal, so every party knows who they're working with.
The list is broker-governed rather than a direct mirror of data room access: granting someone data room access and adding them to the visible Deal Team roster are two separate decisions, because a broker may grant a buyer's advisor document access without wanting that person to show up as a named contact to the company, other deal team members, or (critically) to other buyers. The Deal Team tab must never become a mechanism by which one buyer can see that another buyer exists or is engaged on the same deal.
# 2. User Stories
- As a broker, I want to control exactly who appears on the Deal Team tab for a given deal, independent of who has data room access, so that sensitive relationships (e.g., which buyers are engaged) are never inadvertently exposed.
- As a broker, I want the Deal Team list to auto-populate when I grant a new user access to the data room, with the option to add or remove people manually, so that I don't have to build the list twice.
- As a company user, I want to see the deal team members the broker has chosen to show me (e.g., my accountant, the broker, my own team), so that I know who is officially involved without seeing information the broker hasn't cleared for me.
- As a buyer, I want to see my own deal team (my advisors, plus the broker and any company contacts made visible to me) without seeing any other buyer or buyer-side party, so that my process remains confidential.
- As an accountant or other engaged professional, I want to see who else is on the deal team so that I know who to loop in or contact for a given item.
# 3. Functional Requirements
- The system shall display a “Deal Team” tab on the company profile, scoped to a single deal/company.
- The system shall auto-populate a candidate Deal Team entry whenever a broker grants a user access to that deal's data room (per SY - 0002 Company Access Setup).
- The system shall allow the broker to independently control, per user, whether that user (a) has data room access, (b) appears on the Deal Team tab, or both — these two settings shall not be linked or inferred from one another.
- The system shall allow the broker to manually add a Deal Team entry for a person who does not have platform/data room access (e.g., a name/role/contact listed for reference only).
- The system shall allow the broker to manually remove or hide any user from the Deal Team tab at any time, independent of that user's data room access status.
- The system shall capture, for each Deal Team entry: name, role/title, role type (Broker, Company, Accountant, Bank, Buyer, Buyer Advisor, Other), firm/company affiliation, and contact info (email/phone), where available from the user's profile.
- The system shall render the Deal Team tab differently per viewing role: a viewer in Company, Accountant, or internal Broker-side roles may see all Deal Team entries the broker has marked visible to that role; a Buyer-side viewer shall only ever see entries the broker has explicitly marked visible to that specific buyer's side, and shall never see entries belonging to another buyer or that buyer's advisors.
- The system shall default all new buyer-side data room access grants to NOT appear on the Deal Team tab for any other party until the broker explicitly marks that entry visible, so no buyer relationship is exposed by default.
- The system shall log every addition, removal, or visibility change to the Deal Team list to the activity/audit log (see Dependencies, SE - 0004 / SY - 0003).
- The system shall prevent a Buyer-role viewer from ever seeing another Buyer-role entry on the Deal Team tab, regardless of broker configuration (hard rule, not a togglable default).
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Deal Team entry (user, role, visibility flags) | Read/Write | New Deal Team table — candidate for DB module table block; references SY - 0002 access grants |
| User profile (name, firm, contact info) | Read | US - 0001 through US - 0005 (role-specific profile modules) |
| Company/deal access grant | Read | SY - 0002 Company Access Setup |
| Visibility change / add / remove event | Write | SY - 0003 Activity & Audit Log |

# 5. Access & Security
- Roles with access: Broker (full control), Company, Accountant, Bank, Buyer, Buyer Advisor (view only, per broker-configured visibility).
- Roles explicitly excluded from editing: all roles except Broker are read-only on this tab; only the Broker can add, remove, or change visibility of Deal Team entries.
- Buyer-side isolation: a Buyer or Buyer Advisor shall never see any other buyer or that buyer's advisors on the Deal Team tab, under any broker configuration. This is enforced as a hard platform rule, not a broker-configurable default.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web + Mobile (light) — the Deal Team tab is a lightweight, read-mostly view consistent with mobile's role of reviewing deal status and access.
- Wireframe reference: N/A
The tab presents a simple roster (name, role, firm, contact) grouped by role type. Broker view includes an “add to Deal Team” / visibility toggle inline wherever a user's data room access is managed (see SY - 0002 UI), plus a standalone “Add Deal Team Member” action for manually-added contacts. Non-broker views are read-only and show only the entries the broker has made visible to that viewer's role/side.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| SY - 0002 (Company Access Setup) | Depends on | Deal Team auto-population and per-user visibility controls build on the access grant model defined there. |
| SY - 0003 (Activity & Audit Log) | Depends on | All Deal Team changes (add/remove/visibility) must be logged. |
| US - 0001 through US - 0005 (Profile modules) | Depends on | Deal Team entries pull name/firm/contact detail from the relevant role profile. |
| BO - 0003 (Outreach Pipeline & Follow-Up Cadence) | Related, not a dependency | Buyer stage (e.g., NDA executed, LOI received) is not used to gate Deal Team visibility — visibility is controlled entirely by broker action at the time access is granted, per clarification in this spec. |

# 8. Out of Scope / Deferred
- Automated visibility rules tied to deal stage (e.g., auto-showing a buyer once an LOI is signed) — explicitly deferred; visibility is a manual broker decision made at the point of granting access, not a status-driven rule.
- Messaging or communication tools between deal team members — this feature is a directory/roster only.
- Onboarding/invite mechanics for adding a brand-new user to the platform — covered under the Onboarding / Invite flow gap (see Open Questions).
# 9. Open Questions
- This feature depends on the not-yet-specced Onboarding / Invite flow (see Known Cross-Cutting Gaps) for how a manually-added Deal Team contact without an existing platform account gets invited/activated. Flag as a dependency once that spec exists.
- Should a manually-added Deal Team entry with no platform account be allowed to persist indefinitely (contact-only, never logs in), or does it expire/require conversion to a real account after some period?
- When a buyer is later passed on / marked dead in BO - 0003, should their Deal Team visibility be automatically revoked, or does that remain a manual broker action consistent with the rest of this spec?
# 10. Acceptance Criteria
- Broker can view, add, remove, and toggle visibility of Deal Team entries for a given deal, independent of each user's data room access setting.
- Granting a user data room access creates a candidate Deal Team entry that is NOT visible to other parties until the broker explicitly enables visibility.
- A Buyer-role user viewing the Deal Team tab never sees another buyer or that buyer's advisors, under any configuration.
- Company, Accountant, and other non-buyer roles see only the Deal Team entries the broker has marked visible to their role.
- Every add, remove, and visibility change to the Deal Team list is captured in the activity/audit log.
- Deal Team tab is fully usable on both web and the mobile (light) experience.

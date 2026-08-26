CENTURIUUM
Feature Specification

| Feature ID | DB - 0006 |
|---|---|
| Feature Name | Configurable Chart of Accounts (Drag-and-Drop Hierarchy) |
| Module | DB - Database |
| Status | Draft |
| Related / Recycled IDs | Depends on DB-0003 (COA), DB-0002 (GL Data); related to DB-0007 (Suggestions on COA), RP-0001/RP-0002 (P&L / Balance Sheet) |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
2-3 sentences: what problem this solves, for whom, and why it matters.
Once GL data is loaded, the system auto-generates a Chart of Accounts (DB-0003) directly from the accounts used in the company's transactions. Different stakeholders working the same deal — the company's own bookkeeping, the QoE preparer, and the broker building a CIM — often want to see that same underlying data grouped differently (e.g., how much detail sits under COGS vs. SG&A, or whether "Other SG&A" absorbs a long tail of immaterial accounts). This feature gives each of them a visual, drag-and-drop way to reorganize the COA hierarchy — moving base accounts between top-level buckets and creating/removing their own mid-level subtotal groupings — with annual P&L/Balance Sheet figures shown alongside so materiality is obvious while reorganizing, without ever touching a text-editable hierarchy table.
# 2. User Stories
One story per user type that touches this feature. Format: "As a [role], I want to [action], so that [benefit]."
- As a QoE preparer (Accountant), I want to drag accounts and subtotal groups into a structure that fits how I present adjusted earnings, so that my QoE analysis reflects a hierarchy I control, independent of how the company or broker view the same data.
- As a Broker, I want to reorganize the same underlying accounts into my own hierarchy under Key Reports, so that my CIM presentation groups costs the way I want without altering the QoE preparer's or company's configuration.
- As a Company user, I want to see my chart of accounts alongside annual P&L/Balance Sheet totals, so that I can understand which accounts are material and decide how I want my own reported hierarchy organized.
- As any of the above roles, I want to see the annual dollar amount attached to each account and subtotal as I reorganize, so that I can judge whether an account is worth its own line or should be folded into an "Other" bucket.
# 3. Functional Requirements
Numbered, testable statements the dev team can build against directly.
- The system shall render the COA (DB-0003) as an interactive tree view, separately for P&L accounts and Balance Sheet accounts, with each node showing the account or group name and its annual total.
- The system shall support drag-and-drop reassignment of a base-level (leaf) account from one top-level bucket (e.g., COGS) to another (e.g., SG&A).
- The system shall support drag-and-drop reassignment of a base-level account between existing mid-level subtotal groups within the same or a different top-level bucket.
- The system shall allow the user to create a new mid-level subtotal group (e.g., "Selling Costs," "General Costs," "Administrative Costs") under a top-level bucket.
- The system shall allow the user to rename or delete a mid-level subtotal group they created; deleting a group shall prompt the user to reassign its child accounts rather than silently discarding them.
- The system shall allow a top-level bucket to have zero mid-level subtotal groups (flat list of base accounts directly under the bucket, e.g., "Total Vehicle Costs" kept as-is) as well as multiple levels of subtotal grouping.
- The system shall prevent the user from creating, renaming, moving, or deleting the platform-fixed top-level buckets (e.g., Revenue, COGS, SG&A, Other Income/Expense) defined by the base COA structure — only base accounts and user-created mid-level groups are movable/editable.
- The system shall display, next to each account and each subtotal group, the trailing annual total (with the specific annual period(s) shown configurable per Open Question in Section 9) so materiality is visible while reorganizing.
- The system shall recalculate and display subtotal and top-level bucket totals live as accounts are dragged between groups.
- The system shall persist hierarchy configuration changes to the DB-0003 chart of accounts data, scoped per firm/role as defined in Section 5 — i.e., the change updates that firm's classification of record for the company, not just a local display setting.
- The system shall, when a new GL pull/version is ingested for the same company (per DR-0003), automatically carry forward each firm's existing hierarchy configuration by matching on account name/number, and shall apply that firm's saved grouping rules to only the newly-introduced accounts rather than resetting the full hierarchy.
- The system shall flag newly-introduced accounts (from a new pull) that have not yet been placed into a subtotal group by the current firm, so the user can confirm or reclassify them rather than have them silently default somewhere.
- The system shall allow the user to save/apply suggested reclassifications surfaced by DB-0007 directly into this drag-and-drop interface, when that feature is available.
# 4. Data Requirements
What tables/fields does this feature read from or write to?

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Chart of Accounts hierarchy (base accounts, top-level buckets, mid-level subtotal groups, sort order) | Read/Write | DB - 0003 (COA) |
| GL account balances used to compute annual account/group totals | Read | DB - 0002 (GL Data) |
| Trial Balance / Balance Sheet source figures for BS-side hierarchy | Read | DB - 0004 (Trial Balance) |
| Firm/role identifier owning a given hierarchy configuration (Company, Accountant/QoE, Broker) | Read/Write | DB - 0003 (COA), scoped by SY - 0002 (Company Access Setup) |
| Suggested reclassifications | Read | DB - 0007 (Suggestions on COA) |
| P&L / Balance Sheet report output reflecting the active hierarchy | Read | RP - 0001 (Profit & Loss), RP - 0002 (Balance Sheet) |

# 5. Access & Security
Confirm roles and deal isolation explicitly on every spec — never assume it.
- Roles with access: Company, Accountant/QoE preparer, Broker — each of whom may hold their own independent hierarchy configuration for the same company's COA.
- Firm-scoped configuration model: a given company's COA can carry multiple parallel hierarchy configurations, one per firm/role with edit access to that company (e.g., the QoE accounting firm's configuration used for QoE analysis, and the broker's configuration used under Key Reports for CIM building). Editing your own firm's configuration never modifies another firm's configuration, and neither modifies the underlying GL source data.
- Roles explicitly excluded: any user without an active access grant to the company/deal (per SY-0002); Bank users, consistent with the platform-wide default of excluding Bank until a deal reaches underwriting, unless explicitly granted otherwise on a spec-by-spec basis.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
Layout, interaction notes, or wireframe reference. State platform scope explicitly per feature.
- Platform: Web only.
- Wireframe reference: N/A
Two tree views (P&L and Balance Sheet), each showing top-level buckets (fixed) containing mid-level subtotal groups (user-defined, collapsible) containing base accounts (leaf nodes, draggable). Each node shows its annual total right-aligned. Dragging a node onto a group reparents it; dragging onto empty space between groups within the same bucket creates a new group after a name prompt. A persistent indicator distinguishes "platform-fixed" nodes (buckets) from user-editable nodes (groups/accounts) so users don't attempt to drag a fixed bucket. Newly-introduced unplaced accounts (after a re-pull) surface in a distinct "Unclassified" tray at the top of the relevant bucket until the user drags them into a group.
# 7. Dependencies
Upstream features that must exist first.

| Related Feature | Relationship | Notes |
|---|---|---|
| DB - 0003 | Depends on | COA must already be generated from GL data before a hierarchy can be configured on top of it. |
| DB - 0002 | Depends on | GL Data load populates the accounts and balances this feature reorganizes and totals. |
| DB - 0004 | Depends on | Balance Sheet-side hierarchy configuration requires Trial Balance data. |
| DR - 0003 | Depends on | Data Retrieve Wizard defines how/when a new GL pull creates a new version; this feature's carry-forward behavior on re-pull builds directly on that versioning. |
| SY - 0002 | Depends on | Company Access Setup determines which firms/roles have edit access to a given company's COA, and therefore whose configuration is being edited. |
| DB - 0007 | Related (not blocking) | Suggestions on COA reclassifications may be surfaced and applied through this interface once built; this spec does not build the suggestion engine itself. |
| RP - 0001 / RP - 0002 | Blocks | P&L and Balance Sheet reports should render using whichever firm's active hierarchy configuration is selected by the viewing user. |

# 8. Out of Scope / Deferred
Name what this feature explicitly does NOT do.
- This feature does not generate reclassification suggestions — that is DB-0007.
- This feature does not edit, rename, or delete base-level (leaf) GL accounts, or alter underlying GL transaction data — it only changes how existing accounts are grouped and presented.
- This feature does not add or remove platform-fixed top-level buckets (Revenue/COGS/SG&A/etc.) — those are defined by the base COA structure, not by this UI.
- This feature does not merge or reconcile differing hierarchy configurations across firms into a single "master" view — each firm's configuration remains independent by design.
# 9. Open Questions
Anything unresolved. Log it here rather than assuming an answer.
- Which annual period(s) display alongside each account/group — most recent completed fiscal year only, or trailing 12 months plus 1-2 prior years for trend/materiality context?
- When a Company user and their engaged Accountant/QoE firm both have edit access, does the Company's own configuration exist as a distinct fourth configuration, or does the Company simply view/use the Accountant's configuration by default?
- Should there be a limit on hierarchy depth (levels of subtotal grouping) to keep the UI and report rendering from becoming unwieldy?
- Does DB-0007 (Suggestions on COA) exist yet in a form this UI can call, or should this spec assume that integration point is a future no-op until DB-0007 is built?
# 10. Acceptance Criteria
The concrete “this is done when…” checklist used for QA and sign-off.
- A user with edit access can drag a base account from one top-level bucket to another, and the change is saved and reflected in that firm's COA configuration (DB-0003) without affecting any other firm's configuration for the same company.
- A user can create a new mid-level subtotal group, move accounts into it, and see the group's total update live to reflect its member accounts.
- A top-level bucket with no user-created subtotal groups displays its base accounts as a flat list with a correct total, unchanged from the default COA structure.
- After a new GL pull for a company (per DR-0003), a firm's previously-saved hierarchy configuration is intact for all previously-known accounts, and any brand-new accounts appear in an "Unclassified" tray rather than being auto-placed.
- P&L and Balance Sheet reports (RP-0001/RP-0002) generated for a given firm reflect that firm's active hierarchy configuration.
- A user without edit access to the company cannot view or modify any firm's hierarchy configuration for that company.

CENTURIUUM
Feature Specification

| Feature ID | DR - 0002 |
|---|---|
| Feature Name | Templated File Structure |
| Module | DR - Data Room |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

1. Purpose & Business Context
Brokers and QoE providers repeatedly recreate the same data room folder structure for every new engagement, and many currently manage anywhere from a handful to over a hundred folders with inconsistent organization across deals. A templated file structure lets a user define a folder tree once and apply it automatically whenever a new company/deal is created, so the data room is organized and ready to receive documents from day one. This also gives brokers a structure that maps to what banks, buyers, and other counterparties typically expect to see, reducing setup time and improving the consistency of deliverables across a brokerage.
2. User Stories
- As a broker, I want to save a personal default folder template, so that every new company I create starts with my preferred structure without manual setup.
- As a brokerage admin, I want to publish a firm-wide template, so that all brokers at my firm start deals with a consistent, firm-approved folder structure.
- As a broker creating a new company/deal, I want to choose from my saved templates or Centuriuum's pre-built templates, so that I can pick the structure that best fits this particular deal.
- As a broker, I want to edit the folder structure after it's applied to a specific deal, so that I can adapt it to that deal's unique needs without affecting my saved template.
- As a broker, I want to create and manage multiple templates, so that I can maintain different structures for different deal types or industries.
3. Functional Requirements
- The system shall allow a user to create a named folder-structure template consisting of nested folders (no depth limit enforced by the system, though a soft warning should display beyond a reasonable depth, e.g., 6 levels).
- The system shall allow a template to be saved at either the individual user (personal) level or the brokerage (firm-wide) level, with the creating user selecting the scope at save time.
- The system shall restrict firm-wide template creation and editing to users with an admin or owner role at the brokerage; individual brokers shall be able to view and apply firm-wide templates but not edit them.
- The system shall allow a user to mark one personal template as their default, which pre-selects (but does not auto-apply) that template in the template picker.
- The system shall provide a set of Centuriuum pre-built system templates (e.g., a general M&A data room structure) available to all users regardless of brokerage.
- The system shall present a template picker at company/deal creation, listing the user's personal templates, their brokerage's firm-wide templates, and Centuriuum system templates, grouped and labeled by source.
- The system shall require a template selection (or an explicit 'start blank') before the company/deal's data room is initialized.
- The system shall create the full folder tree from the selected template inside the new company's data room upon confirmation, with zero documents populated (folders only).
- The system shall allow the applied folder structure to be edited per-deal after creation, including adding, renaming, reordering, deleting, and nesting folders, without altering the source template.
- The system shall allow a user to save an edited, deal-specific folder structure back as a new template (personal or firm-wide, per permissions) for future reuse.
- The system shall allow a user to edit or delete their own saved templates independently of any company/deal the template has already been applied to; existing deals retain their already-created folders unaffected by later template edits.
- The system shall prevent deletion of a folder within an active deal's structure if it contains documents, requiring the user to move or delete the contents first.
- The system shall log template creation, edits, and deletions, and the template applied to each company/deal, to the activity/audit log.
4. Data Requirements
Templates are structural metadata (folder trees), not GL/financial data, so direct DB-0001 through DB-0010 table references are limited. The core data room and its permission model (DR-0001) are the direct dependency.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Template record (name, scope, owner, created/modified dates) | Write | New: Template table |
| Template folder-tree structure (nested folder nodes) | Write | New: Template Folder Node table |
| Applied folder structure per company/deal | Write | DR - 0001 (Core Data Room folder structure) |
| Brokerage / firm identifier | Read | SY - 0002 (Company Access Setup) / Broker profile |
| User role (admin vs. broker) for firm-wide template permission check | Read | SY - 0001 (Role Based Access Setup) |
| Template applied + folder edit events | Write | SY - 0003 (Activity & Audit Log) |

5. Access & Security
- Roles with access: Broker (create/edit personal templates, apply any visible template), Brokerage Admin/Owner (create/edit firm-wide templates), Accountant/QoE provider (apply templates to companies they have access to create, if permitted by role setup).
- Roles explicitly excluded: Bank, Buyer, and Company users cannot create, edit, or apply templates; they only see the resulting folder structure once granted data room access.
- Personal templates are visible only to their creator; firm-wide templates are visible to all users associated with that brokerage. Centuriuum system templates are visible to all users platform-wide.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results. Templates themselves are structure-only (no documents or deal data) and are not deal-specific.
6. UI / UX Notes
- Platform: Web only. Template creation/editing and the template picker are full data-room workflows and are not part of the Mobile (light) companion experience.
- Wireframe reference: N/A
Template creation/editing should use a drag-and-drop or indent-based tree editor allowing folders to be nested, reordered, renamed, and deleted inline. The template picker at company creation should visually distinguish 'My Templates,' '[Brokerage Name] Templates,' and 'Centuriuum Templates' as separate groups, and should show a preview of the folder tree before the user confirms selection. An explicit 'Start Blank' option should always be available alongside template options.
7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DR - 0001 (Core Data Room) | Depends on | Templates create folder structures within the core data room; the data room must exist first. |
| SY - 0001 (Role Based Access Setup) | Depends on | Determines who may create/edit firm-wide vs. personal templates. |
| SY - 0002 (Company Access Setup) | Depends on | Associates a user/broker with a brokerage, which scopes firm-wide template visibility. |
| SY - 0003 (Activity & Audit Log) | Depends on | Logs template application and folder edits per house rule and cross-cutting audit trail gap. |
| DR - 0006 (Document Control & Watermarking) | Blocks (informs) | Per-folder permission/watermark defaults referenced in DR-0006 may eventually be set at the template level; out of scope for this spec (see Section 8). |

8. Out of Scope / Deferred
- Assigning folder-level permissions, watermarking, or download rules within a template — this belongs to DR-0006 (Document Control & Watermarking) and the role/permission model in SE/SY modules. This spec covers folder names and hierarchy only.
- Auto-populating folders with placeholder documents, checklists, or required-item lists (e.g., lender requirements) — this belongs to DR-0005 (Lender Requirements).
- Bulk-editing or reorganizing an already-populated, in-use data room's structure across many existing documents at once — this spec covers structure creation at initialization and standard per-deal edits, not large-scale reorganization tooling.
- Sharing or licensing templates across brokerages (e.g., a marketplace of templates) — not addressed here.
9. Open Questions
- Should Centuriuum system templates be versioned/updated centrally over time, and if so, do companies that already applied an older version get any prompt to adopt changes? Recommend: no retroactive changes, consistent with the locked-at-creation convention used elsewhere (e.g., VL-0010).
- Is there a limit on the number of personal or firm-wide templates a user/brokerage can save? Needs a decision if this ties into tiered pricing/metering (SY-0004).
- Should folder-level permission defaults eventually be attachable to a template (tying into DR-0006) in a future spec? Logged here as a forward-looking dependency, not designed in this spec.
10. Acceptance Criteria
- A user can create, name, and save a folder-structure template with nested folders, choosing personal or firm-wide scope (firm-wide restricted to admin/owner roles).
- A user can mark a personal template as their default.
- At company/deal creation, the user is prompted with a template picker showing personal templates, firm-wide templates, and Centuriuum system templates, plus a 'Start Blank' option, and must make a selection to proceed.
- Selecting a template creates the corresponding empty folder tree in the new company's data room.
- The folder structure can be edited (added/renamed/reordered/deleted/nested) after being applied to a specific deal without modifying the original saved template.
- A folder containing documents cannot be deleted until its contents are moved or removed.
- Template creation, edits, deletions, and application to a company/deal are recorded in the activity/audit log.
- Bank, Buyer, and Company user roles cannot access template creation, editing, or selection functionality.

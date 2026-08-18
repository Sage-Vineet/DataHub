CENTURIUUM
Feature Specification

| Feature ID | DR - 0001 |
|---|---|
| Feature Name | Core Data Room |
| Module | DR - Data Room |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
Every deal on Centuriuum needs a secure, central place to store and organize the company's documents throughout the M&A process — financials, tax returns, legal files, and diligence materials. The Core Data Room is the foundation that every other document-facing feature (Templated File Structure, Data Retrieve Wizard, Redaction, Document Control & Watermarking) is built on top of, so it must ship first and be simple, fast, and reliable rather than feature-loaded. It solves the basic problem of “where do the company's files live, who can see them, and how does a broker manage that” before any of the more advanced data-room behaviors are layered in.
# 2. User Stories
- As a broker (deal owner), I want to upload, organize, and browse the company's documents in folders, so that I have one authoritative place to manage everything for the deal.
- As a broker, I want a Manage Access button, so that I can control which users can see or download this deal's data room.
- As a company (seller) user, I want to upload documents directly into the data room, so that I don't have to email files back and forth with the broker.
- As a buyer or accountant with granted access, I want to browse and open files I've been given permission to see, so that I can do my part of diligence or analysis without asking the broker to send individual files.
- As any data room user, I want to see other relevant actions (Data Retrieve Wizard, etc.) surfaced from within the data room, so that I don't have to hunt for related tools in a separate part of the app.
# 3. Functional Requirements
- The system shall provide a per-deal data room consisting of folders and files, presented as a file-explorer-style interface (tree or breadcrumb navigation, list/grid view of folder contents).
- The system shall allow authorized users to create, rename, move, and delete folders within a deal's data room.
- The system shall allow authorized users to upload one or more files at a time, including drag-and-drop upload, into any folder they have write access to.
- The system shall allow authorized users to download individual files or a selected folder (as a zip) that they have download permission for.
- The system shall support in-browser preview for common file types (PDF, Word, Excel, PowerPoint, and standard image formats) without requiring download.
- The system shall fall back to download-only when a file type does not support in-browser preview.
- The system shall run OCR extraction as part of the upload pipeline for scanned or image-based documents (e.g., scanned PDFs), consistent with the platform-wide OCR-first-class convention, so uploaded content is text-searchable.
- The system shall create a new version — not an overwrite — whenever a file with the same name is re-uploaded to the same folder, and shall display prior versions with the ability to view or restore them.
- The system shall display a persistent “Manage Access” button, visible to the deal owner (typically the broker), that opens a simple access panel.
- The Manage Access panel shall allow the deal owner to add a user by selecting them (or inviting them, per the Onboarding/Invite flow) and assigning them one of two rights at the deal level: View or View + Download.
- The Manage Access panel shall allow the deal owner to remove a user's access or change their assigned right at any time, with the change taking effect immediately.
- The system shall surface entry points to related data-room actions — at minimum, the Data Retrieve Wizard (DR - 0003) and Templated File Structure (DR - 0002) — as visible buttons/actions within the data room screen.
- The system shall log every upload, download, view, delete, and access-change event for the data room to the platform activity log.
- The system shall restrict all data room contents, folders, and search results to the single deal/company they belong to, with no cross-deal or cross-company visibility under any circumstance.
- The system shall allow a user to search for files by file name within the current deal's data room.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Folder metadata (name, parent folder, deal ID) | Read / Write | DB - 0001 (Table Structure) |
| File metadata (name, type, size, uploader, timestamp, version number) | Read / Write | DB - 0001 (Table Structure) |
| File binary/content | Read / Write | Document storage (per DB - 0010 Table Blocks architecture) |
| Access grant (user, deal, right level) | Read / Write | SY - 0002 (Company Access Setup) |
| Activity/audit events (upload, download, view, delete, access change) | Write | SY - 0003 (Activity & Audit Log) |
| OCR-extracted text | Write | DB - 0001 (Table Structure) — supports search |

# 5. Access & Security
- Roles with access: Broker (deal owner, full manage access), Company, Accountant, Buyer, Bank — each per whatever right level the deal owner grants under this feature.
- Roles explicitly excluded: any user not explicitly granted access by the deal owner via Manage Access; Bank until the deal owner chooses to grant access (e.g., typically not before underwriting stage, per Bank Profile flow).
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
- This spec covers deal-level access only (View / View + Download). Per-folder and per-file permission granularity, document watermarking, view-only rendering, and download restriction by file category are handled in DR - 0006 (Document Control & Watermarking) and are out of scope here.
# 6. UI / UX Notes
- Platform: Web only. Mobile covers lighter-weight actions per the platform convention (e.g., granting access, reviewing deal status) — full data room browsing/upload is not required on mobile for this spec.
- Wireframe reference: N/A
New deals start with a blank data room (no pre-seeded folder skeleton) — folder structure is created ad hoc by the deal owner or applied later via the Templated File Structure feature (DR - 0002). The interface should read as a clean, familiar file-explorer: breadcrumb or tree navigation on the left, file listing with name/type/size/modified date/version, drag-and-drop upload target, and a clearly visible Manage Access button plus related action buttons (Data Retrieve Wizard, etc.) in the toolbar.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DB - 0001 (Table Structure) | Depends on | Underlying table structure for folders/files must exist first. |
| SY - 0002 (Company Access Setup) | Depends on | Deal-level access grants are governed by this feature's access model. |
| SY - 0003 (Activity & Audit Log) | Depends on | All data room events must write here; build early per conventions doc. |
| DR - 0002 (Templated File Structure) | Blocks | Custom folder templates layer on top of the blank data room shipped here. |
| DR - 0003 (Data Retrieve Wizard) | Related | Surfaced as a visible action from within the data room. |
| DR - 0006 (Document Control & Watermarking) | Blocks | Granular per-folder/per-file permissions, watermarking, and view-only rendering extend this feature's simple access model. |
| Onboarding / Invite flow (cross-cutting gap) | Depends on | Adding a user in Manage Access who is not yet on the platform requires the invite flow; not yet a specced feature. |

# 8. Out of Scope / Deferred
- Per-folder or per-file permission granularity — belongs to DR - 0006 and/or SY - 0002 expansion.
- Watermarking, view-only rendering, download restriction by file category, and IP/geography restriction — belongs to DR - 0006.
- Custom/templated folder structures — belongs to DR - 0002.
- Redaction of sensitive fields (e.g., tax return PINs) — belongs to DR - 0004.
- Full-text search across document contents — this spec covers file-name search only; content search may be considered in a future iteration once OCR text is reliably indexed.
- Mobile upload/browse experience beyond lightweight actions — mobile scope is limited per the platform convention.
# 9. Open Questions
- Onboarding/Invite flow is a known cross-cutting gap with no feature ID yet — Manage Access assumes a user can be invited by email if not already on the platform. This needs to be resolved before or alongside this build.
- Is there a file size or total storage cap per deal, and if so, does it vary by plan/tier? Not addressed in the conventions doc.
- Should deleted files be soft-deleted/recoverable for a retention period, or permanently removed immediately? Ties into the not-yet-addressed Legal/Compliance gap (data retention).
# 10. Acceptance Criteria
- A broker can create folders, upload files (including via drag-and-drop), and see them organized in a file-explorer-style view scoped to a single deal.
- A broker can open Manage Access, add a user with View or View + Download rights, and that user's access reflects immediately; removing access immediately revokes it.
- Re-uploading a file with the same name creates a new version without destroying the prior version, and both are viewable.
- Common file types (PDF, Word, Excel, PowerPoint, images) open in an in-browser preview; unsupported types fall back to download.
- A user without granted access to a deal cannot see any of that deal's folders, files, or search results.
- Every upload, download, view, delete, and access change is recorded in the activity log with user, timestamp, and action.
- Data Retrieve Wizard and Templated File Structure actions are visible and reachable from within the data room screen.

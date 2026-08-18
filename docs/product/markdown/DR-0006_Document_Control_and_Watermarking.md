CENTURIUUM
Feature Specification

| Feature ID | DR - 0006 |
|---|---|
| Feature Name | Document Control & Watermarking |
| Module | DR - Data Room |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
In a confidential M&A process, the risk is not only who can open a data room folder, but what a party can do with a file once opened and whether a leaked page can be traced back to its source. This feature gives the broker document-level control over exported and printed files: the ability to require watermarking (viewer name, email, company, and access timestamp) on exports so a leaked document is traceable to the individual who obtained it, with the broker deciding per deal whether watermarking is on, and which file types it applies to. Because watermarking on non-PDF formats (Excel workbooks) requires converting the file to PDF at export time, the broker must be warned of that tradeoff and given the choice to accept it, exclude those file types, or turn watermarking off entirely.
# 2. User Stories
- As a Broker, I want to require watermarking on exported/printed documents for a deal, so that any leaked page can be traced back to the individual who downloaded it.
- As a Broker, I want to choose which file types get watermarked, so that I'm not forced to convert every Excel workbook to PDF just to get watermark protection on the sensitive PDFs.
- As a Broker, I want to be warned before enabling watermarking that Excel files will be converted to PDF on export and that preview mode will be disabled, so that I can make an informed choice instead of discovering the side effect after the fact.
- As a Buyer/Company/Accountant user with export access, I want to see a watermark on my downloaded or printed copy of a document, so that I understand my copy is individually attributable.
# 3. Functional Requirements
- The system shall allow a Broker to enable or disable watermarking independently for each deal/company file (data room).
- The system shall allow the Broker, when watermarking is enabled for a deal, to select which file types are included (e.g., PDF, Word, Excel, image files) rather than applying watermarking to all file types uniformly.
- The system shall apply the watermark dynamically at export time (download or print), stamping it onto the rendered output rather than into the stored source file, so the stored original remains unaltered.
- The watermark shall include, at minimum: the exporting user's name, email address, company/organization, and the date/time of export.
- The system shall display a confirmation warning to the Broker before watermarking is enabled for any file type that requires format conversion to render a watermark (Excel and other non-PDF-native formats), stating explicitly that (a) matching files will be converted to PDF upon export, and (b) preview/view-only mode will no longer be available for files in scope of the watermarking setting.
- The system shall store the original uploaded file in its native format regardless of the watermarking setting; conversion to PDF shall occur only at export time and shall not overwrite or replace the stored original.
- When watermarking is enabled for a deal, the system shall disable the in-app preview/view-only mode for files within the scope of that setting (i.e., the matching file types), requiring users to export/download to view the content.
- When watermarking is disabled for a deal (or for a given file type within that deal), the system shall permit normal preview and export behavior with no watermark applied.
- The watermarking setting shall apply to the company file broadly, covering documents in the data room as well as reports and workbook exports generated from within the platform for that deal (e.g., financial reports, QoE workbook exports), not only uploaded source documents.
- The system shall log every watermarked export event (user, file, file version, timestamp, and watermark content applied) to the platform activity log.
- The system shall log every attempt to export a file where watermarking is required but fails to apply, and shall block the export rather than releasing an unwatermarked copy.
# 4. Data Requirements
Traces to the Database module table blocks (DB-0001 through DB-0010) and the platform-wide activity log.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Deal-level watermark enabled/disabled flag | Read/Write | Data Room settings (deal/company record) — see DR-0001, DR-0002 |
| Watermark file-type scope (which file types are included) | Read/Write | Data Room settings (deal/company record) |
| Exporting user identity (name, email, company/org) | Read | User Set up module — US-0001 through US-0005 |
| Export/print event record (user, file, version, timestamp) | Write | Activity & Audit Log — SY-0003 |
| Original stored file (native format) | Read | Core Data Room file storage — DR-0001 |
| Rendered/converted export copy (watermarked) | Write | Generated at export time; not persisted as the file of record |

# 5. Access & Security
- Roles with access to configure watermarking: Broker (deal owner/admin).
- Roles that can trigger a watermarked export as a recipient: Buyer, Company, Accountant, Bank — any role granted export/download permission on a given file per the permission model in SE-0002 (formerly product-listed as such; see Open Questions).
- Roles explicitly excluded from configuring watermarking: any non-Broker role. Watermarking policy is set exclusively by the Broker for their deal.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of watermarking settings, exported files, or export activity.
# 6. UI / UX Notes
- Platform: Web only. Watermark configuration and export behavior are managed and rendered through the web data room; not extended to the mobile (light) companion experience in this spec.
- Wireframe reference: N/A
Watermarking is configured from a settings panel on the deal/company data room (toggle: On/Off), with a secondary file-type selector (checkboxes) that appears once toggled On. Selecting a file-type combination that requires PDF conversion (e.g., Excel) triggers a modal warning before the setting is saved, listing both consequences: (1) matching files will be converted to PDF on export, and (2) preview mode will be disabled for those file types. The Broker must acknowledge the warning to proceed. Any file rendered with a watermark should show a preview of the watermark placement/content to the Broker before the setting goes live, so the Broker knows what recipients will see.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DR - 0001 (Core Data Room) | Depends on | Watermarking is applied to files stored in the core data room. |
| DR - 0002 (Templated File Structure) | Depends on | Deal-level file structure/company file context that watermarking settings attach to. |
| SY - 0003 (Activity & Audit Log) | Depends on | Every watermarked export and blocked export attempt must write to the activity log. |
| QE - 0013 (Workbook Export) / Reports module (RP) | Depends on / Blocks | If watermarking scope extends to report and workbook exports as directed, those export pipelines must call the same watermarking service. Not yet specced — see Open Questions. |
| Access permission model (folder/file-level export permissions) | Depends on | Not yet specced as its own feature at time of writing; watermarking assumes an underlying permission layer already governs who may export a given file. Flagged as an Open Question below. |

# 8. Out of Scope / Deferred
- Per-user or per-file granular watermark toggling (i.e., watermarking a single specific file for a single specific user, independent of the deal-level file-type setting) — this spec covers deal-level, file-type-scoped configuration only.
- IP or geography-based access restriction — deferred to a future data-room security spec.
- Remote revocation of a previously downloaded file — deferred; not addressed by this feature.
- Automatic access expiration/revocation tied to deal stage changes — deferred to a future data-room security spec.
- Secure in-app viewer restrictions such as disabling copy/screenshot capture during preview — out of scope since this spec removes preview mode entirely for in-scope file types rather than hardening it.
# 9. Open Questions
- Which specific report/workbook export pipelines (QoE Workbook Export QE-0013, Reports module RP-0001/0002/0003, Valuation exports VL-0001) are in scope for "company file" watermarking on day one, versus deferred to when those modules are specced individually?
- What is the source-of-truth permission model that determines who may export/download a given file in the first place? This spec assumes that layer exists and simply adds watermarking on top of it, but it is not yet its own feature spec.
- Should the file-type scope selector default to any preset (e.g., PDF only) when a Broker first enables watermarking, or start unselected and require explicit choice?
- Does disabling preview mode for in-scope file types affect any existing feature that currently assumes in-app preview is always available (e.g., buyer engagement analytics in BO-0004, which tracks document view duration)? If preview is disabled for watermarked file types, view-duration telemetry for those files may need to be reconsidered.
# 10. Acceptance Criteria
- Broker can enable watermarking for a deal and select which file types are included; the setting persists and is scoped to that deal only.
- Enabling watermarking for a file type that requires PDF conversion triggers the warning modal, and the setting is not saved until the Broker acknowledges it.
- Exporting an in-scope file (download or print) produces an output stamped with the exporting user's name, email, company, and export timestamp; the stored original file is unchanged.
- Preview/view-only mode is unavailable for file types in scope of an enabled watermarking setting, and remains available for file types outside that scope or when watermarking is disabled.
- Every watermarked export, and every blocked export attempt where watermarking could not be applied, appears in the deal's activity log with user, file, version, and timestamp.
- Disabling watermarking for a deal restores normal preview and export behavior with no watermark applied, with no change to previously exported (already-watermarked) copies.

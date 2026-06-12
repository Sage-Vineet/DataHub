# Key Reports Architecture — Analysis & Implementation Report (Phase 1)

> **Status:** Analysis complete. **No code has been changed.** This document is the pre-implementation deliverable requested before any work begins.
> **Date:** 2026-06-12 · **Branch:** `08_06_swapnil`
> **Goal:** Make "Key Reports" the official source of truth for financial data, relocate Connections under Data Room, add manual file→category mapping, versioning, file-link protection, and a sync→financial-tables pipeline — **with zero regressions**.

---

## 0. Stack Summary (verified)

| Layer | Reality (verified, not assumed) |
|---|---|
| Frontend | React 19 + Vite, `react-router-dom` **HashRouter** (`src/App.jsx`), Zustand stores, Tailwind. |
| Backend | Express (`backend/src/app.js`), JWT auth (`backend/src/middleware/auth.js`). |
| DB | **Supabase (Postgres) via service-role client** (`backend/src/db/index.js`, `backend/src/lib/supabaseClient.js`). The `sqlite3`/`pg` deps and the README "SQLite fallback" are **stale** — runtime is Supabase only. One raw `pg.Pool` is used solely at boot for `email_verifications` DDL (`backend/src/server.js:33-65`). |
| Migrations | **No migration runner exists.** `backend/sql/migrations/NNN_*.sql` is a hand-applied, idempotent changelog; `backend/sql/schema.sql` is the consolidated base. New tables must be written to **both** a new `046_*.sql` and `schema.sql`. Next free number = **046**. |
| File storage | Hybrid, size-based (`backend/src/controllers/uploads.js`): ≤5 MB → `uploads.data` bytea; >5 MB → Supabase Storage bucket `documents` (path in `uploads.storage_path`). **No `uploads/` filesystem dir, no S3.** |

---

# PHASE 1 — FULL CODEBASE ANALYSIS

## 1.1 Existing Modules — what exists vs. what does not

| Module | Status | Where |
|---|---|---|
| Data Room (Folders/Documents) | ✅ Exists | `folderService.js`, `documentService.js`, `FileExplorer.jsx` (2769-line monolith) |
| Connections | ✅ Exists (workspace tab) | `WorkspaceConnections.jsx`, route `connections` |
| QuickBooks **Online** | ✅ Exists (live OAuth + sync) | `backend/src/routes/quickbooks/*`, `quickbooksConnectionStore.js` |
| QuickBooks **Desktop** | ❌ **Does NOT exist** | No `qbxml`/`web connector`/`qwc` anywhere. "QuickBooks Manual" (`quickbooks_manual`) = uploading QB-exported Excel/PDF, not a Desktop connector. |
| Manual Upload (Excel/PDF) | ✅ Exists | `manualReportUploadService.js`, `manual_upload_excel_pdf` source |
| General Ledger upload flow | ✅ Exists (version-isolated) | `manualGlMultiYearService.js`, `manualGlUploadOrchestrationService.js` |
| Financial Report generation (P&L / BS / Cash Flow) | ✅ Exists | `WorkspaceReports.jsx` (3 tabs), `reports/*` components |
| EBITDA / Adjusted EBITDA | ✅ Exists | `WorkspaceEbitda.jsx`, `ebitdaAdjustments.js`, migration 043/045 |
| SDE | ⚠️ **Label toggle only**, not a module | `src/lib/profitMetric.js` — relabels the EBITDA page; identical calc |
| CIM Preparation | ❌ **Does NOT exist** | Zero references repo-wide |
| QoE / Quality of Earnings | ⚠️ **Nav grouping only** over Bank + Tax Reconciliation | `ClientWorkspaceLayout.jsx:86-97`. No aggregated QoE computation. |
| Report rendering system | ✅ Exists | `reports/shared/*`, source-mode switch in services |
| Dashboard metrics | ✅ Exists (4-source) | `WorkspaceDashboardDatahub.jsx`, `reportService.js:495-612` |
| Versioning system | ✅ Exists (Manual GL) | `dataset_versions`, `manual_gl_batches`, `reporting_snapshots` |
| File management | ✅ Exists | `uploads`/`documents`/`folders` tables |

**Critical takeaways:** CIM and an aggregated QoE **do not exist yet** — they are greenfield. SDE is a relabel of EBITDA. There is **no "Key Reports version" concept** today; the Manual GL `dataset_versions` + version-isolated `reporting_snapshots` infra is the closest foundation.

## 1.2 Current Data Flow

```
Connections (QB Online OAuth | Manual GL upload | Manual Excel/PDF | QB Manual)
        │
        ▼
Upload (POST /uploads → uploads table: bytea ≤5MB / Supabase Storage >5MB)
        │  └─ Document row created (documents table, folder-scoped, company-scoped)
        ▼
Processing
  • Manual GL:  orchestrateManualGlUpload → stageMultiYearGlUpload
                → manual_gl_batches (is_active=true, AUTO-activated on upload)
                → manual_gl_staged_transactions (tagged upload_batch_id)
                → generateReportingSnapshotsForBatch (fire-and-forget)
                → reporting_snapshots  UNIQUE(upload_batch_id, report_type, fiscal_year)
  • Auto-detect: detectStatementType() (filename+rows heuristic) and
                 autoDetectManualGlMapping() (column scoring)  ← client wants to REPLACE
        ▼
Reports (GET /manual-gl/reports/* )
  • Channel chosen by report_source_records.is_selected  (dataSourceService.getDataSourceState)
  • Batch/version chosen PER REQUEST by resolveEffectiveReportBatchId:
       explicit version → that version (empty if unresolved, never falls back)
       no version       → getActiveUploadBatch (is_active=true) = "LATEST UPLOAD"  ← client wants to REPLACE
  • Snapshot-first (tryLoadActiveSnapshot), live recompute fallback (queryStagedTransactions)
```

**Source-of-truth today = recency.** No persisted record says "report X is sourced from version Y." Each request re-resolves to the auto-activated latest batch unless a version is explicitly passed.

## 1.3 Current Financial Data Sources

- **Reports read from:** Manual GL `reporting_snapshots` (fast path) / `manual_gl_staged_transactions` (recompute) / raw uploaded file rows (Manual Upload, QMS) / QuickBooks API (live).
- **Source switch:** `src/lib/report-source.js` defines 4 modes; every service (`profitAndLossService.js:253-278`, `ebitdaService.js`, `reportService.js`) branches on `sourceMode`.
- **Calculation pipelines:** Manual GL → BS-driven account classification → per-fiscal-year snapshots (see memory `GL Classification Architecture`). EBITDA composes base (NI+Int+Tax+D+A) + year-keyed addbacks (`ebitda_adjustment_values.year`).

## 1.4 Current Database Structure (relevant tables)

| Domain | Tables |
|---|---|
| Files/Data Room | `folders`, `documents`, `uploads`, `document_activity`, `folder_access` |
| Doc-linking precedent | `request_documents(request_id, document_id, visible)` — **both FKs CASCADE** (does NOT protect from deletion) |
| Connections / sources | `report_source_records` (per-channel selector, `UNIQUE(company_id, source_key)`), `companies.data_source_type/quickbooks_connected`, `quickbooks_connections`, `connection_status` |
| Manual GL versioning | `manual_gl_batches` (`is_active` partial-unique per company), `manual_gl_staged_transactions`, `manual_gl_balance_sheet_lines`, `dataset_versions`, `reporting_snapshots` (`UNIQUE(upload_batch_id, report_type, fiscal_year)`), `sync_jobs`, `sync_logs` |
| EBITDA | `ebitda_adjustments` (carries `version_id`/`dataset_version_id`/`upload_batch_id`), `ebitda_adjustment_values` (year/month keyed) |

**Conventions to match (mandatory):** uuid PK `gen_random_uuid()`; `company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE`; `created_at/updated_at timestamptz DEFAULT now()`; `metadata jsonb NOT NULL DEFAULT '{}'`; idempotent DDL (`IF NOT EXISTS`, guarded `DO $$`); "one active per company" via partial unique index; child rows CASCADE, actor/optional refs SET NULL, immutable provenance RESTRICT.

---

# IMPACT ANALYSIS

## 2.1 Files requiring modification

**Frontend**
- `src/App.jsx` — add `dataroom/key-reports` route; relocate `connections` → `dataroom/connections` + legacy redirect; **remove the duplicate `connections` route at `:319`/`:321`**.
- `src/components/layout/ClientWorkspaceLayout.jsx` — move Connections from `bottomNav` (`:99-101`) into `dataroomNav` (`:103-110`); add a **Key Reports** entry to `dataroomNav`; import an icon.
- `src/lib/report-source.js` — add a `key_reports` source mode (so report/EBITDA/dashboard fetch paths can target Key Reports).
- `src/lib/quickbooks.js:84` & fallback redirect strings — update old `connections` path (low priority; dynamic redirect self-heals).
- (Optional) report/EBITDA/dashboard services — teach them to request the Key Reports version when that mode is active.

**Backend**
- `backend/src/app.js` — mount new `keyReportRoutes` in the `:126-132` block.
- `backend/src/services/manualGlMultiYearService.js` — **the primary seam:** `resolveEffectiveReportBatchId` (`:3328-3352`) "no version requested" branch should consult a Key Reports pointer before falling back to active batch.
- `backend/src/services/manualGlActiveBatchService.js` — `resolveReportBatchId`/`getActiveUploadBatch` callers (~6 sites: `manualGlMultiYearService.js:3414, 6282, 7395, 7701`, `getSnapshotForActiveBatch`) must honor the Key Reports pointer.
- `backend/src/services/manualGlUploadOrchestrationService.js:268` — **decouple** Key Reports pointer from auto-`is_active`-on-upload (central conflict, §9).
- `backend/src/services/documentService.js` `deleteDocument` (`:235-280`) & `folderService.js` `deleteFolder` (`:351-358`) — add file-link protection guard (409 if linked). **Also clean up the duplicate dead `createDocument`/`deleteDocument` defs (`:149-194`) before editing.**
- `backend/src/services/reportSourceStore.js` — optionally surface Key Reports pointer in channel metadata.

## 2.2 New files required

**Backend**
- `backend/sql/migrations/046_key_reports.sql` (+ mirror into `backend/sql/schema.sql`)
- `backend/src/services/keyReportService.js` — versions, mappings, sync, table generation
- `backend/src/services/fileReferenceService.js` — link/unlink + deletion-guard lookups
- `backend/src/routes/keyReports.js` — CRUD + sync endpoints (pattern: `requireAuth` + `resolveClientId` + `canAccessCompany`)

**Frontend**
- `src/pages/broker/workspace/WorkspaceKeyReports.jsx`
- `src/components/key-reports/*` — category panels, linked-file list, version controls, sync button, first-visit educational popup
- `src/components/key-reports/DataRoomFilePicker.jsx` — **new** picker (none exists; model on `MoveFolderModal`/`ShareAccessModal`, call `listFolderTree`/`listFolderDocuments` directly)
- `src/services/keyReportService.js` + `src/lib/api.js` additions

## 2.3 APIs requiring updates / additions

New (all `requireAuth` + company-access guarded):
- `GET/POST/PUT /companies/:id/key-reports/versions` (+ duplicate, switch active)
- `GET/POST/DELETE /key-reports/versions/:vid/mappings` (category ↔ file)
- `POST /key-reports/versions/:vid/sync` (idempotent; generate financial tables)
- `GET /key-reports/versions/:vid/sync-logs`
- `GET /key-reports/file-references?fileId=` (for the deletion guard / "linked" badge)
- `GET/PUT /users/me/preferences/key-reports-popup` (first-visit popup dismissal)

Modified read path: report endpoints in `backend/src/routes/manualGl.js` gain Key-Reports-pointer awareness via `resolveEffectiveReportBatchId`.

## 2.4 Database changes — see "DATABASE CHANGES" below.

## 2.5 High-risk areas / regression points

1. **Auto-activation conflict (highest risk):** today an upload sets `manual_gl_batches.is_active=true` and that silently becomes the report source. Key Reports must intercept this without breaking the existing "latest upload shows in reports" default for companies that haven't adopted Key Reports.
2. **CASCADE everywhere defeats deletion protection:** `documents.folder_id`/`company_id` and the `request_documents` precedent all CASCADE. File protection must be enforced at the **application layer** (RESTRICT FK + 409 guard), not by copying the existing junction pattern.
3. **Version-switch races & fiscalYear keying** (already-known landmines per memory `project_gl_perf_correctness_audit`): any new consumer must pass `fiscalYear` and guard last-write-wins.
4. **`FileExplorer.jsx` monolith + localStorage-persisted tree** — do not couple the picker to it; call APIs directly.
5. **Duplicate routes / dead code** (`App.jsx:319/321`, dead `Connections.jsx`, dead `documentService` defs) — fix-while-touching to avoid editing the wrong copy.
6. **No migration runner** — migrations are hand-applied; coordinate DB apply with deploy.

## 2.6 Performance considerations

- Reuse the immutable, per-version `reporting_snapshots` (keyed by `upload_batch_id, report_type, fiscal_year`) — a Key Report just selects which `upload_batch_id` to read; **no recompute needed**.
- Sync must be idempotent and incremental; reuse `reportCache.invalidateCompany` on publish.
- Don't revert the deliberate per-year snapshot split (memory: avoids heap exhaustion on 100k+ rows).
- File picker should lazy-load folder documents, not fan-out the whole tree.

---

# DATABASE CHANGES

New migration `046_key_reports.sql` (idempotent; mirror into `schema.sql`):

```
key_report_versions
  id uuid PK, company_id uuid NOT NULL → companies CASCADE,
  version_number int NOT NULL, version_name text,
  status text DEFAULT 'draft',           -- draft | synced | archived
  is_active boolean DEFAULT false,        -- the "official" version
  created_by uuid → users SET NULL, created_at, updated_at,
  metadata jsonb DEFAULT '{}',
  UNIQUE(company_id, version_number),
  partial-unique (company_id) WHERE is_active   -- one official version per company

key_report_file_mappings
  id uuid PK, version_id uuid NOT NULL → key_report_versions CASCADE,
  report_category text NOT NULL,          -- profit_loss|balance_sheet|general_ledger|bank_statement|tax_return (extensible, text)
  document_id uuid → documents SET NULL,  -- reference Data Room doc (stable; not file_url)
  upload_id uuid → uploads SET NULL,
  linked_by uuid → users SET NULL, created_at,
  UNIQUE(version_id, report_category, document_id)   -- no dup links; multi-file per category allowed

key_report_sync_logs   -- mirror existing sync_logs shape
  id bigserial PK, version_id uuid → key_report_versions CASCADE,
  company_id uuid → companies CASCADE,
  sync_status text, sync_started_at, sync_completed_at, error_message text, metadata jsonb

file_references        -- generic link registry powering deletion protection + "linked" badge
  id uuid PK, company_id uuid → companies CASCADE,
  document_id uuid NOT NULL → documents RESTRICT,   -- RESTRICT = deliberate, opposite of existing CASCADE
  linked_module text NOT NULL,            -- 'key_reports'
  linked_entity_id uuid,                  -- key_report_versions.id
  created_by uuid → users SET NULL, created_at,
  UNIQUE(document_id, linked_module, linked_entity_id)
```

Also: a per-user preference for the educational popup — reuse the existing `workspacePageState` store **or** add a small `user_preferences(user_id, key, value jsonb)` table (decision pending, §11).

**No data migration of existing rows is required** — these are additive tables. Existing reports keep working unchanged until a company creates+activates a Key Report version.

---

# API CHANGES (summary)

- **Additive only** for Key Reports (above).
- **Behavioral change** to existing Manual GL report endpoints: when a company has an active Key Report version, `resolveEffectiveReportBatchId` resolves to the Key-Report-pinned `upload_batch_id` instead of the auto-active batch. **Backward-compatible:** when no Key Report version exists/active, behavior is identical to today (active/latest batch).
- **Connections route move** is backward-compatible via a `Navigate` redirect (mirrors existing `dataroom/*` redirect pattern at `App.jsx:330-353`). OAuth redirect-back self-heals (captured dynamically from live path).

---

# UI CHANGES (summary)

1. **Nav:** move "Connections" into the collapsible **DataRoom** group; add **"Key Reports"** under DataRoom (`ClientWorkspaceLayout.jsx` `dataroomNav`).
2. **New page** `WorkspaceKeyReports` at `dataroom/key-reports`: category sections (P&L, BS, GL, Bank Statements, Tax Returns) each with **[Link Files]** → Data Room picker, linked-file list with unlink, version selector + create/edit/duplicate/switch, **Sync** button + status, first-visit educational popup with "Don't show again."
3. **Data Room file explorer:** add a "★ Linked to Key Reports" indicator on linked files; intercept delete with a warning ("unlink first").
4. **Reports/EBITDA/Dashboard:** add Key Reports as a selectable source (later phase).

---

# DATA MIGRATION STRATEGY

- **Schema:** apply `046_key_reports.sql` to Supabase (hand-applied, idempotent). Update `schema.sql`.
- **Existing data:** none to backfill. Optionally seed a "Version 1" Key Report per company from the current active batch in a later convenience step (not required).
- **Adoption is opt-in per company** — until a version is activated, the system behaves exactly as today.

---

# ROLLBACK PLAN

1. **Frontend:** Key Reports nav/page is additive; hide via feature flag or revert the nav/route commits. Connections relocation rolls back by restoring the `connections` nav entry (the redirect can stay harmlessly).
2. **Backend read path:** the Key Reports pointer check is a single guarded branch in `resolveEffectiveReportBatchId` — if disabled/absent, it falls through to current active-batch logic. Gate it behind a check for an active `key_report_versions` row so absence = today's behavior.
3. **DB:** new tables are additive and unreferenced by legacy code; they can be left in place on rollback (drop only if necessary). No destructive changes to existing tables.
4. **Auto-activation:** keep the existing `is_active`-on-upload behavior intact; Key Reports reads a **separate** pointer, so reverting Key Reports cannot strand the legacy report source.

---

# TESTING STRATEGY (to execute during/after implementation)

**Regression (must stay green):** Data Room upload/move/delete; QB Online connect+sync+reports; Manual Upload & QMS dashboards; Manual GL upload → version isolation (V1/V2/V3 independently selectable); P&L/BS/Cash Flow; EBITDA/Adjusted EBITDA/SDE; version-switch race (no F5 needed); fiscalYear-keyed snapshots.

**New features:** version create/edit/duplicate/switch; multi-file linking per category; file-link protection (delete blocked with warning); sync + re-sync idempotency (no duplicate tables/snapshots); educational popup dismissal persisted per user; Key Reports financial-table generation; report consumption from Key Reports version.

---

# RISKS & RECOMMENDATIONS

1. **Decouple Key Reports from auto-`is_active`.** Do **not** repurpose `manual_gl_batches.is_active` — uploads flip it automatically. Introduce a separate `key_report_versions.is_active` pointer and have `resolveEffectiveReportBatchId` prefer it. This is the single most important design decision.
2. **Enforce file protection in the app layer** (RESTRICT FK + 409 guard in `deleteDocument`/`deleteFolder`), because every existing FK is CASCADE and would silently drop links.
3. **Reference `document_id`/`upload_id`, never `file_url`** (URL is host-dependent, built at insert time).
4. **Build a dedicated lightweight file picker** — none exists; don't couple to the 2769-line `FileExplorer.jsx`.
5. **Implement incrementally & behind opt-in** so the system is identical to today until a company activates a Key Report version → satisfies "no breaking changes."
6. **Validation = warnings only** this phase (allow sync with missing BS/GL/Tax), per requirement.
7. **Fix adjacent dead code/duplicates while touching those files** (duplicate routes, dead `Connections.jsx`, dead `documentService` defs).

---

## Recommended implementation order (incremental, each independently shippable)

1. **DB migration 046** (+ schema.sql) — additive, zero risk.
2. **Connections relocation** under Data Room (route + redirect + nav) — small, isolated.
3. **Key Reports backend** (service + routes + file_references + deletion guard).
4. **Key Reports UI** (page, picker, linking, versions, popup).
5. **Sync → financial-table generation** (reuse snapshot infra).
6. **Source-of-truth wiring** — `resolveEffectiveReportBatchId` prefers active Key Report version (opt-in, fully backward-compatible).
7. **Reports/EBITDA/Dashboard** consume Key Reports source; later CIM/QoE built on top.

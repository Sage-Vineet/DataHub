# Key Reports Rearchitecture — Phase 1 Analysis & Migration Plan

> Status: **Analysis complete. No code changed yet** (per the "do not start coding until dependency
> analysis is complete" directive). This document is the Phase 1 deliverable and the proposed plan.

## TL;DR

Most of the client's "new architecture" is **already built**. Key Reports is already the
version-scoped source of truth (migration `046_key_reports.sql`), version isolation is already
enforced at the DB and query layers (migrations 019/021/026/027/030/038/039), and Bank/Tax
reconciliation already resolve documents by the **selected** Key Report version with **no staging
dependency**. The remaining work is a focused set of gaps, not a ground-up rebuild.

Trying to literally recreate the client's proposed table list (`versions`, `version_files`,
`gl_entries`, `balance_sheet_snapshots`, …) as brand-new tables would **duplicate** the existing
schema under new names and risk breaking everything currently working. The recommended path is to
**extend the existing architecture** to close the real gaps and map the client's concepts onto the
tables that already serve them.

---

## 1. Current Architecture (Dependency Map)

### Data-source spine
```
Company
 └─ key_report_versions            (migration 046)  ← THE version container; one is_active per company
     ├─ key_report_file_mappings   (doc ↔ report_category: profit_loss | balance_sheet |
     │                              general_ledger | bank_statement | tax_return)
     ├─ file_references            (RESTRICT FK — deletion protection)
     ├─ resolved_batch_id ─────────┐
     └─ resolved_dataset_version ──┤  pins the version to a Manual GL dataset
                                    ▼
        dataset_versions (019/021) + manual_gl_batches (026/027)
           └─ manual_gl_staged_transactions   (gl_entries equivalent)
           └─ manual_gl_balance_sheet_lines    (balance_sheet_snapshots equivalent)
           └─ reporting_snapshots              (pre-computed P&L/BS/CF per version+year)
```

### Central resolver contract (every consumer uses this)
`keyReportService.getVersionReportContext(companyId, { datasetVersion, versionId })`
→ resolves version (explicit `versionId` → pinned `datasetVersion` → active version)
→ returns linked documents grouped by category + `flowType` (`manual_gl` | `manual_upload`).
`backend/src/services/keyReportService.js:469-594`.

### Page → dependency table
| Page | Reads from | Version-scoped? | Staging dep? | Upload-type dep? |
|------|-----------|-----------------|--------------|------------------|
| WorkspaceReports (P&L/BS/CF) | `/reports/*` (manualGl.js) → `reporting_snapshots` then `manual_gl_staged_*` | ✅ via `resolveEffectiveReportBatchId` | ⚠️ **Yes** (summary fallback + all monthly-detail) | ⚠️ **Yes** (`sourceMode` + `report_source_records` + `enforceDataSource`) |
| WorkspaceEbitda | P&L staging (via `/reports/profit-loss`) | ✅ | ⚠️ Yes | ⚠️ Yes |
| WorkspaceReconciliation (bank) | `/qb-bank-activity` (QB) + `/extract-bank-pdf-records` (doc-linked) | ✅ via `getVersionReportContext` | ✅ No | partial (`source` param) |
| WorkspaceTaxReconciliation | Key Reports `tax_return` + `profit_loss` docs (frontend extraction) | ✅ | ✅ No | ✅ No |
| WorkspaceKeyReports | `key_report_versions` / `_file_mappings` | ✅ | ✅ No | ✅ No |
| WorkspaceConnections | `report_source_records` (the upload-type selector) | n/a | n/a | **this IS the selector to remove** |

---

## 2. What Already Satisfies the Client Spec

| Client phase | Requirement | Status | Where |
|---|---|---|---|
| 2 | Key Reports = master data source | ✅ Done | migration 046; `keyReportService.js` |
| 4 | Version-centric, fully isolated data | ✅ Done | 019/021/026/027/030/038/039; `manualGlActiveBatchService.resolveReportBatchId` returns empty (not active) on version miss |
| 5 (partial) | versions / version_files / sync_jobs / validation_results / gl_entries / balance_sheet_snapshots | ✅ Exist under other names | see §4 mapping table |
| 6 | Sync runs ordered processing | ✅ Partial | `keyReportService.syncVersion` → `keyReportSyncService.generateFinancialTables` → `orchestrateManualGlUpload` |
| 12 | BS roll-forward from earliest + GL | ✅ Partial | starting/ending BS slots in `keyReportSyncService.js`; `manual_gl_balance_sheet_lines` |
| 14 | Reports use validated version data | ⚠️ Partial | reports are version-scoped BUT still read staging + honor upload-type |
| 15 | Tax recon uses selected version's tax files | ✅ Done | `getVersionReportContext` |
| 16 | Bank recon uses selected version's bank files | ✅ Done | `bankVsBooks.js` `runBankExtraction` |
| 17 | No version/upload/staging mixing | ✅ Mostly | document-signature cache + version-scoped batch resolution |

---

## 3. Real Gaps (the actual work)

| # | Gap | Client phase | Effort |
|---|-----|--------------|--------|
| G1 | **Remove upload-type selection.** Sync should auto-detect tax/bank/GL/BS/P&L from linked files; drop the Manual Upload vs Manual GL cards, `report_source_records.is_selected`, `sourceMode` branching, and `enforceDataSource` gating for reports. | 3, 14 | High (touches reports FE+BE) |
| G2 | **Decouple reports from staging.** Route all `/reports/*` (incl. monthly-detail) to validated version snapshots; eliminate the staging-table fallback as a *user-facing* source. | 14 | Medium-High |
| G3 | **Async sync + live progress dashboard.** Convert `syncVersion` to a background job; add per-data-type progress (GL/BS/Tax/Bank/COA) with %, current file, stage; stream via SSE/poll. Worker columns already exist (036). | 6, 7 | High |
| G4 | **Validation engine + dashboard.** Add `validation_results` keyed by (version, data_type, year, account) with success/warning/error + actionable messages; build the per-year status grid UI. | 8,9,11,12,13,18 | High |
| G5 | **Chart of Accounts engine + table + UI.** Build COA hierarchy from P&L/GL/BS; persist; expose review/edit UI. | 10 | Medium-High |
| G6 | **Structured bank tables.** `bank_accounts` + `bank_statement_periods` (currently JSONB) to drive missing-month / missing-balance detection. | 5, 9 | Medium |
| G7 | **File metadata.** Capture `year` / `file_type` / `account_number` at link time (currently inferred). | 5 | Low-Medium |

---

## 4. Schema Mapping (client name → existing table)

| Client-desired table | Existing table | Action |
|---|---|---|
| `versions` | `key_report_versions` (+ `dataset_versions`) | reuse; add columns if needed |
| `version_files` | `key_report_file_mappings` | reuse; add `year`, `file_type` metadata (G7) |
| `sync_jobs` | `key_report_sync_logs` + `processing_jobs` + `upload_jobs` | reuse; add per-type progress JSONB (G3) |
| `validation_results` | `validation_errors` (errors only) | **extend** to full success/warning/error per (version,type,year) (G4) |
| `chart_of_accounts` | — | **new** (G5) |
| `gl_entries` | `manual_gl_staged_transactions` | reuse |
| `balance_sheet_snapshots` | `manual_gl_balance_sheet_lines` | reuse |
| `bank_accounts` | — | **new** (G6) |
| `bank_statement_periods` | — | **new** (G6) |

---

## 5. Proposed Migration Plan (phased, non-breaking)

Each phase is independently shippable and leaves the app working.

- **M1 — Validation engine + dashboard (G4, G7).** New `validation_results` table (migration 047),
  populate during sync, build the per-year status grid. *Pure addition; no regression risk.*
- **M2 — Chart of Accounts (G5).** New `chart_of_accounts` table (048), COA builder in sync,
  read-only UI first, edit later. *Pure addition.*
- **M3 — Structured bank tables (G6).** `bank_accounts` + `bank_statement_periods` (049), populate
  from extraction, feed missing-month/balance validation. *Pure addition.*
- **M4 — Async sync + live progress (G3).** Per-type progress JSONB + job worker + SSE/poll.
  *Behavioral change to sync; feature-flag it.*
- **M5 — Remove upload-type selection (G1) + decouple reports from staging (G2).** Highest blast
  radius; do last, behind a flag, with full regression pass. *Touches every report page.*

Rationale: additive phases (M1–M3) first to build the validation/COA/bank substrate the client's
screenshots depend on, then the behavioral changes (M4–M5) once the substrate is trusted.

---

## 6. Open Decisions (need client/owner input before coding)

1. **Extend existing schema vs. literal new tables?** (Recommended: extend — see §4.) Building the
   literal new schema duplicates working tables and risks the "do not break existing functionality"
   constraint.
2. **Which phase to start with?** (Recommended: M1 validation engine — highest visible value, zero
   regression risk, directly matches the client's dashboard screenshots.)
3. **Migration application:** migrations here are hand-applied (no runner). Confirm who applies 047+.

---

## 7. Regression Risks To Watch

- Removing `enforceDataSource`/`sourceMode` (M5) affects P&L, BS, Cashflow, EBITDA on
  WorkspaceReports and WorkspaceEbitda — needs a full report-rendering regression pass.
- Decoupling reports from `manual_gl_staged_*` (M5) must guarantee snapshots exist for every
  version+year, or reports go blank. Snapshot-coverage backfill required first.
- Async sync (M4) changes the request/response contract the frontend expects — feature-flag and
  keep the synchronous path until the worker is proven.

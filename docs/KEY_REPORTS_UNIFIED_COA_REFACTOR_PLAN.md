# Key Reports — Unified COA / Date Dimension / Entity Refactor

> **Status: P1-P3 IMPLEMENTED (2026-07-10).** P4 (collapsing the two report engines)
> remains an open decision — see §9 — and has NOT been started.
> **Date:** 2026-07-10 · **Branch:** `10_07_swapnil`
> **Scope:** Align the existing Key Reports database + reporting engine with
> `Space Entertainment Center.xlsx` and `chart_of_accounts_SEC.xlsx` — **evolve**, not
> replace, the current architecture.
>
> **Implementation log:**
> - **P1 (date dimension):** `backend/sql/migrations/067_date_dimension.sql` (new
>   `date_dimension` table + `general_ledger_entries.date_id`), mirrored into
>   `backend/sql/schema.sql`. `generalLedgerExtractionService.js` gained
>   `_attachDateDimension()`, called from `insertRows()` — upserts any new dates
>   and resolves `date_id` per row; degrades gracefully (rows insert with
>   `date_id = null`) if migration 067 hasn't been hand-applied yet.
> - **P2 (vendor/customer/entity_type):** `backend/sql/migrations/068_gl_entity_fields.sql`
>   (adds `vendor`, `customer`, `entity_type` to `general_ledger_entries`), mirrored
>   into `schema.sql`. `generalLedgerExtractionService.js`: split the old merged
>   `NAME_ALIASES` into `VENDOR_ALIASES`/`CUSTOMER_ALIASES` (explicit) with the
>   old generic `name`/`entity` header as an ambiguous fallback that defaults into
>   the `vendor` bucket (documented assumption, not a silent guess).
>   `keyReportReportService.getGeneralLedgerReport` now selects the three new
>   columns plus `date_id`.
> - **P3 (unified COA hierarchy):** `coaHierarchyRules.js`
>   (`SECTION_STANDARD_LEVELS`/`TYPE_STANDARD_LEVELS`) and
>   `chartOfAccountsService.js` (`HIERARCHY_LEVELS`, `validateHierarchyConsistency`,
>   `LEVEL_ORDER`) rewritten from the split `Income Statement`/`Balance Sheet`
>   two-root model to the client's unified model (`Total Liabilities and Equity →
>   Total Equity → Net Income → Pretax Income → Operating Income → Gross Profit →
>   Total Revenue/Income`, parallel `Total Assets` root). No migration required —
>   `chart_of_accounts` column shape is unchanged; only `level_*`/`hierarchy_path`
>   **values** change, on the next COA regenerate (existing upsert-by-stable-key
>   endpoint, non-destructive to `audit_log`/user adjustments). Verified with a
>   standalone script exercising `buildLevelsFromPath` for asset/liability/equity/
>   income/cogs sections — output matches the client's example path exactly.
> - Verification performed: `node --check` + `require()`-load on all 4 touched
>   files (generalLedgerExtractionService.js, coaHierarchyRules.js,
>   chartOfAccountsService.js, keyReportReportService.js) — all pass. **Not**
>   run against a live Supabase instance (no credentials in this environment,
>   consistent with every prior Key Reports change) — migrations 067/068 must be
>   hand-applied, and COA must be regenerated for existing versions, before P3's
>   effect is visible in the UI.

All findings below are verified against the current repository state (migrations through
`066_bank_recon_addback_key_report_version.sql`, `backend/src/services/keyReports/*`,
`backend/src/routes/keyReports.js`), not against stale memory. Two prior analysis docs exist
(`KEY_REPORTS_ARCHITECTURE_ANALYSIS.md`, `KEY_REPORTS_COA_AND_REPORTS_ANALYSIS.md`) — this
document supersedes them for the COA-hierarchy/date-dimension/entity scope and should be read
alongside them for the broader Key Reports history.

---

## 1. Current Architecture Analysis

### 1.1 Existing end-to-end flow (unchanged, verified)

```
Upload → Data Room (documents/uploads)
    │
    ▼
key_report_file_mappings  (category ↔ document, per key_report_versions row)
    │
    ▼
Sync  POST /key-reports/versions/:id/sync   (keyReportSyncService.generateFinancialTables)
    │
    ├─ Phase 0  classifyWorkflowDocuments   (GL required / Opening BS hard gate)
    ├─ Phase 1  extraction → tax_return_entries, bank_statement_entries,
    │                        balance_sheet_entries, general_ledger_entries
    │                        (profit_loss_entries DROPPED — P&L is GL-derived only, migration 056)
    ├─ Phase 2  generateChartOfAccounts()   → chart_of_accounts (15-level, AI-classified)
    ├─ Phase 3  generateTrialBalance()      → trial_balance_entries   (GL-only, migration 057)
    ├─ Phase 4  generateMonthlyBalanceSheets() → balance_sheet_entries (is_generated=true rows)
    ├─ Phase 5  generateReconciliation()    → bs_reconciliation_entries (migration 058)
    └─         buildValidationResultsFromEntryTables → key_report_validation_results
    │
    ▼
Reports API  GET /key-reports/versions/:id/reports/{profit-loss|balance-sheet|trial-balance|
             reconciliation|cashflow|general-ledger|bank-statement|tax-return|
             financial-statements|qoe|kpi}  +  /export
    │
    ▼
Frontend  WorkspaceKeyReports (7-step stepper) → ChartOfAccountsTreeGrid,
          FinancialStatementsView, KeyReportSyncDashboard
```

This already matches the client's target shape (`date_dimension / chart_of_accounts /
general_ledger_entries → trial_balance → financial_statements → reports_api →
frontend_reports`) at the workflow level — the gaps are inside specific tables/columns and one
duplicated engine, detailed in §2.

### 1.2 Current database structure (tables relevant to this refactor)

| Table | Key columns (current) | Notes |
|---|---|---|
| `key_report_versions` | `id, company_id, version_number, status, is_active` | Version container; everything below is version-scoped and CASCADE-deleted with it. |
| `key_report_file_mappings` | `version_id, report_category, document_id` | Category↔file link. |
| `general_ledger_entries` (047→050→060→063) | `id, version_id, company_id, source_file_id, transaction_date, fiscal_year, fiscal_month, account_number, account_name, account_section, account_type(dropped 060), coa_id→chart_of_accounts, transaction_number, memo, debit_amount, credit_amount, amount, split_account, running_balance, row_type, row_number, raw_row_json` | **Fact table.** Migration 060 already renamed it from a raw-export mirror to an accounting-ledger shape and added `coa_id`. **`vendor_name`/`transaction_name` were explicitly DROPPED in migration 060** — see RC-1 below. No `date_id`, no `customer`, no `entity_type`. |
| `chart_of_accounts` (047→051→052→053→059→062) | `id, version_id, account_number, account_name, account_type, statement_type, parent_account_id, sort_order, system_id, normal_balance, level_1..level_15, base_account, hierarchy_path, account_id_name, classification_method, original_name, original_hierarchy, adjusted_name, adjusted_hierarchy, audit_log jsonb, metadata` | Already has **every column the client's Excel lists**: `system_account_id`(`system_id`), `account_number`, `account_name`, `statement_type`, Level 1→15, `hierarchy_path`, `classification_method`, adjusted hierarchy, `sort_order`. Side tables (`coa_account_mappings/adjustments/classification_history/hierarchy_levels`) were **deliberately dropped in migration 055** and folded into `audit_log` + a static in-code taxonomy — a decision the client explicitly asked for ("I do not need the mapping/adjustment/classification tables"). Unique leaf index added in 062. |
| `trial_balance_entries` (057) | `version_id, fiscal_year, account_name, account_number, account_type, total_debits, total_credits, net_balance, opening_balance, closing_balance` | Already generated **exclusively from `general_ledger_entries`** — exactly the client's required `GL → COA → Aggregation → Trial Balance` flow. |
| `balance_sheet_entries` (049→054) | `+ is_generated boolean, as_of_date, section` | Hybrid: extracted (uploaded) rows keep `is_generated=false`; GL carry-forward rows are stored with `is_generated=true`, refreshed every sync. Already functions as the "snapshot" table the client's §6 describes. |
| `bs_reconciliation_entries` (058) | `fiscal_year, account_name, generated_balance, uploaded_balance, variance, status` | Generated-vs-uploaded BS diff, read-only. |
| `profit_loss_entries` | **Table DROPPED** (migration 056) | P&L is generated live from GL in both report engines; nothing persisted. |
| `generated_report_snapshots` (061) | `version_id, report_type(profit_loss|cash_flow), scope_key, payload jsonb` | Render-cache only, not an accounting source. |
| `key_report_document_processing`, `key_report_coa_classification_cache` (065) | — | Performance caches (extraction reuse, AI classification reuse). Unrelated to this refactor; leave untouched. |

### 1.3 Current COA hierarchy taxonomy (code + DB, in sync)

`coaHierarchyRules.js` (`STANDARD_PREFIX`) and the DB seed (`053_coa_hierarchy_reseed.sql`)
implement a **split, two-root hierarchy**:

```
Income Statement                    Balance Sheet
  └─ Net Income                       ├─ Total Assets
       └─ Pretax Income               ├─ Total Liabilities
            └─ Operating Income       └─ Total Equity
                 └─ Gross Profit
                      ├─ Total Revenue → Income
                      └─ Total Expenses → Expenses → (8 standard groups)
```

This is **not** what the client's spec asks for (§2.1 below is the central gap).

### 1.4 Current report generation — two live, duplicated engines (confirmed, not stale)

| Engine | File | Serves | Classification source |
|---|---|---|---|
| A | `keyReportReportService.js` (~2200 lines) | `/profit-loss`, `/balance-sheet`, `/trial-balance`, `/reconciliation`, `/cashflow`, `/general-ledger`, `/bank-statement`, `/tax-return`, `/qoe`, `/kpi` | Its own inline keyword classifier (`ASSET_KW`/`LIABILITY_KW`/…), **does not read `chart_of_accounts` at all** for BS/P&L math (it does read COA for `account_type` in the Trial Balance path only). |
| B | `financialStatementService.js` | `/financial-statements` (only) | COA-tree driven (`buildTree`/`buildMappings`/fuzzy leaf matching against `chart_of_accounts`). |

Both are live, both are called from `routes/keyReports.js`, and they can render different
numbers for the same version+year (documented in memory
`project-key-reports-audit-2026-07`). This directly blocks the client's target
`chart_of_accounts → trial_balance → financial_statements` single-path picture and is the
highest-leverage item in the roadmap below.

### 1.5 Current APIs (`backend/src/routes/keyReports.js`, verified)

Versions CRUD/duplicate/activate/delete · mappings CRUD · sync · sync-logs · extracted-data ·
hierarchy-levels · chart-of-accounts (get/history/regenerate/patch/reset/save/reset-all) ·
file-references · popup-preference · **11 report endpoints** (profit-loss, balance-sheet,
trial-balance, reconciliation, cashflow, general-ledger, bank-statement, tax-return,
financial-statements, qoe, kpi) · export. This is already a mature, broad surface — the
refactor below is additive to it (§8), no endpoint removals required.

---

## 2. Gap Analysis vs. Client Spec

| # | Client requirement | Current state | Gap |
|---|---|---|---|
| 1 | Unified COA hierarchy: `Total Liabilities & Equity → Total Equity → Net Income → Pretax Income → Operating Income → Gross Margin → Revenue → Sales → Account` | Split two-root hierarchy (`Income Statement` / `Balance Sheet`), see §1.3 | **Real, well-defined gap.** Notably, migration `051`'s *original* seed already used the client's exact unified shape (`Total Liabilities and Equity → Total Equity → Net Income → Pretax Income → …`) — migration `053` deliberately replaced it with the current split model. This refactor is close to a **revert-and-extend** of that one seed + its matching code in `coaHierarchyRules.js`, not new design work. |
| 2 | `date_dimension` table: `id, date, year, month, quarter, month_name` only (no fiscal_* columns) | No such table exists anywhere in Key Reports. GL stores `transaction_date` (date) + `fiscal_year`/`fiscal_month` (plain int columns) directly on the fact row. | **Real gap**, purely additive. Note the client's "don't add fiscal_year to date_dimension" instruction is already naturally satisfied — `fiscal_year`/`fiscal_month` are *GL columns*, not proposed dimension columns, so no conflict. |
| 3 | GL extended with `account_system_id`, `vendor`, `customer`, `entity_type`, `date_id` | `coa_id` (FK to `chart_of_accounts`) already exists and serves the `account_system_id` linkage role (join to `chart_of_accounts.system_id`). `vendor`/`customer`/`entity_type`/`date_id` do **not** exist. | **Partial gap.** `account_system_id`: satisfied via existing `coa_id` FK (recommend keeping `coa_id`, not adding a redundant column — see §7). `vendor`/`customer`/`entity_type`/`date_id`: real, additive gaps. |
| 3a | — (not asked, but discovered) | **Code-verified defect**: `generalLedgerExtractionService.js:303` already detects a vendor/customer/payee/entity column (`NAME_ALIASES`) during extraction into a field called `transaction_name` — but the final row shape persisted to the DB (`transformRows`, lines ~390-411) **drops it**, because migration 060 removed the `transaction_name`/`vendor_name` columns from `general_ledger_entries`. | The extraction pipeline is *already half-built* for this — adding the column(s) back (as `vendor`/`customer`) closes a real, already-wired gap rather than starting from zero. |
| 4 | Chart of Accounts: `system_account_id, account_number, account_name, statement_type, Level1–15, hierarchy_path, classification_method, adjusted hierarchy, sort_order` | **All of these columns already exist** (`system_id, account_number, account_name, statement_type, level_1..15, hierarchy_path, classification_method, adjusted_name/adjusted_hierarchy, sort_order`). | **No gap.** Only the *shape of the hierarchy itself* (item #1) needs to change; the column model does not. |
| 5 | Trial Balance generated from `GL → COA → Aggregation → Trial Balance` | Migration 057 already generates `trial_balance_entries` from GL only, keyed by version+fiscal_year+account. `account_type` is sourced "from the COA dimension" per the migration comment — verify it truly joins `chart_of_accounts` rather than re-deriving via keyword (tracked as a §7 verification item, not a structural gap). | **Mostly satisfied.** Minor verification/hardening only. |
| 6 | Balance Sheet table: if duplicating Trial Balance, mark deprecated / convert to snapshot | `balance_sheet_entries` already carries both extracted (`is_generated=false`, real uploaded ground truth used for reconciliation) and generated (`is_generated=true`, GL carry-forward, refreshed every sync) rows in one table. | **Functionally already a snapshot table.** No structural change required; extracted rows must stay (they're the reconciliation baseline in `bs_reconciliation_entries`) — do **not** delete or collapse this table. |
| 7 | GL must store Vendor/Customer/Entity Name/Entity Type flowing to detailed reports | Not stored (see #3/#3a). Report engines have no vendor/customer dimension anywhere. | **Real gap**, additive column + a small read-path addition to expose it in the General Ledger report (`getGeneralLedgerReport`). |
| 8 | Target architecture: `date_dimension + chart_of_accounts + general_ledger_entries → trial_balance → financial_statements → reports_api → frontend_reports` | Already the shape, **except**: (a) two competing report engines instead of one `financial_statements` stage (§1.4), (b) no `date_dimension`, (c) COA hierarchy shape mismatch. | Confirms scope is narrow and well-bounded: 3 concrete items, not a rearchitecture. |

### What already matches (do not touch)
- Fact-table-as-source-of-truth principle (`general_ledger_entries`), version isolation, CASCADE-on-version-delete.
- `chart_of_accounts` column model (15 levels, original/adjusted, audit_log, system_id, normal_balance, statement_type, sort_order).
- Trial Balance generated purely from GL (057).
- Balance Sheet snapshot/extracted hybrid (054).
- Reconciliation as a separate, non-destructive comparison table (058).
- Existing API surface, sync pipeline phases, extraction faithfulness, upload/linking/versioning UX.

### What should be deprecated
- Nothing needs to be *dropped*. The one behavioral deprecation is: `keyReportReportService.js`'s
  inline BS/P&L keyword classifier should stop being the source of truth for `/profit-loss` and
  `/balance-sheet` once Engine B (COA-driven) covers those report types — see §3 Phase 3. The file
  itself is not deleted (it still owns GL/bank/tax/trial-balance/reconciliation/qoe/kpi reads).

---

## 3. Refactoring Roadmap (phased, each independently shippable)

| Phase | Scope | Blast radius | Depends on |
|---|---|---|---|
| **P1 — Date Dimension** | New `date_dimension` table + `general_ledger_entries.date_id` (nullable FK), backfill from existing `transaction_date` values, extraction writes `date_id` going forward. `transaction_date` column is **kept** (backward compatible; existing readers untouched). | Low — additive only | none |
| **P2 — GL Entity Columns** | Add `vendor text`, `customer text`, `entity_type text` to `general_ledger_entries`; wire `generalLedgerExtractionService.transformRows` to stop discarding the already-detected `transaction_name` value — split it into `vendor`/`customer` based on a configurable per-column-alias hint (or store to both if the source doesn't distinguish); surface the field in `getGeneralLedgerReport`. | Low — additive column + one service edit | none |
| **P3 — Unified COA Hierarchy** | Revert `coa_hierarchy_levels`-equivalent taxonomy (now in-code per migration 055) and `coaHierarchyRules.js STANDARD_PREFIX` to the client's unified shape (`Total Liabilities and Equity → Total Equity → Net Income → …`, i.e. migration 051's original seed shape). Regenerate COA for existing versions (idempotent — `generateChartOfAccounts` already upserts by stable key, per `project-key-reports-coa-redesign` memory). | Medium — changes `level_*`/`hierarchy_path` values for every existing COA row; does **not** change `account_type`/amounts, so downstream Trial Balance / BS / P&L math is unaffected (they key off `account_type`, not the hierarchy label path) | none, but should ship after regression-testing P1/P2 since it touches the same service file area |
| **P4 — Collapse the two report engines** | Point `keyReportReportService.getProfitLossReport`/`getBalanceSheetReport` at the same COA-driven building blocks `financialStatementService.js` already has (or vice versa — pick one canonical path), so `/profit-loss` and `/balance-sheet` agree with `/financial-statements` by construction. **Highest blast radius; do last, behind regression tests.** Already flagged as the audit's top recommendation independent of this client ask. | High | P3 (hierarchy must be correct before making it the single source reports read) |

P1/P2/P3 directly satisfy the client's ask. P4 is the one item that goes beyond the literal ask
but is required to make the client's target architecture diagram (`chart_of_accounts →
trial_balance → financial_statements` as *one* path) actually true rather than true-on-paper.
Recommend confirming with the client/user whether P4 is in scope before starting it (see open
question in §9).

---

## 4. Updated ER Diagram

```
 companies
     │
     │ 1:N
     ▼
 key_report_versions ───────────────────────────────────────────────┐
     │ 1:N                                                          │
     ├──► key_report_file_mappings ──► documents                    │
     │                                                              │
     ├──► date_dimension  (NEW)                                     │
     │        id · date · year · month · quarter · month_name       │
     │        (version-agnostic; shared across versions/companies)  │
     │                 ▲                                             │
     │                 │ date_id (nullable FK)                      │
     ├──► general_ledger_entries ─────────────────────┐              │
     │        …existing columns…                      │              │
     │        + date_id      → date_dimension.id       │              │
     │        + vendor       (NEW, nullable)           │              │
     │        + customer     (NEW, nullable)           │              │
     │        + entity_type  (NEW, nullable)           │              │
     │        coa_id ──────────────────────────────────┼──► chart_of_accounts
     │                                                 │        (UNIFIED hierarchy taxonomy;
     ├──► balance_sheet_entries (extracted + generated)│         columns unchanged, only the
     │                                                 │         level_1..15 / hierarchy_path
     ├──► trial_balance_entries  (GL-only, unchanged)  │         SEED VALUES change — P3)
     │            │                                    │
     │            ▼                                    │
     ├──► bs_reconciliation_entries                     │
     │                                                  │
     ├──► tax_return_entries, bank_statement_entries     │
     │                                                  │
     └──► generated_report_snapshots (render cache)      │
                                                          │
                        financial_statements (P4: single reporting service,
                        reads chart_of_accounts + trial_balance_entries +
                        balance_sheet_entries, replaces the two-engine split)
                                │
                                ▼
                         reports_api (routes/keyReports.js — unchanged surface)
                                │
                                ▼
                         frontend_reports (unchanged)
```

---

## 5. SQL Migration Plan

Two new, purely additive migrations (next free numbers after `066`), plus a data-only
re-seed for P3 (no schema change for P3 — it changes seeded/generated *values*, not columns).

### `067_date_dimension.sql`
```sql
CREATE TABLE IF NOT EXISTS date_dimension (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date        date NOT NULL,
  year        integer NOT NULL,
  month       integer NOT NULL,       -- 1-12
  quarter     integer NOT NULL,       -- 1-4
  month_name  text NOT NULL,          -- 'January' … 'December'
  CONSTRAINT uq_date_dimension_date UNIQUE (date)
);

CREATE INDEX IF NOT EXISTS idx_date_dimension_year_month
  ON date_dimension(year, month);

-- Backfill one row per DISTINCT transaction_date already in the GL (generic,
-- no company/version hardcoding; safe to re-run).
INSERT INTO date_dimension (date, year, month, quarter, month_name)
SELECT DISTINCT
  transaction_date,
  EXTRACT(YEAR FROM transaction_date)::int,
  EXTRACT(MONTH FROM transaction_date)::int,
  EXTRACT(QUARTER FROM transaction_date)::int,
  to_char(transaction_date, 'FMMonth')
FROM general_ledger_entries
WHERE transaction_date IS NOT NULL
ON CONFLICT (date) DO NOTHING;

ALTER TABLE general_ledger_entries
  ADD COLUMN IF NOT EXISTS date_id uuid REFERENCES date_dimension(id) ON DELETE SET NULL;

UPDATE general_ledger_entries gl
   SET date_id = dd.id
  FROM date_dimension dd
 WHERE gl.transaction_date = dd.date
   AND gl.date_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_gl_entries_date_id
  ON general_ledger_entries(version_id, date_id);
```

### `068_gl_entity_fields.sql`
```sql
ALTER TABLE general_ledger_entries
  ADD COLUMN IF NOT EXISTS vendor      text,
  ADD COLUMN IF NOT EXISTS customer    text,
  ADD COLUMN IF NOT EXISTS entity_type text;   -- 'vendor' | 'customer' | NULL

CREATE INDEX IF NOT EXISTS idx_gl_entries_vendor
  ON general_ledger_entries(version_id, vendor) WHERE vendor IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gl_entries_customer
  ON general_ledger_entries(version_id, customer) WHERE customer IS NOT NULL;

COMMENT ON COLUMN general_ledger_entries.vendor IS
  'Populated from the source column detected by NAME_ALIASES (vendor/payee) at extraction time.';
COMMENT ON COLUMN general_ledger_entries.customer IS
  'Populated from the source column detected by NAME_ALIASES (customer) at extraction time.';
```

### P3 — no migration; a data re-seed executed by the next `generateChartOfAccounts` run
Because `coa_hierarchy_levels` was already consolidated into in-code constants (migration 055),
"reseeding" the unified taxonomy is a **code change** to `coaHierarchyRules.js` (`STANDARD_PREFIX`)
followed by a COA regeneration (existing `POST /chart-of-accounts/regenerate` — already
upsert-by-stable-key, non-destructive to user adjustments per `audit_log`). No new migration
file needed; this is intentionally called out so it isn't mistaken for a schema change.

Every migration above is hand-applied (no runner in this repo, per established convention) and
must also be mirrored into `backend/sql/schema.sql`, matching every prior migration in this series.

---

## 6. Database Schema Changes (summary)

| Table | Change | Type |
|---|---|---|
| `date_dimension` | **NEW** table | Additive |
| `general_ledger_entries` | `+ date_id` (FK, nullable) | Additive |
| `general_ledger_entries` | `+ vendor, + customer, + entity_type` (nullable) | Additive |
| `chart_of_accounts` | No column changes. `level_1..15` **values** change on next regenerate (unified taxonomy) | Data-only, code-driven |
| Everything else | Untouched | — |

No table is dropped, renamed, or has a column removed. `transaction_date` stays on
`general_ledger_entries` for backward compatibility — `date_id` is additive, not a replacement,
matching the client's own wording ("reference this table using date_id **while preserving
existing functionality**").

---

## 7. Service Layer Changes

- **`generalLedgerExtractionService.js`**
  - `transformRows`: stop discarding the detected name-column value; map it to `vendor`/`customer`
    (heuristic: if the detected header literally matched `vendor`/`payee` → `vendor`; if it
    matched `customer` → `customer`; otherwise leave `entity_type` null and populate whichever of
    the two is more common for the file's statement direction — exact heuristic to be decided at
    implementation time, not now).
  - `insertRows`/row-shape builder: add `date_id` lookup (join against `date_dimension` by date,
    or defer to a post-insert backfill step mirroring `067`'s UPDATE, whichever is cheaper given
    the existing chunked-insert pattern).
- **`chartOfAccountsService.js` / `coaHierarchyRules.js`**: `STANDARD_PREFIX` changes to the
  unified shape; `buildLevelsFromPath` unaffected (structural function, not the taxonomy itself).
- **`keyReportReportService.js` / `financialStatementService.js`**: untouched by P1-P3. P4 (if
  greenlit) consolidates their BS/P&L building blocks — out of scope for this deliverable's
  immediate implementation, tracked as the roadmap's last phase.
- **No changes** to `keyReportSyncService.js` phase ordering, `keyReportAccountingService.js`,
  extraction services for BS/P&L/tax/bank, or any frontend component for P1-P3. The COA tree grid
  (`ChartOfAccountsTreeGrid.jsx`) automatically reflects the new hierarchy shape once regenerated
  since it renders `level_1..15`/`hierarchy_path` generically.

---

## 8. API Impact Analysis

- **No endpoint removed, renamed, or made backward-incompatible.**
- `GET /key-reports/versions/:id/reports/general-ledger`: response rows gain `vendor`, `customer`,
  `entity_type`, `date` (already present via `transaction_date`) — purely additive fields,
  non-breaking for existing consumers that read by key.
- `POST /key-reports/versions/:id/chart-of-accounts/regenerate`: same contract; returned tree
  shape is unchanged (still `level_1..15`), only the label *values* differ after P3.
- No new endpoints are required for P1-P3. If a dedicated "browse GL by vendor/customer" report is
  wanted later, that would be a new additive endpoint — not required by the client's spec as
  written.

---

## 9. Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| P3 changes `level_1..15`/`hierarchy_path` on every existing COA row | Medium | `generateChartOfAccounts` already upserts by stable key (account_number+account_name), preserving `id`/`coa_id` FKs and user `audit_log` history across regeneration (confirmed in code, per `project-key-reports-coa-redesign`). Regenerate, don't hand-migrate. |
| `date_id` backfill runs against a large `general_ledger_entries` table | Low-Medium | Use `fetchAllRows`/paged approach if run via application code; the SQL-only backfill in `067` is a single set-based `UPDATE ... FROM`, cheap even at the ~32k-row scale seen in production per `project-key-reports-gl-pagination-fix`. |
| Vendor/customer heuristic (single detected "name" column could mean either vendor or customer depending on transaction direction) | Medium | Document the heuristic explicitly, expose `entity_type` so downstream reports can filter/ignore ambiguous rows rather than mis-labeling silently. Client's own GL export (image 1) doesn't show an explicit vendor/customer split column, so exact-source verification against `Space Entertainment Center.xlsx`'s raw GL tab is recommended before finalizing the heuristic. |
| P4 (engine collapse) touches every `/profit-loss` and `/balance-sheet` consumer | High | Deliberately sequenced last, behind its own regression pass (byte-identical output check against pre-refactor numbers for at least one real version), and flagged in this doc as a decision point rather than assumed in-scope. |
| Pre-existing, independent defects (not part of this ask): orphaned rows on unmapped documents (partially fixed 2026-07-07), 3-way Net Income divergence, BS drift from the once-only opening-BS seed | Not this refactor's job to fix, but P4 overlaps the same files (`keyReportReportService.js`) — recommend fixing the Net Income divergence *as part of* P4 rather than as a fourth, separate touch of the same code. | Sequence P4 to close both the client's engine-consolidation ask and the audit's still-open P1 item in one regression-tested pass. |

**Open question for the user before implementation starts:** is Phase P4 (collapsing the two
report engines) in scope for this engagement, or should this refactor stop at P1-P3 (date
dimension + entity columns + unified hierarchy) and leave the two-engine consolidation as a
separately-scoped follow-up? The client's target-architecture diagram implies one path, but the
literal spec's numbered sections (1-8) never mention the engines by name.

---

## 10. Step-by-Step Implementation Plan (once this analysis is approved)

1. **P1** — write + hand-apply `067_date_dimension.sql`; mirror into `schema.sql`; wire
   `date_id` population into `generalLedgerExtractionService.transformRows` for new syncs.
2. **P2** — write + hand-apply `068_gl_entity_fields.sql`; mirror into `schema.sql`; wire
   `vendor`/`customer`/`entity_type` into `transformRows`; add the three fields to
   `getGeneralLedgerReport`'s selected columns and response shape.
3. **Regression pass for P1+P2**: `node --check` all touched files; re-run a sync against a real
   version (no live DB available in this environment — flag for hand-verification); confirm
   existing GL report output is unchanged except for the three new (mostly-null-until-resync)
   fields.
4. **P3** — change `coaHierarchyRules.js STANDARD_PREFIX` to the unified taxonomy; regenerate COA
   for one test version; diff old vs. new `hierarchy_path`/`level_*` to confirm only labels moved,
   `account_type`/amounts unchanged; confirm `ChartOfAccountsTreeGrid.jsx` renders the new shape
   without a frontend change.
5. **Decision checkpoint** — confirm with the user whether P4 is in scope (see §9).
6. **P4 (if approved)** — consolidate `/profit-loss` and `/balance-sheet` onto the COA-driven
   engine; full BS/P&L/Cash-Flow regression against at least one real company's numbers,
   before/after diff required to be zero for any linked (extracted) year.
7. Update this document's status header to "Implemented" with a short changelog, mirroring the
   convention in `KEY_REPORTS_ARCHITECTURE_ANALYSIS.md`/`KEY_REPORTS_COA_AND_REPORTS_ANALYSIS.md`.

No step in 1-4 requires touching document linking, upload, extraction faithfulness for
BS/P&L/tax/bank, versioning, or any existing API contract — matching the client's "zero
regressions" requirement.

---

## 11. Phase P5 — Date Architecture Completion: drop fiscal_year/fiscal_month (2026-07-10)

> **Status: IMPLEMENTED (code) — migration 069 ready to hand-apply.**

A follow-up client brief asked to complete the date-dimension refactor by physically removing
`fiscal_year`/`fiscal_month` from `general_ledger_entries` (P1 had added `date_id` alongside them,
deliberately keeping both per the original brief's "do not remove existing columns" instruction —
this phase reverses that for GL specifically, per the newer, more explicit client direction).

### 11.1 Dependency analysis

Repo-wide search found **zero** references to `vw_gl_with_date` or `key_reports_date_dimension`
(plural) anywhere in tracked files — confirmed with the user these referred to what this repo
already calls `key_report_date_dimension` (singular), not separate mystery objects.

Of ~129 raw `fiscal_year`/`fiscal_month` hits across 11 files, most were on **sibling tables**
(`profit_loss_entries`, `balance_sheet_entries`, `trial_balance_entries`,
`bs_reconciliation_entries`) with their own independent `fiscal_year` columns — untouched. The
real `general_ledger_entries`-scoped work was **7 files**:
`generalLedgerExtractionService.js`, `keyReportReportService.js`, `financialStatementService.js`,
`keyReportAccountingService.js`, `chartOfAccountsService.js`, `keyReportService.js`,
`keyReportSyncService.js`. Two files were dead code (zero requirers anywhere) and were deleted
rather than refactored: `keyReportSyncService.refactored.js`, `profitAndLossService.refactored.js`.

### 11.2 Filter design decision

Confirmed with the user: **filter by `transaction_date` range** (robust — never depends on a
join succeeding), **join to `key_report_date_dimension` only for display** (year/month/quarter/
month_name in report output). Rejected the alternative (strict inner-join filtering on every
query) because it would silently drop any row whose `date_id` failed to resolve — reintroducing
the exact bug class migration 063 fixed for `fiscal_year`.

### 11.3 Concrete correctness risk found and fixed

Two classes of GL rows have historically had `fiscal_year` populated but `transaction_date` NULL
— confirmed by existing code (not hypothetical):
1. `BEGINNING_BALANCE`/`TOTAL_ROW` rows — bookkeeping rows with no real calendar date, previously
   tagged via a `fiscal_year` inherited from the surrounding transactions.
2. Manual journal entries / year-end adjustments — documented directly in
   `financialStatementService.loadGlAmountsYearly`'s original docstring as a previously-fixed
   understated-P&L bug.

Fix, in two parts:
- **Going forward**: `generalLedgerExtractionService.js` now stamps `BEGINNING_BALANCE` with a
  `<year>-01-01` sentinel date and `TOTAL_ROW` with `<year>-12-31` (year resolved via a new
  `findNextTransactionYear` lookahead, preferring the upcoming transaction's year for opening
  balances and the last-seen year for totals — more accurate than the old fiscal_year-carryover,
  which had no lookahead at all). `validateRows()` already rejects any dateless TRANSACTION row.
- **Historical rows**: migration 069's Step 1 backfills `transaction_date = make_date(fiscal_year, 6, 30)`
  for any existing row with `fiscal_year` set but `transaction_date` NULL, before the column is
  dropped — turning a silent-data-loss risk into a one-time, auditable backfill.

### 11.4 Files changed (code, already applied in this session)

- `generalLedgerExtractionService.js` — stopped persisting `fiscal_year`/`fiscal_month`;
  renamed internal bookkeeping var `currentFiscalYear`→`currentYear`; added
  `findNextTransactionYear` lookahead; BEGINNING_BALANCE/TOTAL_ROW now get sentinel dates.
- `keyReportReportService.js` — `resolveYears` simplified (dropped the null-fiscal_year OR
  fallback, now redundant); `fetchAllGLRows` simplified to a plain `transaction_date` range;
  `aggregateGLByAccount`/`aggregateGLForBSByMonth`/`aggregateGLForBS`/`aggregateGLByAccountMonth`
  select lists and diagnostic objects updated; `getGeneralLedgerReport` filters by date range and
  joins `key_report_date_dimension` for display fields.
- `financialStatementService.js` — `distinctYears` GL branch simplified to transaction_date only;
  `loadGlAmountsYearly`/`loadGlAmountsByMonth` switched to date-range filters (safe now that the
  backfill guarantees every row has a date).
- `keyReportAccountingService.js` — deleted `glYearRange` entirely (redundant with `glDateRange`
  once fiscal_year is gone); `fetchGlRowsForYear` simplified to a date-range filter; removed the
  now-obsolete fiscal_year/transaction_date bounds-reconciliation logic and its warning log.
- `chartOfAccountsService.js` — `collectGlAccountsFromEntries` selects `transaction_date` instead
  of `fiscal_year`; new `glRowYear()` helper derives the year for COA leaf `metadata.fiscal_years`.
  (Legacy `collectGlAccounts`/batch-scoped path left untouched — already dead/unreachable in the
  live sync flow, which always calls with `batchId=null`; pre-existing brokenness unrelated to
  this change.)
- `keyReportService.js` — `ENTRY_TABLE_CONFIG.general_ledger` now keys on `transaction_date` with
  `yearIsDate: true` (the config already had this exact mechanism for `bank_statement`).
- `keyReportSyncService.js` — `buildValidationResultsFromEntryTables`'s GL entry now uses
  `yearCol: 'transaction_date', isDateCol: true` (same existing generic mechanism).
- **Deleted**: `keyReportSyncService.refactored.js`, `profitAndLossService.refactored.js` (dead
  code, zero requirers repo-wide, verified before deletion).
- `backend/sql/migrations/069_drop_gl_fiscal_columns.sql` (new) + `schema.sql` comment updated.

### 11.5 Impact analysis / risk assessment

| Risk | Mitigation |
|---|---|
| Historical dateless-but-fiscal_year-tagged rows silently vanish from reports | Migration 069 Step 1 backfills a sentinel date before the column drop (§11.3) |
| Indexes reference dropped columns | Migration 069 drops `idx_general_ledger_entries_version_year`, `idx_general_ledger_entries_fiscal_year`, `idx_gl_entries_fiscal_month` before dropping the columns; the existing `transaction_date`/`date_id` indexes (049, 067) already cover the replacement query patterns — no new index needed |
| `glYearRange`'s deletion leaves a dangling export | Verified and removed from `keyReportAccountingService.js`'s `module.exports`; confirmed zero other callers repo-wide |
| Deleting the two `.refactored.js` files breaks something | Verified zero requirers via repo-wide grep before deletion; confirmed by a full `app.js` require-load with no errors |
| Regression across 7 heavily-edited files with no live DB in this session | `node --check` + `require()`-load on every touched file, plus a full `app.js` load — all pass. **Not run against live Supabase** (no credentials this session, consistent with every prior Key Reports change in this repo) |

### 11.6 Step-by-step (remaining, for the user)

1. Hand-apply `069_drop_gl_fiscal_columns.sql` in the Supabase SQL editor (after 067/068 if not
   already applied).
2. Re-run sync for at least one real version; confirm `[FinStmt][Years]`/`[KeyReports][GL]` log
   lines show the same year set as before the migration.
3. Spot-check Trial Balance opening balances (BEGINNING_BALANCE rows) and General Ledger /
   Financial Statements reports for a version with a known multi-year GL — confirm no year or
   opening-balance regression.
4. If anything looks off, the backfill in migration 069 Step 1 is additive/non-destructive
   (only fills NULLs) and can be re-run safely; the column drop itself is the only irreversible
   step — take a table snapshot/export first if you want a rollback path.

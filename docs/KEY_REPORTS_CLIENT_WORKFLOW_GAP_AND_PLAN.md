# Key Reports — Client Accounting Workflow: Gap Analysis & Implementation Plan

> Scope: modify the existing Key Reports workflow to match the client's required
> accounting workflow (Data Table WF + chart_of_accounts_SEC + 6/15 & 6/25 emails).
> Build on existing implementation. Do NOT redesign. Keep extraction unchanged.
> Date: 2026-06-30.

---

## 1. Required workflow (client) vs. current implementation

```
USER CREATES VERSION → UPLOAD → AI EXTRACTION → STORE RAW DATA
  (GL, BS, Tax, Bank entries — NO P&L table)
        ↓
[1] VALIDATE AVAILABLE DOCUMENTS  (GL required; Opening BS required for roll-forward; Ending BS optional)
        ↓
[2] GENERATE CHART OF ACCOUNTS    (from GL + BS; base account only in account_name; parents in levels)
        ↓
[3] GENERATE TRIAL BALANCE        (from GL: debits, credits, net, closing — never from uploaded reports)
        ↓
[4] MONTHLY BALANCE SHEET ENGINE  (Opening BS + monthly GL activity → STORED monthly BS, authoritative)
        ↓
[5] RECONCILE                     (generated ending BS vs uploaded ending BS — if uploaded; never overwrite)
        ↓
[6] PROFIT & LOSS FROM GL         (revenue − expense, by month; NO profit_loss_entries table)
        ↓
[7] CASH FLOW                     (from GL + monthly BS)
        ↓
[8] QoE                           (GL + monthly BS + tax + bank)
        ↓
[9] KPIs                          (monthly BS + P&L + trial balance)
```

---

## 2. Gap analysis (per phase)

| Phase | Required | Current state | Gap | Risk |
|---|---|---|---|---|
| **1. Validate** | Hard gate: stop if no GL; warn if no Opening BS; Ending BS optional | `buildValidationResultsFromEntryTables` emits per-table/per-year success/warning rows, but **never halts** the workflow and has no "GL required / Opening BS required" semantics | Add a **validation gate** that classifies docs (GL / Opening BS / Ending BS / Tax / Bank) and blocks Phases 3-9 when GL absent | Low |
| **2. COA** | Base account only in `account_name`; parents only in level columns; match client sheet | `chartOfAccountsService` already builds 15-level COA, `base_account` = leaf, parents live in `level_*`. BUT depends on 4 tables slated for removal (`coa_account_mappings/adjustments/classification_history/hierarchy_levels`) | **Consolidate** the 4 side tables into `chart_of_accounts`; verify `account_name`/`base_account` never carry a parent label (client's 6/25 complaint) | Medium |
| **3. Trial Balance** | From GL: total debits, credits, net, closing per account | **Does not exist** anywhere | Build new trial-balance generator (GL only) + endpoint | Low (additive) |
| **4. Monthly BS** | Opening + monthly GL → **stored** monthly balances; authoritative; never copy uploaded | Roll-forward logic exists (`generateMonthlyBsFromGL`) but is **computed on-the-fly, never persisted monthly**; only a single year-end (Dec-31) generated row is persisted | Persist **one BS snapshot per month-end** (`is_generated=true`, `as_of_date = month-end`); seed opening from uploaded Opening BS; chain month→month | **High** (core) |
| **5. Reconcile** | Generated ending BS vs uploaded ending BS: missing accounts, balance diffs, variance, review list; don't overwrite | **No reconciliation.** Only `validateBalanceSheet` logs A=L+E imbalance | Build reconciliation engine + storage/endpoint; uploaded ending BS used **only** here | Medium |
| **6. P&L** | Always from GL (revenue − expense by month); no P&L table; uploaded P&L = temporary display fallback only, never persisted | P&L **reads `profit_loss_entries` first** (extracted wins), GL only as fallback; `persistGeneratedPl` writes generated P&L back to the table; `financialStatementService.generateYearlyPl` + COA both read `profit_loss_entries` | Invert: **GL is the only P&L source**; drop `profit_loss_entries`; remove all reads/writes; uploaded P&L extracted to memory for display fallback only | **High** |
| **7. Cash Flow** | From GL + monthly BS | Indirect method from P&L + BS **trees** (`buildCashFlow`) | Re-source inputs to GL-generated P&L + stored monthly BS (mostly satisfied once 4 & 6 land) | Medium |
| **8. QoE** | From GL + monthly BS + tax + bank | **Does not exist** | Build new (definition needed — see decisions) | Low (additive) |
| **9. KPIs** | From monthly BS + P&L + trial balance | **Does not exist** | Build new (definition needed — see decisions) | Low (additive) |

---

## 3. Database changes

### Keep (unchanged schema)
`general_ledger_entries`, `balance_sheet_entries`, `tax_return_entries`,
`bank_statement_entries`, `chart_of_accounts`.

### Remove
| Table | Why removable | Migration of useful data |
|---|---|---|
| `profit_loss_entries` | Client: no P&L table; GL drives P&L | None — P&L generated live from GL |
| `coa_account_mappings` | Report mapping can resolve via COA name/number match directly | Fold mapping into COA read path (name-normalized join in code) |
| `coa_account_adjustments` | Audit only; no production logic | Fold into `chart_of_accounts.audit_log` (jsonb) |
| `coa_classification_history` | Audit only | Fold into `chart_of_accounts.audit_log` (jsonb) |
| `coa_hierarchy_levels` | Reference seed; taxonomy already lives in `coaHierarchyRules.js` | Hardcode taxonomy (already source of truth); expose via a small static endpoint |

### Add (proposed — confirm storage vs on-the-fly in §5)
- `balance_sheet_entries`: now stores **monthly** generated rows (already has `is_generated`, `as_of_date`).
- Trial Balance, Reconciliation, QoE, KPIs: store as new version-scoped tables **or** compute on demand (decision pending).

---

## 4. Blast radius (must change when removing tables)

**`profit_loss_entries` (largest):**
- `profitLossExtractionService.js` (writes) → change to non-persistent / display-only
- `keyReportReportService.js:922+` `getProfitLossReport` → GL-only
- `financialStatementService.js` `generateYearlyPl` / `persistGeneratedPl` → remove P&L-table paths
- `chartOfAccountsService.js:166` `collectPlAccountsFromEntries` → drop (COA from GL+BS only)
- `keyReportSyncService.js` step 3 + generated-row cleanup → drop P&L extraction-to-table
- frontend `profitAndLossService.js`, `cashflowService.js` → unaffected if endpoints keep shape

**`coa_account_mappings`:** `chartOfAccountsService.js` (write), `financialStatementService.js` (read for report mapping) → replace with in-COA name match.

**`coa_account_adjustments` / `coa_classification_history`:** only `chartOfAccountsService.js` (`recordAdjustment`, `recordHistory`, `getHistory`) → repoint to jsonb audit column.

**`coa_hierarchy_levels`:** `chartOfAccountsService.getHierarchyLevels`, route `GET /key-reports/hierarchy-levels`, `api.js`, `ChartOfAccountsTreeGrid.jsx` → serve from hardcoded taxonomy.

API endpoints keep their paths/shapes wherever possible (backward compatible).

---

## 5. Decisions required before refactor (genuine ambiguities)

1. **P&L extraction conflict.** "Extraction unchanged" vs "remove `profit_loss_entries`." Proposed
   resolution: GL/BS/Tax/Bank extraction stays byte-for-byte; **P&L extraction is the documented
   exception** — it no longer persists to a table; when no GL exists it is extracted on demand into
   memory purely for display fallback. Confirm.

2. **Storage vs on-the-fly** for Trial Balance, Reconciliation, QoE, KPIs. Monthly BS **must** be
   stored (client explicit). For the other four: store (queryable, faster, auditable) or compute
   on demand (less schema churn)?

3. **QoE & KPI definitions.** Both are net-new and underspecified. Which specific QoE adjustments
   (add-backs, normalizations) and which KPI metrics does the client want? Without this they can
   only be built as a generic scaffold.

4. **Sequencing.** This is multi-week. Proposed milestone order below; confirm where to start.

---

## 6. Proposed implementation plan (incremental milestones)

- **M1 — Validation gate (Phase 1).** Classify docs; block Phases 3-9 if no GL; warn if no Opening BS; mark Ending BS recon-only. Surfaces in existing validation dashboard. *Low risk, no schema.*
- **M2 — COA consolidation (Phase 2 + DB).** Add `chart_of_accounts.audit_log` jsonb; migrate `recordAdjustment`/`recordHistory`/`getHistory` onto it; replace `coa_account_mappings` reads with in-COA name match; hardcode hierarchy levels. Drop the 4 COA side tables. Verify base-account/account_name purity.
- **M3 — P&L from GL only (Phase 6 + DB).** Invert P&L source to GL; remove all `profit_loss_entries` reads/writes; make P&L extraction display-only; drop `profit_loss_entries`.
- **M4 — Monthly BS engine (Phase 4).** Persist month-end BS snapshots from Opening BS + monthly GL; chain months; authoritative generated records.
- **M5 — Trial Balance (Phase 3).** GL-only generator + endpoint.
- **M6 — Reconciliation (Phase 5).** Generated vs uploaded ending BS; variance/missing/review.
- **M7 — Cash Flow re-source (Phase 7).** Feed GL-P&L + stored monthly BS into existing engine.
- **M8 — QoE (Phase 8).** Pending definition.
- **M9 — KPIs (Phase 9).** Pending definition.

Destructive table DROPs (M2/M3) run **after** all dependent code is repointed, in the same migration,
hand-applied via Supabase (no migration runner in this repo).

---

## 6a. Implementation progress (live)

- **M1 — DONE & verified.** `keyReportAccountingService.js` (NEW) `classifyWorkflowDocuments`:
  GL required (halts sync + emits an error validation row when absent), Opening BS → warning,
  Ending BS → recon-only. Wired into `keyReportSyncService.generateFinancialTables` as a Phase-1
  gate (early-return halt when `!canGenerate`; gate rows flow to the existing validation dashboard).
- **M2 — DONE & verified.** Migration `055_coa_consolidation.sql` (adds `chart_of_accounts.audit_log`
  jsonb; DROPs `coa_account_mappings`, `coa_account_adjustments`, `coa_classification_history`,
  `coa_hierarchy_levels`). `chartOfAccountsService.js`: adjustments + classification history folded
  into inline `audit_log`; hierarchy levels now a static `HIERARCHY_LEVELS` const; mapping/history
  table writes removed. `financialStatementService.js`: `coa_account_mappings` reads → in-memory
  `buildMappings(leaves)`. `schema.sql` mirrored.
- **M3 — DONE & verified.** Migration `056_drop_profit_loss_entries.sql`. P&L generated entirely
  from GL in BOTH engines (`keyReportReportService.getProfitLossReport`,
  `financialStatementService.generateYearlyPl`); `persistGeneratedPl` removed; P&L extraction step
  removed from sync (display-only on-demand fallback noted, not yet implemented); COA built from
  GL+BS only; cash-flow P&L re-sourced to GL (partial M7); all live `profit_loss_entries` readers
  repointed; `getExtractedData` P&L config removed. Dead `.refactored.js` orphans still reference the
  table but are not imported anywhere.
- All M1–M3 changes verified by `node --check` + `require()`-load. NOT runtime-tested (migrations
  055/056 must be hand-applied in Supabase first).

- **M4 — DONE & verified.** Monthly BS engine. `keyReportAccountingService.generateMonthlyBalanceSheets`
  rolls Opening BS + monthly GL activity into one stored month-end snapshot per month
  (`is_generated=true`); wired as sync Phase 4. BS read precedence inverted: new
  `latestGeneratedBsForYear` makes the generated monthly snapshot authoritative in BOTH engines
  (`bsBalancesForYear`/`getBalanceSheetReport` and `generateYearlyBs`/`generateMonthlyBs`); uploaded
  balance sheets are now opening-seed + recon-only. Removed the lazy on-read `persistGeneratedBs`/`Pl`.
  No new migration (reuses `is_generated` from 054).
- **M5 — DONE & verified.** Trial Balance. Migration `057_trial_balance_entries.sql`;
  `generateTrialBalance` (GL only: debits/credits/net/opening/closing); sync Phase 3; read endpoint
  `GET /reports/trial-balance`.
- **M6 — DONE & verified.** Reconciliation. Migration `058_bs_reconciliation_entries.sql`;
  `generateReconciliation` (generated vs uploaded ending BS — missing/difference/variance, never
  overwrites); sync Phase 5 (only when an ending BS exists); read endpoint `GET /reports/reconciliation`.
- **M7 — DONE & verified.** Cash Flow re-sourced: `getCashflowReport` builds from GL-derived P&L +
  the authoritative (generated) Balance Sheets.
- **M8 (QoE) / M9 (KPIs) — DEFERRED** until the client defines the specific add-backs / metrics.

**Migrations to hand-apply, in order:** `055` → `056` → `057` → `058` (Supabase SQL editor).
**Verification:** `node --check` + `require()`-load on all changed backend files, and `vite build`,
all pass. Not runtime-tested end-to-end (Supabase creds absent locally; migrations hand-applied —
the established pattern for this module).

---

## 7. Success criteria (from client)
- [x maps to] Extraction continues to work (GL/BS/Tax/Bank untouched).
- GL is the accounting source of truth.
- COA generated from accounting data; base account only in account_name.
- Trial Balance from GL.
- Monthly BS = Opening + GL activity, **stored**, authoritative.
- Ending BS used only for reconciliation.
- P&L generated entirely from GL; **no permanent P&L table**.
- Cash Flow from GL + BS.
- QoE & KPIs from generated data.
</content>
</invoke>

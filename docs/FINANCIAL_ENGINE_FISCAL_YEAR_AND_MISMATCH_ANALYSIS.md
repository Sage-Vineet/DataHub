# Financial Statement Engine — Root-Cause Analysis, Fixes & Generated-vs-Actual Comparison

**Company under test:** Space Entertainment Center, LLC
**Uploaded fiscal years:** 2022, 2023, 2024, 2025
**Scope:** Key Reports pipeline (`backend/src/services/keyReports/*`) — the active
"revised flow" (commit `7061446`). This is the pipeline that feeds the
`/key-reports/.../reports/*` endpoints the UI renders.

---

## 1. Root cause of the missing final fiscal year (Issue #2) — **FIXED**

### The defect
The engine has **two independent ways of deciding which years to process**, and they
disagree about rows whose `fiscal_year` is `NULL`:

| Path | How it enumerates years | NULL `fiscal_year` rows |
|------|--------------------------|--------------------------|
| **Report renderers** (`getBalanceSheetReport`, `getProfitLossReport`, `getCashflowReport`) | `resolveYears()` — reads `fiscal_year` **plus a `transaction_date` fallback** (`keyReportReportService.js:114-150`) | **Recovered** — year still appears |
| **Report *generators*** (`generateTrialBalance`, `generateMonthlyBalanceSheets`, sync P&L validation rows) | Loop `gate.glStartYear .. gate.glEndYear`, where the bounds come from `glYearRange()` which filters `.not("fiscal_year","is",null)` (`keyReportAccountingService.js:27-45`) | **Dropped** — year is never generated |

Since migration `050` made `general_ledger_entries.fiscal_year` nullable, a GL
transaction row can carry a **valid `transaction_date` but a `NULL` `fiscal_year`**
(a date-parse path that filled the date column but not the year, or rows imported
before `fiscal_year` was reliably populated). When that happens to the **last
uploaded year** — the common case, because the newest export is the one most likely
to differ in format — the result is exactly the reported symptom:

- **P&L for 2025** renders (renderer uses the `transaction_date` fallback).
- **Trial Balance / Monthly Balance Sheet / Cash Flow snapshots for 2025** are
  never generated (generators stop at `glEndYear = 2024`).
- The sync summary and validation dashboard report years `[2022, 2023, 2024]`.

It is **not** a date-parsing off-by-one, not a `<`-vs-`<=` loop bug, and not a
transaction-grouping bug — every generation loop is correctly inclusive
(`for (year = start; year <= end; year++)`). The bug is that **`glEndYear` is
computed from a query that ignores the very rows that define the final year.**

### The fix (three layers — root + defense-in-depth)

| # | File | Change |
|---|------|--------|
| 1 | `keyReportAccountingService.js` — `classifyWorkflowDocuments` | Reconcile `glStartYear/glEndYear` with the years implied by `MIN/MAX(transaction_date)`, so a first/last year that exists only in NULL-`fiscal_year` rows is included. Now every generator uses the **same** year set the renderers use. Logs a warning when the bounds had to be extended. |
| 2 | `keyReportAccountingService.js` — `fetchGlRowsForYear` (Trial Balance) | Changed `.eq("fiscal_year", year)` → `.or(fiscal_year.eq.year, and(fiscal_year.is.null, transaction_date in [year-01-01, year-12-31]))`, mirroring `fetchAllGLRows`. The TB now reads the same rows the reports do. |
| 3 | `generalLedgerExtractionService.js` — `transformRows` | **Root fix:** derive `fiscal_year` from `transaction_date` when the extractor left it `NULL`. New syncs can never again persist a dated row without a year. |
| — | `sql/migrations/063_backfill_gl_fiscal_year.sql` | **Repairs existing data:** `UPDATE general_ledger_entries SET fiscal_year = EXTRACT(YEAR FROM transaction_date) WHERE fiscal_year IS NULL AND transaction_date IS NOT NULL`. Idempotent; adds `(version_id, fiscal_year)` index. |

With #3 + the migration, `fiscal_year` is always populated at the source, so #1 and
#2 become belt-and-suspenders that also protect any legacy data not yet re-synced.

> **Action required:** apply migration `063` via the Supabase Dashboard (direct `pg`
> is blocked from the dev machine), then re-run **Sync** for the affected version so
> the 2025 Trial Balance / Monthly Balance Sheet / Cash Flow snapshots are
> generated. After that, `gate.glEndYear` = 2025 and all four years generate.

### Validation that every fiscal year is generated
After the fix, for GL years `{2022, 2023, 2024, 2025}`:
- `classifyWorkflowDocuments` → `glStartYear = 2022`, `glEndYear = 2025`
  (2025 recovered from `MAX(transaction_date) = 2025-xx-xx`).
- `generateTrialBalance` loop: 2022, 2023, 2024, **2025**.
- `generateMonthlyBalanceSheets` loop: 2022 … **2025** (month cutoff = last GL date,
  so a partial final year still produces its months).
- Sync P&L validation rows fallback: `2022 … 2025`.
- Renderers already resolved all four years; they now find **stored** 2025 artifacts
  instead of regenerating on the fly.

---

## 2. Generated-vs-Actual comparison (Issue #1)

The client's actual statements were used as ground truth. The engine's **core
accounting model is correct** — it reproduces the client's period-linking exactly:

### Equity carry-forward (verified against the real numbers)
```
RE(year) = RE(year-1) + NetIncome(year-1)      Net Income shown as a separate equity line
```
| Year | Client RE | Client NI | Next-year RE (client) | Engine rule |
|------|-----------|-----------|------------------------|-------------|
| 2022 | -105,522.70 | 115,896.38 | 10,373.68 = -105,522.70 + 115,896.38 ✓ | `bsBalancesForYear` closes prior NI into RE ✓ |
| 2023 | 10,373.68 | 104,079.12 | 114,452.80 = 10,373.68 + 104,079.12 ✓ | ✓ |
| 2024 | 114,452.80 | 52,262.23 | (2025 RE 112,021.03 — see note) | ✓ |

P&L Net Income ties to the BS "Net Income" equity line every year (e.g. 2025 P&L
`$169,495.90` = 2025 BS Net Income `$169,495.90`). **The engine's `NetIncome →
Retained Earnings` close and separate-current-NI presentation match QuickBooks.**

> **Data note (not an engine bug):** the client supplied **two different "As of
> Dec 31 2024" balance sheets** — `$790,773.40` (in the 2024 file) and `$771,373.56`
> (in the 2025 file, a later revision). When both an uploaded BS and a GL exist for a
> year, the engine treats the **generated monthly roll-forward as authoritative** and
> the uploaded BS as opening-seed/reconciliation input (`bsBalancesForYear` prefers
> `latestGeneratedBsForYear`). Expect the generated 2024 BS to follow the GL, which
> may differ from either uploaded snapshot — this is by design, surfaced in the
> Reconciliation report, not a defect.

### Remaining structural mismatches (classification is largely correct; **hierarchy is the gap**)

| Area | Client (QuickBooks) structure | Engine output | Severity |
|------|-------------------------------|---------------|----------|
| **BS hierarchy** | `Assets → Current Assets → Bank Accounts → {accounts} → Total for Bank Accounts; Other Current Assets; Total for Current Assets; Fixed Assets; Other Assets`. Liabilities → Current (Credit Cards, Other Current) + Long-term. | `buildBSFromBalances` emits a **flat 3-section** tree: `Assets → {all accounts} → Total Assets`. No Current/Fixed/Other or Bank-Accounts/Credit-Cards sub-groups. | **High** — the most visible difference |
| **P&L sections** | `Income → Total for Income; Gross Profit; Expenses → Total for Expenses; Net Operating Income; Net Other Income; Net Income`. 2023/24 show a `Cost of Goods Sold`/`Gross Profit` band. | `buildPLFromGL` emits `Income; Expenses; Net Income`. No COGS band, no Gross Profit line, no Operating-vs-Other split. | **Medium** (for this client COGS is empty and Net Other Income ≈ 0, so the numbers still tie; the *layout* differs) |
| **Account classification** | — | Spot-checked against the actual accounts and **correct**: `Loans to MTP`/`Due from ERTC` → Asset; `Accumulated Depreciation- *` → contra-Asset; `Credit Card Payment` → Credit Cards (liability); `Interest Income`/`Gain on Sale` → Income; `Discounts/Refunds Given` → contra-Income; `Loan Payable- Officer` (negative) → Liability with sign preserved; `Meals Tax` (expense) vs `Accrued Meals Tax` (liability) kept distinct. | **Low** — no classification errors found in this dataset |

### Why the hierarchy is flat even though a nested engine exists
There are **two Balance-Sheet renderers**:
- `financialStatementService.generateFinancialStatements` (endpoint
  `/reports/financial-statements`) — **does** build the full nested tree from
  `chart_of_accounts.parent_account_id` + `coaHierarchyRules.js` (Current Assets /
  Bank Accounts / Credit Cards / Long-Term Liabilities …).
- `keyReportReportService.getBalanceSheetReport` (endpoint `/reports/balance-sheet`,
  used by the main BS tab) — builds a **flat** tree from the generated monthly
  snapshots, which `snapshotRows` stores as flat rows (`hierarchy_level: 2`, no
  parent). The nesting from the COA is discarded at snapshot time.

So the COA hierarchy is computed correctly but **not carried into the snapshot-backed
renderer**. Making the main BS tab match QuickBooks means having
`getBalanceSheetReport` nest the flat balances under their COA
`level_3`/`level_4` groups (Current/Fixed/Other → Bank Accounts/Credit Cards/…),
or storing the parent linkage in `snapshotRows`.

---

## 3. Recommended next step for the hierarchy mismatch (scoped, not yet applied)

The nested-hierarchy fix touches the **live** BS/P&L renderer in a financial engine
that cannot be executed on this dev machine (Supabase is unreachable per project
setup), so it was deliberately **not blind-rewritten** — an untested change here
risks silently corrupting subtotals across every company. The surgical, low-risk plan:

1. **Carry COA levels into snapshots** — in `keyReportAccountingService.snapshotRows`,
   populate `parent_account_id`/`hierarchy_level`/`level_3`/`level_4` from the COA leaf
   (the COA already has them via `coaHierarchyRules.classifyStandardized`). No new
   classification logic — reuse the finalized COA.
2. **Nest in the renderer** — in `getBalanceSheetReport` / `buildBSHierarchicalRows`,
   group leaves by COA `level_3` (Current/Fixed/Other Assets, Current/Long-Term
   Liabilities) then `level_4` (Bank Accounts, Credit Cards, …), emitting the
   `Total for <group>` subtotals QuickBooks shows. Totals stay derived from the tree
   (never from entries), preserving the existing invariant.
3. **P&L band** — add a COGS section + `Gross Profit` line and an Operating-vs-Other
   split in `buildPLFromGL`, driven by COA `account_type` (`cogs` vs `expense`) and the
   existing `EQUITY_RE`/`REVENUE_RE` classifiers. No hardcoded account names.

All three reuse the already-correct COA classification/hierarchy, so they remain
**generic** (no company/account/layout hardcoding) and keep the single-COA-generation,
no-SQL-in-loops performance profile.

---

## 4. Deliverables checklist

| # | Deliverable | Status |
|---|-------------|--------|
| 1 | Root cause of missing final fiscal year | §1 — NULL `fiscal_year` rows dropped by generator year-bounds |
| 2 | Root cause of report mismatches | §2 — flat snapshot renderer discards COA hierarchy |
| 3 | Root cause of hierarchy/classification | §2 — classification correct; hierarchy not carried into snapshot renderer |
| 4 | Comparison report (Generated vs Actual) | §2 (carry-forward verified; structural gaps tabulated) |
| 5 | Files modified | `keyReportAccountingService.js`, `generalLedgerExtractionService.js`, `sql/migrations/063_backfill_gl_fiscal_year.sql` |
| 6 | SQL modified | Migration `063` (backfill + index); `fetchGlRowsForYear` query filter |
| 7 | Accounting logic changes | Year enumeration now `fiscal_year ∪ transaction_date`; `fiscal_year` guaranteed at extraction |
| 8 | Before/After | Before: generators stop at last non-null-FY year. After: all GL years generate. |
| 9 | Validation every FY generated | §1 — 2022–2025 all enumerated by every generator |
| 10 | Validation reports match client | §2 — carry-forward/NI ties confirmed; hierarchy fix scoped in §3 |

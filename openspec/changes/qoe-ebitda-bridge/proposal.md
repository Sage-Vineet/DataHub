## Why

The `EBITDA Tab` is marked **In UAT** on the 25 Jul 2026 tracker, but the bridge it renders is not
built the way `QE - 0004` specifies and, on the engagement workbook Josh Tonnesen supplied, it does
not produce a defensible number.

Two findings drove this change, both established arithmetically from the source material rather than
by inspection:

1. **EBITDA was computed in the browser by regex over P&L row labels.**
   `apps/web/src/services/ebitdaService.js` matched a single-word pattern as a whole word, and its
   `TAX_PATTERNS` list contained bare `"tax"` and `"taxes"`. On the walkthrough engagement, FY2024,
   that swept up Meals Tax ($37,820.18), Real estate taxes ($39,428.38) and Taxes & Licenses
   ($6,733.00) as income tax expense — **$83,981.56 of fabricated add-back against a true net income
   of $47,568.23**. `QE - 0004` requires the opposite: EBIT lines sourced from predefined mapped GL
   account groupings and a centralized account-level Depreciation/Amortization flag.

2. **Net income itself was inverted.** QuickBooks exports revenue AND expenses as positive ledger
   amounts, so summing a P&L without consulting each account's type yields revenue *plus* expenses.
   That is exactly what the extracted `profit_loss_entries` table holds: FY2024 reports $4,975,913
   where net income is $47,568.23, and the same inversion holds in all four years.

Reported EBITDA starts at net income, so the bridge could not be made correct without fixing the
first line of it.

**Track:** product capability `qoe`; migration domain `reports`. Per `openspec/product/design.md` §D6
the two registers reconcile per capability.

## What Changes

- **New `packages/financial-engine`** — pure TypeScript, zero I/O. Derives the income statement from
  GL + chart of accounts with the sign convention applied once; builds Reported EBITDA from
  account-level `ebitda_role` flags; applies add-backs; computes Adjusted EBITDA / SDE and margin.
  Golden tests assert every figure against the engagement workbook.
- **New `apps/api/src/modules/qoe`** — ports/adapters module behind `QOE_MODULE_ENABLED`, serving
  `/qoe/*`. Mounts at a prefix legacy does not define, so it adds surface rather than shadowing it.
- **Redesigned add-back record** (`qoe_addbacks`) with the sourcing `kind`, data source, grouping,
  granularity, recast baseline and Q&A citations `QE - 0004` requires, plus a data migration from the
  legacy `ebitda_adjustments` set.
- **`chart_of_accounts.ebitda_role`** — the centralized flag that replaces label matching.
- **`general_ledger_entries.coa_id`** — declared for the first time. It already exists in the deployed
  UAT database but in no migration in this repository; the ledger→COA link is what the bridge joins on.
- **Rewritten EBITDA screen** on `@datahub/ui`, replacing ~3,300 lines of client-side calculation with
  a rendering layer: typed add-back wizard, data-source toggle, discrete period selection,
  collapsible groups, per-line commentary, unflagged-account disclosure.
- **CIM autofill repointed** at the same bridge, so the CIM's Adjusted EBITDA exhibit and the QoE tab
  can no longer disagree.

### Defects found and fixed along the way

These were pre-existing and blocked the stack end to end; each carries a regression test.

- **Gateway CORS omitted `Cache-Control`**, which the SPA sends on every request. Preflight failed
  with `HeaderDisallowedByPreflightResponse`, surfacing as a bare "Failed to fetch" on login — the app
  was dead on any cross-origin deploy.
- **`/key-reports/versions` required `?company_id`**, but the SPA only ever sends `X-Client-Id`, and
  the module returned a bare array where legacy returns `{ success, versions, activeVersionId }` and
  camelCase field names. Every screen behind the version selector broke when
  `REPORTS_MODULE_ENABLED` was turned on.
- **`selectKeyReportContext` returned a fresh object from a `useSyncExternalStore` snapshot**
  (`mappingsByCategory || {}`), so React re-rendered on every store read and the page died with
  "Maximum update depth exceeded".

## Non-goals

- The remaining financial-foundation defects: the balance sheet is out by exactly the unclassified
  Retained Earnings / Net Income account every year (2022: $5,863,315.58, to the cent), and
  `trial_balance_entries.opening_balance` is always 0 so `closing_balance` holds period movement
  rather than a balance. Neither feeds `QE - 0004`; both feed `QE - 0001` and `QE - 0003`.
- `QE - 0001` Tax Reconciliation, `QE - 0002` Return Mapping, `QE - 0003` Proof of Cash,
  `QE - 0006` Working Capital, `QE - 0013` Workbook export, `QE - 0014` PowerPoint.
- `.QBB` ingestion — an OLE2 QuickBooks *Desktop* backup with no reader in any language.
  `data-retrieve-wizard` owns it and is unstarted.

## Legacy / main-branch impact

`backend/` is untouched. The legacy `/ebitda-adjustments` routes remain mounted and reachable as the
rollback target; they are removed in a follow-up once this module has soaked. `main` is frozen; all
work is on `ba/rearch`.

# Key Reports Architecture Refactor

## Current Architecture (Before)

```text
Uploads -> extraction tables -> COA generation -> Trial Balance generation
                                      |                 |
                                      +-> monthly BS <--+

Open P&L  -> read COA + scan GL by year -> build report
Open CF   -> read COA + scan GL + read/build current/prior BS -> build report
Open BS   -> read stored BS, with recursive GL fallback
Open TB   -> read stored Trial Balance
```

The sync order was broadly correct, but annual P&L and Cash Flow were rebuilt on
every read. Account classification also performed database lookups inside GL loops
before the in-memory COA lookup change.

## Optimized Architecture (After)

```text
Version -> uploads -> extraction -> General Ledger (source of truth)
                                  -> generate COA once for sync
                                  -> load COA lookup in memory
                                  -> link GL.coa_id in batches
                                  -> store Trial Balance
Opening BS + monthly GL activity  -> store monthly Balance Sheets
GL + COA                          -> generate P&L snapshot
GL-derived P&L + stored BS        -> generate Cash Flow snapshot

Open COA/BS/TB -> read their stored accounting tables
Open annual P&L/CF -> read generated_report_snapshots
Open explicit monthly/date-range view -> minimal dynamic calculation
```

## Data Sources

| Report | API service | Authoritative source | Read behavior |
|---|---|---|---|
| COA | `chartOfAccountsService` | `chart_of_accounts` | Stored rows |
| Trial Balance | `getTrialBalanceReport` | `trial_balance_entries` | Stored rows |
| Balance Sheet | `getBalanceSheetReport` | `balance_sheet_entries` | Latest generated monthly snapshot |
| Profit & Loss | `getProfitLossReport` | GL + COA | Stored render snapshot for annual views |
| Cash Flow | `getCashflowReport` | GL-derived P&L + generated BS | Stored render snapshot for annual views |

## Database Changes

- Migration `060` makes GL columns canonical, adds `fiscal_month` and `coa_id`,
  and adds version/year/month, COA-link, and account-name indexes.
- Migration `061` adds `generated_report_snapshots`, a generic JSON render cache.
  It is not a P&L accounting table and cannot become an accounting source of truth.
- Migration `062` consolidates duplicate COA leaves, relinks affected GL rows,
  and enforces normalized number-plus-name uniqueness even when account number is blank.
- `profit_loss_entries` remains removed by migration `056`.

## Removed Bottlenecks

- Removed per-transaction COA queries from P&L and Balance Sheet aggregators.
- Loads COA classifications once into a normalized in-memory map.
- Disables and unexports dynamic `ensureAccountExistsInCoa` behavior.
- Persists annual P&L and Cash Flow during sync instead of rebuilding on report open.
- Reuses generated P&L trees in Cash Flow during sync, avoiding a second GL scan.
- Uses chunked bulk inserts for Trial Balance and monthly Balance Sheet rows.
- Links GL rows to COA in batches and indexes the resulting foreign key.

## Before vs After

| Concern | Before | After |
|---|---|---|
| COA during report rendering | Lookup queries inside loops | One in-memory lookup; no writes |
| Annual P&L open | GL scan and aggregation | One snapshot lookup |
| Annual Cash Flow open | GL + current/prior BS calculation | One snapshot lookup |
| P&L storage | No table; rebuilt repeatedly | No P&L table; generic render snapshot |
| Monthly BS | Generated and stored | Generated and stored in bulk |
| Trial Balance | Generated and stored | Generated and stored in bulk |

## Client Compliance Checklist

- [x] General Ledger is the accounting source of truth.
- [x] COA generation occurs in sync before reports and is not invoked by rendering.
- [x] Report generators do not insert or update COA.
- [x] No P&L accounting table is required or used.
- [x] COA leaf account names remain distinct from hierarchy parent names.
- [x] COA supports system ID, 15 hierarchy levels, adjusted hierarchy, and adjusted name.
- [x] Trial Balance is generated from GL and COA and stored in bulk.
- [x] Monthly Balance Sheets are rolled from opening BS plus GL activity and stored.
- [x] Cash Flow uses GL-derived income and generated Balance Sheets.
- [x] Annual report rendering reads stored data.
- [x] COA mapping, adjustment, and classification side tables are not required.

## Estimated Performance Improvement

For an annual report open, database work changes from paginated GL/COA/BS reads plus
JavaScript aggregation to one indexed snapshot lookup. Expected latency reduction is
approximately 80-95% for P&L and Cash Flow after sync, depending on GL size and network
latency. Sync also removes the former O(transaction count) COA-query pattern. These are
engineering estimates; production tracing should record row counts and wall-clock time
before and after migration to establish measured results.

## Verification

- Node syntax checks pass for all changed services.
- All service modules load successfully.
- `validateKeyReportsAccuracy.js` passes every expected Balance Sheet, P&L, and
  Cash Flow structural assertion. Its fixture still reports the pre-existing FY2023
  cash reconciliation diagnostic, while expected section totals all pass.

## PDF Accuracy Benchmark

The supplied source statements were visually verified page by page and establish
these report-level controls:

| Control | 2022 | 2023 |
|---|---:|---:|
| Total Assets | $1,147,368.19 | $850,146.91 |
| Total Liabilities | $1,136,994.51 | $735,694.11 |
| Total Equity | $10,373.68 | $114,452.80 |
| Total Income | $2,609,930.60 | $2,927,853.69 |
| Total Expenses | $2,494,034.22 | $2,823,774.57 |
| Net Income | $115,896.38 | $104,079.12 |

The live GL path previously mixed native COA types (`income`, `cogs`) with report
types (`revenue`, `expense`) and treated debit-minus-credit GL values as though all
Balance Sheet accounts shared the asset sign. The corrected contract is:

```text
asset increase      = +debit-minus-credit
liability increase  = -debit-minus-credit
equity increase     = -debit-minus-credit
revenue contribution to net income = -debit-minus-credit
expense contribution to net income = -debit-minus-credit
```

## Rendering Flow

```text
Reports workspace
  -> getKeyReportVersionReport
  -> /reports/balance-sheet | /reports/profit-loss | /reports/cashflow
  -> stored balance_sheet_entries or generated_report_snapshots
  -> BalanceSheetQBSummary | ProfitAndLossQBSummary | CashflowSummary
```

The Reports workspace no longer switches Key Reports versions into the legacy
`FinancialStatementsView` regeneration path. Snapshot-backed P&L and Cash Flow
payloads are recognized explicitly by their `generated_report_snapshots` source.
Mapping suggestions and unmapped-account panels are no longer rendered or returned.

## Modified APIs And Components

- `GET .../reports/profit-loss`: canonicalizes `income/cogs` and reads annual snapshots.
- `GET .../reports/balance-sheet`: reads stored generated month-end balances.
- `GET .../reports/cashflow`: reads annual snapshots built from corrected P&L and BS.
- `WorkspaceReports.jsx`: renders the dedicated stored-report APIs for Key Reports.
- `ProfitAndLossReport.jsx`: supports snapshot-backed payloads.
- `CashflowReport.jsx` and `cashflowService.js`: preserve report rows and comparative columns.
- `FinancialStatementsView.jsx`: removes mapping and synthetic-account diagnostics.

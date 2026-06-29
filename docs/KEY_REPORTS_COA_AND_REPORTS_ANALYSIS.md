# Key Reports — Chart of Accounts & Report-Accuracy Analysis

> Status: **Analysis only. No code changed.** Deliverable for the "fix COA generation +
> report mismatch" objective. Builds on `docs/KEY_REPORTS_REARCHITECTURE_PLAN.md`.

## 0. Current end-to-end flow (verified against code)

```
WorkspaceKeyReports → link docs per category (profit_loss | balance_sheet |
   general_ledger | bank_statement | tax_return)               [DataRoomFilePicker]
        │  addKeyReportMapping → key_report_file_mappings
        ▼
Sync  POST /key-reports/versions/:id/sync
   keyReportSyncService.generateFinancialTables():
     1 tax_return        → tax_return_entries
     2 bank_statement    → bank_statement_entries
     3 profit_loss       → profit_loss_entries
     4 balance_sheet     → balance_sheet_entries
     5 general_ledger    → general_ledger_entries   (raw-row schema, migration 050)
     6 generateChartOfAccounts(companyId, versionId, null)  → chart_of_accounts
     7 buildValidationResultsFromEntryTables → key_report_validation_results
        ▼
Reports  GET /key-reports/versions/:id/reports/{profit-loss|balance-sheet|cashflow|...}
   keyReportReportService:  per-year → render extracted entries if present,
                            ELSE generate from general_ledger_entries.
```

Document types are never mixed (each has its own entry table). Extraction is faithful
(raw GL rows incl. ACCOUNT_HEADER/BEGINNING_BALANCE/TOTAL_ROW; BS/PL keep `is_total`,
`section`, `hierarchy_level`). Linked BS/P&L for a year are rendered **directly** (spec
#4/#5) — that part already works.

Key files:
- COA engine: `backend/src/services/chartOfAccountsService.js`
- Report engine: `backend/src/services/keyReports/keyReportReportService.js` (1507 lines)
- Sync: `backend/src/services/keyReports/keyReportSyncService.js`
- Validation: `backend/src/services/keyReports/keyReportValidationService.js`
- Extraction: `backend/src/services/keyReports/{balanceSheet,profitLoss,generalLedger}ExtractionService.js`, `backend/python/{extract_excel,extract_pdf_text,common}.py`
- Schema: migrations `047_chart_of_accounts`, `048_key_report_validation_results`, `049_key_reports_entry_tables`, `050_general_ledger_entries_new_columns`

---

## 1. Root-cause report — invalid accounts in COA

### RC1 — COA pulls totals & section headers straight from Balance Sheet entries (no filter)
`collectBsAccountsFromEntries` (`chartOfAccountsService.js:137-146`) selects **every** row of
`balance_sheet_entries` (`account_name, section`) with no predicate. `buildCoaModel`
(`:204-205`) turns each into a leaf. So these all become COA accounts:
- Totals: `Total Assets`, `Total Liabilities`, `Total Equity`, `Total for …` (`is_total = true`).
- Section labels / pure headers: `Assets`, `Liabilities`, `Equity`, `Current Assets`, … (`hierarchy_level = 0`, `is_section_header` at extraction).

`balance_sheet_entries` **does** carry `is_total` and `hierarchy_level`, so the data needed to
exclude them exists — the COA query simply ignores it. **This is the direct cause of
"Total …" entering the system.**

### RC2 — "Accrual Basis …" / report-title leakage path
GL extraction records `ACCOUNT_HEADER` rows (`generalLedgerExtractionService.js:280-289`) and
tracks `currentAccountSection`. COA reads only `row_type='TRANSACTION'` from GL
(`chartOfAccountsService.js:124-134`), which excludes header/total rows — good — **but**
`buildCoaModel` falls back to `r.distribution_account || r.account_section` (`:200`). When a
TRANSACTION row has an empty distribution account, the account *section header* is used; a
mis-detected header (report banner like "Accrual Basis", company name, date range) can then
surface as a COA account. There is no `isNonAccountRow()` guard anywhere in the COA path.

### RC3 — COA ignores Profit & Loss entirely; wrong source priority
Spec priority is **BS (highest) → P&L → GL (fallback only)**. Current COA reads **GL
transactions + BS only**; `profit_loss_entries` is never queried
(`generateChartOfAccounts:235-240`). Income/expense accounts appear in COA only if they
happen to occur as a GL `distribution_account` and survive keyword inference. P&L-only
accounts are missing, and GL is used as a *primary* source, not a fallback.

### RC4 — Classification is raw keyword inference off `distribution_account`
For GL accounts COA calls `inferAccountType(name, number)` (keyword fallback) because
`general_ledger_entries.account_type` is NULL. The spec explicitly says **"Never generate COA
directly from raw distribution_account values without classification."** BS section
(`assets/liabilities/equity`) is authoritative and *is* available, but is only applied to BS
rows, not used to correct GL-derived classifications of the same account.

### RC5 — No COA validation engine
`keyReportValidationService` only emits per-(dataType, year) row-count status for the
dashboard grid. **None** of the spec's COA checks exist:
- NULL `account_type`; header rows in COA; total rows in COA; duplicate mappings;
  every GL account mapped to a COA account; one-and-only-one category.
- No validation reports for unmapped / duplicate / invalid / header / total accounts.

---

## 2. Root-cause report — generated reports don't match actual Balance Sheets

### RC6 — COA is decorative; the report engine does NOT use it
`keyReportReportService.js` has its **own** self-contained classifier
(`classifyGLAccount` + `ASSET_KW/LIABILITY_KW/EQUITY_KW/REVENUE_KW/EXPENSE_KW`,
`:148-172`) and builds BS/P&L from GL **independently** of the `chart_of_accounts` table
(grep confirms no `chart_of_accounts` reference in the report service). So COA and reports use
**two divergent classification code paths** — fixing COA alone will not change a single report
number. This is the central architectural finding.

### RC7 — Generated BS imbalance from heuristic GL classification
`aggregateGLForBS` (`:244-322`) classifies each `distribution_account` by keyword. Accounts
that don't match any keyword become `unknown` and are **excluded** from the BS
(`:291-299`), so `Assets ≠ Liabilities + Equity`. The code already logs this:
`[KEY_REPORTS_VALIDATION] Balance Sheet OUT OF BALANCE` with the unclassified accounts
(`:50-69`). Any misclassification (e.g. an asset matched as expense) silently moves money to
the wrong statement.

### RC8 — Sign logic is consistent but fragile
Debit-positive convention throughout: assets `+= amount`; liability/equity stored `+amount`
then negated in `bsBalancesForYear` (`:472-476`); revenue `netIncome += -amount`. Correct for
clean double-entry data, **but** it assumes (a) the keyword classifier is right and (b) the GL
`amount` sign is right. The split-account double-count guard (`plDistSeen`, `:259-265`,
`:306-310`) is heuristic and assumes QB emits a distribution row for every account's own
ledger; partial exports can mis-post.

### RC9 — Retained-earnings chain is cumulative and brittle
Carry-forward `BS(y) = BS(y-1 closing) + GL(y)` (`bsBalancesForYear:423-482`). Prior-year Net
Income rolls into Retained Earnings; current-year NI is a separate equity line. Correct **only
if** the 2021 starting BS RE is right **and every** intervening year's GL nets to zero. Any
excluded/unknown GL row in 2022 corrupts 2023-2025 cumulatively.

### RC10 — Generated BS equity (GL-derived NI) can disagree with the displayed P&L
For 2022-2025 the P&L is rendered from **extracted** `profit_loss_entries`, while the BS is
**generated from GL** carry-forward. The GL-derived net income that rolls into BS equity is a
*different* number from the extracted P&L net income on screen — they are never reconciled, so
equity can visibly disagree with the P&L the user sees.

### What already matches (do not touch)
- Linked-year BS/P&L render verbatim from entry tables (`hasExtractedRows` → render path).
- `buildBSHierarchicalRows` correctly picks the section **grand** total (not the first
  subtotal) and drops "Total Liabilities and Equity" from inside equity (`:1008-1037`).
- Extraction is faithful; totals/sections are preserved with flags.

---

## 3. Answers to the specific questions asked

| Question | Finding |
|---|---|
| Why do `Accrual Basis…` / `Total for…` enter the system? | Reports already filter them; **COA does not** — RC1 (BS totals/headers unfiltered) and RC2 (account_section fallback). |
| Why don't generated reports match actual BS? | RC6–RC10: BS for non-linked years is *generated* from GL by a heuristic keyword classifier that excludes unknowns (imbalance) and is never reconciled to the extracted P&L. |
| Does COA rely only on `distribution_account`? | For GL accounts, yes (RC4). It also reads BS, but **not** P&L (RC3). |
| Is classification missing/incorrect? | Two separate classifiers (COA's `inferAccountType`, reports' `classifyGLAccount`); both keyword-based, can disagree, and reports ignore COA (RC6). |
| Are retained-earnings calcs incorrect? | Logic is plausible but cumulatively brittle (RC9) and unreconciled with extracted P&L (RC10). |
| Is sign logic wrong? | Self-consistent debit-positive scheme; failure mode is misclassification/unknown exclusion, not the sign rule itself (RC7/RC8). |

---

## 4. COA redesign (First Objective)

Make `chart_of_accounts` a clean, classified, deduped directory built BS → P&L → GL.

1. **Shared invalid-row guard** `isNonAccountRow(name)` (new small util, reused by COA &
   validation): rejects `accrual/cash basis`, `report generated`, `date generated`, section
   labels (`assets/liabilities/equity/income/expenses/current assets/fixed assets/other
   current assets/long-term liabilities`), and any total (reuse `is_total_row` semantics).
2. **BS source (authoritative):** `collectBsAccountsFromEntries` filters
   `is_total = false AND hierarchy_level <> 0` and skips `isNonAccountRow`. Type comes from
   `section` (asset/liability/equity) — never keyword for BS.
3. **P&L source (new):** `collectPlAccountsFromEntries` reads `profit_loss_entries`, same
   filters; classify income vs expense vs COGS from `account_type`/keyword.
4. **GL source (fallback only):** keep `row_type='TRANSACTION'`, but only add an account that
   is **not already present** from BS/P&L; drop the `|| account_section` fallback for the COA
   name; still skip `isNonAccountRow`.
5. **Merge & precedence:** dedupe by normalized name; **BS type wins** over P&L wins over GL
   keyword. Record `classification_source` and (optionally) `source_document_type` /
   `source_file_id` per the spec's column list.
6. **Reports consume COA (the real mismatch fix):** in `keyReportReportService`, replace the
   per-call keyword `classifyGLAccount` with a lookup into the version's `chart_of_accounts`
   (built BS-first), falling back to keyword only for accounts absent from COA. This makes COA
   and reports agree by construction and removes the "unknown → excluded → imbalance" class of
   bugs. *(Higher blast radius — phase 2.)*

## 5. COA validation engine (deliverable #4)

After COA generation, run and persist (as `key_report_validation_results` rows with
`data_type='chart_of_accounts'`, plus detail arrays in `metadata`):
- no NULL `account_type`; no header/total/section rows present; no duplicate (name, number);
- every distinct GL `distribution_account` (TRANSACTION) maps to a COA account → list
  **unmapped**; each account in exactly one category → list **multi-category**.
- Surface counts + sample lists in `KeyReportSyncDashboard` (the grid already renders
  chart_of_accounts status; extend its detail pane).

## 6. Migration plan

- `chart_of_accounts` (047), `validation_results` (048), entry tables (049), GL raw rows (050)
  already exist. **No destructive migration needed.**
- Optional additive `051_chart_of_accounts_metadata.sql`: add `account_subtype text`,
  `source_document_type text`, `source_file_id uuid`, `classification_source text` to match
  the client's requested COA column list. Nullable, idempotent, hand-applied (no runner here).

## 7. Phased, low-risk implementation plan

- **P1 — COA correctness (additive, no report change).** Items §4.1–§4.5 + optional 051.
  Pure rebuild of the COA derivative; cannot affect any report or existing flow. Regenerate
  endpoint + sync both produce a clean COA.
- **P2 — COA validation engine.** §5. Pure addition; new validation rows + dashboard detail.
- **P3 — Reports consume COA.** §4.6. Behavioral; gate behind a flag; full BS/P&L/CF
  regression. This is what actually makes generated BS match.
- **P4 — Reconcile generated BS NI to extracted P&L NI** (RC10) for years with linked P&L.

## 8. Regression test plan

- **No-op safety:** linked-year BS/P&L (2021 BS; 2022-2025 P&L) must render byte-identical
  before/after P1–P2 (they bypass COA).
- **COA:** assert no `is_total`/header/section/`Accrual Basis` rows; every account has a
  non-null type & single category; P&L accounts now present; counts logged.
- **Reports (P3):** for each version+year, `Assets = Liabilities + Equity` within $0.50;
  `[KEY_REPORTS_VALIDATION]` shows `balanced:true`; unknown-account list empty; generated NI ==
  extracted P&L NI for linked-P&L years.
- **Untouched flows:** manual GL upload, manual upload, bank/tax reconciliation, document
  linking/unlink (RESTRICT FK), version activate/duplicate — smoke each.
- Build gates: `node --check` changed JS, `python -m py_compile` changed Python, `vite build`.

## 9. Constraints honored

No change to: document linking, manual upload, manual GL upload, extraction faithfulness,
API contracts, report rendering for linked years, or cross-type/cross-year isolation. COA fix
(P1/P2) is a pure derivative rebuild; report behavior changes only in P3 behind a flag.

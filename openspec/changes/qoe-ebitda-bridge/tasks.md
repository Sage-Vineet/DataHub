## 1. Calculation engine — `packages/financial-engine`

- [x] 1.1 Scaffold the workspace package (ESM, `@datahub/config` bases).
- [x] 1.2 `types.ts` — accounts, ledger rows, add-backs, bridge result.
- [x] 1.3 `periods.ts` — discrete period selection, annual/monthly aggregation, money rounding.
- [x] 1.4 `income-statement.ts` — derive revenue/expenses/net income with the sign applied once;
      `UnclassifiedAccountError` rather than a silent zero.
- [x] 1.5 `coa-roles.ts` — role→line mapping, display order, default EBIT commentary.
- [x] 1.6 `addbacks.ts` — the four sourcing kinds, vendor scope, smoothing, duplicate detection.
- [x] 1.7 `bridge.ts` — Reported EBITDA, grouping, owner-comp rule, Adjusted EBITDA/SDE, margin.
- [x] 1.7a `classify.ts` — assign EBITDA roles from the account record. Phrase matching only, an
      operating-tax exclusion list checked before income tax, high/low confidence, and a reason on
      every result. 34 tests, including all four of this engagement's tax accounts and 14 more.
- [x] 1.8 `scripts/build-fixture.py` — anonymize the engagement, asserting every year's revenue,
      expenses and net income before writing.
- [x] 1.9 **vitest**: golden suite against the workbook — the FY table, FY2024 Reported EBITDA
      $347,403.35, the three operating-tax accounts contributing $0, SDE vs Adjusted EBITDA,
      each add-back kind, monthly reconciliation. (23 tests)

## 2. Contracts — `packages/contracts`

- [x] 2.1 `qoe.ts` — bridge query/response, add-back create with per-kind refinements, role update.
- [x] 2.2 Export from the barrel.
- [x] 2.3 **vitest**: the contract refuses an unexplained manual adjustment, a hand-typed GL amount,
      and a recast with no normalized value. (6 tests)

## 3. Schema — `packages/db`

- [x] 3.1 Model `chart_of_accounts`, `general_ledger_entries`, `qoe_addbacks`.
- [x] 3.2 `0002_qoe_bridge.sql` — `ebitda_role`, `market_rate_replacement_salary`,
      `general_ledger_entries.coa_id` (drift reconciliation, design D6), `qoe_addbacks` with CHECK
      constraints, and the legacy add-back migration in dynamic SQL.
- [x] 3.3 `0002_qoe_bridge.down.sql`.
- [x] 3.4 Exercise the migration **both** with and without the legacy tables present, and the down
      migration, against real Postgres.

## 4. API module — `apps/api/src/modules/qoe`

- [x] 4.1 `ports.ts`, `service.ts`, `router.ts`, `repository.drizzle.ts`, `repository.memory.ts`.
- [x] 4.2 Tenant guard via the shared `canAccessCompany`.
- [x] 4.3 Commentary draft returns unsaved; a separate confirm persists.
- [x] 4.4 Wire `QOE_MODULE_ENABLED` into `env.ts` and `server.ts`.
- [x] 4.5 **vitest**: service tests over the in-memory repo. (9 tests)
- [x] 4.6 **supertest + pglite**: load the engagement into the real `chart_of_accounts` and
      `general_ledger_entries` tables **with no classification**, classify it through the API, read
      it back through the Drizzle repository, and assert the workbook figures over HTTP. (12 tests)
- [x] 4.6a `POST /qoe/versions/:id/classify` with `?dry_run=true`; bulk role assignment in one
      transaction.
- [x] 4.7 Regenerate `tools/parity/route-surface.json`.

## 5. Frontend — `apps/web`

- [x] 5.1 Delete `ebitdaService.js`, `ebitdaAdjustmentService.js`, `WorkspaceEbitda.jsx`,
      `AddbackEditorModal.jsx`, `EbitdaAdjustmentsPanel.jsx` (~3,300 lines).
- [x] 5.2 `services/qoeApi.js` — client for `/qoe/*`.
- [x] 5.3 `components/qoe/BridgeTable.jsx` — itemized lines, collapsible groups, margin.
- [x] 5.4 `components/qoe/AddbackWizard.jsx` — gates on sourcing kind, enforces the per-kind rules.
- [x] 5.5 Rewrite `WorkspaceEbitda.jsx` — period selection, source toggle, commentary, unflagged
      disclosure.
- [x] 5.5a `ClassificationPanel.jsx` — review what was classified, what needs confirming, and what
      was left out with the reason; re-run and override from the same place.
- [x] 5.6 Repoint `cimFinancialAutofillService.js` at the bridge via `qoeBridgeAdapter.js`.
- [ ] 5.7 Convert the new components `.jsx → .tsx` under `frontend-ui-adoption`.

## 6. Defects found en route (each with a regression test)

- [x] 6.1 Gateway CORS omitted `Cache-Control` — every cross-origin SPA request failed preflight.
- [x] 6.2 `/key-reports/versions` required `?company_id`; the SPA sends `X-Client-Id`.
- [x] 6.3 The reports module returned a bare array and snake_case where legacy returns
      `{ success, versions, activeVersionId }` and camelCase.
- [x] 6.4 `GET /key-reports/versions/:id` returned a bare object where the SPA reads `detail.version`.
- [x] 6.5 `selectKeyReportContext` minted a fresh object per snapshot — "Maximum update depth
      exceeded".
- [x] 6.6 An infinite render loop in the new page: `load` both depended on and set `selectedYears`.
- [x] 6.7 Dialogs centred inside a mis-parented fixed overlay, putting the header above the top edge
      where it could not be reached. Anchored to the top instead.

## 7. Demo / verification

- [x] 7.1 `tools/demo/seed-qoe.mjs` — load the engagement into the real tables.
- [x] 7.2 Wire into `tools/demo/up.sh` with live assertions of the workbook figures.
- [x] 7.3 `AUTH_TRUSTED_ORIGINS` overridable so a local dev server can reach the demo gateway.
- [x] 7.4 Full stack verified from a clean build; all checks green.
- [x] 7.5 UI driven end to end in a browser: login, bridge renders the workbook figures, wizard gates
      on kind and refuses an unexplained manual adjustment.

## 8. Follow-ups (not this change)

- [x] 8.1 Backfill `ebitda_role` for existing report versions — `tools/ops/classify-accounts.mjs`,
      dry-run by default since it changes the earnings figure on every engagement it touches.
- [ ] 8.2 Retire the legacy `/ebitda-adjustments` routes and `ebitda_adjustments*` tables after soak.
- [ ] 8.3 The financial-foundation change: balance-sheet Retained Earnings/Net Income classification
      and trial-balance opening balances.

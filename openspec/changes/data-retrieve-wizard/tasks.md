## 1. Contracts
- [ ] 1.1 zod schemas: `pullStart` (source, companyId), `dateRangeConfirm`, `pullResponse`,
      `pullReportStatus`, `connectionStatus` (status/connectedAt/realmDisplayName — **no tokens**)
- [ ] 1.2 Key-report registry entry schema (`key`, `displayName`, per-source report id, `required`, `order`)
- [ ] 1.3 Contract tests, incl. an assertion that no connection schema can serialize a token field

## 2. Data layer
- [ ] 2.1 Model `source_connections` (unique on `company_id` + `source`, token set encrypted at rest)
- [ ] 2.2 Model `data_pulls` (company-scoped `version_number`, source, date range, status, initiated_by, timestamps)
- [ ] 2.3 Model `data_pull_reports` (pull_id, report_key, status, file_id, error, attempts)
- [ ] 2.4 Key-report registry storage/seed with the launch set (P&L, BS, GL, COA, TB, AR Aging S/D, AP Aging S/D)
- [ ] 2.5 Schema tests assert the columns and the per-company version uniqueness

## 3. Source seam
- [ ] 3.1 `ReportSourcePort` (`authorize`, `supportedRange`, `listReports`, `fetchReport`) + source registry
- [ ] 3.2 Source descriptor drives step rendering (OAuth step vs upload step) and disabled-with-reason state
- [ ] 3.3 `DesktopBackupParserPort` stub — explicit not-implemented, never a silent success
- [ ] 3.4 Vitest: registry resolution, descriptor-driven steps, unknown source rejected

## 4. QuickBooks Online adapter
- [ ] 4.1 Intuit hosted OAuth: authorize redirect, callback exchange, connection persisted per company
- [ ] 4.2 Connection health check + re-authorize path on expired refresh token
- [ ] 4.3 `fetchReport` per registry entry for the confirmed range; typed per-report errors (timeout, unavailable)
- [ ] 4.4 Vitest against a mocked Intuit API: success, denied consent, expired token, per-report failure

## 5. Pull orchestrator
- [ ] 5.1 Background job: resolve/create destination subfolder via `folders`, snapshot the registry
- [ ] 5.2 Fetch per report; write the file via `uploads` **on that report's success** (not batched)
- [ ] 5.3 Per-report status transitions; pull completes as `succeeded` / `partial` / `failed`
- [ ] 5.4 Retry path re-runs only `failed` children into the **same** pull version
- [ ] 5.5 Auto-numbered `version_number`; re-run never mutates a prior pull
- [ ] 5.6 Vitest: partial failure leaves succeeded files intact; retry re-fetches only failures;
      re-run creates a new version with the prior pull's files unmodified

## 6. Access control
- [ ] 6.1 `requireSession` + `canAccessCompany` **and** the Data Room upload-permission check (FR-1)
- [ ] 6.2 Repository queries take `company_id` from session context, never from the request body
- [ ] 6.3 Supertest: Bank/Buyer denied; no-upload-permission user denied at the endpoint (not just the UI);
      company A's connection unreachable from company B; company A's files absent from B's listings/search

## 7. Router
- [ ] 7.1 Endpoints: start, connection status, confirm range, pull progress, retry failed, summary
- [ ] 7.2 helmet + pino scoped; shared `requireAuth`
- [ ] 7.3 Supertest: 400 on malformed payloads; 401/403 on the access matrix; progress readable after reconnect

## 8. Desktop path (behind `DESKTOP_SOURCE_ENABLED`, default off)
- [ ] 8.1 Single-file `.qbb` drag-and-drop upload; reject wrong type and multi-file in place
- [ ] 8.2 Pull records `awaiting_processing` with reason when no parser is bound — no placeholder files
- [ ] 8.3 Supertest: flag off → source disabled with reason; flag on, no parser → awaiting_processing,
      zero files written

## 9. Notifications & checklist
- [ ] 9.1 `NotificationPort` + `ChecklistPort` with no-op-and-log implementations (hub/tracker not built)
- [ ] 9.2 Emit `pull.completed`; mark mapped Deal Tracker (`BR - 0001`) / Lender Requirement (`DR - 0005`) items
- [ ] 9.3 Vitest: completion notifies; no configured tracker → pull still completes with no side effect

## 10. Web wizard
- [ ] 10.1 Data Room "Retrieve Reports" entry point, hidden without upload permission
- [ ] 10.2 Six steps per §6: source → authenticate/upload → date range → confirm → progress → summary
- [ ] 10.3 Live progress ("Retrieving Profit & Loss… 3 of 8 complete"), resilient to reload
- [ ] 10.4 Completion summary lists each saved report and links its Data Room folder; failed reports
      offer retry-failed-only
- [ ] 10.5 Abandoning before confirm leaves no pull and no files

## 11. Gateway cutover
- [ ] 11.1 Mount behind `QUICKBOOKS_MODULE_ENABLED` (off → legacy); document both flags
- [ ] 11.2 Soak against a sandbox Intuit company; parity checklist
- [ ] 11.3 Retire the legacy QuickBooks OAuth routes after a green soak

## 12. Wrap up
- [ ] 12.1 `openspec validate data-retrieve-wizard --strict` passes
- [ ] 12.2 typecheck + lint + test green; module coverage ≥90%
- [ ] 12.3 `main` untouched; Conventional Commits; update `docs/REARCH_LOG.md`
- [ ] 12.4 Close or carry the six open questions in `design.md`; the `.qbb` spike is a separate change

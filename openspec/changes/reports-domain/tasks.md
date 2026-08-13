## 1. Contracts
- [x] 1.1 zod schemas: reportVersionCreate (name?, metadata?), reportVersionUpdate (name?/status?/metadata?), version response
- [x] 1.2 Contract tests

## 2. Data layer
- [x] 2.1 Model `key_report_versions` (+ partial-unique active index) in `packages/db`
- [x] 2.2 Schema test asserts the columns

## 3. Repository (Drizzle + in-memory)
- [x] 3.1 listByCompany, getById, create (auto-number), update, delete
- [x] 3.2 duplicate (copy → new draft), activate (transactional single-official invariant)
- [x] 3.3 In-memory adapter mirrors it all

## 4. Service
- [x] 4.1 Tenant guard (company on row / path) via `canAccessCompany`
- [x] 4.2 create/update/duplicate/activate/delete; `ReportSyncPort` stub (501 for the deferred GL sync)

## 5. Router
- [x] 5.1 Version-lifecycle endpoints only (list/create/get/update/duplicate/activate/delete); sync et al. fall through to legacy
- [x] 5.2 helmet + pino scoped; shared `requireAuth`

## 6. Tests (≥90% on the module)
- [x] 6.1 Create auto-numbers; update; delete; tenant denial
- [x] 6.2 Activate deactivates the previously-active version (invariant) — real Postgres
- [x] 6.3 Duplicate copies into a new inactive draft
- [x] 6.4 400 on malformed; sync port returns 501 (deferred)

## 7. Gateway cutover
- [x] 7.1 Mount behind `REPORTS_MODULE_ENABLED` (off → legacy); document the flag

## 8. Cutover & retire
- [~] 8.1 Enable in staging; parity checklist — deferred (needs a real env)
- [~] 8.2 Retire legacy version handlers after a green soak — deferred (sync stays on legacy)

## 9. Wrap up
- [x] 9.1 `openspec validate reports-domain --strict` passes
- [x] 9.2 typecheck + lint + test green; module coverage ≥90%
- [x] 9.3 `main` untouched; Conventional Commits; update `docs/REARCH_LOG.md`

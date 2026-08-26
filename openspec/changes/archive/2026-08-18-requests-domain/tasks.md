## 1. Contracts
- [x] 1.1 zod enums (category, response_type, priority, status, approval_status) + requestCreate/Update/Bulk, narrativeUpdate, reminder; request + reminder responses
- [x] 1.2 priority→reminder-frequency helper; contract tests

## 2. Data layer
- [x] 2.1 Model `requests` (full columns), `request_reminders`, `request_narratives`, `request_documents` in `packages/db`
- [x] 2.2 Schema test asserts the columns

## 3. Repository (Drizzle + in-memory)
- [x] 3.1 CRUD: listByCompany, getById, create, update, delete
- [x] 3.2 bulk create (transactional), approve
- [x] 3.3 reminders append/list; narrative get/upsert; request-document link/list
- [x] 3.4 In-memory adapter mirrors it all

## 4. Service
- [x] 4.1 Validate/normalize (enums, future due-date on create, reminder frequency, approval derivation)
- [x] 4.2 Tenant guard (company on the row / path :companyId) via shared `canAccessCompany`
- [x] 4.3 create/bulk/update/approve/delete; narrative get/update; reminders; document links

## 5. Router
- [x] 5.1 The endpoints (list/create/bulk/get/update/approve/delete, reminders, narrative, documents)
- [x] 5.2 helmet + pino scoped; shared `requireAuth`

## 6. Tests (≥90% on the module)
- [x] 6.1 Validation: enum + future-date + reminder-frequency + approval derivation
- [x] 6.2 Tenant scoping (list/get/update/delete); cross-tenant denial
- [x] 6.3 Bulk create; approve; narrative upsert; reminder append; document link — real Postgres
- [x] 6.4 400 on malformed create

## 7. Gateway cutover
- [x] 7.1 Mount behind `REQUESTS_MODULE_ENABLED` (off → legacy); document the flag

## 8. Cutover & retire
- [~] 8.1 Enable in staging; parity checklist vs the real DB — deferred (needs a real env)
- [~] 8.2 Delete legacy request handlers after a green soak — deferred

## 9. Wrap up
- [x] 9.1 `openspec validate requests-domain --strict` passes
- [x] 9.2 typecheck + lint + test green; module coverage ≥90%
- [x] 9.3 `main` untouched; Conventional Commits; update `docs/REARCH_LOG.md`

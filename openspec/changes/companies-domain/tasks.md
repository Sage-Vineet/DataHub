## 1. Contracts

- [ ] 1.1 zod schemas in `packages/contracts`: companyCreate, companyUpdate (safe fields only), companyListQuery, and the company response (incl. stats) + inferred types
- [ ] 1.2 Profit-metric enum + normalization helper (aliases → `adjusted_ebitda` | `sde`)
- [ ] 1.3 Contract tests (valid/invalid payloads; normalization)

## 2. Data layer

- [ ] 2.1 Extend `packages/db` companies schema to all columns (`project_name`, `logo`, `contact_*`, `data_source_type`, `quickbooks_connected`, `manual_upload_active`, `profit_metric`, `last_source_switch_at`); `user_companies` already modeled
- [ ] 2.2 Reconcile via `db:pull` against the dev DB; schema test asserts the new columns

## 3. Shared access + ports

- [ ] 3.1 Move `canAccessCompany` from `modules/auth` to `apps/api/src/shared/access.ts`; update auth to import it
- [ ] 3.2 Define `UserProvisioningPort` (client-rep sync) + `FolderProvisioningPort` (default folders) + `CompanyStatsPort` in `modules/companies/ports.ts`
- [ ] 3.3 Legacy-backed adapters for each port (call the existing services) until users/folders modules exist

## 4. Repository (Drizzle + in-memory)

- [ ] 4.1 `repository.drizzle.ts`: getById, listForUser (role-scoped), create, updateSafeFields, and the **transactional cascade delete** (nested → company-keyed in FK order → null users.company_id → delete)
- [ ] 4.2 `repository.memory.ts`: same interface for tests
- [ ] 4.3 No Supabase/pg fallback — Drizzle only

## 5. Service

- [ ] 5.1 list/get (tenant-guarded via shared access; attach stats via port)
- [ ] 5.2 create: role gate (broker/admin), normalize profit metric, then provisioning ports (folders + client-rep sync)
- [ ] 5.3 update: safe fields only (never touch `quickbooks_connected`/`data_source_type`); re-sync rep on email change
- [ ] 5.4 delete: tenant guard → transactional cascade

## 6. Router

- [ ] 6.1 `GET/POST /`, `GET/PATCH/DELETE /:id` — validate via contracts (400), enforce access, map errors to status
- [ ] 6.2 Mount helmet + pino scoped to the module (not global)

## 7. Tests (≥90% on the module)

- [ ] 7.1 List scoping: admin all; broker/client only their companies
- [ ] 7.2 Create: role gate; default folders + client-rep sync invoked (via fake ports); profit normalization
- [ ] 7.3 Update: safe-field only; integration flags untouched; rep re-sync on email change
- [ ] 7.4 Delete: seed a company with dependents → all removed, atomic; access required
- [ ] 7.5 Cross-tenant read/update/delete denied

## 8. Gateway cutover

- [ ] 8.1 Mount `/api/companies` in `apps/api` behind `COMPANIES_MODULE_ENABLED` (off → legacy)
- [ ] 8.2 Document the flag in `apps/api/.env.example`

## 9. Cutover & retire

- [ ] 9.1 Enable in staging; parity checklist (list/get/create/update/delete + tenant boundary) against the real DB
- [ ] 9.2 After a green soak, delete legacy `companies` routes/controller/service
- [ ] 9.3 Swap provisioning ports to the real `users`/`folders` module services once those land

## 10. Wrap up

- [ ] 10.1 `openspec validate companies-domain --strict` passes
- [ ] 10.2 `turbo run typecheck lint test build` green; module coverage ≥90%
- [ ] 10.3 `main` untouched; Conventional Commits; update `docs/REARCH_LOG.md`

## Notes

- Riskiest task is the transactional cascade (4.1) — test it hard; keep legacy as rollback until soaked.
- `canAccessCompany` becoming shared (3.1) benefits every later domain — do it cleanly.

## 1. Contracts

- [x] 1.1 zod schemas in `packages/contracts` (`companies.ts`): companyCreate, companyUpdate (safe fields only), companyListQuery, companyResponse (incl. stats) + inferred types
- [x] 1.2 Profit-metric enum + `normalizeProfitMetric` helper (aliases → `adjusted_ebitda` | `sde`)
- [x] 1.3 Contract tests (`companies.test.ts`): valid/invalid payloads, email + metric normalization, unsafe-field stripping

## 2. Data layer

- [x] 2.1 Extended `packages/db` companies schema to all columns (`project_name`, `logo`, `contact_*`, `data_source_type`, `quickbooks_connected`, `manual_upload_active`, `profit_metric`, `last_source_switch_at`); `industry` relaxed to nullable (legacy parity)
- [x] 2.2 Schema test asserts the new columns. `db:pull` reconciliation deferred — no live DB reachable here (same constraint as auth); the schema mirrors legacy `schema.sql`

## 3. Shared access + ports

- [x] 3.1 Moved `canAccessCompany` to `apps/api/src/shared/access.ts`; auth re-exports it (existing imports unchanged)
- [x] 3.1b Added `apps/api/src/shared/session.ts` — `requireSession` (wraps Better Auth `requireBetterAuth`); the companies router uses it, not the bespoke `requireAuth` (ADR-0007)
- [x] 3.2 `UserProvisioningPort` (client-rep sync) + `FolderProvisioningPort` (default folders) + `CompanyStatsPort` in `ports.ts`
- [x] 3.3 Drizzle-backed adapters for each port (`adapters.drizzle.ts`); transitional until users/folders modules land

## 4. Repository (Drizzle + in-memory)

- [x] 4.1 `repository.drizzle.ts`: getById, listAll/listByIds (role-scoped in the service), create, updateSafeFields, and the **transactional cascade delete** (nested → company-keyed in FK order → null `users.company_id` → delete)
- [x] 4.2 `repository.memory.ts`: same interface for service tests
- [x] 4.3 No Supabase/pg fallback — Drizzle only (D6)

## 5. Service

- [x] 5.1 list/get (tenant-guarded via shared `canAccessCompany`; stats attached via port)
- [x] 5.2 create: role gate (broker/admin), normalize profit metric, then provisioning ports (folders + client-rep sync) + link creator
- [x] 5.3 update: safe fields only (integration columns never touched — absent from the contract); re-sync rep on contact-email change
- [x] 5.4 delete: access guard → transactional cascade

## 6. Router

- [x] 6.1 `GET/POST /`, `GET/PATCH/DELETE /:id` — validate via contracts (400), enforce access (403/404 parity), legacy response shapes
- [x] 6.2 helmet + pino scoped to the module; shared `requireAuth` guard runs first

## 7. Tests (≥90% on the module)

- [x] 7.1 List scoping: admin all; broker/client only their companies (`service.test.ts`)
- [x] 7.2 Create: role gate; default folders + client-rep sync invoked (fake ports); profit normalization
- [x] 7.3 Update: safe-field only; integration flags untouched; rep re-sync on email change
- [x] 7.4 Delete: seed a company with dependents across the cascade surface → all removed, atomic, `users.company_id` nulled (real Postgres via PGlite, `companies.integration.test.ts`)
- [x] 7.5 Cross-tenant read/update/delete denied (403); missing → 404. Coverage: 93% stmts overall, service 96–98%, router 89–94%

## 8. Gateway cutover

- [x] 8.1 Mounted `/api/companies` in `apps/api` behind `COMPANIES_MODULE_ENABLED` (off → legacy); shared Better Auth session guard injected
- [x] 8.2 Documented the flag (+ Better Auth/CORS/Graph env) in `apps/api/.env.example`

## 9. Cutover & retire

- [~] 9.1 Enable in staging; parity checklist against the real DB — **deferred**: needs a real environment (ops). Module + cascade proven against real Postgres locally.
- [~] 9.2 Delete legacy `companies` handlers after a green soak — **deferred**: legacy stays the rollback target until soaked.
- [~] 9.3 Swap provisioning ports to the real `users`/`folders` module services — **deferred**: those modules don't exist yet (Phase 2 follow-ons); the ports make it a no-contract-change swap.

## 10. Wrap up

- [x] 10.1 `openspec validate companies-domain --strict` passes
- [x] 10.2 typecheck + lint + test green (contracts 13, db 4, api 76); module coverage ≥90%
- [x] 10.3 `main` untouched; Conventional Commits; `docs/REARCH_LOG.md` updated

## Notes

- Riskiest task was the transactional cascade (4.1) — covered hard in `companies.integration.test.ts` (seed-and-delete across 8+ tables, atomic, user survives with `company_id` nulled). Legacy stays the rollback target until soaked.
- `canAccessCompany` + `requireSession` are now shared (`apps/api/src/shared/`), so `users`/`folders` inherit them.
- **Parity note:** non-admin list scoping reads the caller's session `company_ids` (as legacy did) — a broker sees a freshly-created company once their session reflects the new membership.

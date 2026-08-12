## 1. Contracts

- [x] 1.1 zod schemas (`packages/contracts/users.ts`): userCreate, userUpdate, listQuery, companyMembership (add/remove), brokerTeamInvite; userResponse with `effective_role`, `assigned_companies`, sub-role fields
- [x] 1.2 Role/sub-role enums + `effectiveRole` enum + the client-side/broker-team/client-team sub-role sets; contract tests (`users.test.ts`)

## 2. Data layer

- [x] 2.1 Extended `packages/db` users to full columns (`sub_role`, `designation`, `buyer_company_name`, `parent_user_id`, profile fields); modeled `broker_team_invites`
- [x] 2.2 Schema test asserts the new columns. `db:pull` deferred — no live DB reachable here (same constraint as auth/companies)

## 3. Ports

- [x] 3.1 `EmailerPort` + `NotificationPort` (best-effort, non-fatal on create) — service swallows failures
- [x] 3.2 `AuthCachePort` — a no-op adapter (Better Auth sessions are DB-backed, so an update is reflected on the next `getSession`; nothing to bust) (ADR-0007)
- [x] 3.3 Reassignment done as a **transactional repo method** (`reassignAndDelete`) — reassigns `created_by`/`uploaded_by` across requests/folders/documents/request_narratives/request_reminders/folder_access/reminders/activity_log, then removes links + deletes the user, atomically
- [x] 3.4 Transitional adapters (`adapters.ts`: console email/notification, no-op auth-cache)

## 4. Repository (Drizzle + in-memory)

- [x] 4.1 CRUD, listAll, getByEmail, add/remove companies (`user_companies`), broker-team invite/remove/list, `assignedCompaniesFor`, `replacementCandidates`
- [x] 4.2 Transactional delete: service resolves replacement → repo `reassignAndDelete` (reassign via port targets → clean links → delete) in one transaction
- [~] 4.3 Historical-company-inference read (D5) — **not ported**: it exists only to cover empty `user_companies` for legacy brokers; `assignedCompaniesFor` already unions `user_companies` + primary `company_id`. Left as a documented follow-up (proposal non-goal) rather than porting the 5-query Supabase fan-out
- [x] 4.4 In-memory adapter mirrors it all (`repository.memory.ts`)

## 5. Service (pure, tested rules)

- [x] 5.1 Visibility filter (self / shared-company broker + invited-team / admin-all)
- [x] 5.2 Create with role/sub-role gating (brokers can't make admin/primary-broker; can make broker-team sub-roles + buyers) + best-effort email/notification
- [x] 5.3 Update: no role change for brokers (buyer only); own-companies only; self password requires + verifies `current_password` (bcrypt); auth-cache invalidate hook
- [x] 5.4 Delete: replacement-required invariant → reassign → delete (atomic)
- [x] 5.5 `effective_role` computation (admin/broker/client/user, incl. seller-by-contact-email) as a **pure function** (`roles.ts`); client-team request-restriction helper
- [x] 5.6 Company membership add/remove; broker-team invite/remove

## 6. Router

- [x] 6.1 The 10 endpoints (list, create, find-by-email, get, update, delete, add/remove-companies, broker-team invite/remove) — validate via contracts (400), enforce access (403/404), static routes before `/:id`
- [x] 6.2 helmet + pino scoped to the module; shared `requireAuth` guard runs first

## 7. Tests (≥90% on the module)

- [x] 7.1 Table-driven `effective_role` across role/sub-role/seller-contact combinations (`roles.test.ts`, 13 cases)
- [x] 7.2 Visibility: broker scoped (+ invited team), admin all, self-only
- [x] 7.3 Create gating (broker can't make admin/primary broker; company scope); update (no role change; self password path verified)
- [x] 7.4 Delete: rejected (400) with no replacement and nothing changed; reassign-then-delete atomic against real Postgres (`users.integration.test.ts`)
- [x] 7.5 Membership add within/out of scope; broker-team invite/remove; cross-tenant denials. Coverage: 91% stmts overall

## 8. Gateway cutover

- [x] 8.1 Mounted `/api/users` behind `USERS_MODULE_ENABLED` (off → legacy), sharing the Better Auth session guard; documented in `apps/api/.env.example`

## 9. Cutover & retire

- [~] 9.1 Enable in staging; parity checklist against the real DB — **deferred**: needs a real environment (ops). Module + transactional delete proven against real Postgres locally.
- [~] 9.2 Delete legacy `users` handlers after a green soak — **deferred**: legacy stays the rollback target until soaked.
- [~] 9.3 Swap reassignment/notification ports to real sibling-module services — **deferred**: those modules don't exist yet; the ports make it a no-contract-change swap.

## 10. Wrap up

- [x] 10.1 `openspec validate users-domain --strict` passes
- [x] 10.2 typecheck + lint + test green (contracts 17, db 6, api 104); module coverage ≥90%
- [x] 10.3 `main` untouched; Conventional Commits; `docs/REARCH_LOG.md` updated

## Notes

- Highest-risk surfaces were `effective_role` correctness (7.1 — 13-case table) and delete-with-reassignment atomicity (4.2/7.4 — transactional, proven against real Postgres). Both tested hard.
- Historical-company-inference (D5) intentionally not ported (see 4.3) — `assignedCompaniesFor` unions memberships + primary company, which covers the observable behavior.
- Shared `requireSession` + `canAccessCompany` (from `companies-domain`) reused unchanged.

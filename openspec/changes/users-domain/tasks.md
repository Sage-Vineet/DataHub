## 1. Contracts

- [ ] 1.1 zod schemas: userCreate, userUpdate, listQuery, addCompanies/removeCompanies, brokerTeamInvite; response with `effective_role`, `assigned_companies`, sub-role fields
- [ ] 1.2 Role/sub-role enums + the client-side sub-role set; contract tests

## 2. Data layer

- [ ] 2.1 Extend `packages/db` users to full columns (`sub_role`, `designation`, `buyer_company_name`, `parent_user_id`, profile fields); model `broker_team_invites`
- [ ] 2.2 Reconcile via `db:pull`; schema test asserts the columns

## 3. Ports

- [ ] 3.1 `EmailerPort` + `NotificationPort` (best-effort, non-fatal on create)
- [ ] 3.2 `AuthCachePort` → auth module's `invalidateUserCache` on update
- [ ] 3.3 `RecordReassignmentPort` → reassign `created_by`/`uploaded_by` across folders/requests/documents/activity/reminders (transactional)
- [ ] 3.4 Legacy-backed adapters for each until the sibling domains land

## 4. Repository (Drizzle + in-memory)

- [ ] 4.1 CRUD, listForViewer, getByEmail, add/remove companies (`user_companies`), broker-team invite/remove
- [ ] 4.2 Transactional delete: resolve replacement → reassign via port → delete user
- [ ] 4.3 Historical-company inference read (isolated; only when `user_companies` empty for a broker) — marked legacy-compat
- [ ] 4.4 In-memory adapter mirrors it all

## 5. Service (pure, tested rules)

- [ ] 5.1 Visibility filter (self / shared-company broker-admin / admin-all)
- [ ] 5.2 Create with role/sub-role gating (brokers can't make admin/top-broker; can make team sub-roles + buyers) + email/notification ports
- [ ] 5.3 Update: no role change for brokers; own-companies only; self password requires `current_password`; invalidate auth cache
- [ ] 5.4 Delete: replacement-required invariant → reassign → delete (atomic)
- [ ] 5.5 `effective_role` computation (admin/broker/client/user) + client-team request restriction — pure function
- [ ] 5.6 Company membership add/remove; broker-team invite/remove

## 6. Router

- [ ] 6.1 The 10 endpoints (list, create, find-by-email, get, update, delete, add/remove-companies, broker-team invite/remove) — validate via contracts, enforce access
- [ ] 6.2 helmet + pino scoped to the module

## 7. Tests (≥90% on the module)

- [ ] 7.1 Table-driven `effective_role` across every role/sub-role/contact-match combination
- [ ] 7.2 Visibility: broker scoped, admin all, self-access
- [ ] 7.3 Create gating (broker can't make admin); update (no role change; self password path)
- [ ] 7.4 Delete: rejected with no replacement; reassign-then-delete when replacement exists
- [ ] 7.5 Membership + broker-team; cross-tenant denials

## 8. Gateway cutover

- [ ] 8.1 Mount `/api/users` behind `USERS_MODULE_ENABLED` (off → legacy); document in `.env.example`

## 9. Cutover & retire

- [ ] 9.1 Enable in staging; parity checklist against the real DB (visibility, create/update/delete, membership, team, effective-role spot-checks)
- [ ] 9.2 After a green soak, delete legacy `users` routes/controller/service
- [ ] 9.3 Swap the reassignment/notification ports to real sibling-module services as they land

## 10. Wrap up

- [ ] 10.1 `openspec validate users-domain --strict` passes
- [ ] 10.2 `turbo run typecheck lint test build` green; module coverage ≥90%
- [ ] 10.3 `main` untouched; Conventional Commits; update `docs/REARCH_LOG.md`

## Notes

- Highest-risk surfaces: `effective_role` correctness (7.1) and delete-with-reassignment atomicity (4.2/7.4). Test both hard.
- Do `companies-domain` first so the shared `canAccessCompany` guard already exists.

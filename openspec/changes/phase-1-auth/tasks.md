## 1. Shared contracts (`packages/contracts`)

- [x] 1.1 Scaffold `packages/contracts` (TS, consumes `@datahub/config`), add `zod`
- [x] 1.2 Define auth zod schemas + inferred types: login, forgot-password, reset-password, OTP send/verify, current-session (`/me`)
- [x] 1.3 Unit-test the schemas (accept valid payloads, reject malformed) — establishes the contract test pattern

## 2. Data layer (`packages/db`, Drizzle — auth slice)

- [x] 2.1 Scaffold `packages/db`; add `drizzle-orm` + `drizzle-kit`; add a typed pg client reading `DATABASE_URL`
- [x] 2.2 Auth-slice schema committed (hand-authored from `backend/sql/schema.sql`, design D4). **Reconciliation validated:** with the local dev DB (see local-dev-environment), `drizzle-kit pull` now introspects successfully (after bumping drizzle-orm → 0.40.1) and confirms the auth-slice tables/columns match the hand-authored schema.
- [x] 2.3 `drizzle.config.ts` + `migrations/README` establish the Drizzle baseline; legacy 76-file set documented as frozen
- [x] 2.4 Schema smoke test (types compile; column names asserted)

## 3. Auth module (`apps/api/src/modules/auth`)

- [x] 3.1 Typed, fail-closed config loader (`config.ts`): mandatory `JWT_SECRET`, same 7d HS256 claim shape for token parity (design D3)
- [x] 3.2 `repository.drizzle.ts` — auth data access via `packages/db`; `repository.memory.ts` — in-memory adapter for tests/dev (no raw SQL outside the repo)
- [x] 3.3 `service.ts` — login (bcrypt-only, no static password), JWT issue/verify, enumeration-safe forgot/reset, OTP; ports post-login client company-sync + default-folders at parity
- [x] 3.4 `router.ts` — thin HTTP surface; validates every request with `packages/contracts` (400 on failure); `/login`, `/forgot-password`, `/reset-password`, `/send-otp`, `/verify-otp`, `/me`, `/logout`
- [x] 3.5 Auth contract consumed from `packages/contracts`

## 4. New-API security middleware

- [x] 4.1 `express-rate-limit` on `/login` keyed by IP+email, skipping successful requests (audit H1)
- [x] 4.2 `helmet` + `pino-http` scoped to the auth router (NOT global — legacy pass-through stays byte-identical; design D6)

## 5. Gateway mount + cutover flag

- [x] 5.1 `MountedModule` support added to the gateway; auth mounted at `/api/auth` **before** the catch-all proxy (design D1)
- [x] 5.2 Mount gated by `AUTH_MODULE_ENABLED` (off by default → `/api/auth` falls through to the legacy proxy; design D2)
- [x] 5.3 `AUTH_MODULE_ENABLED` + rate-limit env documented in `apps/api/.env.example`

## 6. Tests (≥90% on the new module)

- [x] 6.1 Login: valid → 200 + JWT; wrong password / unknown email → generic 401
- [x] 6.2 Former shared password ("123456") on a client account → 401 (no static password)
- [x] 6.3 Rate limit: repeated failures → 429; success under threshold unaffected
- [x] 6.4 Token: valid accepted; forged/tampered/foreign-secret → null; missing secret → fail-closed
- [x] 6.5 Reset: identical generic 200 for known/unknown; reset needs valid OTP + strong password; weak password → 400
- [x] 6.6 OTP: valid within limits passes; expired → fails; resend limit → 429
- [x] 6.7 `/me`: valid token → identity; no token → 401
- [x] 6.8 Tenant parity: `canAccessCompany` — brokers/admins any; buyers only their own
- [x] 6.9 Post-login provisioning: first client login yields synced company + default folders
- [x] 6.10 Token cross-validity: a legacy-shaped `{sub}` token (same secret) verifies in the new module
- [x] 6.11 Module coverage 95% stmts / 100% funcs (above the gate); legacy pass-through proven by the Phase 0 gateway tests

## 7. Cutover & verify — runtime (pending a deploy)

- [ ] 7.1 Enable `AUTH_MODULE_ENABLED` in a canary/preview; run the parity checklist (needs the DB + running deploy)
- [ ] 7.2 Confirm all non-auth routes still proxy to legacy unchanged (runtime)
- [ ] 7.3 After a green soak, remove the legacy `/api/auth` handlers (separate, reversible commit)

## 8. Validate & wrap up

- [x] 8.1 `openspec validate phase-1-auth --strict` passes
- [x] 8.2 Full `turbo run typecheck lint test build` green (typecheck 7/7, test 49, lint 6/6, build 4/4)
- [x] 8.3 Confirmed `main` untouched and legacy source unmodified; committed on `ba/rearch` with Conventional Commits; `docs/REARCH_LOG.md` updated

## Notes — apply-time status

- Built **flag-off by default**: the module is fully implemented + tested but not yet in the request path. Enabling it (**7.x**) requires a reachable `DATABASE_URL` and a running deploy — the in-repo work ends here.
- **2.2** used the hand-authored schema fallback (no DB at apply time); reconcile via `db:pull` before enabling.

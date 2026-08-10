## 1. Shared contracts (`packages/contracts`)

- [ ] 1.1 Scaffold `packages/contracts` (TS, consumes `@datahub/config`), add `zod`
- [ ] 1.2 Define auth zod schemas + inferred types: login, forgot-password, reset-password, OTP send/verify, current-session (`/me`)
- [ ] 1.3 Unit-test the schemas (accept valid payloads, reject malformed) — establishes the contract test pattern

## 2. Data layer (`packages/db`, Drizzle — auth slice)

- [ ] 2.1 Scaffold `packages/db`; add `drizzle-orm` + `drizzle-kit`; add a typed pg client reading `DATABASE_URL`
- [ ] 2.2 Introspect (`drizzle-kit pull`) and commit the auth-slice schema only (users, OTP/email-verification, company + user-company links). Fallback: hand-author from `backend/sql/schema.sql` if no DB is reachable (design D4)
- [ ] 2.3 Establish a frozen Drizzle migration baseline; document that the legacy 76-file set is frozen
- [ ] 2.4 Smoke test the client/schema (types compile; a trivial query builds)

## 3. Auth module (`apps/api/src/modules/auth`)

- [ ] 3.1 Typed, fail-closed env/secret loader (port of `backend/src/config/secrets.js`): mandatory `JWT_SECRET`, same claim shape for token parity (design D3)
- [ ] 3.2 `repository.ts` — auth data access via `packages/db` (find user by email, write password hash, OTP records, company links). No raw SQL outside here
- [ ] 3.3 `service.ts` — login (bcrypt-only, no static password), JWT issue/verify, enumeration-safe forgot/reset, OTP verify, current-session; port post-login client company-sync + `ensureDefaultFolders` side effects at parity
- [ ] 3.4 `router.ts` — thin HTTP surface; validate every request with `packages/contracts` schemas (400 on failure); wire `/login`, `/forgot-password`, `/reset-password`, OTP, `/me`
- [ ] 3.5 Re-export the auth contract from `packages/contracts`

## 4. New-API security middleware

- [ ] 4.1 Add `express-rate-limit` on `/login` keyed by IP + email (audit H1)
- [ ] 4.2 Add `helmet` and `pino`/`pino-http` scoped to the auth router (NOT global — legacy pass-through must stay byte-identical; design D6)

## 5. Gateway mount + cutover flag

- [ ] 5.1 Mount `authRouter` at `/api/auth` in `apps/api` **before** the catch-all proxy, gated by `AUTH_MODULE_ENABLED` (design D1/D2)
- [ ] 5.2 With the flag off, confirm `/api/auth` still falls through to the legacy proxy (no behavior change)
- [ ] 5.3 Document the env (`AUTH_MODULE_ENABLED`, rate-limit window) in `apps/api/.env.example`

## 6. Tests (≥90% on the new module)

- [ ] 6.1 Login: valid → 200 + JWT; wrong password / unknown email → generic 401 (spec: credential login)
- [ ] 6.2 Former shared password ("123456") on a client account → 401 (spec: no static password)
- [ ] 6.3 Rate limit: repeated failures → 429; a success under the threshold is unaffected (spec: login rate limiting)
- [ ] 6.4 Token: valid token accepted; forged/tampered token → 401; missing secret → service fails to start (spec: token issuance/verification)
- [ ] 6.5 Reset: forgot-password returns identical generic 200 for known/unknown email; reset needs valid OTP + strong password; bad/expired OTP → no change (spec: enumeration-safe reset)
- [ ] 6.6 OTP: valid within limits passes; expired/over-limit fails (spec: OTP verification)
- [ ] 6.7 `/me`: valid token → identity; no/invalid token → 401 (spec: current session)
- [ ] 6.8 Tenant parity: authorized company access allowed; cross-tenant denied 403/404 (spec: multi-tenant access parity)
- [ ] 6.9 Post-login provisioning: first client login yields synced company + default folders (spec: post-login provisioning)
- [ ] 6.10 Token cross-validity: a legacy-shaped token verifies in the new module and vice-versa (design D3)
- [ ] 6.11 Confirm module coverage ≥90% and legacy pass-through for a non-auth route is byte-identical

## 7. Cutover & verify

- [ ] 7.1 Enable `AUTH_MODULE_ENABLED` in a canary/preview; run the parity checklist (login, reset, OTP, `/me`, tenant boundary, 429)
- [ ] 7.2 Confirm all non-auth routes still proxy to legacy unchanged
- [ ] 7.3 After a green soak, remove the legacy `/api/auth` handlers (separate commit; reversible until then)

## 8. Validate & wrap up

- [ ] 8.1 `openspec validate phase-1-auth --strict` passes
- [ ] 8.2 Full `turbo run typecheck lint test build` green; new module coverage ≥90%
- [ ] 8.3 Confirm `main` untouched; commit on `ba/rearch` with Conventional Commits; update `docs/REARCH_LOG.md`

## Notes — apply-time prerequisites

- **2.2** Drizzle introspection needs a reachable `DATABASE_URL`; otherwise use the hand-authored fallback and reconcile later.
- **7.x** cutover/soak and legacy removal happen against a running deploy; the in-repo work ends at a tested, flag-gated module (flag off by default).

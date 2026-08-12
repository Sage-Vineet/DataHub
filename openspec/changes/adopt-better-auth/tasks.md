## 1. Dependencies & schema

- [ ] 1.1 Add `better-auth` + `@better-auth/drizzle-adapter` to `apps/api`; bump `drizzle-orm` to `^0.45.2` in `packages/db` (and every workspace consumer)
- [ ] 1.2 `pnpm -r typecheck` + `pnpm -r test` green after the drizzle bump (catch any 0.40→0.45 breakage)
- [ ] 1.3 Generate the Better Auth Drizzle schema (`npx @better-auth/cli generate`) into `packages/db`; add `session`/`account`/`verification` tables mapped to our naming
- [ ] 1.4 Write an **additive, reversible** Drizzle migration: new tables + the columns Better Auth adds to `users` (e.g. `email_verified`)

## 2. Better Auth module (behind the gateway)

- [ ] 2.1 `createBetterAuthModule()` in `apps/api/src/modules/auth/`: `betterAuth({ database: drizzleAdapter(db, { provider: "pg", schema }), secret, baseURL, trustedOrigins })`
- [ ] 2.2 Map the `user` model onto the existing `users` table (D2): `modelName` + field mapping + `additionalFields` for `role`/`companyId`/`status`/`phone`
- [ ] 2.3 Custom `emailAndPassword.password.verify` = `bcrypt.compare` (legacy-hash parity); `hash` = Better Auth default (D3)
- [ ] 2.4 Configure DB-backed httpOnly/Secure/SameSite cookie sessions (D4); decide `cookieCache`
- [ ] 2.5 Mount at `/api/auth` in `server.ts` `buildModules()` behind `BETTER_AUTH_ENABLED`; mutually exclusive with the bespoke module
- [ ] 2.6 Keep login rate-limiting (audit H1) on the sign-in route (D7)

## 3. Password reset (email-otp + Graph)

- [ ] 3.1 Enable the `email-otp` plugin; implement a Microsoft Graph `sendVerificationOTP` (mirror legacy `emailService.js`); keep `ConsoleEmailer` for dev
- [ ] 3.2 Preserve enumeration-safe behavior (generic response) + attempt/resend/expiry limits
- [ ] 3.3 Unit test the email adapter (mocked Graph); reset returns the generic response

## 4. Credential backfill

- [ ] 4.1 Idempotent, reversible migration script: one `account` row per user (`providerId="credential"`, `password = users.password_hash`)
- [ ] 4.2 Test: a user seeded from a real legacy bcrypt hash signs in with the original plaintext (no reset) — the spike's parity check, against the mapped schema

## 5. Session parity & tenant boundary

- [ ] 5.1 `requireAuth` reads the Better Auth session (cookie) and resolves the same `SessionUser` (`id`, `role`, `company_id`, `company_ids`) (D6)
- [ ] 5.2 `/me` returns the identical shape/status codes (200 authed / 401 not)
- [ ] 5.3 Keep `canAccessCompany` unchanged; test cross-tenant denial still holds
- [ ] 5.4 Revocation test: revoke a session → next request 401 (audit **M1** closed)

## 6. Frontend cutover (apps/web)

- [ ] 6.1 `apps/web/src/lib/api.js`: send `credentials: "include"`; stop reading/sending the `localStorage` Bearer token
- [ ] 6.2 `AuthContext.jsx`: use the Better Auth client / cookie session for login/logout/refresh/`/me`
- [ ] 6.3 Gateway CORS allows credentials for the SPA origin; add CSRF handling for cookie auth
- [ ] 6.4 Remove the `leo-session-expiry` / token-in-storage logic; verify hard-refresh keeps the session

## 7. Parity checklist & tests (vitest/supertest)

- [ ] 7.1 Supertest parity: login, `/me` (200/401), wrong-password 401, forgot→reset→login, rate-limit 429, cross-tenant denied, **revocation**
- [ ] 7.2 e2e login/refresh/logout against a real Postgres via the cookie flow
- [ ] 7.3 Coverage meets the [ADR-0005](../../../docs/adr/0005-testing-and-coverage-standard.md) gate on new code

## 8. Staged cutover

- [ ] 8.1 Deploy `apps/api` to staging with `BETTER_AUTH_ENABLED=false`; confirm 100% still serves via the bespoke module / legacy
- [ ] 8.2 Flip `BETTER_AUTH_ENABLED=true` in staging; run the parity checklist against real DB + real email
- [ ] 8.3 Watch pino logs + error rates for a soak period in staging
- [ ] 8.4 Enable in production; monitor login-success, 401/429/5xx, reset-email delivery, latency vs baseline
- [ ] 8.5 Hold for the agreed green soak; document rollback = flag off + restart

## 9. Wrap up

- [ ] 9.1 Flip [ADR-0007](../../../docs/adr/0007-auth-library-vs-bespoke.md) to **Accepted**; move the spike note to "implemented by"
- [ ] 9.2 Sync the `auth` capability spec (session transport + revocation deltas) via `/opsx:sync`
- [ ] 9.3 Update `docs/REARCH_LOG.md`; unblock `auth-production-cutover` §6 (retire legacy) now that Better Auth is the engine
- [ ] 9.4 `openspec validate adopt-better-auth --strict` passes
- [ ] 9.5 Commit on `ba/rearch` with Conventional Commits

## Notes

- **Prerequisites that gate the flip:** drizzle bump green (1.2), backfill proven (4.2),
  reset-email delivering in staging (3.1/8.2), revocation verified (5.4).
- The bespoke `AuthService`/JWT engine stays as the rollback target until the soak is green;
  its deletion is owned by `auth-production-cutover`, not this change.

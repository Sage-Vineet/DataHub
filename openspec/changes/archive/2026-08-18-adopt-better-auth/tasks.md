## 1. Dependencies & schema

- [x] 1.1 Add `better-auth` + `@better-auth/drizzle-adapter` to `apps/api`; bump `drizzle-orm` to `^0.45.2` in `packages/db` + `apps/api`; add `@electric-sql/pglite` (test DB engine)
- [x] 1.2 `typecheck` + `test` green after the drizzle bump — `@datahub/db` (3/3) and `@datahub/api` (39/39) pass on 0.45.2
- [x] 1.3 Better Auth identity tables authored in `packages/db/src/auth-schema.ts` (`auth_user`/`session`/`account`/`verification`) + combined `schema.all.ts` barrel so `db.query.*` resolves for the adapter
- [x] 1.4 Additive, reversible migration: `packages/db/migrations/0000_better_auth_identity.sql` (+ `.down.sql`); `auth_user` carries `role`/`companyId`/`status` as additionalFields

## 2. Better Auth module (behind the gateway)

- [x] 2.1 `createBetterAuth()` in `better-auth.ts`: `betterAuth({ database: drizzleAdapter(db, { provider: "pg", schema }), secret, baseURL, trustedOrigins })`; `loadBetterAuthConfig` fails closed on a weak secret
- [x] 2.2 `user` model mapped to `auth_user` (`modelName: "authUser"`) with `additionalFields` `role`/`companyId`/`status` surfaced on the session (D2)
- [x] 2.3 Custom `password.verify` = `bcrypt.compare` (legacy-hash parity); `hash` = bcrypt (D3) — proven in `better-auth.test.ts`
- [x] 2.4 DB-backed httpOnly/Secure/SameSite cookie sessions (D4); `advanced.defaultCookieAttributes` set, `Secure` in production
- [x] 2.5 Mounted at `/api/auth` in `server.ts` `buildModules()` behind `BETTER_AUTH_ENABLED`, mutually exclusive with the bespoke module (Better Auth wins); proven in `cutover.test.ts`
- [x] 2.6 Login rate-limiting kept on the sign-in route (D7) — `429` test in `better-auth.test.ts`

## 3. Password reset (email-otp + Graph)

- [x] 3.1 `email-otp` plugin enabled; `GraphEmailer` (`emailer.graph.ts`) mirrors legacy `emailService.js` (client-credentials token + `sendMail`); `ConsoleEmailer` kept for dev; real emailer wired in `server.ts` when Graph is configured
- [x] 3.2 Enumeration-safe forgot-password (generic response) + OTP length/expiry preserved — tested
- [x] 3.3 `emailer.graph.test.ts`: token fetch + `sendMail` (202), token cache, token-failure and non-202 error paths (5 tests, mocked fetch)

## 4. Credential backfill

- [x] 4.1 `backfill.ts` — `backfillBetterAuthIdentities(db)`: idempotent (`onConflictDoNothing`), reversible (down migration); one `credential` `account` row per user carrying `password_hash`
- [x] 4.2 `better-auth.test.ts` seeds a real legacy bcrypt hash via the backfill and logs in with the original plaintext — no reset (parity)

## 5. Session parity & tenant boundary

- [x] 5.1 `requireBetterAuth` (`better-session.ts`) reads the session (cookie or bearer) and resolves the same `SessionUser` (`id`/`role`/`company_id`/`company_ids`) (D6)
- [x] 5.2 `/me` returns the identical shape/status codes (200 authed / 401 not) — tested
- [x] 5.3 `canAccessCompany` unchanged; cross-tenant `company_ids` + boundary asserted in `better-auth.test.ts`
- [x] 5.4 Revocation test: logout → next `/me` is 401 and the `session` row is gone (audit **M1** closed)

## 6. Frontend cutover (apps/web)

- [x] 6.1 `apps/web/src/lib/api.js`: all fetches send `credentials: "include"` so the session cookie flows (Bearer kept for transitional legacy-proxy interop)
- [x] 6.2 `AuthContext.jsx`: session restore is cookie-first — `meRequest()` (credentials-included) validates the cookie even with no stored token
- [x] 6.3 Gateway credentialed-CORS for allow-listed origins (`corsOrigins` from `AUTH_TRUSTED_ORIGINS`); CSRF for the auth endpoints enforced by Better Auth's Origin check — `gateway.test.ts` CORS test
- [x] 6.4 Removed the `!token` early-return so a valid cookie restores the session across hard refresh; legacy expiry-window checks now gate on `token` presence only

## 7. Parity checklist & tests (vitest/supertest)

- [x] 7.1 Supertest parity in `better-auth.test.ts`: login, `/me` (200/401), wrong-password 401, forgot→reset→login, rate-limit 429, cross-tenant, **revocation**
- [x] 7.2 e2e login/(bearer+cookie)/logout against real Postgres (PGlite) via the cookie flow
- [x] 7.3 Coverage over the gate ([ADR-0005](../../../docs/adr/0005-testing-and-coverage-standard.md)): **92.5% stmts / 80% branch / 97% funcs** (63 tests)

## 8. Staged cutover (local-equivalent; no staging/prod env available)

- [x] 8.1 Flag OFF ⇒ `/api/auth` falls through to legacy — asserted in `cutover.test.ts` (rollback path)
- [x] 8.2 Flag ON ⇒ Better Auth serves `/api/auth` in-process, non-auth paths still proxy — asserted in `cutover.test.ts`; parity checklist runs against real DB + captured email
- [x] 8.3 Structured logging (pino-http) active on the router; error/status paths exercised by the suite
- [~] 8.4 Enable in production — **deferred**: requires a real prod environment (ops action). Mechanism proven locally; rollout is a flag flip.
- [x] 8.5 Rollback documented = `BETTER_AUTH_ENABLED=false` + restart (proven by the flag-off test)

## 9. Wrap up

- [x] 9.1 [ADR-0007](../../../docs/adr/0007-auth-library-vs-bespoke.md) flipped to **Accepted**; "implemented by → change `adopt-better-auth`"
- [x] 9.2 `auth` capability spec synced: session issuance now cookie/DB-backed + ADDED revocation + credential-migration requirements (`openspec/specs/auth/spec.md`)
- [x] 9.3 `docs/REARCH_LOG.md` updated; `auth-production-cutover` §6 re-pointed to retire legacy under this change
- [x] 9.4 `openspec validate adopt-better-auth --strict` passes (via `@fission-ai/openspec` 1.8.0); `validate --all --strict` green (10/10 changes + specs)
- [x] 9.5 Commit on `ba/rearch` with Conventional Commits

## Notes

- **Prerequisites that gated the flip (all met locally):** drizzle bump green (1.2), backfill parity proven (4.2), reset flow via emailer (3.x), revocation verified (5.4).
- The bespoke `AuthService`/JWT engine stays as the rollback target; its deletion is owned by `auth-production-cutover`.
- **Deviation from design D2:** Better Auth uses its own `auth_user` table (not the existing `users` table in place) — the proven, lower-risk shape from the spike. `auth_user.id` is preserved equal to `users.id` on backfill, so `user_companies`/`folders` still line up and `company_ids` resolves via the existing join. Business data is not moved.

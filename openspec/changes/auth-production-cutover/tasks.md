## 1. Schema reconciliation

- [ ] 1.1 Run `pnpm --filter @datahub/db db:pull` against staging (or a prod snapshot); diff against `packages/db/src/schema.ts`
- [ ] 1.2 Fix any drift in the auth-slice tables (users, companies, user_companies, email_verifications, folders); note any prod-only columns
- [ ] 1.3 Confirm `pnpm --filter @datahub/db typecheck` + a smoke query succeed against the real DB

## 2. Real emailer (Microsoft Graph)

- [ ] 2.1 Implement `GraphEmailer implements Emailer` in `apps/api/src/modules/auth/` (mirror legacy `emailService.js`: tenant/client/secret, sender)
- [ ] 2.2 Wire it in `server.ts` (`createAuthModule({ repo, emailer: new GraphEmailer(...) })`) when the module is enabled; keep `ConsoleEmailer` for dev
- [ ] 2.3 Test the adapter (unit with a mocked Graph client); verify forgot/reset still returns the generic 200

## 3. Production config & secrets

- [ ] 3.1 Set prod `JWT_SECRET` **equal to the legacy secret**; `DATABASE_URL`; `AUTH_LOGIN_RATE_WINDOW_MS`/`MAX`; Graph creds
- [ ] 3.2 Verify token cross-validation in staging: a legacy-issued token validates in the module and vice-versa
- [ ] 3.3 Confirm helmet + pino active on the module; legacy pass-through byte-identical for a non-auth route

## 4. Staging cutover

- [ ] 4.1 Deploy `apps/api` to staging with `AUTH_MODULE_ENABLED=false`; confirm 100% proxies to legacy unchanged
- [ ] 4.2 Flip `AUTH_MODULE_ENABLED=true` in staging
- [ ] 4.3 Run the parity checklist against real DB + real email: login, `/me` (200/401), wrong-password 401, forgot→**email received**→reset→login, rate-limit 429, cross-tenant denied
- [ ] 4.4 Watch pino logs + error rates for a soak period in staging

## 5. Production rollout

- [ ] 5.1 Enable `AUTH_MODULE_ENABLED=true` in production (canary instance first if topology allows)
- [ ] 5.2 Monitor: login-success rate, 401/429/5xx, reset-email delivery, latency — against pre-cutover baselines
- [ ] 5.3 Hold for the agreed green soak window; document that rollback = flag off + restart

## 6. Retire legacy auth

> **PAUSED (2026-08-11):** blocked pending the auth-engine decision in
> [ADR-0007](../../../docs/adr/0007-auth-library-vs-bespoke.md) — the CTO chose to adopt
> **Better Auth** (change `adopt-better-auth`). Do **not** delete legacy or the bespoke
> engine until Better Auth is the soaked production engine; legacy remains the rollback
> target. When Better Auth's soak is green, this section retires legacy under that change
> (`adopt-better-auth` task 9.3) instead of the bespoke module.

- [ ] 6.1 After a green soak, delete legacy `/api/auth` handlers: `backend/src/routes/auth.js`, `controllers/auth.js`, and the now-unused parts of `authService.js`/`otpService.js`
- [ ] 6.2 Remove the auth route from the legacy mount; confirm the gateway serves `/api/auth` entirely in-process
- [ ] 6.3 Separate, reversible commit; keep it revertable for one release

## 7. Rate-limit topology

- [ ] 7.1 Confirm `apps/api` instance count. If multi-instance: enable sticky sessions or add a shared store (e.g. Redis) so the login limit is global (audit H1 holds at scale)

## 8. Wrap up

- [ ] 8.1 `openspec validate auth-production-cutover --strict` passes
- [ ] 8.2 Update `docs/REARCH_LOG.md` (Phase 1 closed in prod); mark phase-1-auth tasks 7.2/7.3 done
- [ ] 8.3 Commit on `ba/rearch` with Conventional Commits

## Notes

- **Prerequisites that gate the flip:** schema reconciled (1.x), Graph emailer shipped (2.x), secret parity verified (3.2). Do not enable in prod without all three.
- Ties off phase-1-auth tasks 7.1 (prod parity), 7.2 (non-auth proxy), 7.3 (legacy removal).

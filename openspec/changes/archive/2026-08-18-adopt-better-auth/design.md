## Context

[ADR-0007](../../../docs/adr/0007-auth-library-vs-bespoke.md) selected Better Auth over
the bespoke module and Supabase Auth; the spike (`spikes/better-auth/SPIKE.md`, 8/8
green) proved bcrypt-login parity, httpOnly cookie + DB-backed sessions, and server-side
revocation on the Drizzle adapter over Postgres. This change productionizes that on
`ba/rearch`, behind the same gateway seam the bespoke module uses, so cutover/rollback
stays a config flag ([ADR-0003](../../../docs/adr/0003-parallel-rewrite-behind-gateway.md)).

## Goals / Non-Goals

**Goals:** serve `/api/auth` from Better Auth with parity for every existing behavior,
close M1/M2/M3, migrate existing bcrypt users without a reset, and keep identity in our
own Postgres. Instant rollback via flag.

**Non-Goals:** organizations plugin, social/magic-link, SSO/SAML, other domains, retiring
legacy handlers (owned by `auth-production-cutover`).

## Decisions

### D1 — Better Auth mounts behind the gateway, gated by `BETTER_AUTH_ENABLED`
A new `createBetterAuthModule()` returns an Express handler mounted at `/api/auth`, added
in `apps/api/src/server.ts` `buildModules()` exactly like the bespoke module. The two are
mutually exclusive (Better Auth wins if both flags are set) so we can flip between engines
by env alone. Rollback = `BETTER_AUTH_ENABLED=false` + restart.

### D2 — Map onto the existing `users` table, don't fork identity
Configure Better Auth's `user` model to the existing `users` table via `modelName` +
field mapping, with `additionalFields` for `role` / `companyId` / `status` / `phone`, so
all existing FKs (`user_companies`, `folders.created_by`, `companies` rep sync) stay
valid. Only `session` / `account` / `verification` are new tables. This is the key
divergence from the spike (which used stand-alone tables for speed) and keeps the
migration additive. Add the small columns Better Auth needs (e.g. `email_verified`).

### D3 — Credentials live in `account`; bcrypt hashes migrate verbatim
Backfill one `account` row per user (`providerId = "credential"`, `password =
users.password_hash`). A custom `emailAndPassword.password.verify` delegates to
`bcrypt.compare`, so legacy hashes authenticate unchanged; `hash` uses Better Auth's
default for new/changed passwords (optionally re-hash-on-login later). Migration is
idempotent (upsert by userId) and reversible (drop the new tables/columns).

### D4 — DB-backed cookie sessions (closes M1/M2/M3)
Sessions are httpOnly, `Secure`, `SameSite` cookies backed by the `session` table.
Revocation, force-logout, and "kill all sessions" are built in (M1); the SPA no longer
holds a token in `localStorage` (M2/M3). Add `session.cookieCache` (short-lived signed
cache) if per-request DB reads become a latency concern; a shared secondary store is only
needed if `apps/api` runs multi-instance (mirrors the bespoke rate-limit topology question).

### D5 — Reset flow via the `email-otp` plugin + Graph emailer
Replace the hand-rolled OTP service with Better Auth's `email-otp` plugin, wiring
`sendVerificationOTP` to a Microsoft Graph emailer (the same real-email prerequisite the
cutover called out). Preserve enumeration-safe behavior (generic response) and the
attempt/resend/expiry limits.

### D6 — Preserve `/me` shape and the tenant boundary
`requireAuth` reads the Better Auth session (cookie) instead of a `Bearer` token and still
resolves the same `SessionUser` (`id`, `role`, `company_id`, `company_ids`). Keep
`canAccessCompany` unchanged — multi-tenant isolation is out of scope to re-model here.

### D7 — Login rate-limiting stays
Keep `express-rate-limit` (or Better Auth's built-in rate limiter) on the sign-in route so
audit **H1** holds; same window/max envs.

## Risks / Trade-offs

- **`drizzle-orm` bump (`0.40.1 → ^0.45.2`)** touches every consumer of `packages/db` —
  gate on a green typecheck + test run across the workspace. (Spike ran on 0.40.1, but we
  adopt the supported range.)
- **SPA transport change** (Bearer→cookie) is the riskiest surface: CORS `credentials`,
  `SameSite`, and CSRF must be right. Cover with an e2e login/refresh/logout parity test.
- **Two auth engines transiently coexist** — bounded by the mutually-exclusive flag; delete
  the bespoke engine only after a green soak (in `auth-production-cutover`).
- **Reset-email delivery** must be proven in staging before prod (same as the cutover).

## Migration Plan

1. Add deps + bump drizzle; generate the Better Auth Drizzle schema; write the additive
   migration (new tables + `users` columns).
2. Build the Better Auth module (D1–D7) with tests against a real Postgres (parity checklist).
3. Backfill `account` rows from `users.password_hash` (idempotent, reversible).
4. Cut the SPA to cookie sessions; enable CORS credentials + CSRF.
5. Flip `BETTER_AUTH_ENABLED` in staging → parity checklist + real-email reset + revocation
   → production. **Rollback:** flag off + restart.
6. After a green soak, `auth-production-cutover` retires the legacy handlers and the bespoke
   engine; flip ADR-0007 to **Accepted** and sync the `auth` spec.

## Open Questions

- `apps/api` instance count → whether the session store needs a shared secondary store
  (same topology question as the bespoke rate-limit; resolve with ops).
- Cookie `SameSite`/domain given the SPA/gateway origins (drives the CSRF + CORS config).

## Why

The bespoke auth module fixed the *critical* audit findings but left three gaps
deliberately deferred (`auth-production-cutover` Non-goals): no token
**revocation/refresh (M1)**, and a JWT held in the SPA's `localStorage` with CORS
hardening unaddressed (**M2/M3**). Those are exactly the gaps a mature auth library
closes for free. Per [ADR-0007](../../../docs/adr/0007-auth-library-vs-bespoke.md) —
backed by a green spike (`spikes/better-auth/`, 8/8) — we adopt **Better Auth**
(self-hosted, MIT, TypeScript-native) as the auth engine, keeping identity in our own
Postgres via the Drizzle adapter and mounting it behind the existing gateway seam.

Supabase Auth was rejected as the direction: we use Supabase only as a hosted
Postgres (service-role key, **0 RLS policies**), so its Auth↔RLS synergy buys us
nothing, and adopting it would deepen the coupling [ADR-0002](../../../docs/adr/0002-drizzle-data-layer.md)
is unwinding. See ADR-0007 for the full comparison.

**Track:** `auth` (reference domain — replaces the bespoke engine before Phase 2 copies
the pattern). Behavior changes (session transport + revocation), so this ships **spec
deltas** for the `auth` capability, not `skip_specs`.

## What Changes

- **Adopt Better Auth in `apps/api`** with `@better-auth/drizzle-adapter` over
  `packages/db`; bump `drizzle-orm` to the supported `^0.45.2`.
- **Map Better Auth onto the existing `users` table** (custom model/field mapping) so
  business rows and FKs stay put; add only the `session` / `account` / `verification`
  tables + a Drizzle migration.
- **Backfill credentials:** one `account` row per user carrying the existing bcrypt
  `password_hash`; a custom `password.verify` authenticates legacy hashes verbatim (no
  forced resets). Idempotent, reversible.
- **DB-backed cookie sessions** replace the stateless `Bearer` JWT: httpOnly secure
  cookie + a `session` row → instant **revocation / force-logout (M1)** and no
  `localStorage` token (**M2/M3**).
- **Preserve behavior at parity:** login, `/me`, wrong-password 401, enumeration-safe
  forgot/reset (via the `email-otp` plugin + the Graph emailer), login rate-limiting,
  and the `canAccessCompany` multi-tenant boundary.
- **SPA cutover:** api client sends `credentials: "include"` and stops reading the token
  from `localStorage`; gateway CORS allows credentials + CSRF handling.
- **Gateway flag** (`BETTER_AUTH_ENABLED`) mounts it at `/api/auth`; rollback is flag-off.

## Impact

- **New deps:** `better-auth`, `@better-auth/drizzle-adapter`; `drizzle-orm` bump in
  `packages/db` (re-run typecheck + tests).
- **New code:** Better Auth module + config + email-otp adapter in
  `apps/api/src/modules/auth/`; a `users→account` backfill migration; SPA auth-client +
  `AuthContext`/`api.js` changes in `apps/web`.
- **Schema:** additive — new `session`/`account`/`verification` tables; `users` gains a
  couple of Better Auth columns (e.g. `email_verified`). No business data moved.
- **Supersedes:** the bespoke `AuthService`/JWT engine (kept as rollback target until the
  soak is green, same as the cutover).
- **Branch:** `ba/rearch`; `main` frozen.

## Non-goals

- **Organizations plugin** for multi-tenant modeling — later; this change preserves the
  existing `canAccessCompany` boundary as-is.
- **Social login / magic links.**
- **SSO / SAML / OIDC** — a follow-up when an enterprise customer requires it (Better
  Auth plugin; no re-platforming needed).
- Migrating any other domain (companies/users/folders remain Phase 2).
- Retiring the legacy `/api/auth` handlers — that stays owned by `auth-production-cutover`
  (now paused at its retire-legacy step pending this change).

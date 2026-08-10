## Why

With the Phase 0 gateway in place ([archived change](../archive/2026-08-10-phase-0-harness/), [ADR-0003](../../../docs/adr/0003-parallel-rewrite-behind-gateway.md)), we can now move the first real domain onto the new stack. **Auth is chosen as the reference domain**: it is high-value (the audit's account-takeover findings live here), self-contained, and every later domain will copy its shape. Rebuilding it end-to-end proves the whole pattern — zod contract + Drizzle repository + typed service + router + tests, fronted by the gateway with per-route rollback — while also hardening the one still-open critical-path gap (no login rate-limit, audit **H1**).

**Cutover-order domain:** `auth` (the reference step, right after `config`/`contracts`/`db`), per `docs/MODERNIZATION_PLAN.md` §5.

## What Changes

- **`packages/contracts` (new).** zod schemas + inferred TS types for the auth surface — login, forgot-password, reset-password, OTP send/verify, current-session (`/me`) — imported by both the API and (later) the SPA. First member of the shared contract package.
- **`packages/db` (new).** Drizzle client + schema introspected (`drizzle-kit pull`) for the **auth-relevant tables only** (users, OTP/email-verification, and the company/user-company links used by the post-login client company-sync). Drizzle owns new migrations; the legacy 76-migration set is frozen ([ADR-0002](../../../docs/adr/0002-drizzle-data-layer.md)).
- **`apps/api/modules/auth` (new).** router + service + repository + contract + tests. Ports the security fixes already made in legacy JS into a typed module: mandatory `JWT_SECRET` (fail-closed at boot), bcrypt-only verification (no static password), enumeration-safe forgot/reset, OTP verify. **Adds** login rate-limiting (`express-rate-limit`, **H1**). Behavior parity: JWT HS256 tokens, and the post-login client company-sync + `ensureDefaultFolders` side effects.
- **New-API security middleware.** `helmet` (security headers) and `pino`/`pino-http` (structured logging) enabled on `apps/api`.
- **Gateway cutover.** Flip the `/api/auth` route-group to the in-process auth module; everything else stays legacy. Reverting the one routing entry is instant rollback. Legacy auth is retired only after the flip is verified.
- **BREAKING (internal, not user-facing):** the legacy `/api/auth/*` handlers are superseded by the new module at cutover. The HTTP contract is unchanged, so the SPA is unaffected.

## Capabilities

### New Capabilities
- `auth`: the authentication surface as observable behavior — credential login (bcrypt), JWT issuance/verification, login rate-limiting, enumeration-safe password reset, OTP verification, current-session lookup, and multi-tenant access parity. This is the first capture of auth as a spec (legacy had no spec); it encodes parity-plus-H1, not a behavior change users can see.

### Modified Capabilities
<!-- None. api-gateway already specifies per-route-group cutover; flipping /api/auth exercises that existing behavior rather than changing it. -->

## Impact

- **New code:** `packages/contracts/*`, `packages/db/*` (Drizzle schema + client + first migration baseline), `apps/api/src/modules/auth/*`, `apps/api` middleware (helmet, pino), and the gateway routing entry for `/api/auth`.
- **Dependencies added:** `drizzle-orm` + `drizzle-kit`, `zod`, `express-rate-limit`, `helmet`, `pino` + `pino-http`, `jsonwebtoken` + `bcryptjs` (or `bcrypt`) in the new module.
- **Data:** reads/writes the **same Postgres** as legacy via Drizzle (introspected) — no dual-write, no data migration.
- **Runtime behavior:** unchanged for end users (same `/api/auth` contract); the only observable delta is that repeated bad logins now return `429` (H1).
- **Branch impact:** all on `ba/rearch`; `main` frozen. Legacy auth source stays in place until the gateway flip is verified, then is retired.
- **Apply-time prerequisite:** Drizzle introspection needs a reachable `DATABASE_URL` (staging/dev). If none is available at apply time, the auth-slice schema is hand-authored from `backend/sql/schema.sql` and reconciled against the live DB later. (Recorded as an assumption; see design.md.)

## Non-goals

- **JWT refresh / rotation / server-side revocation (audit M1)** — deferred to a later auth-hardening change; this change keeps the existing 7-day HS256 token model at parity.
- **Migrating any other domain** (companies, users, folders, uploads, reports, quickbooks) — later phases.
- **Full DB introspection** beyond the auth-relevant tables.
- **Any frontend TypeScript / shadcn change** — the SPA keeps calling the same `/api/auth` contract; UI work is a separate program ([ADR-0006](../../../docs/adr/0006-shadcn-design-system.md)).
- **CORS/token-storage hardening (M2/M3)** — tracked separately.

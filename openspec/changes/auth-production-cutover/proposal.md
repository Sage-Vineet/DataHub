## Why

The TypeScript auth module (`phase-1-auth`) is built, tested, and **locally** soaked 9/9 — but it is not serving any real traffic yet (`AUTH_MODULE_ENABLED` defaults off). This change finishes Phase 1: roll the module out through the gateway in a real environment, prove parity against production data + email, then retire the legacy `/api/auth` handlers. Only after this do the security fixes (H1 login rate-limit, bcrypt-only, fail-closed secret) and the new typed pattern actually protect users.

**Track:** `auth` (closing the reference domain). No new product behavior — this is rollout, so `skip_specs` (the `auth` capability spec already exists at `openspec/specs/auth/spec.md`).

## What Changes

- **Reconcile `packages/db`** with the real database via `drizzle-kit pull` (the auth-slice schema was hand-authored offline; confirm it matches prod before serving).
- **Ship a real emailer.** Implement the `Emailer` port with a Microsoft Graph adapter (legacy sends via Graph) so forgot/reset codes actually deliver in prod — the current `ConsoleEmailer` is a dev stub.
- **Production config.** `apps/api` gateway deployed with `LEGACY_ORIGIN`, the **same `JWT_SECRET` as legacy** (token cross-validity → zero-downtime flip), `DATABASE_URL`, and rate-limit env.
- **Staged cutover.** Enable `AUTH_MODULE_ENABLED` in staging → parity checklist → monitor → enable in production. Non-auth routes keep proxying to legacy unchanged.
- **Retire legacy auth.** After a green soak, delete the legacy `/api/auth` routes/controllers/services (separate, reversible commit).
- **BREAKING (internal only):** legacy `/api/auth/*` handlers are removed at the end; the HTTP contract is unchanged, so the SPA is unaffected.

## Impact

- **Deploy/config:** where `apps/api` runs and points (`LEGACY_ORIGIN`), prod secrets (`JWT_SECRET`, `DATABASE_URL`, Graph creds), rate-limit window/max. The gateway becomes the front door for `/api/auth`.
- **New code:** a Graph `Emailer` adapter + tests in `apps/api/src/modules/auth/`.
- **Data:** none migrated — reads/writes the same Postgres via Drizzle.
- **Removed at the end:** legacy auth handlers under `backend/src/{routes,controllers,services}`.
- **Branch:** `ba/rearch`; `main` frozen.

## Non-goals

- Migrating any other domain (that's Phase 2 — `companies`/`users`/`folders`).
- JWT refresh/rotation/revocation (audit M1) — a later hardening change.
- CORS/token-storage hardening (M2/M3).
- Standing up a shared rate-limit store unless the API runs multi-instance (see design).

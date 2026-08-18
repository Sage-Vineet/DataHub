## Why

`users` is the second Phase 2 domain (after `companies`). It carries the richest access logic in the app — role/sub-role gating, effective-role computation, multi-company membership, broker-team management, and a delete-with-reassignment invariant. Migrating it onto the module pattern consolidates those rules in one typed, tested place and removes the Supabase-vs-`pg` dual path plus the migration/fallback shims that grew around it.

**Cutover-order domain:** `users` (per `docs/MODERNIZATION_PLAN.md` §5, after companies).

## What Changes

- **`packages/contracts`** — zod schemas for user create/update, list query, add/remove companies, and broker-team invite; response shape (with `effective_role`, `assigned_companies`, sub-role fields).
- **`packages/db`** — extend `users` to the full column set (`sub_role`, `designation`, `buyer_company_name`, `parent_user_id`, profile fields) and model `broker_team_invites`.
- **`apps/api/src/modules/users`** — router + service + repository (Drizzle + in-memory) + contract + tests. Ports the 10 endpoints and their rules.
- **Cross-domain effects via ports** — welcome email + in-app notification on create (non-fatal); auth-cache invalidation on update; record **reassignment** on delete (updates `created_by`/`uploaded_by` across folders/requests/documents/activity/reminders). All modeled as injected ports.
- **Gateway cutover** — flip `/api/users` behind `USERS_MODULE_ENABLED`; instant rollback.

## Capabilities

### New Capabilities
- `users`: user management as observable behavior — tenant-scoped visibility, role/sub-role-gated create/update, effective-role computation, multi-company membership, broker-team invites, and delete-with-reassignment (with the "no delete without a replacement owner" invariant).

## Impact

- **New code:** `packages/contracts` (user schemas), `packages/db` (fuller users + `broker_team_invites`), `apps/api/src/modules/users/*`, ports + adapters (email, notification, auth-cache, reassignment), gateway routing entry.
- **Data:** same Postgres via Drizzle — no migration.
- **Runtime behavior:** unchanged (same `/api/users` contract); internal change is dual-path + fallback removal.
- **Branch:** `ba/rearch`; `main` frozen. Legacy `users` handlers retired after a green soak.

## Non-goals

- **`companies` and `folders`** — separate changes; touched here only through ports (reassignment/provisioning).
- **JWT/session model changes** (M1) — out of scope.
- **Removing the historical-company-inference shim entirely** — ported for parity; simplification is a follow-up once `user_companies` is fully authoritative.
- No frontend changes (see `frontend-ui-adoption`).

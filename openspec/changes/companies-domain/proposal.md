## Why

`companies` is the first Phase 2 domain and the backbone of the product — users, folders, requests, reports and QuickBooks all reference a company. Migrating it onto the module pattern (behind the gateway, following the `auth` reference) unblocks everything downstream and lets us drop the Supabase-vs-`pg` dual path for this domain. It's a good first Phase 2 target: real business rules, but lower risk than the reporting engine.

**Cutover-order domain:** `companies` (per `docs/MODERNIZATION_PLAN.md` §5, right after auth).

## What Changes

- **`packages/contracts`** — zod schemas for company create/update/list and the response shape (incl. stats).
- **`packages/db`** — extend the introspected schema to the full `companies` columns (`project_name`, `logo`, `contact_*`, `data_source_type`, `quickbooks_connected`, `manual_upload_active`, `profit_metric`, `last_source_switch_at`) and `user_companies` (already modeled).
- **`apps/api/src/modules/companies`** — router + service + repository (Drizzle + in-memory) + contract + tests. Ports the endpoints and rules: list-for-user, get-with-stats, create, update, delete-cascade.
- **Shared access guard** — promote `canAccessCompany` into a shared helper used by all domain modules (it already exists in the auth module).
- **Cross-domain side effects via ports** — company creation/update triggers **client-representative sync** (a user concern) and **default-folder provisioning** (a folders concern). Model these as injected ports with legacy-backed adapters until the `users`/`folders` modules exist, then swap to their services.
- **Gateway cutover** — flip `/api/companies` to the module behind `COMPANIES_MODULE_ENABLED`; everything else stays legacy; instant rollback.

## Capabilities

### New Capabilities
- `companies`: managing companies as observable behavior — tenant-scoped list/get, create (with provisioning side effects), update (safe fields, rep re-sync), cascade delete, multi-tenant access enforcement, and profit-metric normalization.

## Impact

- **New code:** `packages/contracts` (company schemas), `packages/db` (fuller companies schema), `apps/api/src/modules/companies/*`, shared access helper, provisioning ports + legacy adapters, gateway routing entry.
- **Data:** same Postgres via Drizzle — no migration.
- **Runtime behavior:** unchanged for users (same `/api/companies` contract); the only internal change is the dual-path removal.
- **Branch:** `ba/rearch`; `main` frozen. Legacy `companies` handlers retired after a green soak.

## Non-goals

- **`users` and `folders`** — separate Phase 2 changes; here they're touched only through provisioning ports.
- **Requests/groups/reports** cascade *targets* are deleted, but those domains aren't migrated here.
- No JWT/auth changes; no frontend changes (see `frontend-ui-adoption`).

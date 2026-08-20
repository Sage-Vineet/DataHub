## Why

Three surfaces — data room versioning, Q&A, and the CIM builder — are being built against a
**Monday 24 Aug 2026 booth demo** where strangers use the product unsupervised on iPads. Each of
those changes needs the same four things underneath it, and none of the four exists today. Built
once here, they are cheap; discovered separately inside three feature changes, they are three
times the work and arrive too late to help.

**1. There is no way to apply a migration.** `packages/db` has no `db:migrate` script. Migrations
are applied by five hand-written `psql < file` steps in `tools/demo/up.sh:70-90`, whose own header
documents that "standing up a database from this repo takes a bespoke script" and calls that
sequence "itself the finding". A dev checkout has no working bootstrap at all — that is
`devenv-schema-bootstrap`, open at 0/5. Three new table groups cannot land on that.

**2. A backend kill switch currently produces a *broken* UI, not a smaller one.** The team was
promised that unfinished features could be disabled 48 hours before the event. The flag mechanism
exists (`MODULE_FLAGS`, `apps/api/src/env.ts:26-41`) but the SPA has no awareness of it, and an
unmatched path does **not** 404 — it falls through the catch-all proxy in `apps/api/src/gateway.ts`
to the legacy backend and returns something unexpected. So flipping a flag off leaves the nav item
in place, the fetch resolving to garbage, and a permanent spinner in front of a prospect. That is
the "underwhelming" outcome the demo is explicitly meant to avoid, arriving through the very
mechanism intended to prevent it.

**3. The SPA leaks one visitor's data to the next on a shared device.**
`apps/web/src/store/fileExplorerStore.js:586-595` persists to localStorage under a single global
key, `leo-file-explorer`, with no user or company scoping — and what it persists includes `tree`
and `folderAccess`, the latter being what drives the client-side permission gate. On a booth iPad,
the second visitor sees the first visitor's folder tree and access grants.

**4. The demo has no data and no way back to a clean state.** `tools/demo/seed.sql` is 63 lines:
three personas, three companies, zero documents. A demo that works perfectly and shows empty
folders is the most common way a technically-correct build underwhelms. And unsupervised visitors
generate mess that someone must be able to clear in seconds, without a terminal.

**Cutover-order domain:** `config/contracts/db` (per `docs/MODERNIZATION_PLAN.md` §5), plus
`platform/api-gateway`. No domain route-group is cut over by this change.

## What Changes

- **A real migration runner** — `tools/db/migrate.mjs`, exposed as
  `pnpm --filter @datahub/db db:migrate` and `just db-migrate`. Applies
  `packages/db/migrations/*.sql` in `NNNN` order inside transactions, records each in
  `schema_migrations` with a sha256, and **refuses to run when a recorded checksum no longer
  matches** so an edited migration is loud rather than silent. `--to` / `--down` drive the existing
  `.down.sql` siblings. `tools/demo/up.sh`'s hand-listed steps 2, 3 and the `0002` line of step 5
  collapse into one call.
- **A feature payload on `/healthz`** — the existing gateway handler
  (`apps/api/src/gateway.ts:94-96`) grows a `features` object reporting the live module-flag set.
  It lives on the gateway app rather than a module router, so `route-contract.test.ts` never sees
  it and no new route surface is claimed.
- **`FeatureContext` in the SPA** — fetches `/healthz` once at boot and exposes `useFeature()`.
  Every flag is **`false` until the fetch resolves and `false` on error**, so a feature is off
  unless the server says otherwise. Off features are **not rendered** — not disabled, not greyed.
- **Per-user persistence scoping** — the zustand `persist` key becomes user-scoped and is cleared
  on logout.
- **A rich demo seed and a reset path** — `tools/demo/seed-dataroom.sql`, `seed-qa.sql`,
  `seed-cim.mjs`, and `tools/demo/reset.sh` returning a seeded state in under 30s with no container
  restart.
- **A T-48h freeze checklist** — `docs/DEMO_FREEZE_CHECKLIST.md`, making the promise checkable.

## Capabilities

### New Capabilities
- `platform/schema-migrations`: an ordered, checksum-verified, idempotent migration-apply path with
  a recorded history and a down path.
- `platform/feature-degradation`: server-declared feature availability that the client honors by
  omission rather than by error.

### Modified Capabilities
- `platform/api-gateway`: `/healthz` gains the feature payload.

## Impact

- **New code:** `tools/db/migrate.mjs`, `tools/demo/reset.sh`, `tools/demo/seed-*.sql`,
  `apps/web/src/context/FeatureContext.jsx`, `docs/DEMO_FREEZE_CHECKLIST.md`.
- **Changed:** `packages/db/package.json` (the missing `db:migrate`), `justfile`,
  `tools/demo/up.sh`, `apps/api/src/gateway.ts`, `apps/api/src/env.ts`,
  `docker-compose.demo.yml`, `apps/web/src/store/fileExplorerStore.js`.
- **Data:** one new table, `schema_migrations`. No existing table is altered.
- **Legacy impact:** none. No legacy handler is touched and no route-group is flipped. The gateway
  change is additive to a health endpoint legacy does not serve.
- **Closes:** `devenv-schema-bootstrap` (0/5) as a side effect — a dev checkout gains a working
  bootstrap for the first time.

## Non-goals

- **A general-purpose feature-flag service.** `useFeature()` reads a static payload fetched once at
  boot. No runtime toggling, no per-user targeting, no percentage rollout. Changing a flag means
  restarting the API, which is exactly the operation the T-48h freeze performs.
- **Replacing `backend/sql/schema.sql` as the legacy bootstrap.** The runner owns
  `packages/db/migrations/` only. The legacy schema load stays a separate, tolerant step — it still
  contains the known-bad statement at line 278, and fixing that is `Phase C`, not this change.
- **Feeding migration files into PGlite integration tests.** Those hand-write their DDL per file
  (`apps/api/src/modules/uploads/uploads.integration.test.ts:12-43`) and must continue to;
  `0001_module_schema.sql` presupposes tables from the legacy schema and would fail. New tests copy
  the hand-written-DDL pattern.
- **Production migration deployment.** This is a dev and demo path. Production schema management is
  `docs/PHASE_C_PLAN.md`.
- **Fixing the schema drift** between `backend/sql/` and Drizzle (`document_status` enum,
  `document_activity` columns, missing `uploads.storage_path` / `file_references`). Named in
  `packages/db/src/drift.ts` as backlog drift; untouched here.

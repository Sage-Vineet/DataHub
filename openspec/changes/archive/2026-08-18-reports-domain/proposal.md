## Why

`reports` is the largest and riskiest legacy area — the 9,088-line `manualGlMultiYearService`
GL engine plus the Key Reports surface (versions, mappings, sync, chart-of-accounts). It is the
program's headline decomposition target. Rather than a big-bang rewrite, this change migrates the
**Key Report *version* lifecycle** — the backbone entity every report datum hangs off — onto the
module pattern, and draws a clean seam: the heavy GL computation/sync stays on legacy behind a port
until it is decomposed incrementally.

**Cutover-order domain:** `reports` (per `docs/MODERNIZATION_PLAN.md` §5). **This change is the
first slice**, not the whole domain.

## What Changes

- **`packages/contracts`** — zod schemas for key-report version create/update + the version response.
- **`packages/db`** — model `key_report_versions` (incl. the one-active-per-company invariant).
- **`apps/api/src/modules/reports`** — router + service + repository (Drizzle + in-memory) + contract
  + tests. Ports the version lifecycle: list, create (auto-numbered), get, update, duplicate,
  **activate** (the single-official-version invariant, transactional), delete.
- **`ReportSyncPort`** — the seam for the GL sync/computation. This change ships a **not-yet-migrated
  stub**; the sync/mappings/chart-of-accounts/extracted-data routes stay on legacy (fall-through).
- **Gateway cutover** — flip only the version-lifecycle routes behind `REPORTS_MODULE_ENABLED`; every
  other key-reports route falls through to legacy.

## Capabilities

### New Capabilities
- `reports`: key-report version lifecycle as observable behavior — tenant-scoped list, auto-numbered
  create, get, update, duplicate, activate (exactly one official version per company), and delete.

## Impact

- **New code:** `packages/contracts` (version schemas), `packages/db` (`key_report_versions`),
  `apps/api/src/modules/reports/*`, `ReportSyncPort`, gateway routing entry.
- **Data:** same Postgres via Drizzle — no migration.
- **Runtime behavior:** unchanged version contract; only the version-lifecycle routes move.
- **Branch:** `ba/rearch`; `main` frozen. Legacy version handlers retired after a green soak.

## Non-goals

- **The GL multi-year computation engine** (`manualGlMultiYearService`) and **sync**,
  **chart-of-accounts**, **mappings**, **extracted-data** — these stay on legacy behind `ReportSyncPort`
  and are decomposed in later slices. This is the explicit, staged boundary.
- **QuickBooks / extraction** — later domains.
- No frontend changes.

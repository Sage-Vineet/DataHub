## Context

See `proposal.md`. The legacy Key Reports area is huge: `key_report_versions` is the backbone entity;
around it sit mappings, sync, chart-of-accounts, extracted-data, and the 9,088-line
`manualGlMultiYearService`. A big-bang rewrite is unshippable. This change migrates the **version
lifecycle** and draws a port seam so the compute engine decomposes later.

## Goals / Non-Goals

**Goals:** parity for the key-report version lifecycle incl. the one-active-per-company invariant; a
clean `ReportSyncPort` seam; tenant scoping.

**Non-Goals:** the GL computation engine, sync, chart-of-accounts, mappings, extracted-data (all stay
on legacy behind the port for now).

## Decisions

### D1 — Blueprint + shared guard
`modules/reports/` follows the blueprint and uses `requireSession` + `canAccessCompany`. Versions carry
`company_id`; list/create scope on the company, get/update/etc. guard against `version.company_id`.

### D2 — Migrate only the version lifecycle; everything else falls through
The router defines only the version-lifecycle routes. The gateway mounts it under `/api`, so
sync/mappings/chart-of-accounts/extracted-data routes (not defined here) fall through to legacy. This
is the incremental decomposition boundary.

### D3 — The single-official-version invariant is transactional
Exactly one `is_active` version per company (a partial unique index backs it). `activate(versionId)`
runs in a transaction: clear `is_active` for the company's versions, then set it on the target.

### D4 — Auto-numbered create; duplicate copies metadata
Create assigns `version_number = max(company) + 1`, `status = draft`, `is_active = false`. Duplicate
copies name/metadata into a new draft version (never active).

### D5 — `ReportSyncPort` is a stub for now
`ReportSyncPort.sync(versionId)` throws a clear "handled by the legacy engine" error (501). The seam
exists so a decomposed GL engine implements it later without touching callers.

## Risks / Trade-offs

- **Compute stays on legacy** → intentional; the port makes the boundary explicit and the version
  lifecycle is independently useful/testable now.
- **Active-version race** → the partial unique index + transactional activate is the guarantee; test
  that activating a second version deactivates the first.

## Migration Plan

1. Contracts + `packages/db` (`key_report_versions` + partial-unique active index); reconcile via `db:pull`.
2. Repository (Drizzle + in-memory): list/create(auto-number)/get/update/duplicate/activate(tx)/delete.
3. Service (tenant guard + invariant) + `ReportSyncPort` stub + router; tests ≥90%.
4. Mount behind `REPORTS_MODULE_ENABLED`; soak; retire legacy version handlers (sync stays on legacy).
- **Rollback:** flag off → legacy serves the routes.

## Open Questions

- The order in which the GL compute engine is decomposed behind `ReportSyncPort` — a separate program
  of later slices.

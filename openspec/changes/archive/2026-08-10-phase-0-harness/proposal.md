## Why

The DataHub re-architecture (see `docs/MODERNIZATION_PLAN.md`) can only proceed safely if there is a structural seam that lets new TypeScript modules run **alongside** the untouched legacy backend, with per-route reversibility and a CI gate enforcing quality from commit one. Phase 0 builds that seam and ships **nothing user-facing**: it converts the repo into a pnpm + Turborepo monorepo, adds an Express gateway that transparently proxies 100% of traffic to the legacy backend, and stands up the CI pipeline (typecheck + lint + test + coverage + audit) that every later phase depends on. Without this, every subsequent domain rewrite would be a risky big-bang.

This is the **`config`/harness** step at the head of the locked cutover order (`config/contracts/db → auth → …`). It belongs to no product domain — it is pure platform enablement.

## What Changes

- **Monorepo topology.** Introduce `pnpm-workspace.yaml` + `turbo.json` at the repo root. Establish `apps/`, `packages/` layout.
- **`packages/config`.** Shared, versioned toolchain config: `tsconfig.base.json` (strict), a flat ESLint config, and Prettier — consumed by every workspace. This is the mechanism that enforces the **100% TypeScript** and lint standards program-wide.
- **`apps/api` gateway (TypeScript).** A thin Express reverse proxy driven by an **env-configured routing table**. Default routing: **every path → legacy backend**. Individual route-groups are flipped to new modules later by editing that table (one-line, reversible rollback per domain). Includes a `/healthz` endpoint. No business logic.
- **`apps/web`.** **BREAKING (build/deploy paths only):** physically relocate the existing React/Vite SPA into `apps/web` and wire it into the workspace. Application behavior is unchanged; import roots, the Vite root, and the Vercel project root move.
- **`legacy/` (or retained path) integration.** The current backend keeps running unchanged, now started/proxied through the workspace; it is retired domain-by-domain in later phases, not here.
- **CI pipeline.** A GitHub Actions workflow running `turbo` typecheck + lint + test + **coverage gate** + dependency audit on every PR into `ba/rearch`; failing any gate blocks merge. The coverage threshold is wired now (enforced per-package as code lands) toward the program target of **90% coverage** on new/migrated code.
- **Vitest baseline.** Root test runner + coverage reporter configured so `packages/*` and `apps/*` can add tests immediately (turns the current backend `lint`/`test` no-ops into real gates for the new tree).

## Capabilities

### New Capabilities
- `platform/api-gateway`: the reverse-proxy seam that fronts all HTTP traffic — env-driven routing table, default-all-to-legacy, transparent pass-through of method/path/query/headers/body/status/streaming, health check, and per-route-group cutover switching. This is the one genuinely behavioral surface Phase 0 introduces; the monorepo/CI/relocation work is tooling captured under **Impact**.

### Modified Capabilities
<!-- None. No existing product behavior changes; legacy endpoints are proxied byte-for-byte. -->

## Impact

- **Tooling / build (not runtime behavior):** new root `pnpm-workspace.yaml`, `turbo.json`, `packages/config/*`, `.github/workflows/ci.yml`, root `vitest`/coverage config. Existing `package.json`s are split/relocated into workspaces.
- **Deploy:** Vercel (frontend) root path changes to `apps/web`; the API host must run/point at `apps/api` (which forwards to legacy). Deploy config update required at cutover of this change — the only externally visible operational change.
- **Runtime behavior:** **none** for end users — the gateway forwards 100% to legacy; the SPA is byte-for-byte the same app at a new path.
- **Branch impact:** all work lands on **`ba/rearch`**; `main` stays frozen at `e56ff1b`. No legacy source files are modified (only moved/wrapped).

## Non-goals

- No domain rewrites, no Drizzle/`packages/db` or `packages/contracts` work, no auth changes — those are Phase 1+.
- No `.js → .ts` conversion of legacy source, and no decomposition of the god-files (9,088-line GL service, CIM component) yet.
- No **shadcn/ui** component migration or visual refactor — the reusable shadcn design-system rebuild (matching the current look ~90%) is a later frontend change; Phase 0 only relocates the existing UI unchanged.
- No production data or schema migration.

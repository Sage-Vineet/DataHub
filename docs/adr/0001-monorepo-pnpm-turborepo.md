# ADR-0001 — Monorepo on pnpm workspaces + Turborepo

- **Status:** Accepted (2026-08-07)
- **Deciders:** CTO / platform
- **Implemented by:** commit `8a1fd22` (Phase 0 harness)

## Context

The repo shipped as two `package.json`s (frontend at root, backend under `backend/`) with backend-only dependencies (`express`, `pg`, `multer`, `jsonwebtoken`, …) bundled into the frontend build — an audit finding (dependency bleed) that bloated the build and widened the vulnerability surface. There was no shared type story between frontend and backend, and no way to share config or cache builds. The re-architecture needs new TypeScript packages (`contracts`, `db`, `config`) consumable by both an API and the SPA.

## Decision

Adopt a **pnpm workspaces + Turborepo** monorepo: `apps/{web,api}`, `packages/{config,contracts,db}`, with the legacy backend as a workspace member. pnpm is pinned via `packageManager` and Turborepo orchestrates `build`/`typecheck`/`lint`/`test`.

## Reasons

- **Shared types as first-class** — `packages/contracts`/`db` types are importable by both apps without publishing.
- **Cached, dependency-aware builds** — Turborepo skips unchanged packages; CI stays fast as the tree grows.
- **A clean extraction seam** — a workspace package is trivially liftable into its own service later (supports [ADR-0004](0004-modular-monolith.md)).
- **Kills the dependency bleed** — each app declares only what it uses; unused `sqlite`/`sqlite3` were dropped.
- **pnpm over npm/yarn** — content-addressed store (fast, disk-efficient) and strict, non-flat `node_modules` that surfaces phantom dependencies.

## Alternatives considered

- **npm workspaces + Nx** — rejected: Nx adds a heavier mental model than needed; pnpm's strictness is a feature here.
- **Two separate repos** — rejected: loses shared types and atomic cross-cutting changes, which the contracts-first approach depends on.

## Consequences

- One lockfile (`pnpm-lock.yaml`); the old npm `package-lock.json` was removed.
- The frontend moved to `apps/web`, changing the Vercel project root (a one-time deploy-config change).
- Contributors need `corepack`/pnpm; documented in the root README.

## References

- `pnpm-workspace.yaml`, `turbo.json`, `package.json`
- `docs/MODERNIZATION_PLAN.md` §2–3
- Audit: dependency-bleed / repo-hygiene findings

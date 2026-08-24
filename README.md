# DataHub

Multi-tenant M&A / accounting platform — a broker↔client portal with QuickBooks Online integration and AI-assisted financial-document extraction.

> **This branch (`ba/rearch`) is a modernization line.** It is being migrated to a TypeScript monorepo behind a gateway, one domain at a time, without disturbing `main`. If you want the "why", start with **[`docs/REARCH_LOG.md`](docs/REARCH_LOG.md)**.

## Layout (monorepo)

```
apps/
  web/          React 19 + Vite SPA (the relocated frontend)
  api/          TypeScript Express gateway — routes traffic to legacy or new modules
packages/
  config/       shared strict tsconfig, ESLint, Prettier, Vitest/coverage
backend/        legacy Express/Node API (proxied by apps/api; retired domain-by-domain)
docs/           MODERNIZATION_PLAN.md · REARCH_LOG.md · adr/
openspec/       spec-driven change proposals (proposal → specs → design → tasks)
```

The **gateway** (`apps/api`) fronts all backend traffic. Today its routing table is empty, so it forwards **100% to the legacy backend** — a transparent no-op. Domains are cut over (and rolled back) one route-group at a time. See [ADR-0003](docs/adr/0003-parallel-rewrite-behind-gateway.md).

## Prerequisites

- Node ≥ 20
- **pnpm** (pinned via `packageManager`; `corepack enable` will provide it, or `npm i -g pnpm@9`)

## Run locally (Nix — recommended)

A Nix flake + [devenv](https://devenv.sh) provide the whole toolchain (Node 22, pnpm 9.15.9) **and a local Postgres**, so nothing external is needed:

```bash
direnv allow                 # or: nix develop --impure   (or: devenv shell)
devenv up -d                 # start local Postgres (127.0.0.1:5433, db "datahub_dev")
load-schema                  # load backend/sql/schema.sql into the dev DB
introspect                   # pnpm --filter @datahub/db db:pull  (reconcile packages/db)
```

`DATABASE_URL`, a dev `JWT_SECRET`, and `PG*` are exported in the shell. To exercise the
TypeScript auth module end-to-end: `AUTH_MODULE_ENABLED=true pnpm dev:api`. Verify the flake
with `nix flake check`. Postgres defaults to **5433** (5432 is often taken); override in a
git-ignored `devenv.local.nix`.

## Run locally (without Nix)

```bash
pnpm install                 # installs the whole workspace

# env files (copy the examples):
#   apps/api/.env.example  -> apps/api/.env      (PORT, DATABASE_URL, secrets, capability flags)
#   apps/web/.env.example  -> apps/web/.env.local (VITE_API_BASE_URL -> the gateway)

pnpm dev:legacy              # start the legacy backend (default :4000)
pnpm dev:api                 # start the gateway       (default :8080 -> legacy)
pnpm dev:web                 # start the SPA (Vite)
# or run backend + gateway together:
pnpm dev:stack
```

The SPA talks to the **gateway** (:8080), which proxies to the legacy backend
(:4000). That ordering matters: the gateway is the cutover seam, so a module flag
only has an effect on traffic that actually passes through it. Module mount paths
mirror `backend/src/app.js` for the same reason — `apps/api/src/route-contract.test.ts`
fails the build if a module claims a path legacy does not serve.

## Quality gates (what CI enforces on `ba/rearch`)

```bash
pnpm typecheck               # strict TS across new packages
pnpm lint                    # ESLint (new packages strict; legacy web advisory)
pnpm test                    # Vitest + coverage gate (per package)
pnpm build                   # Turborepo build (incl. the SPA)
```

CI runs the same steps plus a dependency audit — see `.github/workflows/ci.yml` and [ADR-0005](docs/adr/0005-testing-and-coverage-standard.md).

## Documentation

- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — how to build here: quick start, the quality gate, the module blueprint + Definition of Done (keep it open while working)
- **[`docs/REARCH_LOG.md`](docs/REARCH_LOG.md)** — referenced, reasoned trail of the modernization work (start here)
- **[`docs/MODERNIZATION_PLAN.md`](docs/MODERNIZATION_PLAN.md)** — target architecture + phased roadmap
- **[`docs/adr/`](docs/adr/)** — one record per decision (context, decision, reasons, consequences)
- **`openspec/changes/`** — the spec for each change; the harness lives in `phase-0-harness/`
- `DataHub_Engineering_Audit.docx` — the audit that motivates all of the above

## Notes

- QuickBooks and Microsoft Graph credentials belong only in `backend/.env`.
- `supabase/schema.sql` mirrors the current tables (to be superseded by Drizzle migrations — [ADR-0002](docs/adr/0002-drizzle-data-layer.md)).

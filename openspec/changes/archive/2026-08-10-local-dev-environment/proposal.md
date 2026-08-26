## Why

The modernized stack now needs a **local Postgres** to be genuinely testable end-to-end: `packages/db` introspection (`drizzle-kit pull`) and the Phase 1 auth cutover soak both require a reachable `DATABASE_URL`, which is why those steps are currently blocked (phase-1-auth tasks 2.2/7.x). More broadly, onboarding is "install Node somehow, install pnpm somehow, find a database somewhere." A **Nix flake + devenv** makes the whole toolchain — Node, pnpm, Postgres — reproducible and one-command, on NixOS/Linux/macOS, with no external services. `nix`, `devenv`, and `direnv` are already installed; the repo has none of these files yet.

**Track:** dev-infrastructure (the enabler under `config`/`db` in the cutover order). Belongs to no product domain.

## What Changes

- **`flake.nix` (+ `flake.lock`).** A flake exposing a dev shell and a `nix flake check`-able output, wrapping devenv via its flake module so both `nix develop` and `devenv shell` work.
- **`devenv.nix` / `devenv.yaml`.** Node 22 + pnpm pinned to **9.15.9** (corepack); a local **PostgreSQL** service (`services.postgres`) with a ready-to-use `DATABASE_URL`; supporting tools (`git`, `openssl`, `jq`).
- **Local env wiring.** Export `DATABASE_URL` (local pg), a dev `JWT_SECRET`, and the `AUTH_MODULE_ENABLED` toggle so the new auth module runs end-to-end locally. A documented one-liner to introspect the local DB (`drizzle-kit pull`) and reconcile `packages/db`.
- **`.envrc` (direnv).** Auto-loads the environment on `cd`; `devenv`-integrated.
- **Convenience scripts.** devenv `scripts`/`processes` for the common flows: `db up`, install, `dev:stack`, `test`, introspect.
- **Docs.** README "Run locally (Nix)" section + a `docs/REARCH_LOG.md` entry.

## Capabilities

<!-- None. This is tooling / dev-infrastructure with no product behavior change;
     `.openspec.yaml` sets `skip_specs: true`. No spec deltas. -->

## Impact

- **New files:** `flake.nix`, `flake.lock`, `devenv.nix`, `devenv.yaml`, `.envrc`; `.gitignore` additions for devenv/direnv state (`.devenv/`, `.direnv/`, local PG data). README + REARCH_LOG edits.
- **Unblocks:** phase-1-auth 2.2 (introspection) and 7.x (local cutover soak); future `packages/db` work.
- **No application code changes**; CI is untouched (GitHub Actions stays pnpm-on-ubuntu).
- **Branch:** `ba/rearch`; `main` frozen.

## Non-goals

- **CI runner changes** — GitHub Actions remains npm/pnpm-on-ubuntu; the flake is for local use.
- **Production / staging infrastructure**, Docker/containerization.
- **A NixOS system or home-manager module** — this is a project-local dev shell only.
- **Migrating the legacy backend's runtime** — the local DB simply gives it (and the new modules) a Postgres to talk to.

## Context

See `proposal.md` — Why. Target machine already has `nix 2.34`, `devenv`, and `direnv`. The monorepo pins `pnpm@9.15.9` and needs Node ≥ 20 and a Postgres for `packages/db`/auth. No Nix files exist yet.

## Goals / Non-Goals

**Goals:**
- `direnv allow` (or `devenv shell`) yields a shell with Node 22, pnpm 9.15.9, and a running/available local Postgres with `DATABASE_URL` set.
- `nix flake check` passes (so the flake is CI/other-dev verifiable even though app CI stays on ubuntu).
- Reproducible: same versions everywhere, no "works on my machine".

**Non-Goals (design-level):**
- Managing app processes/orchestration beyond a Postgres service + helper scripts (no supervisor for the full stack).
- Pinning transitive Nix inputs beyond what's needed for a stable dev shell.

## Decisions

### D1 — devenv, wrapped by a flake
Use **devenv** as the primary interface (clean `services.postgres`, `languages`, `scripts`) and expose it through **`flake.nix`** via the devenv flake module. This gives both `nix develop`/`direnv` users and `devenv shell` users one source of truth, and a `flake check`-able output. *Alternative:* a hand-rolled `flake.nix` `mkShell` + a separately-run Postgres — rejected: re-implements what devenv's `services.postgres` already does well (init, socket, per-project data dir).

### D2 — pnpm via corepack, Node from nixpkgs
Provide `nodejs_22` from nixpkgs and enable **corepack** so pnpm resolves to the repo-pinned `9.15.9` (matching `packageManager`) rather than a second, drifting pnpm. Keeps one pnpm version across local + CI.

### D3 — Postgres as a devenv service, local socket + TCP
`services.postgres.enable = true` with an `initialDatabases` entry (e.g. `datahub_dev`) and a listen on `127.0.0.1:5432`. Export `DATABASE_URL=postgres://…@127.0.0.1:5432/datahub_dev?sslmode=disable`. `sslmode=disable` is correct for a local socket and avoids the H2 rejectUnauthorized anti-pattern (the client honors the URL's sslmode — ADR-0002/D of phase-1-auth). Data lives under a git-ignored `.devenv/state`.

### D4 — env wiring for the auth module
The dev shell exports `DATABASE_URL`, a throwaway `JWT_SECRET` (clearly dev-only), and leaves `AUTH_MODULE_ENABLED` unset by default (developer opts in per session). This is exactly what phase-1-auth needs to (a) `drizzle-kit pull` and (b) run the module behind the gateway locally.

### D5 — direnv auto-load, state git-ignored
`.envrc` uses `use devenv`. Add `.devenv*/`, `.direnv/`, and local PG state to `.gitignore`. `flake.lock` IS committed (reproducibility); devenv/direnv runtime state is not.

### D6 — helper scripts, not a new task runner
Expose devenv `scripts` that shell out to the existing pnpm/turbo commands (`db-up`, `introspect`, `stack`), so there's no second source of truth for how to build/test — they just wrap `pnpm …`.

## Risks / Trade-offs

- **First `nix develop`/`flake check` is slow (downloads)** → acceptable one-time cost; `flake.lock` pins inputs so it's cached thereafter.
- **Port 5432 already in use on a dev machine** → make the port configurable via an env var with a sane default; document the override.
- **devenv version drift** → pin the devenv/nixpkgs inputs in `flake.lock`; `flake check` guards regressions.
- **macOS vs NixOS differences** → devenv abstracts most; call out any macOS caveat (e.g. Postgres socket dir) in the README if it surfaces.

## Migration Plan

1. Add `flake.nix` + `devenv.{nix,yaml}` + `.envrc`; `.gitignore` state.
2. `direnv allow`; verify Node/pnpm versions and that Postgres comes up with `DATABASE_URL` set.
3. `pnpm install && pnpm test` inside the shell (parity with CI) and a local `drizzle-kit pull` against the dev DB.
4. `nix flake check` green; commit (incl. `flake.lock`).
- **Rollback:** delete the Nix files; nothing else depends on them (app code + CI unchanged).

## Open Questions

- Postgres major version (16 vs 17) — pick the devenv default unless a Supabase-parity version is needed; does not affect the interface. Resolve at implementation.

## 1. Flake + devenv scaffold

- [x] 1.1 `flake.nix` exposes the dev shell via the devenv flake module; `nix flake check` builds it
- [x] 1.2 `devenv.yaml` (inputs) + `devenv.nix` (shell definition)
- [x] 1.3 `.envrc` with `use flake . --impure`
- [x] 1.4 `.gitignore`: `.devenv*`, `.direnv/`, `devenv.local.nix`; `flake.lock` tracked

## 2. Toolchain

- [x] 2.1 `nodejs_22` + corepack (pnpm resolves to 9.15.9)
- [x] 2.2 Supporting tools: `git`, `openssl`, `jq`, `postgresql_16` (psql)
- [x] 2.3 Verified in-shell: node **v22.23.2**, pnpm **9.15.9**, psql **16.14**

## 3. Local Postgres

- [x] 3.1 `services.postgres` (postgresql_16), db `datahub_dev`, listen 127.0.0.1, port **5433** (5432 was in use)
- [x] 3.2 `DATABASE_URL=postgres://127.0.0.1:5433/datahub_dev?sslmode=disable` exported
- [x] 3.3 Verified: `devenv up -d --no-tui` (standalone CLI) starts Postgres; `pg_isready` ready in 1s; `select 1` → 1

## 4. Auth-module + db env wiring

- [x] 4.1 Dev-only `JWT_SECRET` exported; `AUTH_MODULE_ENABLED` unset (opt-in)
- [x] 4.2 Verified: `psql "$DATABASE_URL" -f backend/sql/schema.sql` loads; auth tables (users, companies, user_companies, email_verifications, folders) present
- [x] 4.3 `db:pull` introspection — **fixed and verified.** Root cause: drizzle-kit 0.30.6 imports `drizzle-orm/gel-core`, first exported in drizzle-orm 0.40.0; bumped `drizzle-orm ^0.38.3 → ^0.40.1` (packages/db + apps/api). `db:pull` now introspects the local DB (11 enums, 58 indexes, 80 FKs; auth-slice tables confirmed). packages/db keeps its curated auth-slice `src/schema.ts` (the full dump is validation-only, not committed).

## 5. Helper scripts

- [x] 5.1 devenv `scripts`: `db-up`, `load-schema`, `introspect`, `stack`
- [x] 5.2 Documented in the shell banner + README "Run locally (Nix)"

## 6. Verify parity & docs

- [x] 6.1 Inside the shell: `pnpm test` green — **49 tests, 7/7 packages** (typecheck/lint/build verified across the same workspace)
- [x] 6.2 Full gateway e2e with `AUTH_MODULE_ENABLED=true` against the dev DB — **done: 9/9 auth soak passed** (login/`/me`/401/forgot/429) against local Postgres; see phase-1-auth task 7.1
- [x] 6.3 `nix flake check` → "all checks passed!"
- [x] 6.4 README "Run locally (Nix)" section + `docs/REARCH_LOG.md` entry; `flake.lock` committed

## 7. Wrap up

- [x] 7.1 `openspec validate local-dev-environment --strict` passes
- [x] 7.2 No application code changed; `main` untouched; committed on `ba/rearch` with Conventional Commits

## Notes

- **Flake vs standalone devenv:** inside `nix develop` the `devenv` command is a reduced flake wrapper (`up` is foreground-TUI-only). For detached/headless Postgres control use the **standalone** devenv CLI at the repo root: `devenv up -d --no-tui` / `devenv processes down`. In a normal terminal, `devenv up` (foreground TUI) also works. Documented in `devenv.nix` + README.
- **4.3 & 6.2 resolved:** drizzle introspection fixed (orm → 0.40.1) and the full auth e2e soak passed 9/9 against local Postgres. The dev environment is fully verified end-to-end.
- First `nix develop` / `nix flake check` downloads inputs (one-time; pinned by `flake.lock`).

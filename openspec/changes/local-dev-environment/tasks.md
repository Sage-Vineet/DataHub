## 1. Flake + devenv scaffold

- [ ] 1.1 Add `flake.nix` exposing the dev shell via the devenv flake module (inputs: nixpkgs, devenv); ensure a `nix flake check`-able output
- [ ] 1.2 Add `devenv.yaml` (inputs) and `devenv.nix` (the shell definition)
- [ ] 1.3 Add `.envrc` with `use devenv`; document `direnv allow`
- [ ] 1.4 `.gitignore`: add `.devenv*/`, `.direnv/`, and local Postgres state; keep `flake.lock` tracked

## 2. Toolchain

- [ ] 2.1 Provide `nodejs_22`; enable corepack so pnpm resolves to `9.15.9` (matches `packageManager`)
- [ ] 2.2 Add supporting tools: `git`, `openssl`, `jq`
- [ ] 2.3 Verify in-shell versions: `node -v` (22.x), `pnpm -v` (9.15.9)

## 3. Local Postgres

- [ ] 3.1 Enable `services.postgres` with an `initialDatabases` entry (`datahub_dev`), listening on `127.0.0.1` (configurable port, default 5432)
- [ ] 3.2 Export `DATABASE_URL=postgres://…@127.0.0.1:<port>/datahub_dev?sslmode=disable`
- [ ] 3.3 Confirm the DB starts (`devenv up` / process) and `psql "$DATABASE_URL" -c 'select 1'` succeeds

## 4. Auth-module + db env wiring

- [ ] 4.1 Export a clearly dev-only `JWT_SECRET`; leave `AUTH_MODULE_ENABLED` unset (opt-in per session)
- [ ] 4.2 Load the legacy `backend/sql/schema.sql` into the dev DB (or document doing so) so introspection/testing has real tables
- [ ] 4.3 Verify `pnpm --filter @datahub/db db:pull` introspects the local DB and reconciles `packages/db/src/schema.ts` (spot-check the auth-slice tables)

## 5. Helper scripts

- [ ] 5.1 devenv `scripts`: `db-up`, `introspect` (drizzle-kit pull), `stack` (pnpm dev:stack), thin wrappers over existing pnpm/turbo commands
- [ ] 5.2 Document the scripts in the shell banner / README

## 6. Verify parity & docs

- [ ] 6.1 Inside the shell: `pnpm install && pnpm typecheck lint test build` all green (parity with CI)
- [ ] 6.2 End-to-end local auth: with `AUTH_MODULE_ENABLED=true` + `DATABASE_URL`, start the gateway and hit `/api/auth/login` against the dev DB
- [ ] 6.3 `nix flake check` passes
- [ ] 6.4 README "Run locally (Nix)" section + `docs/REARCH_LOG.md` entry; commit incl. `flake.lock`

## 7. Wrap up

- [ ] 7.1 `openspec validate local-dev-environment --strict` passes
- [ ] 7.2 Confirm no application code changed and `main` untouched; commit on `ba/rearch` with Conventional Commits

## Notes

- `nix flake check` and the first shell entry download/build inputs (one-time; pinned by `flake.lock`).
- If port 5432 is taken, override via the documented env var.
- This change unblocks phase-1-auth 2.2 (introspection) and 7.x (local cutover soak).

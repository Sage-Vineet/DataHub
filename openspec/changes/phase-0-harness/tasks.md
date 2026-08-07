## 1. Workspace scaffolding

- [ ] 1.1 Add root `pnpm-workspace.yaml` globbing `apps/*` and `packages/*`; set `packageManager` in root `package.json`
- [ ] 1.2 Add `turbo.json` with `build`, `typecheck`, `lint`, `test` pipelines (dependency-aware, cached)
- [ ] 1.3 Convert the root `package.json` into a workspace root (remove app-level deps/scripts that move into workspaces)
- [ ] 1.4 Verify `pnpm install` resolves the empty workspace cleanly (`pnpm -r list`)

## 2. Shared config package

- [ ] 2.1 Create `packages/config` with `tsconfig.base.json` (strict, `noImplicitAny`, `noUncheckedIndexedAccess`)
- [ ] 2.2 Add shared flat ESLint config and Prettier config, exported for reuse
- [ ] 2.3 Add a `vitest` base config + V8 coverage reporter, with legacy paths excluded from coverage
- [ ] 2.4 Add a trivial unit test proving `packages/config` builds and `turbo run test` executes it

## 3. API gateway (`apps/api`)

- [ ] 3.1 Scaffold `apps/api` as a TypeScript Express app consuming `packages/config`
- [ ] 3.2 Implement env-driven routing-table parsing (named origins + `pathPrefix=target`, longest-prefix match, terminal `* → LEGACY_ORIGIN`); throw a descriptive error at boot on malformed/missing config (spec: routing-table)
- [ ] 3.3 Wire `http-proxy-middleware` for streaming pass-through of method/path/query/headers/body/status (spec: default pass-through, streaming)
- [ ] 3.4 Preserve `Authorization` + client headers and add `X-Forwarded-*` (spec: header integrity)
- [ ] 3.5 Add unauthenticated `GET /healthz` returning 200 without proxying (spec: health check)
- [ ] 3.6 Map upstream connect/timeout failures to `502`/`504` with an error body and a log line — no swallowed errors (spec: upstream failure handling)

## 4. Gateway tests (coverage gate)

- [ ] 4.1 Test: unmapped path forwards to legacy; method/query/body/status preserved
- [ ] 4.2 Test: a route-group flipped to a mock new-module target routes there while others stay legacy; reverting the entry rolls back
- [ ] 4.3 Test: malformed routing config fails startup with a descriptive error
- [ ] 4.4 Test: `Authorization` header preserved and `X-Forwarded-*` added
- [ ] 4.5 Test: large streamed upload and chunked download pass through without buffering/truncation
- [ ] 4.6 Test: `GET /healthz` returns 200 without hitting an upstream; unreachable upstream yields 502/504
- [ ] 4.7 Confirm `apps/api` coverage meets the configured per-package threshold

## 5. Legacy backend as upstream

- [ ] 5.1 Register/reference the existing backend within the workspace without editing its source
- [ ] 5.2 Provide run wiring so the gateway's `LEGACY_ORIGIN` points at the running legacy backend (env + local dev script)
- [ ] 5.3 Smoke-verify end-to-end: a real legacy endpoint served through the gateway returns byte-identical results vs. direct

## 6. Frontend relocation (`apps/web`)

- [ ] 6.1 `git mv` the SPA (`src/`, `index.html`, Vite/Tailwind/PostCSS config, frontend `package.json`) into `apps/web`, preserving history
- [ ] 6.2 Fix path-rooted config only (Vite root, `index.html` path, package name/scripts); no source/behavior changes
- [ ] 6.3 `pnpm --filter web build` succeeds; app runs locally identically to before
- [ ] 6.4 Update the Vercel project root to `apps/web`; verify a preview deploy renders the app (do this as the final, isolated commit)

## 7. CI pipeline

- [ ] 7.1 Add `.github/workflows/ci.yml` triggered on PRs targeting `ba/rearch`
- [ ] 7.2 Steps: setup pnpm+Node, `pnpm install --frozen-lockfile`, `turbo run typecheck lint test` (with coverage)
- [ ] 7.3 Add a dependency-audit step (`pnpm audit`) that fails on high-severity advisories
- [ ] 7.4 Enforce the coverage gate in CI; confirm a failing test / low coverage blocks the run
- [ ] 7.5 Mark the workflow as a required check on `ba/rearch`

## 8. Validate & wrap up

- [ ] 8.1 `openspec validate phase-0-harness --strict` passes
- [ ] 8.2 Full `turbo run typecheck lint test build` green from a clean clone
- [ ] 8.3 Confirm no legacy source files changed (only moved/wrapped) and `main` untouched; commit on `ba/rearch` with Conventional Commit messages

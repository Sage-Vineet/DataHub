## 1. Workspace scaffolding

- [x] 1.1 Add root `pnpm-workspace.yaml` globbing `apps/*` and `packages/*`; set `packageManager` in root `package.json`
- [x] 1.2 Add `turbo.json` with `build`, `typecheck`, `lint`, `test` pipelines (dependency-aware, cached)
- [x] 1.3 Convert the root `package.json` into a workspace root (remove app-level deps/scripts that move into workspaces)
- [x] 1.4 Verify `pnpm install` resolves the workspace cleanly (531 pkgs, `pnpm-lock.yaml` generated)

## 2. Shared config package

- [x] 2.1 Create `packages/config` with `tsconfig.base.json` (strict, `noImplicitAny`, `noUncheckedIndexedAccess`)
- [x] 2.2 Add shared flat ESLint config and Prettier config, exported for reuse
- [x] 2.3 Add a `vitest` base config + V8 coverage reporter, with legacy paths excluded from coverage
- [x] 2.4 Add a trivial unit test proving `packages/config` builds and `turbo run test` executes it (2 tests pass)

## 3. API gateway (`apps/api`)

- [x] 3.1 Scaffold `apps/api` as a TypeScript Express app consuming `packages/config`
- [x] 3.2 Implement env-driven routing-table parsing (named origins + `pathPrefix=target`, longest-prefix match, terminal default → legacy); throws a descriptive error on malformed/missing config (spec: routing-table)
- [x] 3.3 Wire `http-proxy-middleware` for streaming pass-through of method/path/query/headers/body/status (spec: default pass-through, streaming)
- [x] 3.4 Preserve `Authorization` + client headers and add `X-Forwarded-*` (spec: header integrity)
- [x] 3.5 Add unauthenticated `GET /healthz` returning 200 without proxying (spec: health check)
- [x] 3.6 Map upstream connect/timeout failures to `502`/`504` with an error body and a log line — no swallowed errors (spec: upstream failure handling)

## 4. Gateway tests (coverage gate)

- [x] 4.1 Test: unmapped path forwards to legacy; method/query/body/status preserved
- [x] 4.2 Test: a route-group flipped to a mock new-module target routes there while others stay legacy; reverting the entry rolls back
- [x] 4.3 Test: malformed routing config fails startup with a descriptive error
- [x] 4.4 Test: `Authorization` header preserved and `X-Forwarded-*` added
- [x] 4.5 Test: large streamed upload (2 MB) and chunked download pass through without buffering/truncation
- [x] 4.6 Test: `GET /healthz` returns 200 without hitting an upstream; unreachable upstream yields 502
- [x] 4.7 Confirm `apps/api` coverage meets the per-package threshold (94% stmts / 79% branch / 100% funcs — above 80/70/80)

## 5. Legacy backend as upstream

- [x] 5.1 Register the existing backend as a workspace member (added to `pnpm-workspace.yaml`) without editing its source
- [x] 5.2 Provide run wiring so the gateway's `LEGACY_ORIGIN` points at the running legacy backend (`apps/api/.env.example` + `dev:legacy`/`dev:stack` scripts)
- [ ] 5.3 Smoke-verify end-to-end against the **running** legacy backend (byte-identical vs. direct). Proxy behavior is proven by the gateway integration tests against a mock upstream; the live check needs the legacy backend booted with its DB/secrets — pending a dev environment.

## 6. Frontend relocation (`apps/web`)

- [x] 6.1 `git mv` the SPA (`src/`, `public/`, `index.html`, Vite/Tailwind/PostCSS/ESLint config) into `apps/web`, preserving history
- [x] 6.2 Add `apps/web/package.json` (frontend deps only; backend-only + unused `sqlite*` dropped); no source/behavior changes
- [x] 6.3 `pnpm --filter @datahub/web build` succeeds (2,342 modules → `dist`), app builds identically to before
- [ ] 6.4 Update the **Vercel project root** to `apps/web` and verify a preview deploy. Dashboard action — cannot be done from the repo; do as the final deploy step.

## 7. CI pipeline

- [x] 7.1 Add `.github/workflows/ci.yml` triggered on PRs/pushes targeting `ba/rearch`
- [x] 7.2 Steps: setup pnpm+Node, `pnpm install --frozen-lockfile`, `turbo run typecheck/lint/test` (with coverage)
- [x] 7.3 Add a dependency-audit step. **Deviation:** non-blocking for now — `xlsx`/`pdf-parse` carry high advisories with no upstream fix (audit H7); ratchets to a hard gate once they are replaced.
- [x] 7.4 Enforce the coverage gate in CI (thresholds in each package's vitest config; a failing test / low coverage fails `turbo run test`)
- [ ] 7.5 Mark the workflow as a **required check** on `ba/rearch`. GitHub branch-protection setting — cannot be done from the repo.

## 8. Validate & wrap up

- [x] 8.1 `openspec validate phase-0-harness --strict` passes
- [x] 8.2 Full `turbo run typecheck lint test build` green (typecheck 3/3, lint 4/4, test 16/16, build 2/2)
- [x] 8.3 Confirmed no legacy source files changed (only moved/wrapped) and `main` untouched; committed on `ba/rearch` with Conventional Commits

## Notes — items requiring action outside the repo

- **5.3** live end-to-end smoke needs the legacy backend running with DB/secrets.
- **6.4** Vercel "Root Directory" → `apps/web` is a dashboard setting; do it with a preview-deploy check before merging.
- **7.5** marking CI a required status check is a GitHub branch-protection setting.
- **7.3** dependency audit is intentionally advisory until `xlsx`/`pdf-parse` are replaced (audit finding H7).

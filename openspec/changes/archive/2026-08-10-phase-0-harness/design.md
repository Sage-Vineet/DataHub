## Context

See `proposal.md` — Why. Current state: a two-`package.json` repo (frontend at root, backend under `backend/`), 100% JavaScript, zero tests, no CI. The re-architecture (`docs/MODERNIZATION_PLAN.md`) requires new TS modules to run beside the legacy backend with per-route reversibility. This design covers the topology, the proxy seam, the frontend relocation, and the CI gate. Constraint: all work is additive on `ba/rearch`; `main` is frozen; end-user behavior must not change.

## Goals / Non-Goals

**Goals:**
- One command (`pnpm i` + `turbo run …`) builds, typechecks, lints, and tests the whole workspace.
- A gateway that is provably a no-op today (100% → legacy) but flips per route-group by config alone.
- CI that fails closed on typecheck/lint/test/coverage/audit for the new tree.
- Preserve git history through the frontend relocation.

**Non-Goals (design-level):**
- Any proxy *policy* beyond routing (no auth, rate-limit, caching in the gateway yet — those arrive with the auth phase behind it).
- Turborepo remote caching / release pipeline (local + CI caching only for now).
- Converting legacy `.js` to `.ts`; legacy is wrapped, not rewritten.

## Decisions

### D1 — pnpm workspaces + Turborepo
Locked in `MODERNIZATION_PLAN.md`. `pnpm-workspace.yaml` globs `apps/*` and `packages/*`; `turbo.json` defines `build`/`typecheck`/`lint`/`test` pipelines with dependency-aware caching. *Alternative considered:* npm workspaces + nx — rejected to match the locked decision and pnpm's stricter, faster installs.

### D2 — Gateway implementation
`apps/api` is an Express app whose sole middleware is a proxy. Use a maintained streaming proxy (`http-proxy-middleware`, built on `node-http-proxy`) rather than hand-rolling `http` forwarding — it gives streaming, header, and websocket handling for free and avoids re-introducing hand-rolled infrastructure (an explicit program anti-goal). The routing table is resolved once at boot from env into an ordered list of `{ matcher → target }`, with a terminal `* → LEGACY_ORIGIN` default. *Alternative:* a dedicated proxy (nginx/Caddy/Traefik) — rejected for Phase 0 because the routing table must be TypeScript-testable and colocated with the modules that will replace legacy; an infra proxy can front `apps/api` later without changing this design.

### D3 — Routing table format
Env-driven, e.g. `GATEWAY_ROUTES` as a JSON/line list of `pathPrefix=targetName` plus named origins (`LEGACY_ORIGIN`, and later `API_ORIGIN` for in-process new modules). Longest-prefix wins; anything unmatched → legacy. Malformed config throws at boot (spec: "fails to start with a descriptive error"). Keeping it env-shaped (not code) is what makes a cutover/rollback a deploy-config change, not a code deploy.

### D4 — Frontend relocation into `apps/web`
Move with `git mv` (history-preserving) into `apps/web`; keep Vite/Tailwind/HashRouter and all source unchanged. Update only path-rooted config: Vite root, `index.html` location, `package.json` name/scripts, and the **Vercel project root → `apps/web`**. This is the one operationally visible change (deploy root), called out as BREAKING(build/deploy) in the proposal. *Alternative:* leave FE at root — rejected per the user's explicit decision to relocate now for a clean final layout.

### D5 — Legacy backend under the workspace
The existing backend stays byte-for-byte; it is registered as a workspace (or kept at its path and referenced) and started as the gateway's legacy upstream (`LEGACY_ORIGIN`). No legacy source edits — only its start/proxy wiring.

### D6 — Test + coverage baseline
Vitest at the workspace root with V8 coverage. CI enforces coverage **per-package** so the global number isn't diluted by the large untyped legacy tree (which is excluded from coverage). New packages (`packages/config`, `apps/api`) ship with tests from day one; the threshold ratchets toward the program target of **90%** as modules land. `packages/config` exports the strict `tsconfig.base.json` (`strict`, `noImplicitAny`, `noUncheckedIndexedAccess`) that enforces **100% TypeScript** for all new code.

### D7 — CI shape
Single `.github/workflows/ci.yml` on PRs targeting `ba/rearch`: setup pnpm + Node, `pnpm install --frozen-lockfile`, then `turbo run typecheck lint test` (with coverage) and a dependency audit step. Turbo caching keyed on content so unchanged packages are skipped.

## Risks / Trade-offs

- **Frontend relocation breaks the Vercel deploy** → Do the `git mv` + Vercel-root change as the final, isolated commit of this change; verify a preview deploy before merging; rollback = revert that commit.
- **Gateway adds a network hop / latency** → Same-host/process forwarding keeps it sub-millisecond; streaming avoids buffering. Acceptable for the reversibility it buys; can be removed once legacy is fully retired.
- **Coverage gate stalls delivery if applied globally** → Exclude legacy from coverage; enforce per new-package thresholds only, ratcheting up — avoids a false 90% and avoids blocking on untestable legacy.
- **Proxy mishandles auth headers / streaming (would silently break QuickBooks OAuth, uploads)** → Covered by explicit spec scenarios (header integrity, streaming pass-through) with tests; this is the highest-value test surface in Phase 0.
- **Monorepo churn to import paths** → Confined to config roots; legacy source imports are internal to `backend/` and move as a unit.

## Migration Plan

1. Add workspace scaffolding (`pnpm-workspace.yaml`, `turbo.json`, `packages/config`) — no behavior change.
2. Add `apps/api` gateway defaulting 100% → legacy; add tests; run legacy as its upstream.
3. `git mv` the SPA into `apps/web`; update Vite + Vercel root; verify preview deploy.
4. Add CI workflow; make it required on `ba/rearch`.
5. **Rollback:** each step is its own commit; revert in reverse order. The gateway default-to-legacy means steps 1–2 and 4 are invisible to users; step 3 is the only one needing a deploy-config revert.

## Open Questions

- Exact hosting target for `apps/api` (same platform as legacy vs. a separate service) — does not affect this design or the specs; resolve at deploy time.

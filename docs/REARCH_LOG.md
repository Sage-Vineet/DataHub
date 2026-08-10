# DataHub Re-architecture — Work Log

> A referenced, reasoned trail of the modernization work on branch **`ba/rearch`**.
> Every entry links to the commit, the files touched, and *why* it was done.
> This is the single entry point; deeper detail lives in the linked documents.

## Context

DataHub is a multi-tenant M&A / accounting platform (React/Vite SPA + Express/Node backend, Supabase/Postgres, QuickBooks Online, AI document extraction). In **August 2026** a new CTO commissioned a full audit, which graded the codebase **F overall** on security and delivery fundamentals despite solid product breadth. The remediation and modernization run on a dedicated branch so the team's shared history is never disturbed mid-flight.

- **Branch model:** all work lands on **`ba/rearch`** (cut from `main` @ `e56ff1b`, pushed to `origin/ba/rearch`). **`main` is frozen** at `e56ff1b`; nothing here touches it. Feature work is merged *into* `ba/rearch`.
- **Why a branch, not `main`:** the audit found account-takeover-class bugs and zero tests; changes of this size need to be staged, reviewed, and reversible without risking the running product. See [ADR-0003](adr/0003-parallel-rewrite-behind-gateway.md).

## How to read this program

| Document | What it gives you |
|---|---|
| `DataHub_Engineering_Audit.docx` | Code-quality / architecture / mistakes / velocity audit + scorecard (the "why now") |
| `.claude/plans/…` security scorecard *(working copy)* | The security audit findings C1–C3 / H1–H7 / M1–M7 |
| `docs/MODERNIZATION_PLAN.md` | The target architecture + locked decisions + phased roadmap |
| `docs/adr/` | One record per locked decision: context, decision, **reasons**, consequences |
| `openspec/changes/` | Spec-driven change proposals (proposal = why, design = how, tasks = steps) |
| **this file** | Chronological log tying commits → reasons → references |

---

## Chronological log

### 0. Audit & scorecard — *the reason everything else exists*
- **What:** Full codebase audit (security + engineering) verified by direct inspection and parallel exploration passes. Security graded **F**; engineering fundamentals graded **D/F** (0 tests, 0% TypeScript, dual data path, 9,088-line god-service).
- **Why:** New CTO needed an evidence-based risk picture before touching anything.
- **References:** `DataHub_Engineering_Audit.docx`, `DataHub_Executive_Overview.odt`, security scorecard (findings **C1** shared static client password, **C2** `"change_me"` JWT fallback, **H3** query-string JWT, plus H/M items).

### 1. Security remediation — C1 / C2 / H3 + password reset
- **Commit:** `17c7e08` — `security: remove auth bypasses, add password reset (C1/C2/H3)`
- **What & why (each tied to a finding):**
  - **C1 — shared static client password.** Removed the `CLIENT_STATIC_PASSWORD` login bypass; deleted `backend/src/config/demoUsers.js`; clients are now provisioned with a random password (`companyService.js`) and reset via a new enumeration-safe flow (`/auth/forgot-password` + `/auth/reset-password`, `src/pages/ForgotPassword.jsx`). *Reason:* one shared secret (`"123456"`) authenticated every client account → mass account takeover.
  - **C2 — `"change_me"` JWT fallback.** New `backend/src/config/secrets.js` makes `JWT_SECRET` mandatory and **fails closed at boot**; removed every `|| "change_me"`. *Reason:* an unset secret let anyone forge admin tokens, and the server booted happily in that state.
  - **H3 — query-string JWT.** Query-token support is now opt-in per route (`requireAuthAllowQueryToken`), enabled only for the QuickBooks OAuth-start redirect that genuinely needs it. *Reason:* tokens in URLs leak into logs/history/referers.
- **Breaking:** existing client accounts must reset their password on deploy (the shared password is gone by design).

### 2. Repo hygiene
- **Commit:** `00b8fa8` — `chore: stop tracking committed junk; ignore lock/db/pyc artifacts`
- **What:** Untracked (kept on disk) committed junk — `debug_pdf_output.txt`, two `dev-database*.db` SQLite files, `backend_spec 2.doc`, 8 `__pycache__/*.pyc`; added a LibreOffice lock-file pattern to `.gitignore`.
- **Why:** committed databases exposed the `users` schema; the `.gitignore` gaps were the root cause the audit flagged (Low/hygiene). Untracked with `git rm --cached` rather than deleting, to preserve local dev data.

### 3. Modernization plan & audit deliverables
- **Commit:** `31186ae` — `docs: add modernization plan and audit deliverables`
- **What:** `docs/MODERNIZATION_PLAN.md` (TS + monorepo + Drizzle parallel-rewrite program), `DataHub_Engineering_Audit.docx`, `DataHub_Executive_Overview.odt`.
- **Why:** capture the target state and the decision rationale so the rewrite has a durable reference. Decisions are distilled into [`docs/adr/`](adr/).

### 4. OpenSpec — spec-driven planning
- **Commit:** `9fd8b8d` — `chore: set up OpenSpec for spec-driven rearch planning`
- **What:** `openspec/` (`schema: spec-driven`) with project context (current + target stack, cutover order, known debt, conventions) seeded into `openspec/config.yaml`; `.claude/` `opsx` commands + skills.
- **Why:** every change is planned as proposal → specs → design → tasks before code, so the rewrite is auditable and reviewable. The seeded context means generated proposals are grounded in *this* project's constraints.

### 5. Phase 0 — proposal
- **Commit:** `0912c3a` — `docs(openspec): add phase-0-harness change proposal`
- **What:** planning artifacts for the harness under `openspec/changes/phase-0-harness/` (proposal, `platform/api-gateway` spec, design, tasks), validated with `openspec validate --strict`.
- **Why:** the harness is the seam the whole program cuts over into; it earns a full spec (behavioral gateway contract) before implementation.

### 6. Phase 0 — implementation (monorepo + gateway + CI)
- **Commit:** `8a1fd22` — `feat: Phase 0 modernization harness (monorepo + gateway + CI)`
- **What:**
  - **Monorepo:** pnpm workspaces + Turborepo; root becomes the workspace root (`packageManager: pnpm@9.15.9`); npm lockfile replaced by `pnpm-lock.yaml`.
  - **`packages/config`:** strict `tsconfig.base.json`, shared flat ESLint + Prettier, vitest base with V8 coverage (legacy excluded). Enforces the 100%-TS / lint / coverage standards on new code.
  - **`apps/api`:** TypeScript Express **gateway** — env-driven routing table (default 100% → legacy, per-route-group cutover + rollback), streaming `http-proxy-middleware` pass-through, `/healthz`, `502/504` upstream-error handling. 16 vitest+supertest tests; **94% stmts / 100% funcs** coverage.
  - **`apps/web`:** SPA relocated here via `git mv` (history preserved); frontend deps split out (backend-only + unused `sqlite*` dropped). Builds identically.
  - **`backend/`:** added as a workspace member (proxied by the gateway), **source untouched**.
  - **CI:** `.github/workflows/ci.yml` — typecheck + lint + test/coverage + audit on `ba/rearch`.
- **Why:** deliver the reversible seam (see [ADR-0003](adr/0003-parallel-rewrite-behind-gateway.md)) and stand up the quality gate ([ADR-0005](adr/0005-testing-and-coverage-standard.md)) that every later phase depends on — while shipping **nothing user-facing** (gateway forwards 100% to legacy; the SPA is byte-for-byte the same app at a new path).
- **Verification:** typecheck 3/3 · lint 4/4 · test 16/16 · build 2/2 · gateway coverage above the 80/70/80 gate.
- **Deliberate deviations** (recorded in the change's `tasks.md`):
  - *Web lint is advisory* — the legacy SPA has 235 pre-existing lint errors (audit **M7**); gating them now contradicts the "migrate frontend later" plan, so only the new TS packages are strictly gated. One is a real latent bug: undefined `keyReportVersionId` in `apps/web/src/services/profitAndLossService.js:707`.
  - *Dependency audit is non-blocking* — `xlsx`/`pdf-parse` carry high advisories with no upstream fix (audit **H7**); the step ratchets to a hard gate once they're replaced.

---

## Decisions (ADR index)

| ADR | Decision | Reason (one line) |
|---|---|---|
| [0001](adr/0001-monorepo-pnpm-turborepo.md) | pnpm workspaces + Turborepo monorepo | Shared types + cached builds + a clean seam for later service extraction |
| [0002](adr/0002-drizzle-data-layer.md) | Drizzle ORM as the single data layer | Retire the Supabase-vs-`pg` dual path (the #1 architectural liability) |
| [0003](adr/0003-parallel-rewrite-behind-gateway.md) | Parallel rewrite behind a gateway | Per-route-group cutover with instant rollback; no big-bang |
| [0004](adr/0004-modular-monolith.md) | Modular monolith, module boundaries via typed contracts | Enforce boundaries now; keep the microservice option open |
| [0005](adr/0005-testing-and-coverage-standard.md) | 100% TypeScript + 90% coverage gate on new code | Convert a class of runtime failures into compile/CI errors |
| [0006](adr/0006-shadcn-design-system.md) | Reusable shadcn/ui component system (~90% look match) | Replace duplicated god-component UI with a tested design system |

## Pending actions outside the repo
- **Vercel** "Root Directory" → `apps/web`, with a preview-deploy check (Phase 0 task 6.4).
- **Live legacy smoke-test** through the gateway once the backend is booted with DB/secrets (task 5.3).
- **GitHub branch protection:** mark CI a required check on `ba/rearch` (task 7.5).
- **CTO-owned security follow-ups:** rotate the leaked Gmail app password and purge secrets from history (audit **C3**); these are destructive/outward-facing and intentionally deferred to an explicit decision.

## Reference map
- Program target & roadmap: `docs/MODERNIZATION_PLAN.md`
- Decisions: `docs/adr/`
- Change specs: `openspec/changes/phase-0-harness/`
- Audit evidence: `DataHub_Engineering_Audit.docx`, `DataHub_Executive_Overview.odt`
- Commits: `git log --reverse main..ba/rearch`

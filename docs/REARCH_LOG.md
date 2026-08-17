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

### 7. Phase 1 — auth reference domain (implementation)
- **Change:** `phase-1-auth` (proposal `c177c0d`); implementation commit *(this change)*.
- **What:** first real domain rebuilt behind the gateway — `packages/contracts` (zod auth schemas), `packages/db` (Drizzle auth-slice schema, hand-authored via the design's no-DB fallback), and `apps/api/src/modules/auth` (router + service + repository + tests). Ports the C1/C2/H3 fixes into TypeScript and **adds the still-open H1 login rate-limit**; `helmet` + `pino-http` scoped to the module.
- **Why:** establish the reusable module pattern (router→service→repository→contract, cross-module only via typed services — [ADR-0004](adr/0004-modular-monolith.md)) and prove per-route cutover. The service depends only on a repository *port*, so it is fully tested without a database (in-memory adapter) — the Drizzle adapter is the runtime counterpart.
- **Cutover design:** the module mounts at `/api/auth` **ahead of** the proxy, gated by `AUTH_MODULE_ENABLED` (off by default → falls through to legacy); tokens use the **same secret + `{sub}` claim** as legacy so a flip/rollback is zero-downtime (design D3).
- **Verification:** typecheck 7/7 · **49 tests** · lint 6/6 · build 4/4 · auth module **95% stmts / 100% funcs**. Legacy source untouched; `main` frozen.
- **Local soak passed (9/9):** with the dev environment (§8), the flag-on gateway ran against local Postgres — login→token, `/me`, 401s, enumeration-safe forgot-password, and live rate-limit **429** (H1); helmet + pino confirmed. Remaining 7.x are true-deploy steps (canary soak on staging, then delete legacy `/api/auth`).

### 8. Local dev environment — Nix flake + devenv
- **Change:** `local-dev-environment` (tooling; skip_specs). Implementation commit *(this change)*.
- **What:** `flake.nix` (+ `flake.lock`) wrapping **devenv** (`devenv.nix`/`devenv.yaml`), plus `.envrc` for direnv. Provides Node 22, corepack-pinned pnpm 9.15.9, and a **local Postgres** (127.0.0.1:**5433** — 5432 was in use) with `DATABASE_URL` + dev `JWT_SECRET` exported, and helper scripts (`db-up`, `load-schema`, `introspect`, `stack`).
- **Why:** make the stack reproducibly runnable/testable with no external services, and **unblock phase-1-auth 2.2 (Drizzle introspection) and 7.x (local cutover soak)** which need a real `DATABASE_URL`.
- **Verification:** `nix flake check` → "all checks passed!"; in-shell node 22.23.2 / pnpm 9.15.9 / psql 16.14 and **49 tests pass**; standalone `devenv up -d --no-tui` starts Postgres (ready in ~1s), `select 1` and the legacy schema load succeed. See README "Run locally (Nix)".
- **Note:** inside `nix develop` the `devenv` command is a reduced flake wrapper (foreground-TUI `up`); use the **standalone** devenv CLI at the repo root for detached/headless (`devenv up -d --no-tui`).
- **drizzle-kit introspection fixed:** `db:pull` had failed with `ERR_PACKAGE_PATH_NOT_EXPORTED` — drizzle-kit 0.30.6 imports `drizzle-orm/gel-core` (first exported in drizzle-orm 0.40.0). Bumped `drizzle-orm ^0.38.3 → ^0.40.1` (packages/db + apps/api; typecheck 7/7, 49 tests still green). `db:pull` now introspects the local DB and validates the phase-1-auth auth-slice schema.

### 9. shadcn design system — `@datahub/ui`
- **Change:** `shadcn-design-system` (implements [ADR-0006](adr/0006-shadcn-design-system.md)). Implementation commit *(this change)*.
- **What:** new `packages/ui` — 13 shadcn/Radix components (Button, Input, Label, Badge, Skeleton, Card, Table, Dialog, Tabs, Tooltip, DropdownMenu, Select, Toast) + `cn()`, a lightweight Vite gallery, and vitest/Testing-Library tests. A shared `tailwind-preset` (tokens extracted verbatim from the app) is now consumed by **both** `apps/web` and the library — one token source.
- **Why:** replace duplicated hand-rolled UI with owned, tested, accessible primitives matching the current look (~90%+, [ADR-0006](adr/0006-shadcn-design-system.md)); seeds FE TypeScript adoption at the UI layer.
- **Key decision:** styled with the existing Tailwind tokens (`bg-primary`, `rounded-card`…) instead of shadcn's default palette → exact parity.
- **Adoption proof + deviation:** the spec named the broker "Users table", but `Users.jsx` has no table — it uses hand-rolled modals; migrated its **DeleteModal** to the `@datahub/ui` Dialog + Button instead (same intent; modals are the real duplicated primitive there). Proves a `.jsx` page consumes `@datahub/ui` `.tsx` via Vite.
- **Verification:** typecheck 8/8 · ui tests **13/13** (incl. Dialog focus-trap/Escape, DropdownMenu keyboard, Select) · coverage **92% stmts** · lint 7/7 · build 4/4 (`apps/web` builds consuming the library; CSS regenerates with the new component classes). No backend/routing/state changes; `main` frozen.

### 10. Auth engine decision — off-the-shelf vs bespoke ([ADR-0007](adr/0007-auth-library-vs-bespoke.md))
- **Trigger:** a CTO question mid-cutover — *are we using an off-the-shelf, bulletproof auth solution, or building it ourselves? What about Better Auth / Supabase?* Answer: we use sound **primitives** (`bcryptjs`, `jsonwebtoken`) but the **identity/session layer is hand-rolled**, and the cutover proposal defers revocation/refresh (**M1**) and cookie/CORS hardening (**M2/M3**). Auth is the reference domain Phase 2 will copy, so the engine choice is cheapest to make **now**.
- **Decision (proposed):** adopt **Better Auth** (self-hosted, MIT, TS-native) behind the existing gateway seam, keeping identity in our own Postgres — over Supabase Auth (deepens the very platform coupling ADR-0002 removes) and over keeping the bespoke module (owning revocation/MFA/SSO forever). See [ADR-0007](adr/0007-auth-library-vs-bespoke.md).
- **Spike (evidence, not vibes):** `spikes/better-auth/` — real Better Auth 1.6.27 on the real Drizzle adapter over embedded Postgres (PGlite). **8/8 green:** existing **bcrypt** hash logs in unchanged (parity, custom `verify`), session is an **httpOnly cookie** (M2/M3) and a **DB row** in our Postgres, and **revocation** invalidates it server-side (**M1 — the gap the bespoke HS256 module cannot close**).
- **Findings:** migration is a `users → user/account` backfill (credentials move to Better Auth's `account` table), bcrypt hashes carry over verbatim, `drizzle-orm` should bump to `^0.45.2` (spike ran green on 0.40.1 anyway), and the SPA moves from `Bearer`-in-`localStorage` to cookie sessions (~1–1.5 wk total). Full writeup: `spikes/better-auth/SPIKE.md`.
- **Decision:** CTO **chose Better Auth** (2026-08-11). ADR-0007 **Accepted**; scoped as OpenSpec change **`adopt-better-auth`** (proposal + design + tasks + `auth` spec deltas for cookie/DB-backed sessions + revocation). `auth-production-cutover` §6 (retire legacy) is **paused** — legacy stays the rollback target and is retired under `adopt-better-auth` once Better Auth is the soaked prod engine.
- **Implementation (this change):** built end-to-end on `ba/rearch`. `drizzle-orm` bumped `0.40→0.45`; Better Auth `auth_user`/`session`/`account`/`verification` tables (`packages/db/src/auth-schema.ts` + `migrations/0000_better_auth_identity.sql`). New `apps/api` module: `better-auth.ts` (Drizzle adapter, **bcrypt-verify parity**, DB-backed httpOnly cookie sessions, `email-otp` + a real **Microsoft Graph** emailer, bearer plugin), `router.better.ts` (legacy JSON contract preserved), `backfill.ts` (`users → auth_user`+`account`, idempotent/reversible), mounted behind **`BETTER_AUTH_ENABLED`** in `server.ts`. Frontend cut to cookie sessions (`api.js` `credentials:"include"`, cookie-first `AuthContext`), gateway gains credentialed-CORS. **Verification:** api **63/63** tests (incl. parity, **revocation/M1**, reset, cross-tenant, and gateway-cutover), coverage **92.5% stmts / 80% branch**; typecheck + lint clean; SPA builds. Design deviation: Better Auth uses its own `auth_user` table (spike-proven shape) with `id` preserved equal to `users.id`, rather than mapping onto `users` in place.
- **Reference reconcile:** before Phase 2 domains copy the pattern, pointed the blueprint (`CONTRIBUTING.md`) + companies/users/folders proposals at the **shared session guard** (`requireSession`, Better Auth) instead of the retiring bespoke `requireAuth`.

### 11. Phase 2 — `companies` domain (implementation)
- **Change:** `companies-domain` (first Phase 2 domain; [ADR-0003](adr/0003-parallel-rewrite-behind-gateway.md) pattern, ADR-0007 session guard). The backbone every other domain references.
- **What:** contracts (`packages/contracts/companies.ts` — create/update/list/response + `normalizeProfitMetric`); fuller `packages/db` companies schema; `apps/api/src/modules/companies/` = ports + service + `repository.drizzle.ts` + `repository.memory.ts` + Drizzle port adapters (stats/folders/user-provisioning) + router; **shared `apps/api/src/shared/{access,session,errors}.ts`** promoted for all domains; mounted at `/api/companies` behind **`COMPANIES_MODULE_ENABLED`**.
- **Key rules ported:** tenant-scoped list, get-with-stats (via a read port, D5), broker/admin create with **default-folder provisioning + client-rep sync** (cross-domain ports with Drizzle adapters, D3), safe-field update (integration columns never touched), profit-metric normalization, and the **4-step cascade delete in one transaction** (D4). Supabase/`pg` dual path dropped — Drizzle only (D6, [ADR-0002](adr/0002-drizzle-data-layer.md)).
- **Verification:** api **76/76** tests (13 companies: 9 service w/ in-memory repo + fake ports, 4 integration w/ the **transactional cascade** against real Postgres/PGlite — seed-and-delete across 8+ tables, atomic, `users.company_id` nulled); coverage **93% stmts / 79% branch** (service 96–98%, router 89–94%); contracts 13/13, db 4/4; typecheck + lint clean; `openspec validate --strict` green.
- **Deferred (need a real env / later domains):** staging parity + legacy retirement (§9.1/9.2); swapping the provisioning ports to the real `users`/`folders` module services (§9.3) — a no-contract-change swap once those land.

### 12. Phase 2 — `users` domain (implementation)
- **Change:** `users-domain` (second Phase 2 domain; reuses the shared guards from `companies-domain`). The richest access logic in the app.
- **What:** contracts (`packages/contracts/users.ts` — create/update/list/membership/team-invite/response with `effective_role` + sub-roles); fuller `packages/db` users columns + `broker_team_invites`; `apps/api/src/modules/users/` = `roles.ts` (pure rules) + ports + service + `repository.drizzle.ts` + `repository.memory.ts` + transitional adapters + router (10 endpoints); mounted at `/api/users` behind **`USERS_MODULE_ENABLED`**.
- **Key rules ported:** tenant-scoped visibility (self / shared-company broker + invited-team / admin-all), role/sub-role-gated create (brokers can't make admin/primary-broker), guarded update (no broker role-change; self password requires + verifies `current_password`), **`effective_role`** computation as a pure function (admin/broker/client/user, incl. seller-by-contact-email + client sub-roles), company membership, broker-team invites, and **delete-with-reassignment**: the replacement-owner invariant (400 if none) then reassign `created_by`/`uploaded_by` across 8 tables + delete, **in one transaction** (D4). Auth-cache invalidation is a no-op (Better Auth sessions are DB-backed, ADR-0007).
- **Verification:** api **104/104** tests (28 users: 13-case table-driven `effective_role`, 10 service rules w/ in-memory repo + spy ports, 5 integration incl. the **transactional reassign-and-delete** against real Postgres/PGlite); coverage **91% stmts / 80% branch**; contracts 17/17, db 6/6; typecheck + lint clean; `openspec validate --strict` green.
- **Deviations (documented):** historical-company-inference shim (D5) not ported — `assignedCompaniesFor` unions `user_companies` + primary `company_id`, covering the observable behavior; reassignment is a transactional repo method rather than a separate port, to guarantee atomicity.
- **Deferred (need a real env / later domains):** staging parity + legacy retirement (§9.1/9.2); swapping the reassignment/notification ports to real sibling services (§9.3).

### 13. Phase 2 — `folders` domain (implementation) — core trio complete
- **Change:** `folders-domain` (completes companies → users → **folders**). Owns the folder tree, default-folder provisioning, archiving, protected delete, and per-folder access grants.
- **What:** contracts (`packages/contracts/folders.ts` — create/update/move + access create/update with the user-XOR-group rule + `include_archived`); `packages/db` gains `folders.archived_at`, the `folder_access` table (CHECK: exactly one subject), and a `(company_id, coalesce(parent_id), name)` unique index; `apps/api/src/modules/folders/` = `hierarchy.ts` (the default set as data) + ports + service + `repository.drizzle.ts` + `repository.memory.ts` + cross-domain adapters (`FileLinkPort`, `GroupRefPort`) + router; mounted under `/api` behind **`FOLDERS_MODULE_ENABLED`** (folder + access routes only; document sub-routes stay on legacy).
- **Key rules ported:** tenant-scoped tree/list with archived filter, create/update/move, soft-delete archive/restore, **idempotent default-folder provisioning via a unique index + `onConflictDoNothing`** (replacing the legacy in-process mutex, D2), **file-link-protected hard delete** (409 if linked to a Key Report, else delete cascades access, D3/D5), and per-folder access grants (broker/admin only, exactly-one-subject, D4). Supabase/`pg` fallback dropped.
- **Trio payoff (D6):** the real `FolderProvisioningPort` now backs `companies` — `createFolderProvisioningPort(db)` is injected into `createCompaniesModule` when both modules are enabled (server.ts §9.2).
- **Verification:** api **115/115** tests (18 folders: 7 service w/ in-memory repo + fake ports, 4 integration incl. **real idempotent provisioning** + the **409 file-link guard** + access cascade against real Postgres/PGlite; +7 contract); coverage ≥90% on the module; contracts 23/23, db 8/8; typecheck + lint clean; `openspec validate --all --strict` green.
- **Infra note:** the growing suite now runs test files **sequentially** (`vitest.config.ts fileParallelism:false`, 30s timeout) so many embedded-Postgres + Better Auth instances don't contend under load.
- **Deferred:** staging parity + legacy folder/access retirement (§9.1/9.3) — legacy stays the rollback target; document handlers remain for the uploads phase.

### 14. Phase 2 — `uploads` domain (implementation)
- **Change:** `uploads-domain` (next after the core trio). Owns file storage + the folder **documents** left on legacy when `folders` migrated. Newly scoped as an OpenSpec change (there was no prior proposal) then implemented.
- **What:** contracts (`packages/contracts/uploads.ts` — document create/list + upload/document/activity responses); `packages/db` models `uploads` (blob as **`bytea`** via a drizzle `customType`), `documents`, `document_activity`; `apps/api/src/modules/uploads/` = ports + service + `repository.drizzle.ts` + `repository.memory.ts` + a **`StoragePort`** (bytea adapter) + `FolderRefPort`; router mounted under `/api` behind **`UPLOADS_MODULE_ENABLED`** (manual-GL upload sessions stay on legacy).
- **Key rules ported:** store a blob / stream it back with its content-type, add/list/delete documents under a folder (tenant-guarded via the folder's company), soft-delete archive/restore, and an append-only document-activity log. **Dropped the Supabase-Storage large-file branch** — blobs live in Postgres `bytea` behind `StoragePort`, so an S3/GCS adapter swaps in later with no contract change (ADR-0002 direction).
- **Verification:** api **125/125** tests (10 uploads: 6 service w/ in-memory storage/repo/folder-ref, 4 integration incl. a **binary bytea store→stream round-trip** + document CRUD/archive + activity cascade against real Postgres/PGlite); coverage **91.5% stmts / 82% branch**; contracts 26/26, db 9/9; typecheck + lint clean; `openspec validate --all --strict` green.
- **Deferred:** staging parity + legacy upload/document retirement (§9.1/9.2); object-store backend (behind `StoragePort`); manual-GL upload orchestration (reports/quickbooks phases).

### 15. Phase 2 — `requests` domain (implementation)
- **Change:** `requests-domain` (broker↔client work items). Scoped as a new OpenSpec change then built.
- **What:** contracts (`packages/contracts/requests.ts` — enums + create/update/bulk/approve/narrative/reminder/doc-link + the priority→reminder-frequency helper); `packages/db` models `requests` (full), `request_reminders`, `request_narratives`, `request_documents`; `apps/api/src/modules/requests/` = ports + service + `repository.drizzle.ts` + `repository.memory.ts` + router mounted under `/api` behind **`REQUESTS_MODULE_ENABLED`**.
- **Key rules ported:** validated create (enums + future due-date) with **priority-driven reminder frequency** (critical/high→1, medium→2, low→7, explicit override honored), single + **transactional bulk** create, update (re-derives frequency on priority change), approval flow, delete (cascades reminders/narrative/doc-links), 1:1 narrative upsert, append-only reminder log, and request→document links. Reminder *delivery* is out of scope. Drizzle-only (dual path dropped).
- **Verification:** api **133/133** tests (8 requests: 6 service w/ in-memory repo, 2 integration incl. bulk + approve + narrative upsert + reminder + doc-link + cascade delete against real Postgres/PGlite); coverage ≥90% on the module; contracts 30/30, db 10/10; typecheck + lint clean; `openspec validate --strict` green.
- **Infra:** vitest switched from fully-sequential to **bounded parallelism** (3 forks) — the growing suite finishes quickly without the embedded-Postgres contention that caused earlier flakes.
- **Deferred:** staging parity + legacy request retirement; reminder delivery (email/cron).

### 16. Phase 2 — `messages` domain (implementation)
- **Change:** `messages-domain` (in-app communication). Scoped as a new OpenSpec change then built.
- **What:** contracts (`packages/contracts/messages.ts` — send/group-create/member schemas + responses); `packages/db` models six tables (`company_messages`, `direct_messages`, `message_groups`, `message_group_members`, `group_messages`, `group_message_reads`); `apps/api/src/modules/messages/` = ports + service + `repository.drizzle.ts` + `repository.memory.ts` + router mounted under `/api` behind **`MESSAGES_MODULE_ENABLED`**.
- **Key rules ported:** tenant-scoped **company conversations**, **symmetric 1:1 direct** messages, **message-groups** (explicit create, membership add/remove/list), **member-only** group read/post (or a broker/admin on the group's company), group messaging, and **unread tracking via a per-user read watermark**. Auto-created groups + thread/contacts aggregations stay on legacy (non-goals).
- **Verification:** api **139/139** tests (6 messages: 4 service w/ in-memory repo, 2 integration incl. group membership + watermark unread-count against real Postgres/PGlite); coverage ≥90% on the module; contracts 32/32, db 11/11; typecheck + lint clean; `openspec validate --strict` green.
- **Deferred:** staging parity + legacy message retirement; group auto-creation; thread/contacts endpoints.

### 17. Phase 2 — `reports` domain, first slice (implementation)
- **Change:** `reports-domain` — the first slice of the program's biggest decomposition target (the 9,088-line `manualGlMultiYearService` GL engine + Key Reports). Scoped as a new OpenSpec change then built.
- **What:** migrates the **key-report version lifecycle** (the backbone entity) and draws a clean seam for the compute engine. contracts (`packages/contracts/reports.ts` — version create/update + response); `packages/db` models `key_report_versions` with a **partial-unique active index** (one official version per company); `apps/api/src/modules/reports/` = ports + service + `repository.drizzle.ts` + `repository.memory.ts` + a **`ReportSyncPort` stub** + router mounted under `/api` behind **`REPORTS_MODULE_ENABLED`**.
- **Key rules ported:** tenant-scoped list, **auto-numbered** create (draft), update, duplicate (→ new inactive draft), **activate** (the single-official-version invariant, transactional), and delete. Only the version-lifecycle routes are defined — **sync / mappings / chart-of-accounts / extracted-data fall through to legacy** (D2). The GL sync is a `ReportSyncPort` that returns **501 ("handled by the legacy engine")** — the explicit decomposition boundary (D5).
- **Verification:** api **144/144** tests (5 reports: 3 service w/ in-memory repo, 2 integration incl. the transactional one-active-version invariant against real Postgres/PGlite); coverage ≥90% on the module; contracts 34/34, db 12/12; typecheck + lint clean; `openspec validate --strict` green.
- **Explicit scope boundary:** this is the **first slice**, not the whole reports domain. The GL multi-year computation engine stays on legacy behind the port and is decomposed incrementally in later slices — the safe way to dismantle a 9k-line god-service.
- **Deferred:** the GL compute/sync engine, chart-of-accounts, mappings, extracted-data; staging parity + legacy version-handler retirement.

### 18. Cutover platform — making the parallel stack real (Phases A + B)
- **Why:** eight domains were built, tested and merged, and **none served a single request**. Every domain change ended `[~] deferred: needs a real environment (ops)`, `auth-production-cutover` was 0/23, and no legacy handler had ever been deleted. The blocker was that no delivery path existed — no Dockerfile, no staging, no deploy workflow. Building a ninth domain would have widened the gap that `docs/MODERNIZATION_PLAN.md` §8 names as risk #1.
- **What the attempt uncovered — the cutover mechanism did not work:**
  - **Every module was mounted on a path nothing calls.** Modules sat under `/api/*`; the SPA calls `/auth/login`, `/companies`, `/users` (`grep -c "'/api/" apps/web/src/lib/api.js` → **0**) and the gateway does no path rewriting. Flipping any flag was a no-op — **all 69 module routes were unreachable**. The route-contract test, run against the old mount table, flags every one.
  - **`/api/auth/*` is QuickBooks, not DataHub auth.** Legacy mounts auth at `/auth` (`backend/src/app.js:124`); `/api/auth/*` belongs to the QBO OAuth routes (`routes/quickbooks/token.js`). Because modules attached helmet/body-parser/`requireAuth` via `router.use()`, mounting under `/api` also 401'd those five endpoints and consumed their request bodies before the proxy saw them.
  - **There was no runnable build.** `pnpm build && node dist/server.js` died with `ERR_MODULE_NOT_FOUND`: `@datahub/contracts` and `@datahub/db` declare `exports` → `./src/index.ts`, so Node resolved TypeScript source. The program had never produced a running artifact.
  - **`backend/sql/schema.sql` does not apply to a clean database** — line 278 indexes `bank_transactions(client_id)`, a column the table does not declare. The audit's "no authoritative schema" finding, now reproducible, and the reason `db:pull` reconciliation must come from a production snapshot.
  - **A mistyped flag silently meant "off"** — `COMPANIES_MODULE_ENABLED=1` parsed as false, so an operator could flip a flag, see a clean boot, and believe a domain had cut over.
- **What shipped:** `shared/router.ts::withCommonMiddleware` (per-route chain → clean fall-through); modules re-mounted on the legacy contract in `server.ts`; the SPA + devenv pointed at the gateway instead of straight at legacy; `exports` split into `development` → src / `default` → dist so the build runs; `apps/api/Dockerfile` + `backend/Dockerfile` + `docker-compose.staging.yml`; `env.ts` strict flag/PORT validation.
- **Two standing guards:** `route-contract.test.ts` derives the legacy surface from `backend/src` and the new surface from the real routers, failing the build if a module claims a path legacy does not serve (two pre-existing additive endpoints are recorded explicitly). Gateway fall-through tests cover the QBO OAuth paths and assert a POST body reaches legacy intact — all 6 fail against the old `router.use()` pattern.
- **Verification — the first working cutover in the program:** the full stack ran under compose (postgres + legacy + gateway). Flags off: `/healthz` 200 in-process, `/public/health/db` 200 proxied through to legacy. `BETTER_AUTH_ENABLED=true` → `/auth/login` answered **400 from the TypeScript module's zod validation** instead of legacy's 500; `/api/auth/status` still proxied to legacy (QBO intact); flag off again → back to legacy. api **144 → 179 tests**, typecheck + lint clean.
- **Next (Phase C onward):** seed staging from a production snapshot, run `db:pull` and reconcile the drift, verify `JWT_SECRET` parity, then flip domains in order with a parity harness, deleting legacy handlers per green soak.

## Decisions (ADR index)

| ADR | Decision | Reason (one line) |
|---|---|---|
| [0001](adr/0001-monorepo-pnpm-turborepo.md) | pnpm workspaces + Turborepo monorepo | Shared types + cached builds + a clean seam for later service extraction |
| [0002](adr/0002-drizzle-data-layer.md) | Drizzle ORM as the single data layer | Retire the Supabase-vs-`pg` dual path (the #1 architectural liability) |
| [0003](adr/0003-parallel-rewrite-behind-gateway.md) | Parallel rewrite behind a gateway | Per-route-group cutover with instant rollback; no big-bang |
| [0004](adr/0004-modular-monolith.md) | Modular monolith, module boundaries via typed contracts | Enforce boundaries now; keep the microservice option open |
| [0005](adr/0005-testing-and-coverage-standard.md) | 100% TypeScript + 90% coverage gate on new code | Convert a class of runtime failures into compile/CI errors |
| [0006](adr/0006-shadcn-design-system.md) | Reusable shadcn/ui component system (~90% look match) | Replace duplicated god-component UI with a tested design system |
| [0007](adr/0007-auth-library-vs-bespoke.md) | Off-the-shelf auth (Better Auth) vs. the bespoke module *(accepted; spike green → `adopt-better-auth`)* | Get revocation/MFA/SSO off-the-shelf and stop owning the identity layer |

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

# DataHub Modernization Plan — TypeScript, Standard Deps, Service-Ready

> Status: proposed · Owner: CTO / platform · Last updated: 2026-07-27

## 1. Goals

1. **Migrate to TypeScript** across frontend and backend.
2. **Outsource common functionality to industry-standard dependencies** — stop maintaining hand-rolled infrastructure (data access, HTTP client, validation, rate-limiting, logging, config, tests).
3. **Preserve the option to extract microservices** later, without committing to distributed-systems overhead now.

## 2. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Repo topology | **pnpm workspaces + Turborepo monorepo** | First-class shared types; cached, parallel builds; clean seam for later service extraction |
| Data-access layer | **Drizzle ORM** (Postgres, hosted on Supabase) | SQL-first, strong TS inference, `drizzle-kit pull` introspects the live schema; owns migrations — replaces the Supabase/pg dual path |
| Migration approach | **Parallel rewrite** (backend) | Build `apps/api` fresh in TS; cut over per route-group behind a gateway |
| Service posture | **Modular monolith first** | Enforce module boundaries + contracts now; extract services only where load/ownership justifies it |

**Open item (needs confirmation):** frontend strategy. Recommendation is **incremental in-place TS migration** of the existing SPA (not a parallel UI rewrite) — parallel-rewriting ~70k LOC of working UI is high-cost/low-return. The new `packages/contracts` types benefit the existing SPA immediately either way.

## 3. Target architecture

```
datahub/                          ← pnpm workspaces + Turborepo
  packages/
    contracts/   zod schemas → inferred TS types (shared FE/BE API contract)
    db/          Drizzle schema (introspected) + typed client + migrations
    config/      zod-validated env loader; shared tsconfig / eslint / prettier
  apps/
    web/         React SPA (TS) · @tanstack/react-query over a typed client
    api/         Express (TS) · thin routers → domain modules
      gateway    reverse-proxy: migrated route-groups → new modules,
                 everything else → legacy backend (cutover seam)
      modules/
        auth · companies · folders · uploads · requests · messages ·
        reports(manual-gl, key-reports) · quickbooks · extraction
  legacy/        the current backend, untouched, retired domain-by-domain
```

### Module anatomy (the rule that preserves the microservices option)
Every `modules/<domain>` contains:
```
router.ts        HTTP surface (thin; validation via contracts)
service.ts       business logic; the ONLY cross-module entry point
repository.ts    data access via packages/db (no raw SQL elsewhere)
<domain>.contract.ts   zod schemas + inferred types (re-exported from packages/contracts)
*.test.ts        vitest + supertest
```
Modules communicate **only** through typed `service` interfaces + shared contracts — never by reaching into another module's repository or DB tables. That single constraint means any module can later be lifted into its own service behind an HTTP/queue adapter with **no contract change**. The gateway that fronts legacy-vs-new today is the same seam that fronts services tomorrow.

## 4. The "standard deps" stack (what replaces what)

| Hand-rolled today | Standard dep | Removes |
|---|---|---|
| Supabase-vs-`pg` dual path · 76 ad-hoc migrations · per-service pools | **drizzle-orm** + drizzle-kit | The #1 architectural liability; one typed data layer + migrations |
| 1,647-line `api.js` fetch client | **@tanstack/react-query** + typed client from `contracts` | Manual cache/loading/error/retry code |
| No request validation | **zod** (in `contracts`) + validate middleware | Implicit, unsafe payloads; FE/BE drift |
| No login rate-limit / no security headers | **express-rate-limit** + **helmet** | High-severity audit findings |
| `console` / `morgan` logging | **pino** + pino-http | Unstructured logs; accidental PII logging |
| Scattered `process.env` reads | **zod env module** (fail-fast) | Config drift; the `JWT_SECRET` class of bug |
| No tests / no CI | **vitest** + **supertest** (+ Playwright later) · **GitHub Actions** | No safety net; no gate |
| Two AI providers + Python, overlapping | one **extraction** module interface | Duplication; becomes the first extracted service |
| Raw `https` Graph calls | **@microsoft/microsoft-graph-client** (optional) | Hand-rolled OAuth/token cache |

## 5. Parallel-rewrite mechanics (backend)

1. **Gateway first.** Put a reverse proxy (in `apps/api`) in front of traffic. By default it forwards **everything to the legacy backend**. As each domain is rebuilt, flip that route-group to the new module. One env-driven routing table = instant rollback per domain.
2. **Cut over by route-group**, not big-bang. Order by *foundational-first, risky-last*:
   1. `config`/`contracts`/`db` packages + gateway (no user-facing change)
   2. **auth** (reference implementation: zod + Drizzle + rate-limit + tests end-to-end)
   3. **companies → users → folders/folderAccess** (core domain, high reuse)
   4. **uploads · requests · messages · reminders · activity**
   5. **reports** (manual-gl, key-reports) — decompose the 9,088-line service here
   6. **quickbooks** (largest external surface; 36 files)
   7. **extraction** last → then extract it as microservice #1 (queue-backed)
3. **Data during cutover.** New modules read/write the **same Postgres** via Drizzle (introspected schema), so legacy and new operate on one database — no data migration, no dual-write. Drizzle owns *new* migrations going forward; the old 76-file set is frozen and consolidated into a Drizzle baseline.
4. **Per-domain Definition of Done:** contract published · Drizzle repository · service + router · vitest/supertest ≥ agreed coverage · gateway flipped · legacy code deleted · dashboards/logs green for 1 week.

## 6. Frontend migration (incremental, in-place — pending confirmation)

- Add TS with `allowJs: true`; rename leaf modules (`lib/`, `services/`) to `.ts` first.
- Consume `packages/contracts` types immediately → delete the corresponding hand-typed shapes in `api.js`.
- Introduce `@tanstack/react-query`; migrate data calls off the monolithic `api.js` per feature.
- **Decompose god-components as you touch them** (`WorkspaceCimPrep` 5,055, `WorkspaceReconciliation` 3,788, `FileExplorer` 2,832).
- Convert `.jsx` → `.tsx` feature-by-feature; strict mode last.

## 7. Phased roadmap

| Phase | Duration (est.) | Deliverables |
|---|---|---|
| **0 — Harness** | 1–2 wk | Monorepo (pnpm+turbo); `packages/config` (tsconfig/eslint/prettier); `apps/api` gateway forwarding 100% to legacy; CI (typecheck+lint+test+`npm audit`) green |
| **1 — Foundations** | 2–3 wk | `packages/db` (Drizzle, introspected from prod) + `packages/contracts`; **auth** domain rebuilt end-to-end as reference; rate-limit + helmet + pino live on new API |
| **2 — Domain cutover** | ongoing | Domains rebuilt + gateway-flipped in the Section 5 order; legacy code deleted per domain; god-files decomposed; FE features migrated in parallel |
| **3 — Harden & extract** | ongoing | Strict TS (`noImplicitAny`); coverage targets; extract **extraction** service behind a queue; retire `legacy/` |

## 8. Risks & mitigations

- **Parallel rewrite divergence / double-maintenance** → keep phases short; freeze legacy features (bug-fixes only) once a domain's rewrite starts; gateway makes cutover reversible.
- **Schema drift between legacy & new** → single shared Postgres; Drizzle introspection as source of truth; no dual-write.
- **God-file complexity underestimated** → decompose *before* typing; treat the 9k GL service and 5k CIM component as their own scoped efforts.
- **Scope creep into microservices** → hard rule: no service extraction until a module is fully typed, tested, and boundary-clean.
- **Auth regressions during cutover** → auth is the reference domain, done first, with the fullest test suite; canary via gateway before 100% flip.

## 9. Immediate next step (Phase 0)

Scaffold the monorepo on a branch: `pnpm-workspace.yaml` + `turbo.json`, `packages/config` (shared `tsconfig.base.json`, eslint, prettier), an empty `apps/api` gateway that transparently proxies to the current backend, and a GitHub Actions workflow. This is additive and ships nothing user-facing — the existing app keeps running unchanged.

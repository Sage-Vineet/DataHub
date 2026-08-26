## Context

See `proposal.md`. Legacy lives in `backend/src/{routes,controllers,services}/compan*` (see the domain map). Key complexity: a **client-representative sync** side effect (creates/updates a `buyer` user), **default-folder provisioning** (22 folders), a **4-step cascade delete** across 17+ tables, request-count **stats**, profit-metric normalization, and a Supabase→`pg` fallback we collapse into one Drizzle path. Reuses the module blueprint from `auth`.

## Goals / Non-Goals

**Goals:** parity behavior for `/api/companies`, one typed data path, boundaries respected, fully testable without a DB.

**Non-Goals:** migrating users/folders/requests here; changing the cascade's *effect* (only its implementation).

## Decisions

### D1 — Reuse the module blueprint
`modules/companies/` = contract + ports + service + `repository.drizzle.ts` + `repository.memory.ts` + router + tests. Copy `auth` structure.

### D2 — Promote the shared guards (`canAccessCompany` + `requireSession`)
Two engine-agnostic guards move to `apps/api/src/shared/`, so every domain uses one implementation:
- `access.ts` — `canAccessCompany` (already in `modules/auth/service.ts`), a pure function over the `SessionUser`. The single most-reused rule in the app.
- `session.ts` — `requireSession`, an Express middleware that resolves the **Better Auth** session (cookie or bearer) and populates `req.user: SessionUser`. It wraps `requireBetterAuth`/`resolveSessionUser` from `modules/auth/better-session.ts` so domains depend on the shared guard, not the auth module internals or the retiring bespoke `requireAuth` ([ADR-0007](../../../docs/adr/0007-auth-library-vs-bespoke.md)). The Better Auth instance is created once (in `server.ts`) and injected, so a domain router just does `router.use(requireSession)` then reads `req.user`.

### D3 — Cross-domain side effects via ports, not direct calls
Company create/update must sync a client-rep **user** and provision **folders** — other domains. Define `UserProvisioningPort` and `FolderProvisioningPort` interfaces in `modules/companies/ports.ts`. Back them with **legacy adapters** now (call the existing services), and swap to the real `users`/`folders` module services once those land — no contract change. This keeps the "cross-module only via service interfaces" rule.

### D4 — Cascade delete in one transaction
Port the 4-step cascade into a single Drizzle transaction in the repository (nested tables → company-keyed tables in FK order → null `users.company_id` → delete company). This is the riskiest task: cover it with a test that seeds a company with dependents and asserts they're all gone and the tx is atomic. *Fallback:* if reimplementing the full cascade is too risky for the first cut, delegate delete to the legacy service via a port and migrate it in a follow-up — but prefer the transaction.

### D5 — Stats as a read port
Request counts come from the `requests` table (another domain). Expose a `CompanyStatsPort` (a read query) rather than reaching into that table from the companies repository, keeping the boundary explicit. A read-only join is acceptable behind that port.

### D6 — Drop the Supabase/pg fallback
The repository uses Drizzle only. The legacy circuit-breaker/fallback complexity is not ported — the single typed path is the point ([ADR-0002](../../../docs/adr/0002-drizzle-data-layer.md)).

## Risks / Trade-offs

- **Cascade correctness** → transaction + a dedicated seed-and-delete test; keep the legacy path as rollback until soaked.
- **Side-effect coupling to users/folders** → ports + legacy adapters decouple ordering; those domains can migrate independently.
- **Historical company inference** (brokers with empty `user_companies`) is a *users* concern — out of scope here; the shared access guard reads `company_ids` as provided.
- **Stats crossing a boundary** → read port keeps it explicit; revisit when `requests` migrates.

## Migration Plan

1. Contracts + fuller `packages/db` companies schema (reconcile via `db:pull`).
2. Shared access guard; provisioning + stats ports with legacy adapters.
3. Repository (Drizzle + in-memory) incl. transactional cascade; service with the rules; router with validation + guards.
4. Tests to ≥90% (list scoping, create+provision, update parity, cascade delete, tenant denial, profit normalization).
5. Mount at `/api/companies` behind `COMPANIES_MODULE_ENABLED`; soak; delete legacy handlers.
- **Rollback:** flag off → legacy serves `/api/companies`.

## Open Questions

- Port vs reimplement the cascade for the first cut (D4) — default to the transaction; decide if scope balloons.
- Whether the client-rep sync stays a port or moves fully into the `users` module when it lands (likely the latter).

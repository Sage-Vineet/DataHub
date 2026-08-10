# ADR-0002 — Drizzle ORM as the single data-access layer

- **Status:** Accepted (2026-08-07)
- **Deciders:** CTO / platform
- **Implemented by:** planned (Phase 1 — `packages/db`)

## Context

The backend accesses Postgres through **two parallel strategies**: the Supabase client (`supabase.from(...)`, ~20 services) *and* raw `pg` pools (9 independent `new Pool()` sites, 4 created inline in `server.js`). They have different timeout and error-handling behavior and no shared source of truth. Schema is equally fragmented: two `schema.sql` files, **76 migrations with 19 duplicate numbers**, and runtime `CREATE TABLE IF NOT EXISTS` at boot. The audit named this the **#1 architectural liability**.

## Decision

Introduce **Drizzle ORM** as the single typed data-access layer in `packages/db`, introspected from the live Postgres (`drizzle-kit pull`). Drizzle owns migrations going forward; the legacy 76-file set is frozen and consolidated into a Drizzle baseline. New modules read/write the same database via Drizzle — no dual-write, no data migration during cutover.

## Reasons

- **One typed path** replaces the Supabase-vs-`pg` split — removes the cognitive and operational hazard.
- **SQL-first with strong inference** — queries stay legible; result types are inferred, not hand-maintained.
- **Owns migrations** — a real, ordered migration history replaces duplicate-numbered files and runtime table creation.
- **Introspection** — `drizzle-kit pull` derives the schema from production, so the model matches reality on day one.
- **Same database during cutover** — legacy and new code share one Postgres, so domains move without data migration ([ADR-0003](0003-parallel-rewrite-behind-gateway.md)).

## Alternatives considered

- **Standardize on the Supabase client only** — rejected: weaker typing, ties data access to a vendor SDK, poor fit for complex reporting SQL.
- **Prisma** — rejected: heavier runtime/engine, less transparent SQL; Drizzle's SQL-first model suits the financial-reporting queries better.

## Consequences

- A one-time introspection + baseline effort; the old migrations are archived, not deleted.
- Repositories become the only place raw SQL lives (per [ADR-0004](0004-modular-monolith.md)).

## References

- `docs/MODERNIZATION_PLAN.md` §4 (standard-deps table)
- Audit: dual-path data access, fragmented schema/migrations

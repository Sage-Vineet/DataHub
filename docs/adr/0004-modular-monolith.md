# ADR-0004 — Modular monolith with typed module boundaries

- **Status:** Accepted (2026-08-07)
- **Deciders:** CTO / platform
- **Implemented by:** convention (enforced per domain from Phase 1)

## Context

The current backend has no consistent layering — controllers reach into the database and carry business logic (`messages.js` ~891 lines, `activity.js` ~778 lines), and services grow without bound (`manualGlMultiYearService.js` is **9,088 lines**). The program wants the *option* to extract microservices (notably the AI extraction pipeline) without committing to distributed-systems overhead now.

## Decision

Build a **modular monolith**. Each `apps/api/modules/<domain>` contains `router` + `service` + `repository` + a zod `contract` + tests. **Cross-module communication happens only through typed `service` interfaces** — never by reaching into another module's repository or DB tables.

## Reasons

- **Boundaries now, distribution later** — the single "talk only through service interfaces" rule means any module can be lifted behind an HTTP/queue adapter **with no contract change**.
- **Testability** — thin routers + isolated services + repositories are unit-testable without booting Express, directly enabling [ADR-0005](0005-testing-and-coverage-standard.md).
- **Kills god-files** — the 9,088-line service is decomposed as its domain is rebuilt, not carried forward.
- **No premature microservices** — avoids network boundaries, eventual consistency, and deployment sprawl until load/ownership actually justifies them.

## Alternatives considered

- **Microservices from the start** — rejected: distributed-systems cost with no current scaling pressure; slows the rewrite.
- **Keep the layered-but-loose structure** — rejected: it is exactly what produced the god-files and logic-in-controllers.

## Consequences

- Raw SQL is allowed only in repositories (via `packages/db`, [ADR-0002](0002-drizzle-data-layer.md)).
- Hard rule: **no service extraction until a module is fully typed, tested, and boundary-clean.** The extraction pipeline is the intended first service.

## References

- `docs/MODERNIZATION_PLAN.md` §3 (module anatomy)
- Audit: god-files, controller logic bleed

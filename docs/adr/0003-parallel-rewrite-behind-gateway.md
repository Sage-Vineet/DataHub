# ADR-0003 — Parallel rewrite behind a gateway seam

- **Status:** Accepted (2026-08-07)
- **Deciders:** CTO / platform
- **Implemented by:** commit `8a1fd22` (gateway); ongoing per domain

## Context

The backend is 100% JavaScript, untested, and structured with business logic bleeding into controllers. It must become typed and modular, but it is also a **live product** — a big-bang rewrite would be unshippable and unreviewable. We need a way to replace it one domain at a time, with the ability to roll back instantly if a rewritten domain misbehaves.

## Decision

Rewrite the backend **in parallel** as new TypeScript modules in `apps/api`, fronted by a **gateway** (`apps/api`, Express + `http-proxy-middleware`). The gateway resolves each request against an **env-driven routing table** that defaults **100% → legacy**. Each domain is cut over by adding one route-group entry; reverting the entry is an instant rollback. The frontend, by contrast, migrates **incrementally in place** (not a parallel UI rewrite).

## Reasons

- **Reversibility** — cutover/rollback is a deploy-config change, not a code deploy; risk per domain is bounded.
- **No big-bang** — legacy and new run side-by-side on one database ([ADR-0002](0002-drizzle-data-layer.md)); domains move on their own schedule.
- **The seam is reusable** — the same gateway that fronts legacy-vs-new today fronts extracted services tomorrow ([ADR-0004](0004-modular-monolith.md)).
- **Ships nothing on day one** — with the table empty, the gateway is a transparent no-op, so Phase 0 is safe and additive.
- **Frontend stays in place** — rewriting ~70k lines of working UI is high-cost/low-return; types benefit the SPA immediately either way.

## Alternatives considered

- **Strangler-in-place (convert files `.js`→`.ts` in the legacy tree)** — rejected: entangles typed and untyped code, hard to enforce boundaries, no clean rollback unit.
- **Infra proxy (nginx/Caddy) instead of an app gateway** — deferred: the routing table must be TypeScript-testable and colocated with the modules that replace legacy; an infra proxy can front `apps/api` later without changing this design.

## Consequences

- The gateway is a required network hop (sub-ms, streaming) until legacy is fully retired.
- Gateway behavior is spec'd and tested (default→legacy, header integrity, streaming, health, upstream failure): `openspec/changes/phase-0-harness/specs/platform/api-gateway/spec.md`.

## References

- `apps/api/src/{routing,gateway,server}.ts` and tests
- `docs/MODERNIZATION_PLAN.md` §5 (parallel-rewrite mechanics)

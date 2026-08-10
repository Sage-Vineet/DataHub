# Architecture Decision Records

Each ADR captures one significant decision: the **context** that forced it, the **decision**, the **reasons** it was chosen over alternatives, and the **consequences**. They are the durable "why" behind the DataHub re-architecture.

Format: [MADR](https://adr.github.io/madr/)-lite. Status is one of `Proposed` / `Accepted` / `Superseded`.

| # | Title | Status |
|---|---|---|
| [0001](0001-monorepo-pnpm-turborepo.md) | Monorepo on pnpm workspaces + Turborepo | Accepted |
| [0002](0002-drizzle-data-layer.md) | Drizzle ORM as the single data-access layer | Accepted |
| [0003](0003-parallel-rewrite-behind-gateway.md) | Parallel rewrite behind a gateway seam | Accepted |
| [0004](0004-modular-monolith.md) | Modular monolith with typed module boundaries | Accepted |
| [0005](0005-testing-and-coverage-standard.md) | 100% TypeScript + 90% coverage on new code | Accepted |
| [0006](0006-shadcn-design-system.md) | Reusable shadcn/ui design system | Proposed |

See also the program-level [`../MODERNIZATION_PLAN.md`](../MODERNIZATION_PLAN.md) and the [`../REARCH_LOG.md`](../REARCH_LOG.md) work log.

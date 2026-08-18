## Why

`@datahub/ui` exists and is proven (one modal migrated), but the value — killing duplicated UI in the god-components and seeding the frontend's TypeScript adoption — only lands as screens actually move onto it. This change is the **ongoing, incremental** frontend track: adopt the shared components screen-by-screen, convert `.jsx → .tsx` as files are touched, and decompose god-components in place. It runs in parallel to the backend Phase 2 domains and never blocks them.

**Track:** frontend (incremental in-place migration, [ADR-0003](../../../docs/adr/0003-parallel-rewrite-behind-gateway.md) / [ADR-0006](../../../docs/adr/0006-shadcn-design-system.md)). Behavior-preserving → `skip_specs`.

## What Changes

- **Modal sweep.** Replace hand-rolled `fixed inset-0` modals with `@datahub/ui` Dialog. `Users.jsx` alone has ~4 more (`UserFormModal`, `ExistingUserConfirmModal`, `InviteBrokerModal`, plus others across pages).
- **Primitive adoption.** Swap ad-hoc buttons/inputs/selects/tables/badges for `@datahub/ui` equivalents **as each screen is touched** — not a dedicated rewrite.
- **Incremental TypeScript.** Turn on `allowJs`, rename leaf `lib/`/`services/` modules to `.ts` first, then convert components `.jsx → .tsx` feature-by-feature; strict mode last.
- **Consume shared types.** Import types from `packages/contracts` to delete the hand-typed request/response shapes in the 1,647-line `api.js`.
- **Decompose god-components as touched.** Extract sub-components from `WorkspaceCimPrep.jsx` (5,055), `WorkspaceReconciliation.jsx` (3,788), `FileExplorer.jsx` (2,832) — in slices, never a big-bang rewrite.
- **(Optional) `@tanstack/react-query`** introduced per feature to migrate data calls off `api.js`.

## Impact

- **`apps/web` files**, touched incrementally; new dev deps (`typescript`, `@types/*`, optionally `@tanstack/react-query`); a `tsconfig.json` with `allowJs`.
- **No backend, routing, or global-state architecture change.** No visual redesign.
- **Branch:** `ba/rearch`; `main` frozen.

## Non-goals

- **No redesign or rebrand** — visual parity is the bar (tokens already match via the shared preset).
- **No big-bang page rewrites** — god-components are decomposed only as they're touched.
- **No forced full-app TS conversion in one pass** — strict mode is the *last* step, not the first.
- **No backend/API changes.**

## Status

**Not started — 0/19 tasks (18 Aug 2026).** `@datahub/ui` exists and is proven on one
migrated modal; what remains is the adoption sweep. No blocker recorded — this is
unscheduled rather than blocked, and can start whenever frontend capacity exists.

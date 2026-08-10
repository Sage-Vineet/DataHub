# ADR-0006 — Reusable shadcn/ui design system

- **Status:** Proposed (2026-08-07) — not yet scheduled; a later frontend change
- **Deciders:** CTO / frontend

## Context

The frontend is ~70k lines with god-components (`WorkspaceCimPrep.jsx` 5,055 lines, `WorkspaceReconciliation.jsx` 3,788, `FileExplorer.jsx` 2,832) and no shared component library — UI patterns are copy-pasted across the `Workspace*` pages, which is untestable and high-change-risk. The CTO wants to move to reusable UI modules that **match the current look ~90%**.

## Decision

Adopt **shadcn/ui** (Radix primitives + Tailwind, copy-in components) as the reusable design system, rebuilt to match the existing visual language to roughly 90%. Migrate god-components onto these primitives incrementally, as each frontend feature is touched during its TS migration.

## Reasons

- **Own the components** — shadcn copies source into the repo (not a black-box dependency), so they're themeable, testable, and versionable — a fit for the existing custom Tailwind theme.
- **~90% look match, not a redesign** — keep user-facing continuity; this is a maintainability refactor, not a rebrand.
- **Kills UI duplication** — one tested `Table`/`Dialog`/`FileTree` replaces N hand-rolled copies, shrinking the god-components.
- **Accessibility for free** — Radix primitives bring keyboard/ARIA behavior the hand-rolled UI lacks.
- **Composes with the incremental FE migration** — components convert to `.tsx` as features are touched (per [ADR-0003](0003-parallel-rewrite-behind-gateway.md)); no separate UI rewrite.

## Alternatives considered

- **MUI / Chakra / Ant** — rejected: heavier runtime, opinionated theming that fights the existing custom look, harder to hit a 90% match.
- **Keep bespoke components** — rejected: that is the source of the duplication and god-components today.

## Consequences

- A design-system change proposal (`/opsx:propose`) will scope the component inventory, theming tokens, and per-page migration order **before** any UI work.
- Explicitly a **non-goal of Phase 0** — the SPA was relocated unchanged; no visual refactor happened yet.

## References

- Audit: god-components, ~70k-line frontend
- `docs/MODERNIZATION_PLAN.md` §6 (frontend migration)

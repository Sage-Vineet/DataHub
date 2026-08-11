## Context

See `proposal.md`. `apps/web` is React 19 + Vite, still `.jsx`, ~70k lines with god-components. `@datahub/ui` (`.tsx`, source-consumed) and the shared Tailwind preset are already wired in; Vite transpiles the `.tsx`. This is a long-running track, so the design is about *how to move safely and continuously*, not a one-shot plan.

## Goals / Non-Goals

**Goals:** steadily replace duplicated UI with shared components, begin TS adoption, and shrink god-files — with zero visual/functional regressions and no dedicated "migration freeze".

**Non-Goals:** redesign; a single mass conversion; changing routing/state management.

## Decisions

### D1 — Adopt as you touch, not a migration sprint
Every PR that modifies a screen swaps that screen's primitives to `@datahub/ui` and (where reasonable) converts the file to `.tsx`. This keeps the blast radius per PR small and the app always shippable.

### D2 — TypeScript in dependency order
Add `tsconfig.json` with `allowJs: true` so `.js` and `.ts` coexist. Convert **leaf modules first** (`lib/`, `services/` — no JSX), then components feature-by-feature. Turn on `strict` only at the end, per-area, once the noise is low.

### D3 — Types flow from the packages
Consume `packages/contracts` (zod-inferred) types at the API boundary and delete the hand-maintained shapes in `api.js`. This is the highest-leverage TS win and removes FE/BE drift.

### D4 — Decompose god-components in slices
When touching `WorkspaceCimPrep`/`WorkspaceReconciliation`/`FileExplorer`, extract the section you're working on into its own component/file. Never rewrite the whole page in one PR — extract, verify, ship, repeat.

### D5 — Data fetching (optional, per feature)
Introduce `@tanstack/react-query` one feature at a time, moving that feature's calls off the monolithic `api.js`. Don't rip out `api.js` wholesale.

### D6 — Parity is the acceptance bar
Each migrated screen is checked side-by-side against the previous build; tokens already match via the shared preset, so appearance should be unchanged. Functionality must be identical.

## Risks / Trade-offs

- **Scope creep into redesign** → hard non-goal; reviewers reject visual changes in adoption PRs.
- **Half-migrated `api.js`** → migrate per feature and keep the old client working until a feature is fully moved.
- **TS friction on huge files** → `allowJs` + leaf-first keeps each step small; strict mode is deferred.
- **Inconsistent adoption across the team** → the CONTRIBUTING checklist + code review keep it uniform.

## Migration Plan

1. Enable `allowJs` TS in `apps/web`; convert a couple of leaf `lib/`/`services/` modules to `.ts` as the pattern.
2. Modal sweep: migrate the remaining `Users.jsx` modals, then other pages' modals, to `@datahub/ui` Dialog.
3. Adopt primitives on each screen as it's touched; track progress in a simple checklist.
4. Consume `packages/contracts` types; delete duplicated shapes in `api.js`.
5. Decompose a first slice of one god-component to set the example.
6. (Optional) introduce react-query on one feature.
- **Rollback:** each PR is independent and revertable; `@datahub/ui` is additive.

## Open Questions

- Whether to adopt `@tanstack/react-query` now or defer — depends on team appetite; not required for the rest of the track.
- Order of screens — suggest starting with the ones Phase 2 backend work will touch anyway (users, companies, folders) to compound the effort.

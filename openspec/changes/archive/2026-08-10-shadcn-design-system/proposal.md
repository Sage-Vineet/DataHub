## Why

The frontend has no shared component library, so UI patterns are copy-pasted across the `Workspace*` god-components (`WorkspaceCimPrep.jsx` 5,055 lines, `WorkspaceReconciliation.jsx` 3,788, `FileExplorer.jsx` 2,832) — untestable and high-change-risk. A reusable **shadcn/ui** design system replaces those hand-rolled primitives with owned, tested, accessible components, **rebuilt to match the current look ~90%+** so users see continuity, not a redesign. This is [ADR-0006](../../../docs/adr/0006-shadcn-design-system.md), and it seeds the frontend's incremental TypeScript adoption at the UI layer.

**Track:** frontend design-system (a supporting layer under the incremental FE migration, [ADR-0003](../../../docs/adr/0003-parallel-rewrite-behind-gateway.md)). Belongs to no backend domain.

## What Changes

- **`packages/ui` (new, TypeScript).** The reusable design-system package consumed by `apps/web` (and future apps). shadcn/ui components (Radix + Tailwind, copy-in source we own): **Button, Input, Label, Card, Dialog, Select, DropdownMenu, Table, Tabs, Toast, Badge, Tooltip, Skeleton** — the primitives the god-components duplicate.
- **`packages/ui` Tailwind preset (theme parity).** Extract the current theme from `apps/web/tailwind.config.js` (primary `#8BC53D`, `primary-dark #476E2C`, `secondary #6D6E71`, the semantic tokens `bg-page/bg-card/border/text-primary/text-muted`, the `green/orange/purple/navy/blue/pink/neutral` scales, Inter font, `card` radius `12px` + shadows) into a **shared preset** consumed by BOTH `packages/ui` and `apps/web`. shadcn CSS variables map to these tokens so components match ~90%+.
- **Component gallery + tests.** A gallery to view/QA components in isolation, plus `vitest` + `@testing-library/react` tests to the coverage standard ([ADR-0005](../../../docs/adr/0005-testing-and-coverage-standard.md)). Accessibility comes from Radix.
- **Adoption proof (incremental).** Migrate ONE representative surface — a **Dialog** and the **broker Users table** — onto the new components to prove drop-in visual + functional parity. Broad page migration is follow-on as features are touched; god-components are decomposed only when touched.
- **`apps/web` consumes `@datahub/ui` `.tsx`** via Vite (which transpiles TSX), beginning FE TypeScript adoption without converting existing `.jsx`.

## Capabilities

### New Capabilities
- `design-system`: the reusable UI component layer as observable behavior — theme-token parity with the current look, accessible interactive primitives (keyboard + ARIA via Radix), and behavior-preserving drop-in adoption on migrated surfaces.

### Modified Capabilities
<!-- None. -->

## Impact

- **New:** `packages/ui/**` (components, preset, gallery, tests, tsconfig/eslint), plus `apps/web` wiring to consume the shared preset + a first migrated surface. New deps: Radix primitives, `class-variance-authority`, `clsx`, `tailwind-merge`, `@testing-library/react` (dev).
- **`apps/web/tailwind.config.js`** switches to `presets: [uiPreset]` (same tokens; no visual change).
- **No backend, routing, or state-management changes.**
- **Branch:** `ba/rearch`; `main` frozen.

## Non-goals

- **No visual redesign or rebrand** — keep the current look; parity is the acceptance bar.
- **No wholesale migration** of all pages / god-components now — one proof surface; the rest is incremental.
- **No styling-approach change** — stays Tailwind (not CSS-in-JS).
- **No backend / API / routing / global-state changes.**

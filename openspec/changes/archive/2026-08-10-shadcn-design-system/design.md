## Context

See `proposal.md` — Why. `apps/web` is React 19 + Vite + Tailwind (custom theme in `apps/web/tailwind.config.js`), still `.jsx`. The monorepo already ships `.tsx`-source workspace packages consumed without a build step (contracts/db pattern via the `exports` map). Radix + Tailwind (shadcn) is the chosen system ([ADR-0006](../../../docs/adr/0006-shadcn-design-system.md)). The overriding constraint is **visual parity** — this is a maintainability refactor, not a redesign.

## Goals / Non-Goals

**Goals:**
- One shared, tested, accessible component set styled to the current tokens.
- A single source of theme tokens for both the library and the app.
- Prove drop-in parity on one real surface before broad adoption.

**Non-Goals (design-level):**
- Not adopting shadcn's default palette/variable theme (we override to our tokens).
- Not converting existing `.jsx` pages to `.tsx` (only new `.tsx` in `packages/ui`).
- Not introducing a heavy Storybook install if a lighter gallery suffices.

## Decisions

### D1 — `packages/ui` as an owned, shared TS package
Rather than shadcn's per-app "copy components into `src/components/ui`" model, put the components in a **shared `packages/ui`** (TypeScript, `.tsx`) consumed by `apps/web` and future apps — this is the "reusable modules" requirement. We still *own* the source (copy-in, editable), we just centralize it. Consumed via the `exports` map pointing at source `.tsx` (no build step), same as `@datahub/contracts`.

### D2 — Style with the existing Tailwind tokens, not shadcn's HSL variables
Standard shadcn themes via CSS variables (`--primary` in HSL) defaulting to a zinc palette. To guarantee ~90%+ parity, we **skip that indirection**: extract the current theme into a shared **Tailwind preset** (`packages/ui/tailwind-preset`), and style components with the existing token classes (`bg-primary`, `text-text-primary`, `rounded-card`, `shadow-card`, etc.) via `cva` variants. `apps/web/tailwind.config.js` switches to `presets: [uiPreset]` with the same tokens — zero visual change. *Trade-off:* less "vanilla shadcn," but exact palette parity, which the user prioritized. *Alternative* (map hex→HSL into shadcn vars) rejected: a translation layer that risks drift for no benefit here.

### D3 — Variants via cva + `cn()`
Use `class-variance-authority` for variant APIs and a `cn()` helper (`clsx` + `tailwind-merge`) for class composition — the standard shadcn utilities, kept.

### D4 — Lightweight gallery, not full Storybook (default)
Provide a small **Vite-powered gallery** in `packages/ui` (an `index.html` + entry that renders each component's states) for isolation QA, avoiding Storybook's large dependency tree. *Alternative:* Storybook — offer as a follow-on if richer docs/interaction testing are wanted; not required to satisfy the spec's "viewable in isolation."

### D5 — Testing: vitest + Testing Library + jsdom
`packages/ui` tests run under vitest with `environment: jsdom` and `@testing-library/react`, covering render + the accessibility behaviors the spec names (Dialog focus-trap/Escape, menu keyboard nav). Coverage meets the ADR-0005 gate; a11y behaviors come from Radix but are asserted here.

### D6 — Adoption proof, minimal blast radius
Migrate exactly two things to prove parity: a **Dialog** instance and the **broker Users table** (`apps/web/src/pages/broker/Users.jsx`). Swap only the primitives (table shell, dialog) — do NOT rewrite the 1,397-line page. This validates that a `.jsx` page can consume `@datahub/ui` `.tsx` through Vite and that behavior/appearance are preserved.

## Risks / Trade-offs

- **Visual parity drift** → tokens come verbatim from the current config; QA each migrated surface side-by-side against the pre-change build; parity is the acceptance bar.
- **`.tsx` consumed from `.jsx` via Vite** → Vite transpiles TSX natively; verified by the adoption-proof build. No app-wide TS switch needed.
- **Bundle growth** → Radix is tree-shakeable and imported per-component; the gallery is dev-only.
- **Two Tailwind configs diverging** → eliminated by the shared preset (single token source).
- **Scope creep into a redesign** → hard non-goal; only parity + the two proof surfaces are in scope.

## Migration Plan

1. Scaffold `packages/ui` + shared preset; point `apps/web` at the preset (no visual change).
2. Add components + `cn()`/cva; add gallery; add tests.
3. Migrate the Dialog + Users table; verify parity (visual + behavior) and that `pnpm build` for web still succeeds.
4. `typecheck/lint/test/build` green; coverage met; docs.
- **Rollback:** `apps/web` can revert to its own `tailwind.config.js` and legacy markup; `packages/ui` is additive.

## Open Questions

- Postgres-style: none. Gallery tech (lightweight vs Storybook) — decided lightweight; revisit only if the team wants interaction docs. Does not affect the spec or component APIs.

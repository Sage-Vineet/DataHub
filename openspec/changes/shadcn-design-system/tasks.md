## 1. `packages/ui` scaffold

- [ ] 1.1 Create `packages/ui` (TypeScript, consumes `@datahub/config`); `exports` map points at source `.tsx` (no build step, contracts/db pattern)
- [ ] 1.2 Add deps: `class-variance-authority`, `clsx`, `tailwind-merge`, the needed `@radix-ui/react-*` primitives; dev: `vitest`, `@vitest/coverage-v8`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`, `react`/`react-dom` (peer)
- [ ] 1.3 Add `tsconfig.json` (extends shared base; jsx: react-jsx), `eslint.config.js`, `vitest.config.ts` (environment jsdom), and the `cn()` util (`clsx` + `tailwind-merge`)

## 2. Shared Tailwind preset (theme parity)

- [ ] 2.1 Extract the current theme from `apps/web/tailwind.config.js` into `packages/ui/tailwind-preset.(js|ts)` — colors (`primary #8BC53D`, `primary-dark #476E2C`, `secondary #6D6E71`, `bg-page/bg-card/border/border-light/text-primary/text-muted`, the `green/orange/purple/navy/blue/pink/neutral` scales), `fontFamily.sans = Inter`, `boxShadow.card/hover/sidebar`, `borderRadius.card = 12px`
- [ ] 2.2 Point `apps/web/tailwind.config.js` at `presets: [uiPreset]` and set `content` to also scan `packages/ui/src`; confirm the web build is visually unchanged
- [ ] 2.3 Ensure `packages/ui` components can be scanned by consumers' Tailwind (documented content-glob)

## 3. Components (styled to current tokens)

- [ ] 3.1 Primitives: Button, Input, Label, Badge, Skeleton (cva variants using existing token classes — `bg-primary`, `text-text-primary`, `rounded-card`, `shadow-card`)
- [ ] 3.2 Surfaces: Card, Table (with header/row/cell parts)
- [ ] 3.3 Interactive (Radix-backed): Dialog, Select, DropdownMenu, Tabs, Tooltip, Toast
- [ ] 3.4 Barrel `src/index.ts` exports every component + `cn()`

## 4. Gallery

- [ ] 4.1 Lightweight Vite gallery in `packages/ui` (`index.html` + entry) rendering each component's primary states
- [ ] 4.2 A `gallery` script; documented in the package README

## 5. Tests (coverage standard)

- [ ] 5.1 Render tests for each component (variants render, correct token classes applied)
- [ ] 5.2 A11y behavior: Dialog traps focus + closes on Escape (restores focus); DropdownMenu/Select keyboard navigation + roles (spec: accessible primitives)
- [ ] 5.3 Confirm `packages/ui` coverage meets the configured threshold

## 6. Adoption proof (parity)

- [ ] 6.1 Replace one Dialog instance in `apps/web` with `@datahub/ui` Dialog — behavior + look preserved
- [ ] 6.2 Migrate the broker Users table (`apps/web/src/pages/broker/Users.jsx`) onto the `@datahub/ui` Table — same rows/columns/actions, no behavior loss (swap primitives only; do NOT rewrite the page)
- [ ] 6.3 Side-by-side visual QA vs the pre-change build; confirm ~90%+ parity

## 7. Verify & docs

- [ ] 7.1 Full `turbo run typecheck lint test build` green; `apps/web` build succeeds consuming `@datahub/ui` `.tsx`
- [ ] 7.2 `packages/ui` coverage meets the gate (ADR-0005)
- [ ] 7.3 `packages/ui/README` (usage + token map) + `docs/REARCH_LOG.md` entry; note Storybook as an optional follow-on

## 8. Wrap up

- [ ] 8.1 `openspec validate shadcn-design-system --strict` passes
- [ ] 8.2 Confirm no backend/routing/state changes and `main` untouched; commit on `ba/rearch` with Conventional Commits

## Notes

- Parity is the acceptance bar — tokens are taken verbatim from the current config; no redesign.
- Broad page/god-component migration is intentionally out of scope (incremental, per ADR-0003); this change ships the library + one proof surface.

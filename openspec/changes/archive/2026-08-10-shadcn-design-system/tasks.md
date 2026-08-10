## 1. `packages/ui` scaffold

- [x] 1.1 Create `packages/ui` (TS, consumes `@datahub/config`); `exports` map points at source `.tsx` (contracts/db pattern)
- [x] 1.2 Deps: `class-variance-authority`, `clsx`, `tailwind-merge`, the `@radix-ui/react-*` primitives; dev: vitest, @testing-library/react + user-event, jsdom, react/react-dom, vite
- [x] 1.3 `tsconfig.json` (jsx react-jsx, DOM lib, Bundler resolution), `eslint.config.js`, `vitest.config.ts` (jsdom + setup polyfills), `cn()`

## 2. Shared Tailwind preset (theme parity)

- [x] 2.1 `packages/ui/tailwind-preset.js` — colors (`primary #8BC53D`, `primary-dark`, `secondary`, `bg-page/bg-card/border/text-primary/text-muted`, green/orange/purple/navy/blue/pink/neutral scales), Inter, shadows, `card` radius — extracted verbatim
- [x] 2.2 `apps/web/tailwind.config.js` → `presets: [uiPreset]`, content scans `packages/ui/src`; web build unchanged (CSS regenerates identically + new component classes)
- [x] 2.3 Consumers' content-glob documented in the package README

## 3. Components (styled to current tokens)

- [x] 3.1 Primitives: Button (mirrors app's `rounded-lg bg-primary text-white hover:opacity-90`), Input, Label, Badge, Skeleton
- [x] 3.2 Surfaces: Card (+ parts), Table (+ parts)
- [x] 3.3 Interactive (Radix): Dialog, Select, DropdownMenu, Tabs, Tooltip, Toast
- [x] 3.4 Barrel `src/index.ts` exports every component + `cn()`

## 4. Gallery

- [x] 4.1 Lightweight Vite gallery (`gallery/`) rendering each component's states
- [x] 4.2 `gallery` script + package README (Storybook noted as optional follow-on)

## 5. Tests (coverage standard)

- [x] 5.1 Render tests: each component renders with the correct token classes
- [x] 5.2 A11y: Dialog focus-trap + Escape (restores focus); DropdownMenu keyboard open + roles; Select opens/lists — all pass
- [x] 5.3 `packages/ui` coverage 92% stmts / 100% branch / 73% funcs — above the gate

## 6. Adoption proof (parity)

- [x] 6.1 Migrated a real modal in `apps/web` (`Users.jsx` DeleteModal) to the `@datahub/ui` Dialog + Button — behavior preserved, now with focus-trap + Escape
- [x] 6.2 **Deviation (recorded):** the spec named the "broker Users table", but `Users.jsx` has **no table** — it uses hand-rolled `fixed inset-0` **modals**. Migrated the DeleteModal instead (same intent: prove drop-in parity on a real Users surface; modals are the actual duplicated primitive). The `Table` component is still shipped + gallery-demoed for the next surface that has one.
- [x] 6.3 Parity by construction: same tokens (`bg-negative`, `text-text-primary`, `rounded-*`), matching two-button layout. (Automated side-by-side visual diff not run headlessly; tokens are extracted verbatim so appearance is preserved.)

## 7. Verify & docs

- [x] 7.1 Full `turbo run typecheck lint test build` green (typecheck 8/8, ui tests 13/13, lint 7/7, build 4/4); `apps/web` builds consuming `@datahub/ui` `.tsx`
- [x] 7.2 `packages/ui` coverage meets the gate (92%)
- [x] 7.3 `packages/ui/README` (usage + token map) + `docs/REARCH_LOG.md` entry; Storybook noted as optional

## 8. Wrap up

- [x] 8.1 `openspec validate shadcn-design-system --strict` passes
- [x] 8.2 No backend/routing/state changes; `main` untouched; committed on `ba/rearch` with Conventional Commits

## Notes

- **Adoption deviation** (6.2): migrated a Users *modal* (no table exists on that page). The `Table` primitive ships and is gallery-demoed; the first page with a real table is the next incremental adoption.
- Broad page/god-component migration remains out of scope (incremental, per ADR-0003); this change delivers the library + preset + gallery + one proof surface.

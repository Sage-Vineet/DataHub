# @datahub/ui

Reusable design-system components for DataHub — shadcn/ui-style primitives (Radix + Tailwind) styled to the **existing** product look. Implements [ADR-0006](../../docs/adr/0006-shadcn-design-system.md).

## Usage

```tsx
import { Button, Dialog, DialogContent, Table } from "@datahub/ui";
```

The package is consumed as **source `.tsx`** (no build step) — Vite/vitest transpile it, exactly like `@datahub/contracts`/`@datahub/db`.

## Theming (parity)

`@datahub/ui/tailwind-preset` is the single source of design tokens (colors like `primary #8BC53D`, `bg-page`, `text-primary`, Inter font, `card` radius/shadows), extracted verbatim from the original app theme. Both the app and the library consume it:

```js
// tailwind.config.js
import uiPreset from "@datahub/ui/tailwind-preset";
export default {
  presets: [uiPreset],
  content: ["./src/**/*.{js,ts,jsx,tsx}", "../../packages/ui/src/**/*.{ts,tsx}"],
};
```

Components are styled with those token classes (e.g. `bg-primary`, `rounded-card`) rather than shadcn's default palette, so migrated surfaces match the current look ~90%+.

## Components

Button · Input · Label · Badge · Skeleton · Card · Table · Dialog · Tabs · Tooltip · DropdownMenu · Select · Toast. Interactive components are Radix-backed (keyboard + ARIA).

## Develop

```bash
pnpm --filter @datahub/ui gallery   # component gallery (Vite)
pnpm --filter @datahub/ui test      # vitest + Testing Library (jsdom)
```

Optional `@datahub/ui/styles.css` adds subtle overlay fade/zoom keyframes (components work without it).

> A richer Storybook is a possible follow-on; the lightweight gallery already satisfies "view each component in isolation".

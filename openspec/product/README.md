# Product surface register

The intended product: 98 features across 14 modules, from the `Centuriuum Product Listing`
and the 59 per-feature specification documents vendored at `docs/product/`.

**This is a register of intent, not a specification of the system.** It is deliberately
*outside* `openspec/changes/`, because it must never be synced into `openspec/specs/`.

## Why it lives here

`openspec/specs/` is the baseline: what the system **does**, today, in shipped code. A
change proposes a delta against that baseline, and archiving it folds the delta in. That
lifecycle is right for a domain migration and wrong for this material.

This register holds 448 requirements across 20 capabilities, and the large majority
describe features that do not exist yet. Filed as a change, its lifecycle would end in an
archive — and archiving syncs. The baseline would absorb all 448 in one step and become
roughly 90% aspiration, at which point "the spec says so" stops predicting "the system does
so". That property is the whole value of the baseline, so the register is kept structurally
incapable of contaminating it.

## The capability taxonomy

Two vocabularies describe this product, and they are **not** interchangeable:

| Register | Keyed by | Lives in | Answers |
|---|---|---|---|
| **Baseline** | migration-domain name — `auth`, `users`, `companies`, `folders`, `uploads`, `requests`, `messages`, `reports`, `activity-log`, `platform/*` | `openspec/specs/` | What does the system do now? |
| **Product surface** | product-module name — `access-control`, `qoe`, `cim`, `data-room`, `valuations`, `financial-data`, … | `openspec/product/specs/` | What should the product eventually be? |

Names overlap across the two, and that is expected — they are different views of the same
product. `activity-log` and `reports` appear in both; `users` here is `user-profiles`,
`folders` + `uploads` are `data-room`, `auth` + `companies` are `access-control`, and
`platform/*` is `platform-services`. Before this split they shared one namespace and
collided outright.

**Rule:** a capability name in `openspec/specs/` refers to the built system. The same name
here refers to the product surface. Never merge the two directories; reconcile them
explicitly in a change when the built system is meant to grow toward the surface —
`design.md` §D6 is the worked example, for `reports`.

## Fidelity

Recorded per capability, and per requirement where a capability is mixed. Each capability's
spec states its own fidelity in its header.

| Fidelity | Meaning | Coverage |
|---|---|---|
| **specified** | Derived from a feature specification document — functional requirements, dependencies, acceptance criteria | 59 features |
| **product-list detail** | No document, but a substantive multi-paragraph product-list summary | `VL - 0005` … `VL - 0010`, `DR - 0006` |
| **sketch** | A one-to-three sentence product-list row — enough to review scope, not enough to build from | remainder: all of `BR`, all of `BY`, all of `PJ`, `BK - 0001`, `DR - 0005`, `DR - 0008`, `DB - 0010`, `RP - 0003` |

39 features are still at sketch or product-list fidelity. Commissioning the missing
documents is tracked in `openspec/changes/centuriuum-product-surface/tasks.md` §4.7.

## Using it

- Cite the feature ID (`QE - 0004`, `SY - 0003`) in any requirement derived from this
  material, so it can be checked back against `docs/product/source/` in one step.
- IDs were renumbered twice. Trust the header ID, not the numbers inside a document body,
  and check Register A in `design.md` before citing one.
- `design.md` holds the analysis: fidelity ledger (§D3), the four gating capabilities (§D4),
  the recommended build order and where it departs from the modernization plan (§D5), the
  `reports` two-author overlap (§D6), and the computed dependency graph (§D7).
- Scheduling a sketch feature means writing it a real change at `data-retrieve-wizard`
  fidelity first.

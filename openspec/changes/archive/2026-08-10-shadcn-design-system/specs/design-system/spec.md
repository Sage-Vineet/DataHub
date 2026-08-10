## Purpose

A reusable UI component library (`@datahub/ui`) that gives DataHub a single, tested set of accessible primitives styled to the product's existing visual language, so feature code stops hand-rolling and duplicating UI. This spec fixes the guarantees the library must uphold: visual parity with the current look, accessible interaction, and behavior-preserving adoption.

## ADDED Requirements

### Requirement: Shared theme tokens drive appearance

The design system SHALL derive all component styling from a shared Tailwind preset that carries the product's current design tokens, and both the library and the web app SHALL consume that single preset.

#### Scenario: Components use the current palette
- **WHEN** a design-system component renders a primary action
- **THEN** it uses the existing primary token (`#8BC53D`) and matching foreground/hover tokens — not an ad-hoc or default shadcn color

#### Scenario: One source of tokens
- **WHEN** the web app and the component library are built
- **THEN** both resolve their theme from the same shared preset (colors, Inter font, `card` radius/shadows), so a token change updates both consistently

### Requirement: Visual parity with the current look

Components SHALL match the current visual language closely enough that migrated surfaces are not perceived as a redesign (target ≈90%+ fidelity on color, type, spacing, and radius).

#### Scenario: Migrated surface looks unchanged
- **WHEN** a surface is migrated from hand-rolled markup to design-system components
- **THEN** its palette, typography, corner radius, and card treatment visibly match the pre-migration appearance

### Requirement: Accessible interactive primitives

Interactive components (Dialog, Select, DropdownMenu, Tabs, Tooltip) SHALL provide keyboard operability and correct ARIA semantics.

#### Scenario: Dialog keyboard behavior
- **WHEN** a Dialog is open
- **THEN** focus is trapped within it and pressing Escape closes it, returning focus to the trigger

#### Scenario: Menu keyboard navigation
- **WHEN** a DropdownMenu or Select is open
- **THEN** it is navigable by arrow keys and exposes appropriate roles/aria attributes for assistive technology

### Requirement: Behavior-preserving adoption

Replacing hand-rolled UI with design-system components on a migrated surface SHALL preserve that surface's existing functionality.

#### Scenario: Users table parity after migration
- **WHEN** the broker Users table is migrated onto the design-system Table
- **THEN** the same rows, columns, and actions are present and function as before, with no loss of behavior

### Requirement: Components are documented and tested

Each component SHALL be viewable in isolation in a gallery and covered by automated tests meeting the project coverage standard.

#### Scenario: Gallery renders every component
- **WHEN** the component gallery is opened
- **THEN** each shipped component has an entry demonstrating its primary states

#### Scenario: Tests gate the library
- **WHEN** the CI test job runs
- **THEN** the design-system package's tests execute and its coverage meets the configured threshold

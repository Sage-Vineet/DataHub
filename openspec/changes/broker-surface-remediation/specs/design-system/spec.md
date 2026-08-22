## Purpose

The guarantees the shared component library must uphold about **action hierarchy and state**, as
distinct from the palette and accessibility guarantees the baseline already fixes.

The baseline requires that a primary action use the primary token (`#8BC53D`). Shipped screens do
not: green, navy, orange and blue are all used as the primary action, and the Deal Team page places
three filled buttons in three different colours on one small screen, none of which is the main
action. That is a conformance failure against an existing requirement rather than a gap in it.

What the baseline does not yet fix, and this delta adds, is the treatment of destructive actions
and the distinguishability of loading, empty and failed states — the two places where the audit
found the interface actively misleading rather than merely inconsistent.

## ADDED Requirements

### Requirement: One primary action per view

A view SHALL present at most one action styled as primary, and that action SHALL be the one the
view exists to perform. Secondary and tertiary actions SHALL use the corresponding tokens rather
than a different primary colour.

#### Scenario: A view with several actions

- **WHEN** a view offers more than one action
- **THEN** at most one is rendered as primary
- **AND** the remainder are rendered as secondary or tertiary

#### Scenario: Colour does not encode a second primary

- **WHEN** two actions of equal weight appear on one view
- **THEN** they are not distinguished by using two different filled accent colours

### Requirement: Destructive actions are treated as destructive and weighted below the main action

The design system SHALL provide a single destructive treatment, and a destructive action SHALL NOT
carry more visual weight than the view's primary action.

Observed today: the request detail renders a filled red `Block Request` and an outlined red
`Delete Request` as the two heaviest elements on the page, while `Save Request Details` — the
action the view exists to perform — is a modest button in the body. The Edit User dialog places
`Delete` immediately beside `Cancel`.

#### Scenario: A destructive action appears alongside a primary action

- **WHEN** a view offers both a primary action and a destructive one
- **THEN** the primary action carries the greater visual weight

#### Scenario: Destructive and dismissive actions are separated

- **WHEN** a dialog offers both a dismissive action and a destructive one
- **THEN** they are not adjacent, and are not styled alike

#### Scenario: One destructive treatment

- **WHEN** destructive actions appear anywhere in the product
- **THEN** they share one treatment drawn from the shared tokens

### Requirement: Loading, empty and failed states are distinguishable

The design system SHALL provide distinct treatments for in-progress, succeeded-but-empty, and
failed, and a surface SHALL NOT render one as another. A failed state SHALL state what failed and
offer a way forward.

The audit found all three collapsed in shipped screens: a 500 rendering as an indefinite
"Loading…"; a generation failure reverting silently to an empty prompt; and a failed contacts
lookup rendering as "No message groups yet".

#### Scenario: A retrieval fails

- **WHEN** a surface's data cannot be retrieved
- **THEN** it renders the failed state, naming what failed and offering a retry
- **AND** it does not remain in the loading state
- **AND** it does not render the empty state

#### Scenario: A retrieval returns nothing

- **WHEN** a surface's data is retrieved successfully and is empty
- **THEN** it renders the empty state, distinctly from the failed state

#### Scenario: One failure produces one message

- **WHEN** a single failure occurs
- **THEN** the surface reports it once, rather than stacking several messages describing it

### Requirement: Empty-state copy addresses the role reading it

Copy in an empty or failed state SHALL be written for the role that can see it, and SHALL NOT
instruct the reader to ask someone to do a thing the reader is the one who does.

Observed today: the broker, in their own workspace, is told "Groups are created automatically when
users are added to a deal. Try refreshing or ask your broker to add users."

#### Scenario: An empty state is shown to a broker

- **WHEN** an empty state renders in a broker's workspace
- **THEN** its copy addresses the broker

#### Scenario: Retrying is not offered as the explanation

- **WHEN** a surface has failed
- **THEN** the copy states what failed, rather than only inviting the reader to refresh

### Requirement: Filter chrome appears only where there is something to filter

A surface SHALL NOT present search and filter controls above an empty set.

Observed today: the Reminders page renders a search box and four filter dropdowns above zero
reminders that never finish loading; the workspace activity log renders a search box and a type
filter above "No activity yet".

#### Scenario: A list is empty

- **WHEN** a list has no items and none are being filtered out
- **THEN** its search and filter controls are not shown

#### Scenario: A filter produces no results

- **WHEN** a filter excludes every item
- **THEN** the controls remain, and the empty state says the filter is the reason

### Requirement: Rendered values are validated before display

Components that format values SHALL NOT render a failed format as text. Dates that cannot be parsed
SHALL render as unknown rather than as an error string, and counts SHALL agree in number with the
noun they qualify.

Observed today: `Joined Invalid Date` on the team member card, `1 items` on folder rows, and a
folder tile reading "3 items" where the tree reads "5 files" for the same folder.

#### Scenario: A date cannot be parsed

- **WHEN** a date value cannot be formatted
- **THEN** the component renders an unknown-value treatment, not the formatter's error output

#### Scenario: A count qualifies a noun

- **WHEN** a count is rendered with a noun
- **THEN** the noun agrees in number with the count

#### Scenario: The same collection is counted twice

- **WHEN** one collection is counted on two surfaces
- **THEN** both report the same number, or state plainly that they are counting different things

### Requirement: Semantic colour matches meaning

Status colour SHALL encode the meaning of the status, independently of the product's accent hue. A
successful or complete state SHALL NOT be rendered in a warning treatment.

Observed today: a category at 100% complete renders its progress bar in warning orange.

#### Scenario: A complete state renders

- **WHEN** a progress indicator reaches completion
- **THEN** it uses the success treatment

#### Scenario: Accent is not used as a status

- **WHEN** a status is rendered
- **THEN** its colour comes from the semantic tokens rather than from the accent

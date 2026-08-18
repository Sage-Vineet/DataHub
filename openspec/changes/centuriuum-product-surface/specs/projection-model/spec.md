## Purpose

The forward-looking model: financing and capital stack inputs (`PJ - 0001`), and monthly five-year
projections of the P&L (`PJ - 0002`), balance sheet (`PJ - 0003`), and cash flow (`PJ - 0004`), plus
tax projection including the stock-versus-asset-sale comparison (`PJ - 0005`). The DCF in `VL - 0002`
is built directly on `PJ - 0002` through `PJ - 0004`, so this capability gates half the valuation
module.

**Fidelity: sketch.** No `PJ` feature specification document exists; the requirements below restate the
product-list summaries. Reads adjusted earnings from `QE - 0004` and headcount/labor assumptions from
the payroll integration (`DR - 0007`).

**Downstream contract.** The `VL - 0002` DCF specification (Josh Tonnesen, 14 Aug 2026) imposes concrete
obligations on this capability — a versioned, attributed projection set; an explicit owner-compensation
declaration; named scenarios; and depreciation, amortization, capital expenditure and working capital
lines readable rather than estimated. Those are stated as requirements below so the projection module is
specified against what actually consumes it. `VL - 0007` additionally reads the capital stack from
`PJ - 0001` and projected cash flow from `PJ - 0004` for its debt service coverage schedule, and
`VL - 0009` reads the tax logic in `PJ - 0005`.

## ADDED Requirements

### Requirement: Financing and capital stack inputs

The system SHALL let a user enter the deal and capital stack information the model runs on — sources and
uses, debt tranches with rate and term, equity, seller financing, and earnout where applicable.
(`PJ - 0001`)

#### Scenario: Capital stack drives the model
- **WHEN** a user enters or changes the capital stack
- **THEN** the projections reflect the resulting debt service and equity structure

### Requirement: Five-year monthly P&L projection from the adjusted base

The system SHALL project the P&L monthly for five years, starting from the adjusted P&L and its
underlying data rather than from a re-keyed base. (`PJ - 0002`)

#### Scenario: Projection starts from adjusted actuals
- **WHEN** a projection is created
- **THEN** its base period is the adjusted P&L from the QoE bridge

#### Scenario: Monthly granularity across five years
- **WHEN** the projection is viewed
- **THEN** sixty monthly periods are presented and editable at the driver level

### Requirement: Scenario testing with fast adjustment

The projection UI SHALL support scenario testing and easy adjustment of assumptions, with scenarios
retained side by side rather than overwriting one another. (`PJ - 0002`)

#### Scenario: Scenarios compared
- **WHEN** a user creates a second scenario
- **THEN** both remain available and comparable

#### Scenario: Assumption change flows through
- **WHEN** an assumption changes
- **THEN** dependent lines and the balance sheet and cash flow projections update

### Requirement: Balance sheet projection

The system SHALL project the balance sheet monthly for five years, consistent with the P&L projection
and the capital stack. (`PJ - 0003`)

#### Scenario: Balance sheet ties to the P&L projection
- **WHEN** the P&L projection changes
- **THEN** the projected balance sheet reflects it and remains in balance

### Requirement: Cash flow projection

The system SHALL project cash flow monthly for five years, consistent with the projected P&L and balance
sheet, and SHALL produce the free cash flow the DCF consumes. (`PJ - 0004`)

#### Scenario: Free cash flow available to the DCF
- **WHEN** the projections are complete
- **THEN** unlevered free cash flow is derivable for `VL - 0002` without re-entry

#### Scenario: Debt service reflected
- **WHEN** the capital stack includes debt
- **THEN** the projected cash flow reflects its service and any covenant-relevant coverage

### Requirement: Tax projection with stock versus asset comparison

The system SHALL project tax by year and SHALL show the impact of a stock sale versus an asset sale.
(`PJ - 0005`)

#### Scenario: Both structures compared
- **WHEN** a user views the tax projection
- **THEN** the stock-sale and asset-sale outcomes are presented side by side

#### Scenario: Tax logic reusable by offer comparison
- **WHEN** offers are compared on after-tax net proceeds
- **THEN** the comparison uses this tax logic rather than a separate implementation

### Requirement: A projection set is versioned and attributed

The system SHALL treat a completed projection set as a versioned artifact recording its version, its
preparer, and its preparation date, so a consuming valuation can display and print all three and freeze
the version it used. (`PJ - 0002` … `PJ - 0004`, required by `VL - 0002`)

#### Scenario: The DCF can name its source
- **WHEN** a DCF is run against a projection set
- **THEN** the set's version, preparer, and preparation date are available to display, print, and freeze

### Requirement: The projection set declares its owner-compensation convention

A projection set SHALL declare whether it already includes market-rate owner compensation. Where the
declaration is absent, a consuming valuation SHALL be unable to proceed until it is stated.
(`PJ - 0002`, required by `VL - 0002`)

#### Scenario: Undeclared convention blocks the DCF
- **WHEN** a projection set carries no owner-compensation declaration
- **THEN** the DCF cannot run until the declaration is supplied

### Requirement: Scenarios are named and distinguishable, with a base case

Where a projection set holds more than one scenario, each SHALL be identifiable and the set SHALL
identify its base case, together with the principal assumptions distinguishing the scenarios, so a
consuming valuation can attribute the endpoints of a scenario-driven range. (`PJ - 0002`, required by
`VL - 0002`)

#### Scenario: Range endpoints are attributable
- **WHEN** a DCF produces a range across scenarios
- **THEN** each endpoint can be attributed to a named scenario and the base case is identifiable

### Requirement: Cash flow and balance sheet lines are read, not estimated

Projected depreciation, amortization, and capital expenditures SHALL be present on the projected cash
flow and balance sheet statements as readable lines, and the projected balance sheet SHALL support
derivation of the change in net working capital, so a consuming valuation reads them rather than
estimating them. (`PJ - 0003`, `PJ - 0004`, required by `VL - 0002`)

#### Scenario: The DCF reads rather than estimates
- **WHEN** unlevered free cash flow is derived
- **THEN** depreciation, amortization, capital expenditures, and the working capital change are read
  from the projected statements

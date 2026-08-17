## Purpose

The valuation deliverable and the three methodologies behind it: the Excel/PDF valuation model
(`VL - 0001`), DCF (`VL - 0002`), public company comparables (`VL - 0003`), precedent transactions
(`VL - 0004`), the summary football field (`VL - 0005`), and the purpose and standard-of-value setup
that gates all of them (`VL - 0006`).

**Fidelity: sketch.** Two hard external dependencies: the market data provider decision
(`design.md` Register B §6) gates `VL - 0003` and `VL - 0004`, and the credentialing/liability question
(Register B §7) gates external delivery of anything this capability produces. Four referenced IDs in this
module (`VL - 0007` … `VL - 0010`) have **no row in the product list** — see Register A; `VL - 0009`, a
deal-structure engine, carries the analytical weight of `BR - 0014`.

## ADDED Requirements

### Requirement: Purpose and standard of value gate the engagement

The system SHALL require, at the start of every valuation engagement, the purpose from a controlled list
— exit planning, SBA or conventional lender financing, gift and estate tax, 409A or equity compensation,
buy-sell agreement funding, shareholder dispute or divorce litigation, ESOP, internal management
planning — together with the valuation date, the effective date of the financial data, and the intended
user. (`VL - 0006`)

#### Scenario: Engagement cannot proceed without the setup
- **WHEN** a user starts a valuation without selecting purpose, dates, and intended user
- **THEN** the engagement does not proceed

### Requirement: Purpose drives standard, premise, scope, and report language

The selected purpose SHALL drive: the standard of value applied (fair market, fair, investment, or
intrinsic value) and therefore whether synergies and buyer-specific benefits may be included; the
premise of value (going concern, orderly liquidation, forced liquidation) and therefore whether the
asset approach controls; the level of report — calculation of value with limited procedures and
restricted use, versus conclusion of value as a full opinion — with the corresponding framework applied
(USPAP, AICPA SSVS No. 1, NACVA); and the disclaimers, limiting conditions, hypothetical and
extraordinary assumptions, and signature block in the PDF deliverable. (`VL - 0006`)

#### Scenario: Standard of value follows purpose
- **WHEN** a purpose is selected
- **THEN** the permitted standards of value and the report language follow from it

#### Scenario: Incompatible combinations are blocked
- **WHEN** a user attempts an incompatible combination — for example investment value on a gift and
  estate engagement
- **THEN** the system blocks it rather than warning

### Requirement: Credential gating on opinion language

The system SHALL record the appraiser's credential (CVA, ABV, ASA, or none) and SHALL suppress
opinion-of-value language when no credential is on file, so the platform never produces something that
reads as a certified opinion when it is not. (`VL - 0006`)

#### Scenario: No credential, no opinion language
- **WHEN** a deliverable is produced with no credential on file
- **THEN** opinion-of-value language is suppressed and the report presents as a calculation

### Requirement: DCF built on the projection model

The system SHALL derive unlevered free cash flow from the five-year projections in `PJ - 0002` …
`PJ - 0004` and discount it at a WACC, with a discount rate build-up appropriate to lower-middle-market
private companies — risk-free rate, equity risk premium, size premium, and company-specific risk premium
— and terminal value by both perpetuity growth and exit multiple. (`VL - 0002`)

#### Scenario: Projections flow into the DCF
- **WHEN** the projections change
- **THEN** the DCF recomputes from them without re-entry

#### Scenario: Both terminal value methods
- **WHEN** the DCF is run
- **THEN** perpetuity growth and exit multiple terminal values are both produced

#### Scenario: Sensitivity grid
- **WHEN** the user views sensitivities
- **THEN** a WACC against terminal growth / exit multiple grid is presented

#### Scenario: Convention consistent with the QoE bridge
- **WHEN** the deal's convention is SDE or EBITDA
- **THEN** the DCF applies the same convention as `QE - 0004`

### Requirement: Public company comparables

The system SHALL support a trading comps analysis: an industry and size screen suggesting a comp set the
user can add to and remove from; retrieval of share price, market cap, net debt, enterprise value,
revenue, EBITDA and EBIT for LTM and forward periods; and calculation of EV/Revenue, EV/EBITDA, EV/EBIT
and P/E with mean, median, and quartile statistics. The applied multiple SHALL flow to the client's
adjusted EBITDA or SDE. (`VL - 0003`)

#### Scenario: Comp set curated by the user
- **WHEN** the screen suggests comparables
- **THEN** the user can add and remove members, and the statistics recompute

#### Scenario: Applied multiple flows to the client's earnings
- **WHEN** a multiple is applied
- **THEN** it is applied to the adjusted earnings from the QoE bridge

### Requirement: Size and liquidity discount is explicit

The comps analysis SHALL require a size and liquidity discount input, since public multiples do not
transfer directly to sub-$50M private targets, and that discount SHALL be a visible, documented
assumption rather than embedded in the calculation. (`VL - 0003`)

#### Scenario: Discount is visible in the output
- **WHEN** a comps-derived value is presented
- **THEN** the discount applied and its basis are shown

### Requirement: Precedent transactions from proprietary and third-party data

The system SHALL support a precedent transaction analysis over two sources: the platform's own
proprietary multiples database captured on every closed deal, searchable by industry/NAICS, revenue and
EBITDA size band, geography, and deal date; and third-party transaction data where the proprietary
database is thin. It SHALL display target, buyer, date, deal size, revenue, EBITDA/SDE and implied
EV/Revenue and EV/EBITDA, with mean, median, and quartile statistics and outlier flagging, and the
user-selected applied multiple range SHALL flow to the client's adjusted earnings. (`VL - 0004`)

#### Scenario: Proprietary and third-party sets combine
- **WHEN** a transaction set is filtered
- **THEN** records from both sources are presented with their source identified

#### Scenario: Outliers flagged, not silently dropped
- **WHEN** a record falls outside the distribution
- **THEN** it is flagged and the user decides whether to exclude it

### Requirement: Proprietary comparables are anonymized

Internal comparables drawn from the platform's own closed deals SHALL be anonymized so that no
individual closed deal is identifiable. (`VL - 0004`)

#### Scenario: No deal is identifiable
- **WHEN** internal comparables are presented
- **THEN** no combination of displayed fields identifies a specific closed deal or party

### Requirement: Valuation summary and football field

The system SHALL reconcile the DCF, public comps, and precedent transaction indications into a single
concluded value range, presented as a football field chart with the low and high indicated enterprise
value from each method and a user-controlled weighting by method, so the conclusion is transparent
rather than a black box. (`VL - 0005`)

#### Scenario: Weighting is visible and adjustable
- **WHEN** the user changes the method weighting
- **THEN** the concluded range updates and the weighting used is shown in the output

### Requirement: Enterprise to equity bridge and implied multiple check

The summary SHALL present the bridge from concluded enterprise value to equity value — less debt, plus
cash, working capital peg adjustment — and SHALL back into implied multiples on the client's adjusted
EBITDA/SDE as a sanity check against the comp sets. (`VL - 0005`)

#### Scenario: Bridge presented
- **WHEN** a concluded enterprise value exists
- **THEN** the equity value bridge and the implied multiples are shown

### Requirement: Narrative drawn from the risk register

The summary SHALL include commentary drawing risk and opportunity items from `QE - 0007` to explain
where in the range the client falls and why. (`VL - 0005`)

#### Scenario: Register items available to the narrative
- **WHEN** the summary commentary is written
- **THEN** the engagement's risk and opportunity items are available to cite

### Requirement: Excel and PDF deliverable

The system SHALL produce the valuation as an Excel and a PDF deliverable, with the summary as its
headline page and the report language determined by the purpose and credential setup. (`VL - 0001`,
`VL - 0006`)

#### Scenario: Deliverable reflects the engagement setup
- **WHEN** the deliverable is produced
- **THEN** its disclaimers, limiting conditions, intended-user restriction, and signature block match
  the engagement's purpose and credential state

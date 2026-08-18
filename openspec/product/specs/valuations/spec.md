## Purpose

What the business is worth, by which approach, for what purpose, and how that conclusion stays
defensible afterwards. Covers `VL - 0001` (Valuation Model), `VL - 0002` (DCF Analysis), `VL - 0003`
(Public Company Comparables), `VL - 0004` (Precedent Transactions), `VL - 0005` (Valuation Summary /
Football Field), `VL - 0006` (Purpose & Standard of Value Setup), `VL - 0007` (SBA / Lender-Ready
Output), `VL - 0008` (Asset / Net Asset Value Approach), `VL - 0009` (Deal Structure Impact on Value),
and `VL - 0010` (Version Control & Assumption Audit Log).

**Fidelity: mixed.** `VL - 0001` … `VL - 0004` are at specified fidelity, drawn from their feature
specifications (Josh Tonnesen, 14 Aug 2026). `VL - 0005` … `VL - 0010` have no specification document
yet; their requirements below are drawn from the product list's detailed summaries, which are
substantive but have not been through the spec process.

**ID note.** `VL - 0005` through `VL - 0010` were previously dangling references with no rows in the
product list. They now exist as rows and are covered here. `VL - 0010`'s summary refers to the security
model as `SE - 0001` / `SE - 0002`; those are now `SY - 0001` / `SY - 0002`.

## ADDED Requirements

### Requirement: Valuations exist standalone or deal-scoped, and are promotable

The system SHALL allow a broker to create a valuation either as a standalone prospect valuation with no
associated deal, or as a deal-scoped valuation attached to an existing deal, and SHALL allow a standalone
valuation to be promoted to deal-scoped when an engagement is signed, retaining its history.
(`VL - 0001`)

#### Scenario: Promotion preserves history
- **WHEN** a standalone valuation is promoted to deal-scoped
- **THEN** it attaches to the deal and its history is retained

### Requirement: Valuation status and immutability

Valuation status SHALL progress Draft, Final, Superseded, Archived, and a Final valuation SHALL be
immutable. Editing a Final valuation SHALL create a new Draft version, with the prior version retained
and marked Superseded on finalization of the new one. Each valuation SHALL record a valuation date and
SHALL record separately the as-of date of every data source it consumes. (`VL - 0001`)

#### Scenario: Editing a Final valuation branches a Draft
- **WHEN** a user edits a Final valuation
- **THEN** a new Draft version is created and the prior version is retained, becoming Superseded when
  the new one is finalized

### Requirement: Earnings basis provenance is recorded and platform-derived earnings are not editable

Each valuation SHALL record and display its earnings basis provenance as either platform-verified
(derived from `QE - 0004`) or broker-entered, and the deliverables SHALL state which applies. For a
deal-scoped valuation, normalized earnings SHALL be read from `QE - 0004`, with the broker selecting
SDE or Adjusted EBITDA as the presented basis, and the system SHALL NOT permit manual editing of
`QE - 0004`-derived earnings within the valuation — adjustments are made in the QoE add-back schedule
and the valuation re-run. For a standalone valuation the broker SHALL enter revenue and the selected
earnings measure directly, and the system SHALL mark those inputs broker-entered throughout the model
and the deliverables. (`VL - 0001`)

#### Scenario: QoE-derived earnings resist editing
- **WHEN** a user attempts to edit `QE - 0004`-derived earnings inside a deal-scoped valuation
- **THEN** the edit is refused and the correction path is the add-back schedule

#### Scenario: Broker-entered inputs are labelled throughout
- **WHEN** a standalone valuation is produced
- **THEN** its revenue and earnings inputs are marked broker-entered in the model and both deliverables

### Requirement: Period basis is a single period or a recorded weighted average

The broker SHALL be able to base the valuation on a single period — trailing twelve months or a
completed fiscal year — or on a weighted average of up to five annual periods. Where a weighted average
is used, the weights applied to each period SHALL be recorded and SHALL print in the assumptions
schedule of both deliverables. (`VL - 0001`)

#### Scenario: Weights are disclosed
- **WHEN** a weighted average basis is used
- **THEN** the per-period weights print in the assumptions schedule of the PDF and the workbook

### Requirement: Closed deals contribute de-identified comparable records, on consent

On deal close the system SHALL write a de-identified comparable-transaction record to the platform comps
pool, capturing: closing period (month and year only), industry taxonomy node, region, revenue, the
earnings measure and its value, total consideration, consideration structure (cash at close, seller
note, earnout, equity rollover), transaction form (asset or stock sale), whether real estate was
included, whether inventory was included, working capital treatment, buyer type (strategic, financial,
individual), employee count band, and years in operation band. Such a record SHALL NOT store the company
name, any trade name, exact address, customer names, personnel names, the deal identifier, the seller's
identity, or the broker's or firm's identity in any field used for cohort assembly or display.
De-identification SHALL occur at the point the record is written to the pool, not at display. A
transaction SHALL be contributed only where seller consent has been recorded; absent consent no record
SHALL be written, and where consent is withdrawn the record SHALL be removed from all future cohort
assembly. The pool SHALL exclude any deal that is not closed, and SHALL exclude the valuing user's own
in-progress deals from every cohort. (`VL - 0001`)

#### Scenario: No consent, no contribution
- **WHEN** a deal closes with no recorded seller consent
- **THEN** no comparable-transaction record is written to the pool

#### Scenario: Withdrawn consent removes the record from cohorts
- **WHEN** consent is withdrawn
- **THEN** the corresponding pool record is excluded from all future cohort assembly

### Requirement: Cohort assembly is constrained, floored, and never re-identifiable

Cohorts SHALL be assembled from fixed, system-defined combinations of industry taxonomy node, size band,
region grouping, and closing period window; free-form or arbitrary filter combinations SHALL NOT be
permitted. The system SHALL enforce an absolute minimum cohort size below which no market-approach
statistic of any kind renders and the system states that market data is unavailable — a floor that SHALL
NOT be overridable by any user or role. The system SHALL additionally suppress any statistic a single
transaction would disproportionately determine beyond a defined concentration threshold, even where the
minimum is met. A separate, higher credibility threshold SHALL apply: where a cohort meets the absolute
minimum but falls below it, statistics SHALL display together with a prominent insufficient-data warning
stating the cohort count, and that warning SHALL print on the PDF report and appear in the Excel
workbook, not only on screen. The system SHALL display only aggregate cohort statistics — count, median,
mean, first and third quartiles, minimum and maximum — and SHALL expose no per-transaction row, record,
or identifier in the interface, the PDF, the workbook, or any export or API response. Every cohort query
SHALL be logged with its parameters, resulting count, and requesting user, so attempts to narrow toward
an individual transaction are detectable. (`VL - 0001`)

#### Scenario: Below the floor, nothing renders
- **WHEN** a cohort contains fewer records than the absolute minimum
- **THEN** no market-approach statistic renders and unavailability is stated, with no override available

#### Scenario: Warnings reach the deliverables
- **WHEN** a cohort falls below the credibility threshold
- **THEN** the insufficient-data warning with cohort count prints in the PDF and appears in the workbook

#### Scenario: Narrowing attempts are detectable
- **WHEN** cohort queries are executed
- **THEN** each is logged with parameters, count, and requesting user

### Requirement: Market approach multiples, positioning, and overrides

Multiples SHALL be computed only from records carrying sufficient consideration-structure data to
normalize the basis; records lacking it SHALL be excluded from multiple computation and the exclusion
count disclosed with the cohort. The market approach SHALL present multiples of total consideration to
the selected earnings measure and to revenue for the assembled cohort, SHALL propose a selected multiple
derived from the cohort statistics, and SHALL present the subject's position relative to the cohort on
defined comparison factors including size, revenue growth, margin, and customer concentration derived
from `DB - 0002`. The broker SHALL be able to override the selected multiple, requiring a recorded
rationale that prints in the assumptions schedule of both deliverables. The approach SHALL produce an
indicated value range rather than a single value. (`VL - 0001`)

#### Scenario: Overrides carry a printed rationale
- **WHEN** a broker overrides the selected multiple
- **THEN** a rationale is required and prints in both deliverables' assumptions schedules

### Requirement: Income approach builds its rate from disclosed components

The income approach SHALL be implemented as a capitalization of earnings method applied to the
normalized earnings basis, building the capitalization rate from disclosed components — risk-free rate,
equity risk premium, size premium, and company-specific risk premium — each displayed separately with
its source or rationale. The broker SHALL be able to override any component, requiring a recorded
rationale that prints in the assumptions schedule of both deliverables, and the approach SHALL produce
an indicated value range derived from a defined variation around the concluded rate. (`VL - 0001`)

#### Scenario: Every rate component is visible
- **WHEN** the capitalization rate is displayed
- **THEN** each component appears separately with its source or rationale

### Requirement: Enterprise-to-equity bridge with flagged manual inputs

The system SHALL treat approach outputs as indications of enterprise value on a debt-free, cash-free
basis and SHALL state that basis on the deliverables. It SHALL provide a bridge from indicated
enterprise value to indicated equity value comprising: less funded debt, plus excess cash, and plus or
minus the difference between actual and normal working capital. Bridge components SHALL be read from
`DB - 0004` where the required detail is available and SHALL otherwise be broker-entered and visibly
flagged as such in both deliverables. The broker SHALL specify whether real estate is included in or
excluded from the valued enterprise, with the treatment stated on the deliverables and no real estate
valued where excluded, and SHALL specify whether inventory is included, consistent with the transaction
form assumed. (`VL - 0001`)

#### Scenario: Manually entered bridge components are visible as such
- **WHEN** a bridge component cannot be read from `DB - 0004` and is broker-entered
- **THEN** it is visibly flagged as broker-entered in both deliverables

### Requirement: Approaches are reconciled to a range, never a point value

The system SHALL present the indicated range from each approach applied side by side together with a
concluded range, SHALL require the broker to record a written reconciliation explaining why the
approaches differ and how the concluded range was reached — printing in the report — and SHALL NOT
require or produce a single point value. Where a midpoint is displayed it SHALL be presented as the
midpoint of a range and not as a concluded value. The system SHALL produce sensitivity tables showing
the effect on indicated value of varying the selected multiple against the earnings basis, and the
capitalization rate against the earnings basis. (`VL - 0001`)

#### Scenario: A midpoint is not a conclusion
- **WHEN** a midpoint is displayed
- **THEN** it is labelled as the midpoint of a range rather than a concluded value

### Requirement: Valuation output never reaches a buyer-facing document

Any pricing guidance derived from a valuation SHALL remain internal to the broker and seller. The system
SHALL NOT flow a valuation output, concluded range, or price into the Teaser (`CM - 0005`), the CIM
(`CM - 0001`), or any buyer-facing document. (`VL - 0001`)

#### Scenario: No valuation figure in marketing material
- **WHEN** a teaser or CIM is generated
- **THEN** no valuation output, concluded range, or price appears in it

### Requirement: The PDF report carries a defined structure and a non-appraisal disclaimer

The system SHALL generate a PDF report containing at minimum: purpose and intended use; standard and
premise of value; scope and limiting conditions; the non-appraisal disclaimer; earnings basis and
normalization summary; market approach with cohort description and aggregate statistics; income approach
with rate build-up; the enterprise-to-equity bridge; indicated ranges by approach; the concluded range
and reconciliation; sensitivity tables; the assumptions and overrides schedule; and a sources schedule
with as-of dates. The report SHALL carry prominent language stating that it is an opinion of value
prepared for pricing and marketing purposes, that it is not a certified appraisal, that it does not
conform to USPAP or SSVS, and that it is not prepared for tax, litigation, ESOP, or financial reporting
purposes. It SHALL identify the preparing broker and firm and render using the `CM - 0001` firm theme.
(`VL - 0001`)

#### Scenario: The disclaimer is prominent
- **WHEN** the PDF report is generated
- **THEN** the non-appraisal, non-USPAP/SSVS, non-tax/litigation/ESOP language appears prominently

### Requirement: The Excel workbook is live, provenanced, and aggregate-only

The system SHALL generate an Excel workbook containing live formulas and editable assumption cells
including the sensitivity tables, so assumptions can be flexed outside the platform, with a provenance
sheet stating the valuation version, valuation date, every source and its as-of date, the cohort
definition and count, and the same non-appraisal disclaimer. The workbook SHALL contain aggregate cohort
statistics only and SHALL contain no per-transaction comparable record under any circumstance.
(`VL - 0001`)

#### Scenario: No per-transaction record in the workbook
- **WHEN** the workbook is inspected
- **THEN** it contains aggregate cohort statistics only

### Requirement: Draft deliverables are watermarked and publication is explicit

Deliverables generated from a Draft valuation SHALL be watermarked "DRAFT — NOT FOR DISTRIBUTION" on
every page of the PDF and marked as draft on the workbook's provenance sheet. For a deal-scoped
valuation the broker SHALL be able to publish finalized deliverables into the deal's data room as
tracked documents; publication SHALL be an explicit action and SHALL NOT occur automatically.
Deliverables for a standalone prospect valuation SHALL be private to the creating user and their firm
and SHALL NOT be written to any deal's data room. (`VL - 0001`)

#### Scenario: Standalone deliverables stay out of data rooms
- **WHEN** a standalone prospect valuation produces deliverables
- **THEN** they remain private to the creating user and firm

### Requirement: Finalization freezes the evidence

On finalization a valuation SHALL freeze the cohort statistics it used together with the cohort
definition, count, and as-of date, so the report remains reproducible after the pool changes. The system
SHALL log to the Activity & Audit Log: valuation created, promoted from standalone to deal-scoped,
cohort queried with parameters and count, assumption overridden with rationale, valuation finalized with
frozen cohort reference, deliverable generated with format and version, deliverable published to the
data room, valuation superseded or archived, comparable-transaction record contributed, and consent
recorded or withdrawn. (`VL - 0001`, feeds `SY - 0003`)

#### Scenario: A finalized report survives pool changes
- **WHEN** the comps pool changes after finalization
- **THEN** the finalized report reproduces from its frozen cohort statistics

### Requirement: The DCF requires a projection set and produces no separate deliverable

The DCF SHALL be available only within a valuation for which a completed projection set exists in
`PJ - 0002` … `PJ - 0004` for the subject company. Where none exists, the DCF section SHALL be absent
from the valuation and the valuation SHALL proceed on the remaining approaches without error or empty
output. The DCF SHALL NOT be available on a standalone prospect valuation unless a projection set exists
for that prospect, SHALL NOT permit creation or editing of projections within it — all projection
changes occurring in the Projection Model module with the DCF re-run — and SHALL produce no separate
deliverable, contributing a section to the `VL - 0001` PDF and dedicated sheets to its workbook. The DCF
SHALL record the projection set version, its preparer, and its preparation date, and SHALL display and
print all three. (`VL - 0002`)

#### Scenario: Absent projections degrade gracefully
- **WHEN** no completed projection set exists
- **THEN** the DCF section is absent and the rest of the valuation proceeds without error

### Requirement: Cash flow is discounted on an EBITDA basis, never on SDE

The DCF SHALL derive unlevered free cash flow on an EBITDA basis in all cases regardless of the
deliverable's SDE or EBITDA presentation convention. Where the projection set is prepared on an SDE
convention — without a market-rate owner compensation expense — the system SHALL deduct a market-rate
owner replacement salary before deriving EBIT; that salary SHALL be an explicit, disclosed input,
overridable with a recorded rationale, printing in the assumptions schedule. The projection set SHALL
declare whether it already includes market-rate owner compensation, and where that declaration is absent
the system SHALL require the broker to state it before the DCF can run. Where the deliverable is set to
SDE convention the DCF section SHALL present a reconciliation from SDE to the EBITDA basis actually
discounted. The system SHALL NOT permit discounting of SDE-derived cash flow under any setting.
(`VL - 0002`)

#### Scenario: SDE is never discounted
- **WHEN** the deliverable convention is SDE
- **THEN** the DCF discounts an EBITDA basis and presents the reconciliation from SDE

#### Scenario: Missing declaration blocks the run
- **WHEN** the projection set does not declare whether it includes market-rate owner compensation
- **THEN** the broker must state it before the DCF can be run

### Requirement: Unlevered free cash flow is built from traced projection lines

The system SHALL derive unlevered free cash flow for each explicit projection period as adjusted EBIT,
less income taxes at the applied rate, plus depreciation and amortization, less capital expenditures,
less the increase in net working capital. Each component SHALL be traced to its source projection
statement and line, with that trace visible in the workbook. Depreciation, amortization, and capital
expenditures SHALL be read from the projected cash flow and balance sheet statements rather than
estimated, and the change in net working capital SHALL be derived from the projected balance sheet.
(`VL - 0002`)

#### Scenario: Components are traceable in the workbook
- **WHEN** the free cash flow build is inspected in the workbook
- **THEN** each component traces to its source projection statement and line

### Requirement: Tax affecting is applied, disclosed, and explained

Income taxes SHALL be applied at an entity-level, C-corp-equivalent rate by default comprising a federal
component and a state assumption, with the applied rate displayed and printed. The broker SHALL be able
to override it — including setting it to zero for a pass-through entity — with a recorded rationale
printing in the assumptions schedule. The system SHALL state on the deliverable that projected earnings
have been tax-affected at the applied rate, and that this is done so the income approach remains
comparable to the tax-affected earnings implicit in transaction multiples. (`VL - 0002`)

#### Scenario: Tax affecting is explained on the deliverable
- **WHEN** the DCF section prints
- **THEN** it states the applied rate and why earnings are tax-affected

### Requirement: One rate build-up serves both the DCF and the capitalization method

The discount rate SHALL be derived from the same shared rate build-up used by `VL - 0001`, with the
components — risk-free rate, equity risk premium, size premium, company-specific risk premium — entered
once per valuation and serving both features, producing a cost of equity with each component displayed
alongside its source or rationale and as-of date. WACC SHALL be computed as the cost of equity weighted
by the equity share of the target capital structure, plus the cost of debt weighted by the debt share
and multiplied by one minus the applied tax rate. The target capital structure SHALL default to an
industry target for the subject's taxonomy node and the cost of debt to a market assumption, each
overridable with a recorded rationale. Overriding any shared component SHALL affect both the DCF's WACC
and `VL - 0001`'s capitalization rate, and the system SHALL make that consequence visible at the point
of override. The deliverable SHALL present the reconciliation between the two rates so they cannot
appear unexplained in one report. (`VL - 0002`)

#### Scenario: Shared override warns about its reach
- **WHEN** a broker overrides a shared build-up component
- **THEN** the effect on both the WACC and the capitalization rate is made visible at the point of
  override

### Requirement: Discounting convention and enterprise-value-only output

The system SHALL discount each period's unlevered free cash flow at the WACC using a mid-year convention
by default, stating the convention applied on the deliverable, and SHALL allow the broker to select an
end-of-year convention, printing the selection in the assumptions schedule. The sum of discounted
explicit-period cash flows plus discounted terminal value SHALL constitute the DCF's indicated
enterprise value on a debt-free, cash-free basis. The DCF SHALL produce an enterprise value indication
only and SHALL NOT compute equity value independently; conversion occurs solely through the `VL - 0001`
bridge. (`VL - 0002`)

#### Scenario: No independent equity value
- **WHEN** the DCF completes
- **THEN** it produces an enterprise value indication and no independent equity value

### Requirement: Two terminal methods, cross-checked, with one designated primary

The exit multiple method SHALL apply an exit multiple to terminal-year EBITDA, defaulting to a value
derived from the `VL - 0001` comparable cohort for the subject's taxonomy node and size band, overridable
with a recorded rationale. Where that cohort does not meet the absolute minimum cohort size, no
cohort-derived exit multiple SHALL be offered, the broker SHALL enter one directly, and the deliverable
SHALL state that no market-derived exit multiple was available. The system SHALL report, as
cross-checks, the exit multiple implied by the perpetuity growth method and the perpetuity growth rate
implied by the exit multiple method. The broker SHALL designate one terminal method primary for
inclusion in `VL - 0001`'s concluded range with a recorded rationale, and the non-primary indication
SHALL be retained and presented as a cross-check. The system SHALL report terminal value as a percentage
of total indicated enterprise value under each method and display a warning where that percentage
exceeds a defined threshold. (`VL - 0002`)

#### Scenario: Terminal value dominance is warned
- **WHEN** terminal value exceeds the defined percentage of total indicated enterprise value
- **THEN** a warning is displayed

### Requirement: The DCF runs across every scenario and attributes its range

The system SHALL run the DCF against every scenario present in the projection set, and the indicated
value range SHALL span the lowest and highest indications produced across scenarios under the primary
terminal method. The deliverable SHALL identify which scenario produces each endpoint and disclose the
principal assumptions distinguishing them, and SHALL identify the base-case indication within the range
so a scenario-driven range is not read as an equally weighted set of outcomes. Where the projection set
contains only a single scenario, the range SHALL instead derive from the sensitivity grid and the
deliverable SHALL state that the range reflects assumption sensitivity rather than scenario variation.
(`VL - 0002`)

#### Scenario: Single-scenario ranges are labelled differently
- **WHEN** the projection set contains one scenario
- **THEN** the range derives from the sensitivity grid and the deliverable says so

### Requirement: Two live sensitivity grids in the workbook

The system SHALL produce a sensitivity grid of indicated enterprise value across WACC against terminal
growth rate for the perpetuity growth method, and across WACC against exit multiple for the exit
multiple method, with configurable step increments stated on the grid, both reproduced in the Excel
workbook as live formulas rather than pasted values. (`VL - 0002`)

#### Scenario: Grids remain live in the export
- **WHEN** the workbook is opened
- **THEN** both sensitivity grids compute from live formulas

### Requirement: DCF disclosure, freezing, and logging

The DCF section of the PDF SHALL include the projection source and preparer with dates, the SDE-to-EBITDA
reconciliation where applicable, the unlevered free cash flow build by period, the rate build-up and
WACC computation, both terminal value methods with their cross-checks, terminal value as a percentage of
total value, the indicated range with scenario attribution, both sensitivity grids, and the assumptions
and overrides schedule; and SHALL state prominently that the DCF indication depends on forward-looking
projections the platform has not audited or verified, identifying who prepared them. The workbook SHALL
include dedicated DCF sheets with the free cash flow build, rate build-up and WACC, both terminal value
computations, and both live grids with editable assumption cells, and its provenance sheet SHALL
additionally record the projection set version, preparer and date, the scenario set used, and the source
of the exit multiple. On finalization of the parent valuation the system SHALL freeze the projection set
version, scenario set, rate components, terminal assumptions, and any cohort-derived exit multiple. The
system SHALL log DCF runs, every rate, tax, capital structure and cost of debt override with rationale,
owner replacement salary set or overridden, terminal assumptions set, primary method designated with
rationale, cohort-derived exit multiple retrieved with cohort count, and terminal value dominance
warnings. (`VL - 0002`, feeds `SY - 0003`)

#### Scenario: Unaudited projections are disclosed
- **WHEN** the DCF section prints
- **THEN** it states that the projections are unaudited and identifies who prepared them

### Requirement: Market data is reached only through a provider-agnostic contract

The system SHALL access market data exclusively through an internal data contract defining the fields
this capability requires, with a provider-specific adapter implementing it, and SHALL support replacing
or adding an adapter without modification to screening, statistics, adjustment, or deliverable logic.
The contract SHALL define at minimum: company identifier, company name, exchange and ticker, industry
classification codes, share price, shares outstanding, market capitalization, total debt, cash and
equivalents, preferred equity, minority interest, enterprise value, LTM revenue, LTM EBITDA, LTM EBIT,
LTM net income, reporting currency, and the as-of date of each value. Provider credentials SHALL be held
as server-side secrets, SHALL never be transmitted to a client, and SHALL never appear in any export,
log entry, or error message. Where no provider is connected or the requesting user's firm is not
entitled, the capability SHALL report itself unavailable with an explanatory message and SHALL NOT block
the remainder of the valuation. Every provider request SHALL record the requesting user, the valuation,
the parameters sent, and the response timestamp. (`VL - 0003`)

#### Scenario: Credentials never leave the server
- **WHEN** exports, logs, and error messages are inspected
- **THEN** no provider credential appears in any of them

#### Scenario: Unavailability degrades gracefully
- **WHEN** no provider is connected or the firm is not entitled
- **THEN** the section reports unavailable and the rest of the valuation proceeds

### Requirement: Comparable screening is taxonomy-driven and never silently widened

The system SHALL screen for candidate comparables using the client's platform industry taxonomy node
mapped to provider industry classification codes through a maintained mapping table, additionally
accepting size parameters — at minimum a revenue range and a market capitalization range — and a
geographic scope parameter, and SHALL exclude non-operating entities, shell companies, blank-cheque and
special purpose acquisition entities, and companies without reported LTM revenue. Where the taxonomy
node has no mapped provider classification, or the mapping yields no candidates, the system SHALL report
that no public comparable set is available for this industry and SHALL NOT silently widen the screen.
(`VL - 0003`)

#### Scenario: No mapping means no set, not a broader one
- **WHEN** the taxonomy node has no mapped classification or the mapping returns nothing
- **THEN** unavailability is reported and the screen is not widened

### Requirement: Comp set curation is visible in the deliverable

The system SHALL present screened candidates as a suggested comp set the broker may accept, extend, or
reduce; SHALL allow adding a company by identifier or name search including one the screen did not
return; and SHALL require a recorded rationale to remove a screened candidate. Removal rationales SHALL
be retained with the valuation and SHALL print in the deliverable, so curation of the set is visible
rather than invisible. The system SHALL enforce a minimum comp set size for the display of statistics
and display a prominent insufficient-data warning where the set falls below it. (`VL - 0003`)

#### Scenario: Removals are explained in print
- **WHEN** a broker removes a screened candidate
- **THEN** a rationale is required and prints in the deliverable

### Requirement: Per-company figures, multiples, statistics, and outlier handling

The system SHALL retrieve LTM revenue, EBITDA, EBIT and net income, share price, shares outstanding,
market capitalization, and net debt components for every company in the comp set; SHALL compute
enterprise value for each as market capitalization plus total debt, plus preferred equity, plus minority
interest, less cash and equivalents, displaying the components of that computation; and SHALL compute
EV/Revenue, EV/EBITDA, EV/EBIT and P/E on an LTM basis per company. Where a required input for a given
multiple is unavailable or non-positive, the system SHALL exclude that company from that multiple only,
not from the others. The system SHALL compute mean, median, first and third quartile for each multiple
and display the number of companies contributing to each separately, since counts differ between
multiples; SHALL apply a defined and documented outlier rule, exclude outliers from computed statistics,
and disclose the number excluded. Every displayed figure SHALL carry the as-of date of its underlying
data, the comp set SHALL display a single prominent data as-of timestamp, and the system SHALL indicate
where retrieved data is stale beyond a defined threshold and offer a refresh. (`VL - 0003`)

#### Scenario: One missing input does not remove a company entirely
- **WHEN** a company lacks an input for one multiple
- **THEN** it is excluded from that multiple only and contributes to the others

### Requirement: Only EV/EBITDA applies to the subject

Only EV/EBITDA SHALL be applicable to the subject company; EV/Revenue, EV/EBIT and P/E SHALL be computed
and displayed for reference only and SHALL NOT be applied to the subject. The system SHALL state on the
deliverable that P/E is a post-tax equity multiple on a minority interest presented for reference only.
(`VL - 0003`)

#### Scenario: Reference multiples are labelled as such
- **WHEN** the trading comparables section renders
- **THEN** EV/Revenue, EV/EBIT and P/E are marked reference-only and P/E carries its explanation

### Requirement: Public-to-private bridge uses three separate, justified adjustments

The broker SHALL select a public EV/EBITDA multiple to carry forward, defaulting to the comp set median,
and SHALL be able to select another statistic or enter a value with a recorded rationale. The system
SHALL bridge that public multiple to a private-market multiple through three separate, independently
entered components: a size discount, a liquidity and marketability discount, and a control premium
applied in the opposite direction. Each SHALL require an entered value and a recorded rationale and
SHALL print separately in the assumptions schedule; the system SHALL NOT accept a single netted
adjustment in place of the three. The system SHALL display the bridge as a sequential computation from
the selected public multiple through each adjustment to the resulting adjusted multiple, SHALL prevent
an adjusted multiple of zero or below, and SHALL display a warning where the net effect of the
adjustments exceeds a defined proportion of the selected public multiple — on the basis that the
indication is then driven principally by the adjustments rather than by market evidence. (`VL - 0003`)

#### Scenario: A netted adjustment is refused
- **WHEN** a single combined adjustment is entered in place of the three components
- **THEN** it is not accepted

#### Scenario: Adjustment dominance is warned
- **WHEN** the adjustments' net effect exceeds the defined proportion of the public multiple
- **THEN** a warning is displayed

### Requirement: The adjusted multiple applies to EBITDA only, producing enterprise value

The adjusted multiple SHALL be applied to the subject's adjusted EBITDA as sourced from `QE - 0004` to
produce an indicated enterprise value, and the system SHALL NOT apply the adjusted multiple, or any
public multiple, to SDE under any setting. Where the deliverable is presented in SDE convention this
section SHALL present the reconciliation from SDE to adjusted EBITDA including the market-rate owner
replacement salary, consistent with `VL - 0002`, and apply the multiple to the EBITDA basis. The
analysis SHALL produce an enterprise value indication only; conversion to equity value occurs solely
through the `VL - 0001` bridge. (`VL - 0003`)

#### Scenario: Public multiples never touch SDE
- **WHEN** the deliverable convention is SDE
- **THEN** the reconciliation to adjusted EBITDA is presented and the multiple applies to EBITDA

### Requirement: Trading comparables default to a cross-check

The trading comparables analysis SHALL default to a cross-check that does not contribute to
`VL - 0001`'s concluded range. The broker SHALL be able to include the indication in the concluded
range, requiring a recorded rationale, and the deliverable SHALL state explicitly whether trading
comparables were included in the concluded range or presented as a cross-check only. (`VL - 0003`)

#### Scenario: Inclusion is deliberate and disclosed
- **WHEN** the broker includes the trading comparables indication in the concluded range
- **THEN** a rationale is required and the deliverable states that it was included

### Requirement: Licensed per-company data is excluded from deliverables server-side

The PDF report and Excel workbook SHALL contain the names of the companies in the comp set, the derived
statistics for each multiple with contributing counts, the removal rationales, the selected public
multiple, the three adjustment components with rationales, the adjusted multiple, the indicated
enterprise value, and the data as-of date; and SHALL NOT contain per-company share price, market
capitalization, net debt, enterprise value, revenue, EBITDA, EBIT, net income, or per-company multiples.
That restriction SHALL be enforced server-side at generation time, not by omission in a template.
Per-company retrieved figures and multiples SHALL be viewable within the application to entitled users
only and SHALL be labelled as licensed data excluded from exports. The deliverable SHALL name the market
data provider and carry any attribution or disclaimer text its terms require. (`VL - 0003`)

#### Scenario: A crafted export cannot include per-company data
- **WHEN** a deliverable is generated
- **THEN** per-company licensed figures are excluded by server-side enforcement rather than template
  omission

### Requirement: Trading comparables freeze on finalization

The system SHALL store a per-valuation snapshot comprising the comp set, retrieved per-company figures,
computed multiples and statistics, and the data as-of date, so a finalized valuation reproduces exactly;
and on finalization of the parent valuation the snapshot, the selected public multiple, the three
adjustment components, and the adjusted multiple SHALL be frozen. The system SHALL log screens executed
with parameters, candidate sets returned with count, companies added, companies removed with rationale,
provider data retrieved with as-of date, outliers excluded with count, multiple selection or override
with rationale, each adjustment component entered or changed with rationale, adjustment dominance
warnings, inclusion in the concluded range elected with rationale, and the snapshot freeze.
(`VL - 0003`, feeds `SY - 0003`)

#### Scenario: A finalized comparables section reproduces exactly
- **WHEN** provider data changes after finalization
- **THEN** the section reproduces from its frozen snapshot

### Requirement: Precedent transactions own the market approach across two separate sources

This capability SHALL own the market approach for the valuation module, producing an indicated
enterprise value range passed to `VL - 0001` for the enterprise-to-equity bridge and the concluded
range, producing an enterprise value indication only and no separate deliverable — contributing a
section to the `VL - 0001` PDF and dedicated sheets to its workbook. The system SHALL maintain two
distinct transaction sources — the internal proprietary database and licensed third-party data — and
SHALL present them as separate sets throughout, and SHALL NOT merge them into any combined count,
median, quartile, or other statistic. (`VL - 0004`)

#### Scenario: Sources never combine into one statistic
- **WHEN** statistics are computed
- **THEN** internal and third-party sets each carry their own count, median, and quartiles

### Requirement: Internal transactions surface only as aggregates, at every permission level

Internal transaction records SHALL surface only as aggregate statistics. No internal transaction SHALL
be displayed as a row, and no internal per-transaction value SHALL appear in any interface, report,
workbook, export, or API response at any permission level, including for Centuriuum internal
administrators. Internal cohorts SHALL be assembled exclusively from fixed, system-defined combinations
of industry taxonomy node, size band, region grouping, and closing period window, with free-form filter
combinations unavailable against the internal source. The system SHALL enforce an absolute minimum
internal cohort size below which no internal statistic renders and unavailability is reported — a floor
not overridable by any user or role — SHALL suppress any statistic a single transaction would
disproportionately determine beyond a defined concentration threshold even where the minimum is met,
SHALL exclude the valuing user's own in-progress deals, and SHALL log every internal cohort query with
its parameters, count, and requesting user. (`VL - 0004`)

#### Scenario: Internal administrators see no more than anyone else
- **WHEN** a Centuriuum internal administrator views internal transaction data
- **THEN** only aggregate statistics are available, with no per-transaction row or value

### Requirement: Internal statistics are computed separately by earnings basis

Internal statistics SHALL be computed separately for SDE-basis and EBITDA-basis transactions and the two
SHALL NEVER be combined into a single statistic. Each internal statistic set SHALL display its own
contributing count and earnings basis. The broker SHALL select the basis set matching the subject's
convention, and the system SHALL indicate where the subject's convention has no corresponding internal
set. Internal records lacking sufficient consideration-structure data to normalize the basis SHALL be
excluded from multiple computation, with the excluded count disclosed. (`VL - 0004`)

#### Scenario: A missing basis set is stated
- **WHEN** the subject's convention has no corresponding internal set
- **THEN** the system indicates that rather than substituting the other basis

### Requirement: Third-party transactions are searchable rows under the shared adapter

Third-party transaction data SHALL be accessed through the same internal data contract and provider
adapter pattern established in `VL - 0003`, so one provider decision serves both capabilities. The
system SHALL allow free-form search of third-party data by industry classification, revenue size band,
earnings size band, geography, and transaction date range, driven by the client's platform taxonomy node
mapped through the maintained mapping with the mapped classification displayed. Third-party transactions
SHALL display as rows showing, where the provider supplies them: target descriptor, buyer, transaction
date, deal size, revenue, EBITDA or SDE, and the implied EV/Revenue and EV/EBITDA or EV/SDE multiples.
The broker SHALL be able to include or exclude individual third-party transactions from the working set,
exclusion requiring a recorded rationale that prints in the deliverable. Third-party statistics SHALL be
computed separately by earnings basis where the provider distinguishes them. (`VL - 0004`)

#### Scenario: Free-form search applies to third-party data only
- **WHEN** a broker searches transaction data
- **THEN** free-form parameters are available against the third-party source and not against the
  internal source

### Requirement: Suspected duplicates are removed silently in favour of the internal record

The system SHALL detect suspected duplicates between the internal and third-party sets by proximity of
industry, size, transaction date, and geography; SHALL retain the internal record and exclude the
third-party record from the third-party set; and SHALL disclose the number of records removed as
suspected duplicates. The system SHALL NOT identify to any user which specific third-party record was
removed, since doing so would disclose that a named third-party transaction is a platform deal.
(`VL - 0004`)

#### Scenario: The count is disclosed, the identity is not
- **WHEN** suspected duplicates are removed
- **THEN** the number removed is disclosed and no specific removed record is identified

### Requirement: Statistics carry source, basis, count, and date range wherever shown

For each set and each basis the system SHALL compute mean, median, first and third quartile for
EV/Revenue and for the applicable earnings multiple, displaying the contributing count for each
statistic separately; SHALL apply a defined and documented outlier rule, flag outliers, exclude them
from computed statistics, and disclose the number excluded; and SHALL display for each set the date
range of contributing transactions so the recency of the evidence is visible. Every statistic SHALL
carry its source, basis, count, and date range wherever displayed or printed. (`VL - 0004`)

#### Scenario: Provenance travels with every statistic
- **WHEN** any statistic is displayed or printed
- **THEN** its source, basis, count, and date range accompany it

### Requirement: The applied multiple range is chosen, justified, and basis-matched

The broker SHALL select which set — internal or third-party — drives the applied multiple range, and
where both are available the selection SHALL require a recorded rationale. The range SHALL default to
the first and third quartile of the selected set's earnings multiple, and the broker SHALL be able to
adjust either endpoint with a recorded rationale printing in the assumptions schedule. The system SHALL
display the subject's position relative to the selected set on defined comparison factors including
size, revenue growth, margin, and customer concentration derived from `DB - 0002`. The applied range
SHALL be applied to the subject's adjusted earnings on the matching basis as sourced from `QE - 0004`,
and the system SHALL NOT apply an EBITDA-basis multiple to SDE, or an SDE-basis multiple to EBITDA,
under any setting. Where the selected set's basis differs from the deliverable's presentation
convention, the system SHALL present the reconciliation between SDE and adjusted EBITDA including the
market-rate owner replacement salary, consistent with `VL - 0002` and `VL - 0003`. (`VL - 0004`)

#### Scenario: Bases are never crossed
- **WHEN** the selected set's basis differs from the subject's earnings basis
- **THEN** the reconciliation is presented and the multiple is applied on the matching basis

### Requirement: Precedent transaction disclosure, licence limits, and freezing

The PDF report and workbook SHALL include, for each set used: the source, earnings basis, contributing
count, date range, computed statistics, outlier and duplicate exclusion counts, and the cohort
definition or search parameters; plus the selected set with rationale, the applied multiple range with
any endpoint rationales, the subject's adjusted earnings, and the resulting indicated enterprise value
range. Third-party transaction rows SHALL be included only to the extent the provider's licence permits,
applying the same redistribution constraints as `VL - 0003`. The deliverables SHALL contain no internal
per-transaction record, enforced server-side at generation time rather than by template omission. On
finalization the system SHALL freeze the internal cohort definition and statistics, the third-party
working set and statistics, the selected set, the applied multiple range, and all as-of dates. The
system SHALL log internal cohort queries, third-party searches, inclusions and exclusions with
rationale, suspected duplicates removed with count, outliers excluded with count, set selection with
rationale, applied range set or adjusted with rationale, and the freeze on finalization. (`VL - 0004`,
feeds `SY - 0003`)

#### Scenario: Licence limits govern what prints
- **WHEN** third-party rows would be reproduced in a deliverable
- **THEN** only what the provider's licence permits is included

### Requirement: The valuation summary reconciles approaches into a weighted concluded range

The system SHALL provide a summary that reconciles the applied approaches — `VL - 0002` DCF,
`VL - 0003` public comparables, `VL - 0004` precedent transactions — into a single concluded value
range, presenting a football field chart showing the low and high indicated enterprise value from each
method, with a user-controlled weighting by method so the concluded value is transparent rather than a
black box. The summary SHALL display the bridge from concluded enterprise value to equity value — less
debt, plus cash, working capital peg adjustment — and back into implied multiples on the client's
adjusted EBITDA or SDE as a sanity check against the comp sets, and SHALL carry a commentary section
pulling risk and opportunity items from `QE - 0007` to explain where in the range the client falls and
why. This SHALL be the headline page of the Excel and PDF deliverable in `VL - 0001`. (`VL - 0005`)

**Fidelity: product-list detail** — no feature specification document exists for `VL - 0005`.

#### Scenario: Weighting is visible
- **WHEN** the concluded range is presented
- **THEN** the per-method weighting driving it is shown

#### Scenario: Implied multiples sanity-check the conclusion
- **WHEN** the concluded enterprise value is bridged to equity value
- **THEN** the implied multiples on adjusted EBITDA or SDE are displayed against the comp sets

### Requirement: Purpose and standard of value gate every engagement

The system SHALL require, at the start of every valuation engagement, selection of the purpose from a
controlled list — exit planning / owner readiness, SBA or conventional lender financing, gift and estate
tax, 409A or equity compensation, buy-sell agreement funding, shareholder dispute or divorce litigation,
ESOP, internal management planning. That selection SHALL drive four downstream behaviours: the standard
of value applied (fair market value, fair value, investment value, intrinsic value), which governs
whether synergies and buyer-specific benefits may be included; the premise of value (going concern,
orderly liquidation, forced liquidation), which determines whether the asset approach in `VL - 0008`
becomes controlling; the level of report and scope of work, distinguishing a calculation of value
(limited procedures, restricted use) from a conclusion of value (full opinion) with the corresponding
compliance framework applied — USPAP, AICPA SSVS No. 1, or NACVA standards; and the report language,
disclaimers, limiting conditions, hypothetical and extraordinary assumptions, and signature block
generated in the PDF deliverable. The system SHALL hard-lock incompatible combinations — for example
blocking investment value on a gift and estate engagement — and SHALL require the valuation date, the
effective date of the financial data, and the intended user to be captured, since intended-use
restrictions are the primary liability control on the deliverable. An appraiser credential field (CVA,
ABV, ASA, none) SHALL suppress opinion-of-value language when no credential is on file, so the platform
never produces something reading as a certified opinion when it is not. (`VL - 0006`)

**Fidelity: product-list detail** — no feature specification document exists for `VL - 0006`.

#### Scenario: Incompatible combinations are blocked
- **WHEN** a user selects investment value on a gift and estate engagement
- **THEN** the combination is refused

#### Scenario: No credential, no opinion language
- **WHEN** no appraiser credential is on file
- **THEN** opinion-of-value language is suppressed in the deliverable

### Requirement: SBA / lender-ready output is addressed to the lender and checked against requirements

The system SHALL produce a lender-formatted variant of the valuation deliverable built to what banks and
SBA lenders require, letting the user designate the lender as the intended user and producing the report
in that name, linked to the intended-user control in `VL - 0006`. Content SHALL cover: a statement of
independence and no contingent fee arrangement; the qualifications of the individual signing; the scope
of work and the standard and premise of value; a full description of the business and the transaction
being financed; historical and adjusted financial statements with the SDE or EBITDA bridge from
`QE - 0004`; all three approaches considered with an explanation of any approach rejected and why; the
concluded fair market value of the assets or equity being acquired; and an allocation of purchase price
across real estate, machinery and equipment, intangibles and goodwill, which lenders need for collateral
coverage and which drives whether the goodwill threshold is triggered. The output SHALL also produce a
debt service coverage schedule tying the concluded value and proposed capital stack from `PJ - 0001` to
projected cash flow from `PJ - 0004`. The output SHALL cross-check against the lender requirement
checklist in `DR - 0005` and flag any missing item before the report can be finalized and released.
(`VL - 0007`)

**Fidelity: product-list detail** — no feature specification document exists for `VL - 0007`.

#### Scenario: Missing checklist items block release
- **WHEN** an item on the `DR - 0005` lender requirement checklist is unmet
- **THEN** it is flagged and the report cannot be finalized and released

#### Scenario: The lender is the intended user
- **WHEN** the lender is designated intended user
- **THEN** the report is prepared for and addressed to the lender rather than the buyer or broker

### Requirement: The asset approach walks the balance sheet to fair market value

The system SHALL provide an asset / net asset value approach, completing the income and market
approaches, starting from the balance sheet built in the database and reports modules and walking each
line from book value to fair market value: accounts receivable net of an uncollectible reserve informed
by the AR aging in `QE - 0011`; inventory adjusted for obsolescence and from any tax-basis or LIFO
convention to fair value; machinery, equipment and vehicles restated to fair market or orderly
liquidation value with a field to reference a third-party equipment appraisal; real estate restated with
a field to reference a real property appraisal; identification of off-balance-sheet and unrecorded items
including operating lease obligations, accrued and unbilled liabilities, pending litigation, deferred
revenue and warranty exposure; and removal of non-operating and personal-use assets consistent with the
normalization in `QE - 0004`. It SHALL produce adjusted net asset value as the equity floor, with a
toggle between going-concern, orderly-liquidation and forced-liquidation premise driven by the premise
selected in `VL - 0006` — on a liquidation premise the system SHALL promote this method to controlling
and suppress the income approach. It SHALL also compute the excess-earnings or capitalized-intangible
spread, showing adjusted net asset value against the concluded value from the income and market
approaches, so the user can see how much of the purchase price is goodwill and other intangibles — the
number determining whether the SBA goodwill threshold in `VL - 0007` is triggered. (`VL - 0008`)

**Fidelity: product-list detail** — no feature specification document exists for `VL - 0008`.

#### Scenario: A liquidation premise promotes the asset approach
- **WHEN** the premise selected in `VL - 0006` is orderly or forced liquidation
- **THEN** the asset approach becomes controlling and the income approach is suppressed

#### Scenario: The intangible spread is visible
- **WHEN** adjusted net asset value is compared against the concluded value
- **THEN** the goodwill and intangible portion of the purchase price is shown

### Requirement: Deal structure bridges enterprise value to what each side actually gets

The system SHALL bridge the concluded enterprise value from `VL - 0005` to what the seller nets and what
the buyer pays. It SHALL cover asset sale versus stock or equity sale — including the buyer's step-up in
basis and depreciation or amortization benefit on an asset sale versus the seller's typically better
capital gains treatment on a stock sale — with the tax consequence for each side pulled from the tax
projection logic in `PJ - 0005`, differentiated by entity type since a C corporation asset sale creates
double taxation while an S corporation or partnership generally does not, and flagging Section
338(h)(10) and F-reorganization structures where relevant. It SHALL handle the consideration mix: cash
at close; seller note with rate, term, amortization and any standby or subordination the lender
requires; earnout with performance metric, measurement period, cap and probability weighting so an
expected value can be discounted to present value at a rate reflecting collection risk rather than
counted at face; rollover or retained equity; assumed liabilities; and escrow or holdback amounts with
release timing. It SHALL apply the working capital peg and true-up mechanism, the cash-free debt-free
convention, and net debt treatment, so the difference between enterprise value, headline purchase price,
and equity proceeds at close is visible. Output SHALL be a side-by-side comparison of two or more
structures showing headline price, risk-adjusted present value of total consideration, seller net after
tax, and buyer cash-on-cash return and debt service coverage. It SHALL also feed personal goal analysis
for the seller, tying net after-tax proceeds to their stated post-close liquidity need, supporting the
wealth-manager cross-sell in `BY - 0006`. (`VL - 0009`)

**Fidelity: product-list detail** — no feature specification document exists for `VL - 0009`. This
feature gates `BR - 0014` (Offer Comparison & Bid Analysis), which is not buildable without it.

#### Scenario: Two offers at one price compare differently
- **WHEN** two structures with the same headline price are compared
- **THEN** risk-adjusted present value, seller net after tax, and buyer returns differentiate them

#### Scenario: Earnouts are probability-weighted, not counted at face
- **WHEN** an earnout is included in the consideration mix
- **THEN** its expected value is discounted to present value at a rate reflecting collection risk

### Requirement: Finalized valuations lock an immutable, reproducible snapshot

On finalization the system SHALL lock an immutable version capturing: the valuation date and report
date; a full snapshot of the underlying financial data as it existed at that moment rather than a live
link, so later GL reloads, `DB - 0006` reclassifications, or QoE adjustments do not silently restate a
historical conclusion; every user-entered assumption with its value and cited source; the selected
comparable company and precedent transaction sets with exact multiples, as-of pull dates and data
provider; the WACC and discount rate build-up components; the discounts and premiums applied; the method
weightings from `VL - 0005`; and the resulting concluded value range. (`VL - 0010`)

**Fidelity: product-list detail** — no feature specification document exists for `VL - 0010`.

#### Scenario: Later data changes do not restate history
- **WHEN** GL data is reloaded or reclassified after a version is locked
- **THEN** the locked version's conclusion and underlying snapshot are unchanged

### Requirement: Assumption changes are logged and versions are comparable

The system SHALL maintain a change log recording who changed which assumption, from what value to what
value, when, and an optional reason, plus a side-by-side version comparison view highlighting which
inputs moved and quantifying how much of the change in concluded value each one drove, so a revised
valuation can be explained rather than asserted. (`VL - 0010`)

#### Scenario: A revision is explainable
- **WHEN** two valuation versions are compared
- **THEN** the moved inputs are highlighted with the share of the value change each drove

### Requirement: Locked versions are read-only, signed off, and stored under the security model

Locked versions SHALL be read-only and SHALL be supersedable only by a new version, never edited or
deleted, with the report PDF and Excel export stored against the version in the data room under the
security model in `SY - 0001` / `SY - 0002`. The system SHALL support a formal reviewer sign-off step
recording reviewer identity and timestamp before a version can be released externally, and SHALL surface
a warning whenever a user opens a valuation whose source data has changed since the last locked version.
(`VL - 0010`)

#### Scenario: External release requires sign-off
- **WHEN** a locked version is released externally
- **THEN** a reviewer sign-off with identity and timestamp must already be recorded

#### Scenario: Stale source data warns on open
- **WHEN** a user opens a valuation whose source data changed since the last locked version
- **THEN** a warning is surfaced

CENTURIUUM
Feature Specification

| Feature ID | VL - 0002 |
|---|---|
| Feature Name | DCF Analysis |
| Module | VL - Valuations |
| Status | Draft |
| Related / Recycled IDs | VL - 0001 (Valuation Model) — supersedes the DCF deferral recorded there; PJ - 0002 through PJ - 0004 (Projection Model); QE - 0004 (SDE/EBITDA Tab); DB - 0004 (Trial Balance) |
| Author | Valentin Secchi |
| Date | August 17, 2026 |

# 1. Purpose & Business Context
VL-0001 deferred the discounted cash flow method on the grounds that projections had no home in the platform. The Projection Model module resolves that, and VL-0002 is the income-approach method that consumes it: the system reads the five-year projected P&L, balance sheet, and cash flow from PJ-0002 through PJ-0004, derives unlevered free cash flow, discounts it at a WACC built from the same rate build-up VL-0001 already uses, and produces a terminal value under both a perpetuity growth method and an exit multiple method. The result is an enterprise value indication that flows into VL-0001's enterprise-to-equity bridge and appears as a third approach in that feature's concluded range, its Excel workbook, and its PDF report. This feature produces no separate deliverable.
Two methodological decisions shape the build. First, the DCF always runs on an EBITDA basis. An SDE convention adds back the owner's compensation, but the business would still have to pay a manager to do that work, so discounting SDE-derived cash flow overstates value by the cost of management in perpetuity. Where the deliverable is set to SDE convention for consistency with QE-0004, the DCF section presents a reconciliation from SDE to EBITDA — deducting a disclosed market-rate owner replacement salary — and discounts the EBITDA-basis cash flow. The toggle changes what the reader sees, never what the model discounts.
Second, there is one rate engine, not two. The build-up that produces VL-0001's capitalization rate — risk-free rate, equity risk premium, size premium, company-specific risk premium — produces the cost of equity here, which is then combined with an after-tax cost of debt at an industry target capital structure to give WACC. A single valuation report showing an unreconciled capitalization rate and WACC for the same company would be the first thing a buy-side reviewer took apart, so the components, their sources, and their overrides are shared and the report presents the relationship between the two rates explicitly.
The honest limitation of this method is that its answer rests on projections the platform has not verified and, frequently, that the seller prepared. The deliverable states who prepared the projections and when, states that they are unverified and forward-looking, and reports terminal value as a percentage of total indicated value so a reader can see how much of the conclusion depends on an assumption about year six and beyond.
# 2. User Stories
One story per user type that touches this feature. Format: "As a [role], I want to [action], so that [benefit]."
- As a broker, I want a DCF built automatically from the projections already in the platform, so that I can present an income-approach indication without building a model by hand.
- As a broker, I want the DCF, the capitalization of earnings, and the market approach to appear side by side in one concluded range, so that I can show a seller three independent views of value rather than one number.
- As a broker, I want to override the discount rate, terminal growth, or exit multiple and have my reasoning printed, so that my judgment is documented rather than buried in a spreadsheet cell.
- As a broker, I want a sensitivity grid of WACC against terminal growth and against exit multiple, so that I can answer a seller's or a buyer's what-if in the room.
- As a CPA or QoE preparer reviewing the work, I want every cash flow line traced back to the projection it came from, and the capitalization rate reconciled to the WACC, so that I can verify the model rather than take it on faith.
- As a CPA reviewing the work, I want the implied exit multiple from the perpetuity method and the implied growth rate from the exit multiple method shown as cross-checks, so that I can see whether the two terminal assumptions are consistent with each other.
- As a broker working an SDE-convention deal, I want the DCF to show me how SDE reconciles to the EBITDA basis it discounts, so that I understand why the DCF value differs from a multiple of SDE.
- As a firm owner, I want the deliverable to disclose that the DCF rests on unverified projections and to show how much of the value sits in terminal value, so that nobody presents a projection-driven number as a certainty.
- As a platform administrator, I want every rate override, terminal assumption, scenario run, and exit multiple source logged, so that any published DCF indication can be reconstructed.
# 3. Functional Requirements
Numbered, testable statements the dev team can build against directly. Avoid prose — each line should be independently verifiable.
- The DCF shall be available only within a valuation for which a completed projection set exists in PJ-0002 through PJ-0004 for the subject company.
- Where no completed projection set exists, the DCF section shall be absent from the valuation, and the valuation shall proceed on the remaining approaches without error or empty output.
- The DCF shall not be available on a standalone prospect valuation unless a projection set exists for that prospect.
- The system shall not permit creation or editing of projections within the DCF. All projection changes shall occur in the Projection Model module and the DCF shall be re-run.
- The DCF shall produce no separate deliverable. Its output shall contribute a section to the VL-0001 PDF report and dedicated sheets to the VL-0001 Excel workbook.
- The DCF shall record the projection set version, its preparer, and its preparation date, and shall display and print all three.
- The DCF shall derive unlevered free cash flow on an EBITDA basis in all cases, regardless of the deliverable's SDE or EBITDA presentation convention.
- Where the projection set is prepared on an SDE convention — that is, without a market-rate owner compensation expense — the system shall deduct a market-rate owner replacement salary before deriving EBIT.
- The owner replacement salary shall be an explicit, disclosed input, shall be overridable with a recorded rationale, and shall print in the assumptions schedule.
- The projection set shall declare whether it already includes market-rate owner compensation. Where that declaration is absent, the system shall require the broker to state it before the DCF can be run.
- Where the deliverable is set to SDE convention, the DCF section shall present a reconciliation from SDE to the EBITDA basis actually discounted, showing the owner replacement salary and any other reconciling items.
- The system shall not permit discounting of SDE-derived cash flow under any setting.
- The system shall derive unlevered free cash flow for each explicit projection period as: adjusted EBIT, less income taxes at the applied rate, plus depreciation and amortization, less capital expenditures, less the increase in net working capital.
- Each component of unlevered free cash flow shall be traced to its source projection statement and line, and that trace shall be visible in the workbook.
- Depreciation, amortization, and capital expenditures shall be read from the projected cash flow and balance sheet statements rather than estimated.
- The change in net working capital shall be derived from the projected balance sheet.
- Income taxes shall be applied at an entity-level, C-corp-equivalent rate by default, comprising a federal component and a state assumption, and the applied rate shall be displayed and printed.
- The broker shall be able to override the applied tax rate, including setting it to zero for a pass-through entity, with a recorded rationale that prints in the assumptions schedule.
- The system shall state on the deliverable that projected earnings have been tax-affected at the applied rate and that this is done so the income approach remains comparable to the tax-affected earnings implicit in transaction multiples.
- The discount rate shall be derived from the same shared rate build-up used by VL-0001. The build-up components — risk-free rate, equity risk premium, size premium, and company-specific risk premium — shall be entered once per valuation and shall serve both features.
- The build-up shall produce a cost of equity, and each component shall be displayed with its source or rationale and its as-of date.
- WACC shall be computed as the cost of equity weighted by the equity share of the target capital structure, plus the cost of debt weighted by the debt share and multiplied by one minus the applied tax rate.
- The target capital structure shall default to an industry target for the subject's industry taxonomy node, and shall be overridable with a recorded rationale.
- The cost of debt shall default to a market assumption and shall be overridable with a recorded rationale.
- Overriding any shared build-up component shall affect both the DCF's WACC and VL-0001's capitalization rate, and the system shall make that consequence visible at the point of override.
- The deliverable shall present the reconciliation between the capitalization rate used in VL-0001's capitalization of earnings method and the WACC used here, so that the two rates cannot appear unexplained in one report.
- The system shall discount each period's unlevered free cash flow at the WACC using a mid-year convention by default, and the convention applied shall be stated on the deliverable.
- The broker shall be able to select an end-of-year convention, and the selection shall print in the assumptions schedule.
- The sum of discounted explicit-period cash flows plus discounted terminal value shall constitute the DCF's indicated enterprise value on a debt-free, cash-free basis.
- The DCF shall produce an enterprise value indication only. It shall not compute equity value independently; conversion to equity value occurs solely through the VL-0001 bridge.
- The system shall compute terminal value under both a perpetuity growth method and an exit multiple method, and shall produce a separate DCF value indication from each.
- The perpetuity growth method shall apply a terminal growth rate to the final explicit-period free cash flow and capitalize it at the WACC less the growth rate.
- The system shall prevent a terminal growth rate equal to or exceeding the WACC less a defined minimum spread, and shall warn where the terminal growth rate exceeds a defined long-run ceiling.
- The exit multiple method shall apply an exit multiple to terminal-year EBITDA.
- The exit multiple shall default to a value derived from the VL-0001 comparable cohort for the subject's industry taxonomy node and size band, and shall be overridable with a recorded rationale.
- Where the comparable cohort does not meet VL-0001's absolute minimum cohort size, no cohort-derived exit multiple shall be offered, the broker shall enter one directly, and the deliverable shall state that no market-derived exit multiple was available.
- The system shall report, as cross-checks, the exit multiple implied by the perpetuity growth method and the perpetuity growth rate implied by the exit multiple method.
- The broker shall designate one terminal method as primary for inclusion in VL-0001's concluded range, and shall record a rationale for that designation. The non-primary indication shall be retained and presented in the report as a cross-check.
- The system shall report terminal value as a percentage of total indicated enterprise value under each method, and shall display a warning where that percentage exceeds a defined threshold.
- The system shall run the DCF against every scenario present in the projection set.
- The DCF's indicated value range shall span the lowest and highest indications produced across scenarios under the primary terminal method.
- The deliverable shall identify which scenario produces each endpoint of the range, and shall disclose the principal assumptions distinguishing the scenarios.
- Where the projection set contains only a single scenario, the DCF's indicated range shall instead be derived from the sensitivity grid, and the deliverable shall state that the range reflects assumption sensitivity rather than scenario variation.
- The deliverable shall identify the base-case indication within the range so that a scenario-driven range is not read as an equally weighted set of outcomes.
- The system shall produce a sensitivity grid of indicated enterprise value across WACC against terminal growth rate for the perpetuity growth method.
- The system shall produce a sensitivity grid of indicated enterprise value across WACC against exit multiple for the exit multiple method.
- Grid step increments shall be configurable, and the increments used shall be stated on the grid.
- Both grids shall be reproduced in the Excel workbook as live formulas, not as pasted values.
- The DCF section of the PDF report shall include: the projection source and preparer with dates, the SDE-to-EBITDA reconciliation where applicable, the unlevered free cash flow build by period, the rate build-up and WACC computation, both terminal value methods with their cross-checks, terminal value as a percentage of total value, the indicated range with scenario attribution, both sensitivity grids, and the assumptions and overrides schedule.
- The report shall state prominently that the DCF indication depends on forward-looking projections that the platform has not audited or verified, and shall identify who prepared them.
- The Excel workbook shall include dedicated DCF sheets containing the free cash flow build, the rate build-up and WACC, both terminal value computations, and both live sensitivity grids, with editable assumption cells.
- The workbook provenance sheet shall additionally record the projection set version, its preparer and date, the scenario set used, and the source of the exit multiple.
- On finalization of the parent VL-0001 valuation, the system shall freeze the projection set version, the scenario set, the rate components, the terminal assumptions, and any cohort-derived exit multiple, so that the DCF section remains reproducible.
- The system shall log to the Activity & Audit Log (SY-0003): DCF run with projection set version and scenario set, every rate component override with rationale, tax rate override with rationale, capital structure or cost of debt override with rationale, owner replacement salary set or overridden, terminal assumptions set, primary terminal method designated with rationale, cohort-derived exit multiple retrieved with cohort count, and terminal value dominance warning triggered.
# 4. Data Requirements
What tables/fields does this feature read from or write to? Reference the relevant Database module table blocks (DB-0001 through DB-0010) wherever applicable so every feature traces back to the reconciled data structure.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Projected P&L by period (revenue, EBITDA, EBIT, D&A) | Read | PJ-0002 through PJ-0004 — Projection Model; exact feature names to be confirmed |
| Projected balance sheet (working capital components) | Read | PJ-0002 through PJ-0004 — Projection Model; source of the change in net working capital |
| Projected cash flow (capital expenditures, depreciation and amortization) | Read | PJ-0002 through PJ-0004 — Projection Model; capex and D&A read rather than estimated |
| Projection set version, preparer identity, preparation date, owner-compensation declaration | Read | Projection Model record; displayed and printed on the deliverable |
| Scenario set (base, upside, downside or as defined) | Read | Projection Model record; every scenario is run |
| Shared rate build-up components (risk-free rate, equity risk premium, size premium, company-specific risk premium) with sources and as-of dates | Read / Write | VL-0001 shared rate engine — entered once per valuation, serving both the capitalization rate and WACC |
| Cost of debt and target capital structure by industry node | Read | Platform reference assumptions; maintenance owner to be confirmed (see Open Questions) |
| Applied tax rate (federal and state components) and any override | Write | New VL-module table block; printed in the assumptions schedule |
| Owner replacement salary input | Write | New VL-module table block; required where projections exclude market-rate owner compensation |
| Terminal assumptions (growth rate, exit multiple, primary method designation) with rationales | Write | New VL-module table block |
| Cohort-derived exit multiple | Read | VL-0001 comparable-transaction cohort statistics — aggregates only, subject to the same minimum cohort floor and suppression rules |
| DCF results by scenario and terminal method (period cash flows, discount factors, present values, indicated enterprise value, terminal value share) | Write | New VL-module table block; frozen on parent valuation finalization |
| Sensitivity grid definitions and increments | Write | New VL-module table block; reproduced as live formulas in the workbook |
| Indicated enterprise value range | Write | Passed to VL-0001 for the enterprise-to-equity bridge and the concluded range; no equity value computed here |
| Normalized historical earnings for the SDE-to-EBITDA reconciliation | Read | QE-0004 — SDE/EBITDA Tab |
| Actual capital structure reference | Read | DB-0004 — Trial Balance; used only for disclosure where the broker overrides to the actual structure |
| DCF run, override, and warning events | Write | SY-0003 — Activity & Audit Log |

# 5. Access & Security
Confirm roles and deal isolation explicitly on every spec — never assume it.
- Roles with access: Broker — run the DCF, set and override assumptions with rationale, designate the primary terminal method, and generate the parent valuation's deliverables. Firm administrator — same rights within their firm. Accountant / QoE preparer — read access to the DCF, its inputs, assumptions, and the deliverable sections on deals they have access to, with no finalize or publish rights.
- Roles explicitly excluded: Company / Seller user — no access to the DCF workspace; a seller sees DCF output only where the broker has published the finalized VL-0001 deliverables into the data room under DR-0001. Buyer — no access to the DCF, its assumptions, its scenarios, or any indicated value, at any status, under any circumstance. Bank — no access; the DCF forms no part of any automatic post-underwriting disclosure under BK-0001.
- Access inheritance: because the DCF produces no separate deliverable, it carries no independent sharing surface. Every disclosure of DCF output occurs through the parent VL-0001 valuation and is governed by that feature's access rules.
- Comparable cohort access is inherited unchanged from VL-0001 and is not relaxed here. The exit multiple is obtained as an aggregate statistic only, subject to the same absolute minimum cohort size, the same single-transaction concentration suppression, and the same fixed cohort definitions. No per-transaction comparable record shall be readable through the DCF, its sensitivity grids, or the exported workbook.
- Deal isolation confirmed: the DCF is scoped to a single valuation within a single company/deal, or to a single prospect record private to the creating user's firm. Its projection inputs, scenarios, assumptions, overrides, results, and frozen snapshots are visible only within that deal or that firm, with no cross-deal or cross-firm visibility. The only cross-deal data reaching this feature is the aggregate cohort exit multiple, under VL-0001's controls.
- Because the DCF's conclusion rests on unverified forward-looking projections, the disclosure of the projections' preparer and the unverified-projections statement are treated as required content of the deliverable rather than optional notes, and cannot be suppressed by the broker.
# 6. UI / UX Notes
Layout, interaction notes, or wireframe reference. State platform scope explicitly per feature.
- Platform: Web only. DCF configuration, assumption entry, override, and scenario review are web-only, consistent with VL-0001. Generated PDF deliverables are viewable on any device through the data room viewer where published; there is no DCF editing on mobile.
- Wireframe reference: N/A
The DCF appears as a step within the VL-0001 valuation workflow rather than as its own destination, since it produces no independent deliverable. Its main view should show the unlevered free cash flow build by period as a readable schedule — each line labeled with the projection statement it came from — with the rate build-up and WACC computation beside it and both terminal indications below. A CPA should be able to audit the model by reading the screen, without opening the workbook.
Terminal value deserves visual prominence proportional to its influence. Show the terminal value share of total indicated value for each method as a headline figure, not a footnote, and surface the dominance warning where it exceeds the threshold. Show the implied exit multiple from the perpetuity method next to the actual cohort multiple, and the implied growth rate from the exit multiple method next to the perpetuity assumption — when those cross-checks disagree, the broker should see it without being asked to compute it.
Where the deliverable is in SDE convention, the SDE-to-EBITDA reconciliation should sit at the top of the DCF view rather than in an appendix, with the owner replacement salary as an obvious, editable line. A broker who does not understand why the DCF value differs from a multiple of SDE will assume the model is wrong; showing the bridge answers the question before it is asked.
Scenario results should be presented together — a small table of indicated value by scenario with the range endpoints and the base case identified — because the concluded range spans scenarios. A range whose width comes from projection scenarios rather than from business risk needs the base case marked inside it, otherwise a seller reads the top of the range as the expected outcome.
Overrides on shared rate components should carry a visible notice that the change also affects VL-0001's capitalization rate. A broker adjusting company-specific risk here is silently changing the other approach too, and discovering that only in the printed report is a bad surprise.
# 7. Dependencies
Upstream features that must exist first. This is the single most valuable section for sequencing the build.

| Related Feature | Relationship | Notes |
|---|---|---|
| PJ-0002 through PJ-0004 — Projection Model | Depends on | Hard dependency. Supplies the projected P&L, balance sheet, and cash flow, the scenario set, the projection preparer and date, and the declaration of whether projections include market-rate owner compensation. No DCF exists without a completed projection set. Confirm the exact feature names and that the module produces scenarios. |
| VL-0001 — Valuation Model | Depends on | Parent feature. Supplies the shared rate build-up, the comparable cohort used for the exit multiple, the enterprise-to-equity bridge, the concluded range, and both deliverables. VL-0001 requires amendment: its DCF deferral is superseded, its rate build-up becomes the shared engine, its concluded range gains a third approach, and its finalization freeze must cover the DCF's projection set, scenarios, and exit multiple. |
| QE-0004 — SDE/EBITDA Tab | Depends on | Normalized historical earnings used in the SDE-to-EBITDA reconciliation and to establish convention consistency. |
| DB-0004 — Trial Balance | Related | Actual capital structure, used only for disclosure where a broker overrides the industry target structure to the subject's actual structure. |
| Comparable-transaction pool (via VL-0001) | Depends on | Source of the default exit multiple. Inherits every confidentiality control unchanged: aggregates only, minimum cohort floor, concentration suppression, fixed cohort definitions. |
| Industry taxonomy reference data | Depends on | Determines the cohort for the exit multiple and the industry target capital structure. Shared with VL-0001 and CM-0005 — must remain a single reference. |
| Rate and structure reference assumptions (unresolved) | Depends on | Risk-free rate source, equity risk premium, size premium table, cost of debt, and industry target capital structures. Ownership, update cadence, and whether they are global or per industry node are unassigned (see Open Questions). |
| Owner compensation benchmark data (unresolved) | Depends on | The market-rate owner replacement salary required whenever projections are prepared on an SDE convention. No platform source is known; broker entry is the fallback. |
| DR-0001 — Core Data Room | Related | Destination of the parent valuation's published deliverables. The DCF has no independent publication path. |
| Legal / compliance (cross-cutting gap) | Depends on | Owns the unverified-projections language and the intended-use restrictions, consistent with VL-0001's non-appraisal framing. |
| SY-0003 — Activity & Audit Log | Depends on | DCF runs, every override with rationale, cohort retrievals, and dominance warnings. Platform-wide audit trail is a known cross-cutting gap. |
| Spreadsheet generation infrastructure | Depends on | Live sensitivity grids and a formula-driven cash flow build within the VL-0001 workbook, rather than pasted values. |

# 8. Out of Scope / Deferred
- Creating or editing projections — owned entirely by the Projection Model module; the DCF is a consumer.
- A simplified DCF built from broker-entered growth and margin assumptions where no projection set exists.
- Levered DCF, equity cash flow method, and adjusted present value methods. V1 discounts unlevered free cash flow at WACC only.
- CAPM or beta-derived cost of equity. The discount rate is produced by the build-up method only, consistent with VL-0001.
- Terminal value by liquidation or asset value, and any terminal method beyond perpetuity growth and exit multiple.
- Synergy value, strategic-buyer value, and control premia or minority discounts, consistent with VL-0001's exclusion of discounts and premia.
- Monte Carlo simulation, probability-weighted scenario expected values, and real options analysis.
- Stub or partial-period discounting where the valuation date falls mid-fiscal-year (see Open Questions).
- Tax attribute modeling, including asset step-up benefits, transaction structure elections, and net operating loss carryforwards.
- Multi-entity consolidated projections and multi-currency cash flows, consistent with the deferral in DB-0002.
- A separate standalone DCF report or workbook. All output is delivered through VL-0001.
- Any flow of DCF output into the CIM, the Teaser, a listing price, or any buyer-facing document, consistent with VL-0001.
# 9. Open Questions
- Reference file access: the project knowledge files (Centuriuum_Product_List.xlsx, Centuriuum_Spec_Conventions_and_Decisions.docx) could not be read when this spec was drafted. Confirm the VL module label, confirm the exact feature names and IDs behind PJ-0002 through PJ-0004, and confirm the Projection Model actually produces named scenarios rather than a single forecast.
- VL-0001 amendments required: (a) Section 8 defers DCF on the grounds that projections have no platform home — that deferral is superseded and should point to VL-0002; (b) the capitalization rate build-up becomes the shared rate engine serving both features; (c) the concluded range and football field must accommodate a third approach; (d) the finalization freeze must extend to the projection set version, the scenario set, and the cohort-derived exit multiple; (e) Related IDs should name VL-0002. Confirm and assign ownership of the edit.
- Scenario-spanning range: the selected behavior is that the DCF range spans lowest to highest across scenarios. The consequence is that range width is driven by how aggressively the projection scenarios were drawn rather than by business risk, and two deals with identical risk will show different DCF widths purely because one broker built a bolder upside. This spec mitigates by identifying the base case inside the range and disclosing the distinguishing assumptions. Confirm accepted, or narrow the concluded range to the base case with scenarios shown as a cross-check.
- Terminal value dominance threshold: what percentage of total indicated value should trigger the warning? A DCF where terminal value is most of the answer is really a multiple applied to year five. Recommend a warning above a clearly stated level and confirmation of that level before build.
- Perpetuity growth ceiling: what is the maximum permitted terminal growth rate, and is it a hard cap or a warning? Recommend a hard cap referencing a long-run inflation or GDP assumption, since an unbounded growth rate produces an unbounded value as it approaches WACC.
- Reference assumption ownership: who maintains the risk-free rate source, equity risk premium, size premium table, cost of debt, and industry target capital structures — and at what cadence? These are the inputs a reviewer will challenge first, and a stale size premium table undermines every valuation on the platform. Are they global or per industry taxonomy node?
- Tax rate default: what federal and state default rate applies, and is entity type read from a platform field or declared by the broker? Note that the state assumption for a business operating in several states is itself a judgment that will need a documented convention.
- Owner replacement salary: is there a data source for market-rate owner compensation by industry and region, or is this always broker-entered? This input directly reduces value on every SDE-convention deal, so brokers will contest it and will want a defensible basis.
- Cross-module requirement on the Projection Model: the projection set must declare whether it includes market-rate owner compensation. If PJ does not currently capture that, it needs to, otherwise this feature cannot know whether to deduct an owner salary and will either double-count or under-deduct. This should be raised as a requirement against the PJ specs.
- Working capital granularity: do the projected balance sheet and cash flow statements carry sufficient detail to derive the change in net working capital, and is the definition of net working capital in the projections the same one VL-0001 uses in its enterprise-to-equity bridge? Two different definitions in one report would be a defect.
- Mid-year convention is the default here. Confirm, and confirm the treatment of a valuation date that falls mid-fiscal-year — whether the first projection period is discounted as a full year, a stub, or the valuation date is constrained to a period boundary in v1.
- Does the DCF indication participate in VL-0001's concluded range by default, or should it initially be presented as a cross-check only until the platform has confidence in projection quality? Recommend a firm-level or platform-level setting rather than a per-valuation broker choice, so the decision is not made deal by deal.
- Override authority: same question as VL-0001 — may any broker with deal access override a rate component, terminal assumption, or tax rate, or should overrides be restricted to the deal owner? Overrides on shared components affect both approaches, which raises the stakes.
- Exit multiple basis consistency: cohort multiples are computed on total consideration to trailing earnings, while the exit multiple is applied to terminal-year projected EBITDA. Confirm that applying a trailing-basis market multiple to a forward-year figure is the intended convention, and that the deliverable discloses it.
# 10. Acceptance Criteria
- A valuation with a completed projection set exposes the DCF section; a valuation without one omits it entirely and completes on the remaining approaches without error.
- A standalone prospect valuation with no projection set offers no DCF.
- Projections cannot be created or edited from within the DCF through any UI path.
- The DCF produces no standalone report or workbook; its output appears only as a section of the VL-0001 PDF and as sheets in the VL-0001 workbook.
- The projection set version, preparer, and preparation date appear on screen and print in the report.
- With the deliverable set to SDE convention, the DCF still derives cash flow on an EBITDA basis, and the report shows the SDE-to-EBITDA reconciliation including the owner replacement salary.
- Where the projection set does not declare whether it includes market-rate owner compensation, the DCF cannot be run until the broker states it.
- Where projections exclude market-rate owner compensation, a market-rate owner replacement salary is deducted before EBIT, and that salary prints in the assumptions schedule.
- There is no setting or path under which SDE-derived cash flow is discounted.
- Unlevered free cash flow for each period equals adjusted EBIT less taxes at the applied rate, plus D&A, less capex, less the increase in net working capital, and each component is traceable to its source projection line in the workbook.
- D&A and capex are read from the projected statements, not estimated, and the change in net working capital derives from the projected balance sheet.
- The applied tax rate displays and prints, and an override to any value including zero requires a rationale that prints in the assumptions schedule.
- The rate build-up components entered in the valuation drive both VL-0001's capitalization rate and this feature's WACC, and overriding a shared component visibly notifies the user that both approaches are affected.
- WACC equals the cost of equity weighted by the equity share plus the after-tax cost of debt weighted by the debt share, using the industry target structure by default, with any override carrying a printed rationale.
- The deliverable presents the reconciliation between the capitalization rate and the WACC.
- Each period's cash flow is discounted using the mid-year convention by default, the convention applied is stated on the deliverable, and selecting end-of-year changes the result and prints the selection.
- The DCF outputs an enterprise value indication only; no equity value is computed within the DCF, and equity value appears solely via the VL-0001 bridge.
- Both terminal methods produce separate indications, and setting a terminal growth rate at or above WACC less the minimum spread is prevented, while a rate above the long-run ceiling produces a warning.
- The exit multiple defaults from the VL-0001 cohort where the cohort meets the minimum size; where it does not, no cohort-derived multiple is offered, the broker enters one, and the report states that no market-derived multiple was available.
- The report shows the implied exit multiple from the perpetuity method and the implied growth rate from the exit multiple method as cross-checks.
- The broker designates a primary terminal method with a recorded rationale, that indication feeds VL-0001's concluded range, and the non-primary indication appears in the report as a cross-check.
- Terminal value as a percentage of total indicated value is reported for each method, and exceeding the defined threshold produces a warning that appears in the report, not only on screen.
- The DCF runs against every scenario in the projection set, the indicated range spans the lowest and highest indications under the primary terminal method, each endpoint is attributed to its scenario, and the base-case indication is identified within the range.
- Where only one scenario exists, the indicated range derives from the sensitivity grid and the report states that the range reflects assumption sensitivity rather than scenario variation.
- Both sensitivity grids are produced with stated increments and are reproduced in the workbook as live formulas that recalculate when an assumption cell changes.
- The report states that the DCF depends on forward-looking projections the platform has not audited or verified, identifies who prepared them, and the broker cannot suppress either statement.
- Finalizing the parent valuation freezes the projection set version, scenario set, rate components, terminal assumptions, and cohort-derived exit multiple, and regenerating the deliverable reproduces the same DCF figures.
- No per-transaction comparable record is readable through the DCF, its grids, or the exported workbook.
- A buyer cannot access the DCF, its assumptions, its scenarios, or any indicated value at any status, and a seller reaches DCF output only through published VL-0001 deliverables in the data room.
- Every DCF run, rate or tax or structure override with rationale, owner salary entry, terminal assumption, primary method designation, cohort retrieval with count, and dominance warning appears in the Activity & Audit Log (SY-0003).
- A user without assigned role/deal access cannot view the DCF, its inputs, its results, or its frozen snapshot for that deal or prospect.

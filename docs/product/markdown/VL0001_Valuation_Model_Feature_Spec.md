CENTURIUUM
Feature Specification

| Feature ID | VL - 0001 |
|---|---|
| Feature Name | Valuation Model |
| Module | VL - Valuations |
| Status | Draft |
| Related / Recycled IDs | QE - 0004 (SDE/EBITDA Tab); DB - 0002 (GL Data); DB - 0004 (Trial Balance); CM - 0005 (shares the industry taxonomy); closed-deal transaction record — Feature ID to be confirmed |
| Author | Valentin Secchi |
| Date | August 17, 2026 |

# 1. Purpose & Business Context
A broker pricing a business today works from instinct, a rule of thumb, and whatever comparable transactions they personally remember. VL-0001 replaces that with a structured opinion of value built on two pillars: normalized earnings the platform has already produced through the QoE work in QE-0004, and multiples derived from the transactions Centuriuum's own users have closed. The output is a formula-driven Excel workbook and a PDF report — the same deliverable pattern as a QoE — covering earnings basis, market approach, income approach, the bridge from enterprise value to equity value, a concluded range by method, and a documented schedule of every assumption and override.
The commercially important capability here is the closed-deal comparable data, and it is also the reason this feature needs more care than any other in the product. Every other spec in this project asserts strict per-deal isolation. A comparable-transaction pool is by definition cross-deal, and the transactions in it belong to sellers who are not party to the deal being valued. This spec therefore treats the pool as a bounded, engineered exception rather than a policy exception: records are de-identified at the moment they are written, only aggregate statistics are ever displayed, cohorts are assembled from fixed definitions rather than free-form filters so a user cannot narrow their way to a single transaction, an absolute minimum cohort size is enforced below which nothing renders at all, no per-transaction row appears anywhere — including in the exported workbook — and contribution requires seller consent captured at engagement.
The output is explicitly an opinion of value prepared for pricing and marketing purposes. It is not a certified appraisal, does not conform to USPAP or SSVS, and is not prepared for tax, litigation, ESOP, or financial reporting use. That framing is stated on the deliverables rather than assumed, because the same document produced without it puts brokers and Centuriuum in appraisal-practice territory. Valuations may also be produced for a prospect before any engagement exists, since an opinion of value is frequently how a broker wins a listing — in that case earnings are broker-entered rather than platform-verified, and the deliverable says so.
# 2. User Stories
One story per user type that touches this feature. Format: "As a [role], I want to [action], so that [benefit]."
- As a broker, I want to produce an opinion of value from the normalized earnings the platform already calculated, so that my pricing rests on the QoE work rather than on a separate spreadsheet I maintain by hand.
- As a broker, I want multiples drawn from real closed transactions in comparable industries and size bands, so that I can defend a price to a seller with market evidence instead of a rule of thumb.
- As a broker, I want to run an opinion of value on a prospect before I am engaged, so that I can win the listing with a credible number.
- As a broker, I want to override a suggested multiple or discount rate when I know the business, and have my reasoning printed in the report, so that my judgment is documented rather than hidden in a cell.
- As a broker, I want a formula-driven Excel workbook, so that I can test assumptions with a seller or their accountant in a live conversation.
- As a CPA or QoE preparer reviewing the work, I want every input traced to its source with an as-of date, so that I can tie the valuation back to the normalized earnings and the balance sheet it was built from.
- As a seller, I want to understand the range and why the methods differ, so that I can form a realistic expectation before we go to market.
- As a firm owner, I want the deliverable to state clearly that it is an opinion of value and not a certified appraisal, so that my brokers are not producing regulated work product.
- As a seller whose deal has closed, I want my transaction to contribute to market data only in de-identified aggregate form and only with my consent, so that participating never exposes what I sold or for how much.
- As a platform administrator, I want every valuation, override, cohort query, and export logged, so that we can reconstruct how any published number was reached.
# 3. Functional Requirements
Numbered, testable statements the dev team can build against directly. Avoid prose — each line should be independently verifiable.
- The system shall allow a broker to create a valuation either as a standalone prospect valuation with no associated deal, or as a deal-scoped valuation attached to an existing deal.
- The system shall allow a standalone valuation to be promoted to a deal-scoped valuation when an engagement is signed, retaining its history.
- Valuation status shall progress Draft, Final, Superseded, Archived. A Final valuation shall be immutable.
- Editing a Final valuation shall create a new Draft version, and the prior version shall be retained and marked Superseded on finalization of the new one.
- Each valuation shall record a valuation date, and shall record separately the as-of date of every data source it consumes.
- Each valuation shall record and display its earnings basis provenance as either platform-verified (derived from QE-0004) or broker-entered, and the deliverables shall state which applies.
- For a deal-scoped valuation, normalized earnings shall be read from QE-0004, and the broker shall select the basis presented as either SDE or Adjusted EBITDA.
- The system shall not permit manual editing of QE-0004-derived earnings within the valuation. Adjustments shall be made in the QoE add-back schedule and the valuation re-run.
- For a standalone valuation, the broker shall enter revenue and the selected earnings measure directly, and the system shall mark those inputs as broker-entered throughout the model and the deliverables.
- The broker shall be able to base the valuation on a single period (trailing twelve months or a completed fiscal year) or on a weighted average of up to five annual periods.
- Where a weighted average is used, the weights applied to each period shall be recorded and shall print in the assumptions schedule of both deliverables.
- On deal close, the system shall write a de-identified comparable-transaction record to the platform comps pool, subject to the consent condition below.
- A comparable-transaction record shall capture: closing period (month and year only), industry taxonomy node, region, revenue, the earnings measure and its value, total consideration, consideration structure (cash at close, seller note, earnout, equity rollover), transaction form (asset or stock sale), whether real estate was included, whether inventory was included, working capital treatment, buyer type (strategic, financial, individual), employee count band, and years in operation band.
- A comparable-transaction record shall not store the company name, any trade name, exact address, customer names, personnel names, the deal identifier, the seller's identity, or the broker's or firm's identity in any field used for cohort assembly or display.
- De-identification shall occur at the point the record is written to the pool, not at the point of display.
- A transaction shall be contributed to the pool only where seller consent to contribute de-identified transaction data has been recorded. Absent recorded consent, no record shall be written.
- Where consent is withdrawn, the corresponding pool record shall be removed from all future cohort assembly.
- The pool shall exclude any deal that is not closed, and shall exclude the valuing user's own in-progress deals from every cohort.
- Cohorts shall be assembled from fixed, system-defined combinations of industry taxonomy node, size band, region grouping, and closing period window. The system shall not permit free-form or arbitrary filter combinations.
- The system shall enforce an absolute minimum cohort size. Where a cohort contains fewer records than that minimum, the system shall render no market-approach statistic of any kind and shall state that market data is unavailable. This floor shall not be overridable by any user or role.
- The system shall additionally enforce a concentration rule: where a single transaction would disproportionately determine a displayed statistic beyond a defined threshold, the statistic shall be suppressed even if the minimum cohort size is met.
- The system shall enforce a separate, higher credibility threshold. Where a cohort meets the absolute minimum but falls below the credibility threshold, statistics shall be displayed together with a prominent insufficient-data warning stating the cohort count.
- The insufficient-data warning shall print on the PDF report and appear in the Excel workbook, not only in the on-screen interface.
- The system shall display only aggregate cohort statistics: count, median, mean, first and third quartiles, and minimum and maximum. No per-transaction row, record, or identifier shall be displayed in the interface, the PDF report, the Excel workbook, or any export or API response.
- The system shall record every cohort query, including its defining parameters, the resulting count, and the requesting user, to the Activity & Audit Log (SY-0003), so that attempts to narrow toward an individual transaction are detectable.
- Multiples shall be computed only from records that carry sufficient consideration-structure data to normalize the basis. Records lacking that data shall be excluded from multiple computation and the exclusion count shall be disclosed with the cohort.
- On finalization, a valuation shall freeze the cohort statistics it used together with the cohort definition, count, and as-of date, so that the report remains reproducible after the pool changes.
- The market approach shall present multiples of total consideration to the selected earnings measure, and to revenue, for the assembled cohort.
- The system shall propose a selected multiple derived from the cohort statistics.
- The system shall present the subject company's position relative to the cohort on defined comparison factors, including size, revenue growth, margin, and customer concentration derived from DB-0002.
- The broker shall be able to override the selected multiple. Any override shall require a recorded rationale, which shall print in the assumptions schedule of both deliverables.
- The market approach shall produce an indicated value range rather than a single value.
- The income approach shall be implemented as a capitalization of earnings method applied to the normalized earnings basis.
- The system shall build the capitalization rate from disclosed components — risk-free rate, equity risk premium, size premium, and company-specific risk premium — each displayed separately with its source or rationale.
- The broker shall be able to override any rate component. Any override shall require a recorded rationale, which shall print in the assumptions schedule of both deliverables.
- The income approach shall produce an indicated value range derived from a defined variation around the concluded rate.
- The system shall treat approach outputs as indications of enterprise value on a debt-free, cash-free basis, and shall state that basis on the deliverables.
- The system shall provide a bridge from indicated enterprise value to indicated equity value comprising: less funded debt, plus excess cash, and plus or minus the difference between actual and normal working capital.
- Bridge components shall be read from DB-0004 where the required detail is available, and shall otherwise be broker-entered and visibly flagged as broker-entered in both deliverables.
- The broker shall specify whether real estate is included in or excluded from the valued enterprise, and the deliverables shall state the treatment. Where excluded, the system shall not value the real estate.
- The broker shall specify whether inventory is included, consistent with the transaction form assumed.
- The system shall present the indicated range from each approach applied, side by side, together with a concluded range.
- The broker shall record a written reconciliation explaining why the approaches differ and how the concluded range was reached, and that reconciliation shall print in the report.
- The system shall not require or produce a single point value. Where a midpoint is displayed, it shall be presented as the midpoint of a range and not as a concluded value.
- The system shall produce sensitivity tables showing the effect on indicated value of varying the selected multiple against the earnings basis, and the capitalization rate against the earnings basis.
- Any pricing guidance derived from a valuation shall remain internal to the broker and seller. The system shall not flow a valuation output, concluded range, or price into the Teaser (CM-0005), the CIM (CM-0001), or any buyer-facing document.
- The system shall generate a PDF report containing, at minimum: purpose and intended use, standard and premise of value, scope and limiting conditions, the non-appraisal disclaimer, earnings basis and normalization summary, market approach with cohort description and aggregate statistics, income approach with rate build-up, the enterprise-to-equity bridge, indicated ranges by approach, the concluded range and reconciliation, sensitivity tables, the assumptions and overrides schedule, and a sources schedule with as-of dates.
- The PDF report shall carry prominent language stating that it is an opinion of value prepared for pricing and marketing purposes, that it is not a certified appraisal, that it does not conform to USPAP or SSVS, and that it is not prepared for tax, litigation, ESOP, or financial reporting purposes.
- The report shall identify the preparing broker and firm, and shall render using the firm theme defined in CM-0001.
- The system shall generate an Excel workbook containing live formulas and editable assumption cells, including the sensitivity tables, so that assumptions can be flexed outside the platform.
- The Excel workbook shall include a provenance sheet stating the valuation version, valuation date, every source and its as-of date, the cohort definition and count, and the same non-appraisal disclaimer.
- The Excel workbook shall contain aggregate cohort statistics only, and shall contain no per-transaction comparable record under any circumstance.
- Deliverables generated from a Draft valuation shall be watermarked “DRAFT — NOT FOR DISTRIBUTION” on every page of the PDF and shall be marked as draft on the workbook's provenance sheet.
- For a deal-scoped valuation, the broker shall be able to publish the finalized deliverables into the deal's data room (DR-0001) as tracked documents. Publication shall be an explicit action and shall not occur automatically.
- Deliverables for a standalone prospect valuation shall be private to the creating user and their firm, and shall not be written to any deal's data room.
- The system shall log to the Activity & Audit Log (SY-0003): valuation created, promoted from standalone to deal-scoped, cohort queried with parameters and count, assumption overridden with rationale, valuation finalized with frozen cohort reference, deliverable generated with format and version, deliverable published to the data room, valuation superseded or archived, comparable-transaction record contributed, and consent recorded or withdrawn.
# 4. Data Requirements
What tables/fields does this feature read from or write to? Reference the relevant Database module table blocks (DB-0001 through DB-0010) wherever applicable so every feature traces back to the reconciled data structure.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Valuation record (scope, status, version, valuation date, earnings basis, provenance flag, created/finalized by and at) | Write | New VL-module table block — DB-0001 to DB-0010 are financial data blocks and none is reserved for valuation content |
| Valuation assumptions and overrides (selected multiple, rate components, period weights, each with rationale) | Write | New VL-module table block; printed in the assumptions schedule of both deliverables |
| Normalized earnings — SDE and Adjusted EBITDA, with add-back detail | Read | QE-0004 — SDE/EBITDA Tab; primary earnings basis for deal-scoped valuations |
| Revenue and adjusted P&L by period | Read | RP-0001 — Profit & Loss, built from DB-0002 — GL Data |
| Customer concentration | Read | DB-0002 — GL Data; used only as a cohort comparison factor, never to name a customer |
| Balance sheet detail for the bridge (funded debt, cash, working capital) | Read | DB-0004 — Trial Balance where the required detail exists; otherwise broker-entered and flagged (same data gap recorded in CM-0001) |
| Broker-entered inputs for standalone valuations | Write | New VL-module table block; flagged as broker-entered wherever displayed or printed |
| Comparable-transaction pool record (de-identified) | Write | New platform-level table block, written at deal close subject to consent; de-identified at write time |
| Seller consent to contribute de-identified transaction data | Read | Engagement or onboarding record — source unconfirmed (see Open Questions) |
| Cohort definitions and size/region/period bands | Read | Platform reference data; fixed definitions only, no free-form filtering |
| Industry taxonomy | Read | Shared platform reference data — must be the same taxonomy used by CM-0005 so cohorts and teaser descriptors align |
| Frozen cohort statistics per finalized valuation (definition, count, aggregates, as-of date) | Write | New VL-module table block; ensures a finalized report remains reproducible |
| Cohort query log (parameters, resulting count, requesting user) | Write | SY-0003 — Activity & Audit Log; supports detection of attempts to isolate an individual transaction |
| Company identity, deal identity, broker and firm identity of contributed transactions | Not stored in pool | Deliberately absent from every pool field used in cohort assembly or display — this is the mechanism preserving isolation |
| Valuation deliverables (PDF report, Excel workbook) | Write | Generated artifacts; published to DR-0001 for deal-scoped valuations by explicit action, private to the firm for standalone valuations |
| Firm theme and report branding | Read | Brokerage/firm settings owned by the admin console (cross-cutting gap) |
| Valuation lifecycle, override, cohort, and export events | Write | SY-0003 — Activity & Audit Log |

# 5. Access & Security
Confirm roles and deal isolation explicitly on every spec — never assume it.
- Roles with access: Broker — create, edit, run, override with rationale, finalize, generate deliverables, and publish deal-scoped deliverables to the data room. Firm administrator — same rights on deals and prospects within their firm. Accountant / QoE preparer — read access to a valuation's inputs, assumptions, and deliverables on deals they have access to, with no finalize or publish rights.
- Company / Seller user — no access to the valuation workspace. A seller sees a finalized valuation only where the broker has explicitly published the deliverables into the data room and the seller holds data room access under DR-0001.
- Roles explicitly excluded: Buyer — no access to any valuation, deliverable, assumption, or cohort statistic, at any status, under any circumstance. A valuation is broker work product and is never buyer-facing. Bank — no access; a valuation is not part of any automatic post-underwriting disclosure under BK-0001.
- No user of any role shall have access to individual comparable-transaction records. The pool is readable only through aggregate cohort statistics produced server-side. There shall be no interface, export, report, or API response that returns a per-transaction row, and this restriction applies equally to Centuriuum internal administrators.
- Cohort assembly shall be constrained to fixed system-defined definitions specifically to prevent a differencing attack, in which a user repeatedly narrows a cohort to isolate a single transaction. The absolute minimum cohort size and the single-transaction concentration rule are non-overridable controls, not configurable conveniences, and every cohort query is logged with its parameters and resulting count.
- Deal isolation confirmed: a valuation is scoped to a single company/deal, or to a single prospect record private to the creating user's firm. Valuation records, assumptions, overrides, broker-entered inputs, frozen cohort snapshots, and deliverables are visible only within that deal or that firm, with no cross-deal or cross-firm visibility.
- The comparable-transaction pool is the single deliberate exception to per-deal isolation in this module, and it is bounded by construction rather than by policy: records are de-identified at write time and carry no company, deal, seller, broker, or firm identity in any field used for assembly or display; contribution requires recorded seller consent and ceases on withdrawal; only aggregates are ever surfaced; an absolute minimum cohort size and a concentration rule suppress any statistic that could expose an individual transaction; cohorts cannot be assembled from arbitrary filters; and the valuing user's own in-progress deals are excluded from every cohort.
- Because the deliverables assert a value for a business, they are treated as controlled documents: Final versions are immutable, every override carries a recorded rationale that prints in the deliverable, and publication into a data room is an explicit act rather than a side effect of finalization.
# 6. UI / UX Notes
Layout, interaction notes, or wireframe reference. State platform scope explicitly per feature.
- Platform: Web only. Valuation creation, assumption entry, finalization, and deliverable generation are web-only. Generated PDF deliverables are viewable on any device through the data room viewer where published; there is no valuation editing on mobile.
- Wireframe reference: N/A
The workspace should present as a stepped model — Basis, Market Approach, Income Approach, Bridge, Conclusion, Deliverables — with a persistent summary strip showing the current indicated range by approach and the concluded range. A CPA reading this expects to see the whole model's shape while working in one part of it, and a broker needs to see immediately what an assumption change did to the answer.
Every assumption cell that differs from the system-suggested value should be visually marked as an override and should not accept the change until a rationale is entered. The rationale is not an optional note — it prints in the deliverable, and the report's defensibility rests on it. The assumptions and overrides schedule should be viewable in the workspace exactly as it will print, so a broker is never surprised by what their reasoning looks like in front of a seller.
The cohort panel should state plainly how the comparable set was defined, how many transactions it contains, how many were excluded for insufficient consideration data, and what period it covers. Where the cohort falls below the credibility threshold, the insufficient-data warning should be unmissable and must carry through to the PDF and the workbook — a warning that exists only on screen will be stripped away the moment the broker sends the file. Where the cohort falls below the absolute minimum, the market approach section should render as unavailable with an explanation rather than showing any number.
The conclusion view should be a football-field chart of indicated ranges by approach with the concluded range overlaid, and the reconciliation text entered directly beneath it. The interface should resist presenting a single headline figure anywhere, including in summary strips and list views, because a point value on a pricing opinion will be quoted back as a promise.
The distinction between platform-verified and broker-entered earnings should be visible continuously, not disclosed only in the report. A standalone prospect valuation and a deal-scoped valuation built on a completed QoE differ enormously in reliability, and the interface should make that obvious to the person relying on it.
# 7. Dependencies
Upstream features that must exist first. This is the single most valuable section for sequencing the build.

| Related Feature | Relationship | Notes |
|---|---|---|
| QE-0004 — SDE/EBITDA Tab | Depends on | Primary source of normalized earnings and the add-back schedule for deal-scoped valuations. A deal-scoped valuation cannot be produced before the QoE basis exists. |
| RP-0001 — Profit & Loss | Depends on | Revenue and adjusted P&L by period, including the periods used in any weighted average. |
| DB-0002 — GL Data | Depends on | Underlying transaction data behind the P&L, and the source of the customer concentration factor used in cohort comparison. |
| DB-0004 — Trial Balance | Depends on | Funded debt, cash, and working capital detail required by the enterprise-to-equity bridge. Where the detail is unavailable, bridge components fall back to broker entry — the same gap recorded in CM-0001 for the Balance Sheet exhibits, and it should be resolved once for both features. |
| Closed-deal transaction record (Feature ID to be confirmed) | Depends on | Hard dependency. Without a feature that captures closing data — consideration, structure, transaction form, real estate and inventory treatment — there is no comps pool and the market approach cannot exist. Confirm which product-list feature owns this. |
| Seller consent capture (cross-cutting: onboarding / legal) | Depends on | Contribution to the pool requires recorded seller consent. Where that consent is captured — engagement letter, onboarding, or platform terms — is unresolved. |
| Industry taxonomy reference data | Depends on | Shared with CM-0005. Must be a single reference so a cohort's industry definition and a teaser's industry descriptor cannot diverge. |
| DR-0001 — Core Data Room | Depends on | Destination for published deal-scoped deliverables, with access control and tracking. Publication is explicit, never automatic. |
| CM-0001 — CIM Helper | Related | Supplies the firm theme applied to the report. Note the explicit boundary: no valuation output flows into the CIM. |
| CM-0005 — Teaser / Blind Profile | Related | The teaser carries no price by decision. No valuation output flows to it, and this spec restates that boundary. |
| Legal / compliance (cross-cutting gap) | Depends on | Owns the non-appraisal disclaimer, the scope and limiting conditions language, the intended-use restriction, and the position on who may sign an opinion of value. |
| Admin console / firm settings (cross-cutting gap) | Depends on | Firm branding on the report, and any firm-level defaults for rate components or cohort preferences. |
| SY-0003 — Activity & Audit Log | Depends on | Valuation lifecycle, overrides with rationale, cohort queries with parameters and counts, exports, and consent events. Platform-wide audit trail is a known cross-cutting gap. |
| Document versioning (cross-cutting gap) | Depends on | Governs how a new finalized valuation supersedes a prior one in the data room while history is retained. |
| Spreadsheet generation infrastructure | Depends on | Server-side generation of a formula-driven, multi-sheet workbook with live sensitivity tables — a different capability from static tabular export. |

# 8. Out of Scope / Deferred
- Discounted cash flow method and any projection-based valuation — deferred, because projections have no platform home; CM-0001 deferred forward-looking exhibits for the same reason.
- Asset approach and adjusted net asset value — deferred; it also depends on balance sheet detail currently unavailable.
- Guideline public company method and public market multiples.
- Discounts and premia for lack of marketability, lack of control, or minority interest, and any partial-interest valuation. V1 values a controlling, whole-company interest.
- Any appraisal-grade or standards-conforming report, including USPAP and SSVS conformity, and any credentialed signer workflow.
- Use of the output for tax, litigation, ESOP, gift or estate, purchase price allocation, or financial reporting purposes — explicitly excluded by the intended-use language.
- Real estate appraisal or valuation of excluded real property, and allocation of personal versus enterprise goodwill.
- Licensed third-party comparable data integration — the pool is internal in v1; licensed data remains available as a future answer to cohort depth.
- Any display of individual comparable transactions, in any surface or export, under any permission level.
- Instant or automated valuation estimates for lead generation, public-facing calculators, or unauthenticated users.
- Buy-side valuation, buyer affordability analysis, and debt service or financing capacity modeling.
- Monte Carlo simulation and probabilistic valuation output.
- Multi-entity consolidated valuation and multi-currency presentation, consistent with the deferral in DB-0002.
- Any automatic flow of a valuation output into the CIM, the Teaser, a listing price, or any buyer-facing document.
- Portfolio or benchmarking dashboards built on the comps pool.
# 9. Open Questions
- Reference file access: the project knowledge files (Centuriuum_Product_List.xlsx, Centuriuum_Spec_Conventions_and_Decisions.docx) could not be read when this spec was drafted. Confirm the VL module label and Feature ID formatting, confirm which product-list feature owns capture of closed-deal transaction data, and confirm nothing here contradicts a locked decision in the conventions doc.
- Two thresholds, two purposes — both numbers need setting. The absolute minimum cohort size exists for confidentiality: below it, an individual transaction could be inferred, so nothing renders and no override is possible. The credibility threshold exists for methodology: between the two, statistics display with a prominent warning, which is the behavior selected. Recommend the confidentiality floor be no lower than five transactions with a single-transaction concentration cap, and that the credibility threshold be materially higher. Confirm both, because a multiple derived from three deals will be quoted to a seller as market evidence.
- Consent mechanics: where is seller consent to contribute de-identified transaction data captured — the engagement letter, platform onboarding, or the terms of service? Is it opt-in or opt-out, is it revocable, and on revocation is the pool record purged or merely excluded from future cohorts? This is a legal question with a data-retention consequence.
- Data ownership and cross-firm benefit: one firm's closed deals will improve the comps available to competing firms on the same platform. Is that acceptable and disclosed, or does a firm need the ability to contribute without its data benefiting competitors — which would collapse the pool's value? This is a commercial decision that should be settled before brokers ask.
- Cold start: the pool will be thin for a considerable period, and the market approach is the feature's main draw. Options are to launch income-approach-only until depth exists, to license third-party comparable data for launch, or to launch with warnings and accept early credibility risk. Recommend deciding this before build rather than discovering it at launch.
- Comparable basis normalization: in lower-market transactions the reported price frequently includes inventory and sometimes real estate, and consideration is often structured with seller notes and earnouts. Confirm the required field set for a usable comp record, and confirm the rule for computing a multiple on a consistent basis — total consideration at face value, or discounted for contingent components?
- Standalone prospect valuations rest on broker-entered earnings with no GL or QoE support. This spec marks provenance throughout and states it in the deliverables. Confirm that is sufficient, or whether standalone valuations should be visually distinct as a document type so a seller cannot mistake one for a QoE-supported valuation.
- The Excel workbook is fully editable, so an exported model is an untracked fork: a multiple can be changed offline and the file circulated. Mitigations specced are a provenance sheet, a version stamp, and the disclaimer. Confirm accepted, or decide whether platform-derived inputs should be locked cells while assumptions stay editable.
- Income approach is capitalization of earnings only in v1, with DCF deferred. Confirm, and confirm that a single-period capitalization is acceptable for high-growth businesses where it will understate value — or whether a growth-adjusted capitalization formula should be included.
- Bridge inputs — funded debt, excess cash, and normal working capital — depend on balance sheet detail that DB-0002 defers and DB-0004 may not fully carry. This is the same unresolved gap as the CM-0001 Balance Sheet exhibits. Recommend resolving it once, for both features, rather than twice.
- Normal working capital determination: is the normal level to be derived by the platform from historical data, entered by the broker, or taken from a QoE working capital analysis if one exists? This materially moves equity value and needs a single defined source.
- Preparer identity and signature: does the report name the individual broker, the firm, or both, and is Centuriuum named as the tool rather than the preparer? Recommend broker and firm as preparer with Centuriuum named only as the platform, so authorship is unambiguous.
- Does a finalized valuation require any seller acknowledgement before the broker relies on it in a listing conversation, and should publication into the data room be defaulted on or off for deal-scoped valuations?
- Reproducibility and retention: this spec freezes cohort statistics at finalization so a report can be reproduced. Confirm, and confirm how long valuations, frozen cohorts, and pool records are retained.
- Access and commercial gating: is the valuation model available to all users, or gated by subscription tier or role? If gated, confirm before build, since it affects where the entry point lives.
# 10. Acceptance Criteria
- A broker can create a standalone prospect valuation with no deal, enter revenue and earnings manually, and produce both deliverables, with broker-entered provenance stated in the interface and printed in both files.
- A broker can create a deal-scoped valuation whose earnings basis reads from QE-0004, and the earnings figures match QE-0004 exactly for the selected basis and period.
- QE-0004-derived earnings cannot be edited within the valuation through any UI path.
- A standalone valuation can be promoted to deal-scoped on engagement, retaining its history.
- Selecting a weighted average of annual periods records the weights, and those weights print in the assumptions schedule of both deliverables.
- A closed deal with recorded seller consent produces a de-identified pool record containing none of: company name, trade name, address, customer names, personnel names, deal identifier, seller identity, broker identity, or firm identity.
- A closed deal without recorded consent produces no pool record, and withdrawing consent removes the record from all subsequent cohort assembly.
- A cohort below the absolute minimum size renders no market-approach statistic of any kind, states that market data is unavailable, and cannot be overridden by any user or role including an internal administrator.
- A cohort meeting the absolute minimum but below the credibility threshold displays statistics together with a prominent insufficient-data warning stating the count, and that warning appears in the PDF and in the workbook, not only on screen.
- A statistic that a single transaction would disproportionately determine is suppressed even where the minimum cohort size is met.
- No per-transaction comparable record appears in the interface, the PDF, the Excel workbook, or any API response, at any permission level.
- Cohorts can only be assembled from fixed system-defined definitions; no free-form filter combination is available through any surface.
- Every cohort query is logged with its defining parameters, resulting count, and requesting user.
- The valuing user's own in-progress deals never appear in any cohort.
- Comp records lacking sufficient consideration-structure data are excluded from multiple computation and the exclusion count is disclosed alongside the cohort.
- The market approach produces an indicated range, and the system's suggested multiple can be overridden only after a rationale is recorded, which then prints in both deliverables.
- The income approach displays each capitalization rate component separately with its source, produces an indicated range, and requires a recorded rationale for any component override.
- The bridge computes indicated equity value from indicated enterprise value using funded debt, excess cash, and the working capital difference, and any broker-entered bridge component is visibly flagged as broker-entered in both deliverables.
- Real estate and inventory treatment are stated on the deliverables, and excluded real estate is not valued.
- The conclusion presents an indicated range per approach applied plus a concluded range, with the broker's written reconciliation printed in the report, and no single point value is presented as a conclusion anywhere.
- Sensitivity tables vary the selected multiple and the capitalization rate against the earnings basis, and are live formulas in the workbook.
- The PDF report contains the non-appraisal disclaimer, purpose and intended use, standard and premise of value, scope and limiting conditions, and the sources schedule with as-of dates.
- The Excel workbook contains live formulas, editable assumption cells, a provenance sheet with version, valuation date, source as-of dates, cohort definition and count, and the same disclaimer, and contains no per-transaction comparable record.
- Deliverables generated from a Draft valuation are watermarked DRAFT on every PDF page and marked draft on the workbook provenance sheet.
- Finalizing a valuation freezes the cohort statistics, definition, count, and as-of date, and regenerating the report after the pool has changed reproduces the same figures.
- A finalized deal-scoped valuation reaches the data room only by an explicit publish action, and a standalone valuation's deliverables are never written to any deal's data room.
- No valuation output, concluded range, or price appears in a CIM, a Teaser, or any buyer-facing document by any automatic route.
- A buyer cannot access any valuation, deliverable, assumption, or cohort statistic at any status, and a company/seller user reaches a valuation only where the broker has published it into the data room.
- Every valuation created, promoted, cohort queried, override recorded, valuation finalized, deliverable generated or published, valuation superseded, and consent recorded or withdrawn appears in the Activity & Audit Log (SY-0003).
- A user without assigned role/deal access cannot view a valuation, its assumptions, its deliverables, or its frozen cohort snapshot for that deal or prospect.

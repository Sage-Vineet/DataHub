CENTURIUUM
Feature Specification

| Feature ID | VL - 0003 |
|---|---|
| Feature Name | Public Company Comparables |
| Module | VL - Valuations |
| Status | Draft |
| Related / Recycled IDs | VL - 0001 (Valuation Model); VL - 0002 (DCF Analysis); QE - 0004 (SDE/EBITDA Tab); BR - 0005 — shares the market data provider decision |
| Author | Valentin Secchi |
| Date | August 17, 2026 |

# 1. Purpose & Business Context
Trading comparables give a broker a second market reference point: what public investors are currently paying for earnings in the client's industry. The feature screens an external market data provider for public companies matching the client's industry and size profile, lets the broker curate the resulting comp set, pulls share price, market capitalization, net debt, enterprise value, revenue, EBITDA and EBIT on an LTM basis, and computes EV/Revenue, EV/EBITDA, EV/EBIT and P/E with mean, median and quartile statistics. A selected EV/EBITDA multiple is then bridged from public-market terms to private-market terms and applied to the client's adjusted EBITDA to produce an indicated enterprise value that flows into VL-0001's bridge.
The bridge is the substance of this feature, not the screen. A public share price buys a minority interest in a large, liquid, publicly reported company. A sale of a sub-$50M private business transfers control of an illiquid, closely held company. Those are different things, and the difference runs in both directions: a size discount and a liquidity discount reduce the multiple, while a control premium increases it. This spec therefore requires three separate, documented adjustment inputs rather than one netted number, each with a recorded rationale that prints in the deliverable, plus a warning where the net adjustment becomes large enough that the indication is driven more by the broker's adjustments than by market evidence.
Two constraints shape the build. First, the provider is not yet chosen and the decision is shared with BR-0005, so this feature is built against a vendor-agnostic internal data contract with a provider adapter behind it — a low-cost API at launch and a move to Capital IQ, PitchBook or FactSet later should be a new adapter, not a rewrite of the analysis. Second, market data licences restrict redistribution and storage. Per-company figures are therefore visible in the application to the entitled user, while the PDF and workbook carry only the comp set names, the derived statistics, the adjustment bridge, and the applied multiple. A per-valuation snapshot is stored so a finalized report remains reproducible, consistent with VL-0001 and VL-0002 — subject to confirmation of storage rights with the chosen provider.
One deliberate departure from the original brief: the applied multiple flows to the client's adjusted EBITDA only, never to SDE. SDE adds back owner compensation, so applying an EV/EBITDA multiple derived from companies that pay professional management to an SDE figure overstates value by the cost of management. Where the deliverable is presented in SDE convention for consistency with QE-0004, this section shows the SDE to EBITDA reconciliation and applies the multiple to the EBITDA basis — the same treatment settled in VL-0002.
# 2. User Stories
One story per user type that touches this feature. Format: "As a [role], I want to [action], so that [benefit]."
- As a broker, I want a suggested set of public comparables based on my client's industry and size, so that I do not have to know which listed companies operate in that space.
- As a broker, I want to add and remove companies from the comp set, so that the final set reflects businesses genuinely comparable to my client.
- As a broker, I want to see mean, median and quartile multiples across the set, so that I can judge where my client should sit rather than anchoring on a single company.
- As a broker, I want the public-to-private adjustment shown as an explicit, documented bridge, so that a seller or a buyer's advisor can see exactly how I got from a public multiple to a private one.
- As a broker, I want to decide whether trading comps inform my conclusion or sit as a cross-check, and record why, so that I am not forced to include an analysis I do not think transfers to this business.
- As a CPA or advisor reviewing the work, I want the comp set, the data as-of date, and the exclusion reasons for screened companies that were removed, so that I can assess whether the set was curated or cherry-picked.
- As a firm owner, I want the deliverable to contain only what our market data licence permits us to redistribute, so that using this feature does not breach our data agreement.
- As a platform administrator, I want provider credentials held securely and every data pull, comp set change and adjustment logged, so that usage is auditable and any published multiple can be reconstructed.
# 3. Functional Requirements
Numbered, testable statements the dev team can build against directly. Avoid prose — each line should be independently verifiable.
- The system shall access market data exclusively through an internal data contract defining the fields this feature requires, with a provider-specific adapter implementing that contract.
- The system shall support replacing or adding a provider adapter without modification to the screening, statistics, adjustment, or deliverable logic.
- The internal data contract shall define, at minimum: company identifier, company name, exchange and ticker, industry classification codes, share price, shares outstanding, market capitalization, total debt, cash and equivalents, preferred equity, minority interest, enterprise value, LTM revenue, LTM EBITDA, LTM EBIT, LTM net income, reporting currency, and the as-of date of each value.
- Provider credentials shall be held as server-side secrets, shall never be transmitted to a client, and shall never appear in any export, log entry, or error message.
- Where no provider is connected or the requesting user's firm is not entitled, the feature shall report itself unavailable with an explanatory message and shall not block the remainder of the valuation.
- The system shall record, for every provider request, the requesting user, the valuation, the parameters sent, and the response timestamp.
- The system shall screen for candidate comparables using the client's platform industry taxonomy node, mapped to the corresponding provider industry classification codes through a maintained mapping table.
- The screen shall additionally accept size parameters, at minimum a revenue range and a market capitalization range, and a geographic scope parameter.
- The screen shall exclude non-operating entities, shell companies, blank-cheque and special purpose acquisition entities, and companies without reported LTM revenue.
- Where the client's industry taxonomy node has no mapped provider classification, or the mapping yields no candidates, the system shall report that no public comparable set is available for this industry and shall not silently widen the screen.
- The system shall present screened candidates as a suggested comp set that the broker may accept, extend, or reduce.
- The broker shall be able to add a company to the comp set by identifier or name search, including a company the screen did not return.
- The broker shall be able to remove a screened candidate from the comp set, and removal shall require a recorded rationale.
- Removal rationales shall be retained with the valuation and shall print in the deliverable, so that curation of the set is visible rather than invisible.
- The system shall enforce a minimum comp set size for the display of statistics, and shall display a prominent insufficient-data warning where the set falls below that minimum.
- The system shall retrieve LTM revenue, EBITDA, EBIT and net income, share price, shares outstanding, market capitalization, and net debt components for every company in the comp set.
- The system shall compute enterprise value for each comparable as market capitalization plus total debt, plus preferred equity, plus minority interest, less cash and equivalents, and shall display the components of that computation.
- The system shall compute, for each comparable, EV/Revenue, EV/EBITDA, EV/EBIT and P/E on an LTM basis.
- Where a required input for a given multiple is unavailable or non-positive, the system shall exclude that company from that multiple only, and shall not exclude it from other multiples.
- The system shall compute mean, median, first quartile and third quartile for each multiple, and shall display the number of companies contributing to each multiple separately, since that count will differ between multiples.
- The system shall apply a defined and documented outlier rule, shall exclude outliers from the computed statistics, and shall disclose the number of companies excluded as outliers.
- Every displayed figure shall carry the as-of date of the underlying data, and the comp set shall display a single prominent data as-of timestamp.
- The system shall indicate where retrieved data is stale beyond a defined threshold and shall offer a refresh.
- Only EV/EBITDA shall be applicable to the subject company. EV/Revenue, EV/EBIT and P/E shall be computed and displayed for reference and shall not be applicable to the subject.
- The system shall state on the deliverable that P/E is a post-tax equity multiple on a minority interest and is presented for reference only.
- The broker shall select a public EV/EBITDA multiple to carry forward, defaulting to the comp set median, and shall be able to select another statistic or enter a value with a recorded rationale.
- The system shall bridge the selected public multiple to a private-market multiple through three separate, independently entered adjustment components: a size discount, a liquidity and marketability discount, and a control premium applied in the opposite direction.
- Each adjustment component shall require an entered value and a recorded rationale, and each shall print separately in the assumptions schedule. The system shall not accept a single netted adjustment in place of the three components.
- The system shall display the bridge as a sequential computation from the selected public multiple through each adjustment to the resulting adjusted multiple.
- The system shall prevent an adjusted multiple of zero or below, and shall display a warning where the net effect of the adjustments exceeds a defined proportion of the selected public multiple, on the basis that the indication is then driven principally by the adjustments rather than by market evidence.
- The adjusted multiple shall be applied to the subject's adjusted EBITDA as sourced from QE-0004 to produce an indicated enterprise value.
- The system shall not apply the adjusted multiple, or any public multiple, to SDE under any setting.
- Where the deliverable is presented in SDE convention, this section shall present the reconciliation from SDE to adjusted EBITDA, including the market-rate owner replacement salary, consistent with VL-0002, and shall apply the multiple to the EBITDA basis.
- The analysis shall produce an enterprise value indication only. It shall not compute equity value independently; conversion occurs solely through the VL-0001 bridge.
- The trading comparables analysis shall default to a cross-check that does not contribute to VL-0001's concluded range.
- The broker shall be able to include the indication in VL-0001's concluded range, and doing so shall require a recorded rationale.
- The deliverable shall state explicitly whether trading comparables were included in the concluded range or presented as a cross-check only.
- The PDF report and Excel workbook shall contain the names of the companies in the comp set, the derived statistics for each multiple with their contributing counts, the removal rationales, the selected public multiple, the three adjustment components with rationales, the adjusted multiple, the indicated enterprise value, and the data as-of date.
- The PDF report and Excel workbook shall not contain per-company share price, market capitalization, net debt, enterprise value, revenue, EBITDA, EBIT, net income, or per-company multiples.
- The restriction on per-company data in deliverables shall be enforced server-side at generation time, not by omission in a template.
- Per-company retrieved figures and per-company multiples shall be viewable within the application to entitled users only, and shall be labelled as licensed data excluded from exports.
- The system shall store a per-valuation snapshot comprising the comp set, the retrieved per-company figures, the computed multiples and statistics, and the data as-of date, so that a finalized valuation reproduces exactly.
- On finalization of the parent VL-0001 valuation, the snapshot, the selected public multiple, the three adjustment components and the adjusted multiple shall be frozen.
- The deliverable shall name the market data provider and shall carry any attribution or disclaimer text required by that provider's terms.
- The system shall log to the Activity & Audit Log (SY-0003): screen executed with parameters, candidate set returned with count, company added to the comp set, company removed with rationale, provider data retrieved with as-of date, outliers excluded with count, public multiple selected or overridden with rationale, each adjustment component entered or changed with rationale, adjustment dominance warning triggered, inclusion in the concluded range elected with rationale, and snapshot frozen on finalization.
# 4. Data Requirements
What tables/fields does this feature read from or write to? Reference the relevant Database module table blocks (DB-0001 through DB-0010) wherever applicable so every feature traces back to the reconciled data structure.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Public company market and financial data (price, shares, market cap, debt, cash, preferred, minority interest, EV, LTM revenue, EBITDA, EBIT, net income, currency, as-of dates) | Read | External market data provider via the internal data contract and provider adapter — provider decision shared with BR-0005 |
| Provider credentials and entitlement configuration | Read | Server-side secret store and firm entitlement settings owned by the admin console (cross-cutting gap) |
| Industry taxonomy to provider classification mapping | Read | Platform reference data; maintenance owner to be confirmed (see Open Questions) |
| Client industry taxonomy node and size profile | Read | Deal/company record and RP-0001 revenue; drives the screen |
| Screen parameters and candidate results | Write | New VL-module table block, scoped to the valuation |
| Comp set membership, additions, and removals with rationales | Write | New VL-module table block; removal rationales print in the deliverable |
| Computed per-company multiples and per-multiple statistics with contributing counts and outlier exclusions | Write | New VL-module table block; per-company values are in-app only and excluded from exports |
| Selected public multiple and the three adjustment components (size discount, liquidity discount, control premium) with rationales | Write | New VL-module table block; printed in the assumptions schedule |
| Subject adjusted EBITDA, and adjusted EBIT for reference | Read | QE-0004 — SDE/EBITDA Tab |
| Owner replacement salary for the SDE reconciliation | Read | VL-0002 input, reused rather than duplicated |
| Indicated enterprise value | Write | Passed to VL-0001 for the enterprise-to-equity bridge; included in the concluded range only where the broker so elects |
| Per-valuation market data snapshot with as-of date | Write | New VL-module table block; frozen on parent valuation finalization, subject to provider storage rights (see Open Questions) |
| Provider attribution and disclaimer text | Read | Provider terms; rendered on deliverables |
| Screen, retrieval, curation, adjustment, and freeze events | Write | SY-0003 — Activity & Audit Log |
| Client identity and deal data sent to the provider | Not transmitted | Deliberately absent — screens are executed on industry and size parameters only; no company name, deal identifier, or client-identifying value is sent to any external provider |

# 5. Access & Security
Confirm roles and deal isolation explicitly on every spec — never assume it.
- Roles with access: Broker — run the screen, curate the comp set with rationales, select the public multiple, enter the adjustment components, and elect inclusion in the concluded range. Firm administrator — same rights within their firm, plus management of firm provider entitlement where the provider relationship is held at firm level. Accountant / QoE preparer — read access to the comp set, statistics, adjustments, and deliverable sections on deals they have access to, with no finalize or publish rights.
- Roles explicitly excluded: Company / Seller user — no access to the analysis workspace; a seller sees output only through published VL-0001 deliverables under DR-0001. Buyer — no access to the comp set, statistics, adjustments, or indication, at any status, under any circumstance. Bank — no access.
- Provider credentials shall be held as server-side secrets, never exposed to a client, never written to logs or error output, and never included in any export.
- No client-identifying information shall be transmitted to the external provider. Screens shall be executed using industry classification and size parameters only, so that a provider request cannot disclose that a particular company is for sale.
- Licence enforcement is treated as a security control: the exclusion of per-company figures from deliverables shall be enforced server-side at generation time. A deliverable shall not be capable of containing per-company licensed values through any template, configuration, or user action.
- Per-company licensed data shall be visible only to entitled users within the application, shall be labelled as excluded from exports, and shall not be retrievable through any API response that serves deliverable generation.
- Deal isolation confirmed: the analysis is scoped to a single valuation within a single company/deal, or to a single prospect record private to the creating user's firm. The screen parameters, comp set, curation rationales, computed statistics, adjustment components, snapshot, and indicated value are visible only within that deal or that firm, with no cross-deal or cross-firm visibility. Public market data is not deal data and carries no confidentiality constraint of its own, but the client's adjusted EBITDA, the applied multiple, and the resulting indication are deal data and are scoped accordingly.
- A firm's comp set selections and adjustment assumptions shall not be visible to any other firm, since they represent that firm's analytical judgment.
# 6. UI / UX Notes
Layout, interaction notes, or wireframe reference. State platform scope explicitly per feature.
- Platform: Web only. Screening, comp set curation, adjustment entry, and inclusion election are web-only, consistent with VL-0001 and VL-0002. Generated PDF deliverables are viewable on any device through the data room viewer where published.
- Wireframe reference: N/A
The workflow should read as screen, curate, compute, bridge. The screen panel states the mapped industry classification and the size and geography parameters in plain language, so a broker can see what was searched rather than trusting a black box. Candidates arrive as a checkable list with enough context — name, exchange, revenue, market capitalization — to judge comparability at a glance.
Per-company data should be clearly marked as licensed and excluded from exports, in the interface itself rather than only in documentation. A broker who sees a comp table on screen will expect it in the PDF, and discovering the difference after sending the report to a client is the kind of surprise that erodes trust in the whole deliverable.
Removing a screened candidate should prompt for a reason in the moment, not in a separate step. The prompt is the control against a comp set quietly curated toward a desired answer, and it only works if it is unavoidable and lightweight. The statistics panel should show the contributing count per multiple beside each statistic, because a median EV/EBITDA drawn from four companies and a median EV/Revenue drawn from eleven should not look equally solid.
The adjustment bridge is the part a reviewer will scrutinise, so it should render as a visible sequential computation — selected public multiple, less size discount, less liquidity discount, plus control premium, equals adjusted multiple — with each rationale visible inline. Where the net adjustment exceeds the warning threshold, the interface should say plainly that the indication is now driven mainly by the adjustments, and that warning must carry through to the deliverable rather than living only on screen.
Because this analysis defaults to a cross-check, the interface should make its role unambiguous at all times, and electing to include it in the concluded range should be a deliberate act with its rationale captured, not a toggle a broker flips without thinking about it.
# 7. Dependencies
Upstream features that must exist first. This is the single most valuable section for sequencing the build.

| Related Feature | Relationship | Notes |
|---|---|---|
| BR - 0005 — shares the market data provider decision | Depends on | The provider selection, licence tier, and commercial terms are common to both features and must be decided together. Both should consume the same internal data contract and adapter rather than integrating separately. |
| Market data provider adapter and internal data contract | Depends on | Hard dependency. No screening, retrieval, or statistics are possible without it. Built to be provider-agnostic so a launch on a low-cost API can move to Capital IQ, PitchBook or FactSet without reworking the analysis. |
| VL-0001 — Valuation Model | Depends on | Parent feature. Supplies the enterprise-to-equity bridge, the concluded range, both deliverables, and the finalization freeze. VL-0001 requires amendment: its blanket exclusion of marketability and control adjustments must be carved out for this public-to-private bridge, the concluded range must accommodate an optional fourth approach, and the finalization freeze must extend to the market data snapshot. |
| VL-0002 — DCF Analysis | Related | Supplies the market-rate owner replacement salary used in the SDE to EBITDA reconciliation, so the same figure is not defined twice. Both features apply the same EBITDA-basis rule. |
| QE-0004 — SDE/EBITDA Tab | Depends on | Source of the subject's adjusted EBITDA, to which the adjusted multiple is applied, and of adjusted EBIT for reference. |
| Industry taxonomy and classification mapping | Depends on | The platform taxonomy shared with CM-0005, VL-0001 and VL-0002, plus a maintained mapping to provider industry classification codes. Without the mapping the screen cannot be driven by the same industry definition used elsewhere in the product. |
| Admin console / firm settings (cross-cutting gap) | Depends on | Holds provider credentials and firm-level entitlement, determining which firms have access to the feature at all. |
| Legal / compliance (cross-cutting gap) | Depends on | Owns review of the chosen provider's redistribution and storage terms against the deliverable content and snapshot decisions in this spec, and the required attribution and disclaimer text. |
| DR-0001 — Core Data Room | Related | Destination of the parent valuation's published deliverables. This analysis has no independent publication path. |
| SY-0003 — Activity & Audit Log | Depends on | Screens, retrievals, curation with rationales, adjustments, warnings, and freezes. Platform-wide audit trail is a known cross-cutting gap. |
| Spreadsheet generation infrastructure | Depends on | Statistics and the adjustment bridge rendered into the VL-0001 workbook, with per-company licensed values excluded. |

# 8. Out of Scope / Deferred
- Forward-period data and consensus estimates, and any forward multiple. V1 is LTM only; consensus data is frequently a separate licence tier and a forward multiple applied to trailing adjusted earnings is a basis mismatch.
- Per-company licensed data in any exported deliverable.
- Application of EV/Revenue, EV/EBIT or P/E to the subject company. These are computed for reference only.
- Independent computation of equity value. All conversion occurs through the VL-0001 bridge.
- Derivation of beta or a CAPM-based cost of equity from the comp set. The discount rate remains build-up based per VL-0001 and VL-0002.
- Guideline public-company M&A transaction data (announced deal multiples) — distinct from both this feature and VL-0001's internal closed-deal pool.
- Manual entry of comparable company financial data where no provider is connected.
- Regression or size-adjusted multiple modelling, and statistical derivation of the size discount from the comp set itself.
- Sum-of-the-parts and segment-level comparable analysis.
- Non-North-American exchanges and multi-currency comp sets, consistent with the multi-currency deferral in DB-0002.
- Real-time or intraday pricing. Retrieval is on a daily close basis.
- Historical time-series analysis of multiples, multiple trend charts, and index construction.
- Any flow of this analysis into the CIM, the Teaser, a listing price, or any buyer-facing document, consistent with VL-0001.
# 9. Open Questions
- Reference file access: the project knowledge files (Centuriuum_Product_List.xlsx, Centuriuum_Spec_Conventions_and_Decisions.docx) could not be read when this spec was drafted. Confirm the VL module label, confirm BR-0005's identity and scope, and confirm nothing here contradicts a locked decision in the conventions doc.
- Provider decision and licence tier: both of this spec's central data decisions — derived statistics only in deliverables, and a stored per-valuation snapshot — are contingent on the chosen provider's actual redistribution and storage terms. Counsel must review those terms against this spec before build. If the chosen provider prohibits storage of retrieved values, the reproducibility guarantee that VL-0001 and VL-0002 make cannot be met here, and the snapshot would have to fall back to derived statistics only.
- Provider commercial model: is the market data relationship held by Centuriuum platform-wide, or does each firm supply its own credentials? Platform-wide is a significant recurring cost across all users; firm-supplied means the feature simply does not exist for firms without a subscription, which affects whether it can appear in the standard valuation workflow at all.
- Change from the original brief: the applied multiple flows to adjusted EBITDA only, not to SDE, because applying a multiple derived from companies that pay professional management to an SDE figure that adds back owner compensation overstates value. This mirrors the treatment settled in VL-0002. Confirm.
- VL-0001 amendments required: (a) VL-0001 Section 8 excludes discounts and premia for marketability and control outright, which contradicts the three-component bridge this feature requires — that exclusion needs a carve-out distinguishing a public-to-private bridge from a minority-interest discount; (b) the concluded range must accommodate an optional fourth approach; (c) the finalization freeze must extend to the market data snapshot and the adjustment components; (d) Related IDs should name VL-0003. Confirm and assign ownership of the edit.
- Inclusion in the concluded range is a per-valuation broker election in this spec. The consequence is that two brokers valuing similar businesses may produce differently constituted conclusions, and the choice is not externally reviewable. Recommend a firm-level or platform-level default rather than a per-deal decision, with the per-valuation election retained only as an override.
- Adjustment defaults: should the size discount, liquidity discount and control premium carry system defaults drawn from a citable empirical source, or must the broker enter all three with no default? Defaults will become the de facto standard across every valuation on the platform, so their source needs to be defensible and stated. If there are no defaults, brokers will invent their own and consistency is lost.
- Adjustment dominance threshold: at what net adjustment, as a proportion of the selected public multiple, should the warning fire? Beyond some level the indication is an opinion wearing market-data clothing.
- Minimum comp set size for displaying statistics, and whether that minimum differs by multiple given that contributing counts differ.
- Outlier rule: needs a concrete definition to be testable — for example exclusion of non-positive EBITDA companies plus multiples beyond a defined interquartile range factor. Confirm the rule and whether excluded companies are named in the deliverable or only counted.
- Enterprise value build: confirm the components, and specifically the treatment of operating lease liabilities under current accounting standards. Lease capitalisation affects both EV and EBITDA comparability between the comp set and a private target whose statements may be prepared differently — a real comparability issue rather than a technicality.
- Taxonomy mapping ownership and upkeep, and the behaviour where a platform industry node has no credible public analogue. Many sub-$50M targets — trades, local services, small distribution — have no meaningful listed comparable at any size. This spec reports the analysis unavailable in that case rather than widening the screen; confirm that is preferred to returning a loosely related set.
- Data as-of policy: should retrieval default to the latest available close, or to the close nearest the valuation date? A valuation dated three months ago supported by today's market data is internally inconsistent, and the answer affects the staleness rule.
- Removal rationales are required and printed, as an anti-cherry-picking control. Confirm, since brokers may object to justifying every exclusion in a client-facing document.
- Shared caching with BR-0005: if both features query the same provider, may a single retrieval serve both, and does the provider's licence permit caching a response for reuse across features or users? This affects cost materially.
# 10. Acceptance Criteria
- All market data access occurs through the internal data contract, and replacing the provider adapter changes no screening, statistics, adjustment, or deliverable logic.
- Provider credentials are never present in any client payload, export, log entry, or error message.
- No company name, deal identifier, or other client-identifying value is transmitted to the external provider in any request.
- With no provider connected or no firm entitlement, the feature reports itself unavailable and the remainder of the valuation completes normally.
- A screen driven by the client's platform industry node returns candidates via the mapped provider classification, and the interface states the mapped classification and the size and geography parameters used.
- Where the client's industry node has no mapped classification or the mapping returns no candidates, the system reports no public comparable set available and does not widen the screen automatically.
- Non-operating entities, shells, blank-cheque vehicles, and companies without reported LTM revenue do not appear in candidate results.
- A broker can add a company not returned by the screen, and can remove a screened candidate only after recording a rationale.
- Removal rationales appear in the PDF report and the Excel workbook.
- A comp set below the minimum size displays a prominent insufficient-data warning, and that warning appears in the deliverable.
- Enterprise value per comparable equals market capitalization plus total debt plus preferred equity plus minority interest less cash, with components displayed.
- EV/Revenue, EV/EBITDA, EV/EBIT and P/E are computed per comparable on an LTM basis, and a company missing an input for one multiple is excluded from that multiple only while remaining in the others.
- Mean, median, first and third quartile are computed per multiple, and the contributing company count is displayed separately for each multiple.
- The outlier rule excludes qualifying companies from the statistics and the number excluded is disclosed.
- Every figure carries an as-of date, the comp set shows a single prominent data as-of timestamp, and data stale beyond the threshold is flagged with a refresh offered.
- Only EV/EBITDA can be carried forward to the subject; there is no path by which EV/Revenue, EV/EBIT or P/E is applied to the subject's earnings.
- The deliverable states that P/E is presented for reference only and why.
- The selected public multiple defaults to the comp set median, and selecting another statistic or entering a value requires a rationale that prints.
- The bridge requires three separately entered components — size discount, liquidity and marketability discount, and control premium — each with its own rationale, and there is no input accepting a single netted adjustment.
- The bridge renders as a sequential computation from selected public multiple to adjusted multiple, and each component and rationale prints in the assumptions schedule.
- An adjusted multiple of zero or below cannot be produced, and a net adjustment exceeding the defined threshold triggers a warning that appears in the deliverable as well as on screen.
- The adjusted multiple applied to the subject's QE-0004 adjusted EBITDA produces the indicated enterprise value, and no equity value is computed within this analysis.
- There is no setting or path under which a public multiple is applied to SDE, and with the deliverable in SDE convention the section shows the SDE to adjusted EBITDA reconciliation including the owner replacement salary.
- The analysis defaults to a cross-check; including it in the concluded range requires a recorded rationale, and the deliverable states which role it played.
- The PDF and workbook contain comp set names, per-multiple statistics with counts, removal rationales, the selected multiple, the three adjustments with rationales, the adjusted multiple, the indication, and the data as-of date.
- The PDF and workbook contain no per-company share price, market capitalization, net debt, enterprise value, revenue, EBITDA, EBIT, net income, or per-company multiple, and this exclusion holds even when a deliverable is generated through a modified template or a direct API call.
- Per-company figures are visible in the application to entitled users and are labelled as excluded from exports.
- Finalizing the parent valuation freezes the snapshot, selected multiple, adjustment components, and adjusted multiple, and regenerating the deliverable reproduces the same figures and the same as-of date.
- The deliverable names the market data provider and carries the provider's required attribution text.
- Every screen, retrieval, addition, removal with rationale, outlier exclusion, multiple selection, adjustment entry, dominance warning, inclusion election, and freeze appears in the Activity & Audit Log (SY-0003).
- A buyer cannot access the comp set, statistics, adjustments, or indication at any status, and a user without assigned role/deal access cannot view any part of this analysis for that deal or prospect.

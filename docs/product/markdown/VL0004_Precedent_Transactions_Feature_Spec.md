CENTURIUUM
Feature Specification

| Feature ID | VL - 0004 |
|---|---|
| Feature Name | Precedent Transactions |
| Module | VL - Valuations |
| Status | Draft |
| Related / Recycled IDs | VL - 0001 (Valuation Model) — this feature assumes ownership of the market approach specified there; VL - 0003 (Public Company Comparables); BY - 0006 (closed-deal capture); BR - 0005 (shared provider decision) |
| Author | Valentin Secchi |
| Date | August 17, 2026 |

# 1. Purpose & Business Context
Precedent transactions are how private businesses are actually priced, and this feature is where Centuriuum's long-term data advantage lives. It draws on two sources. The first is the platform's own proprietary multiples database, built from every deal closed on the platform and captured at close through BY-0006 — the differentiator, because no licensed database has good coverage of sub-$50M North American transactions. The second is licensed third-party transaction data, which provides coverage while the internal database is thin and remains useful afterwards for industries the platform has not yet transacted in.
This feature assumes ownership of the market approach originally specified inside VL-0001. Cohort assembly, statistics, and the applied multiple now live here, and VL-0001 consumes an indicated value range in exactly the way it consumes the DCF indication from VL-0002 and the trading comparables indication from VL-0003. One pattern across all three analytical features, and the transaction-comparable logic is specified once rather than in two places.
The two sources are treated differently by design, because their confidentiality positions are opposite. Third-party records are published under licence, so they display as full rows — target, buyer, date, deal size, revenue, earnings and implied multiples — and are searchable across every dimension. Internal records describe live clients of brokers on this platform who consented to contribute de-identified data, so they surface only as aggregate statistics assembled through fixed cohort definitions, with a minimum cohort floor and single-transaction concentration suppression. Your brief asks for a per-transaction display and free-form search; both are delivered, but on the third-party set, because a de-identified internal row reading “HVAC contractor, Dallas metro, $4.1M revenue, closed March 2026” is identifiable to any broker working that market. The confidentiality rule established in VL-0001 is preserved intact, not relaxed.
The two sources are never merged into a single statistic. They are presented side by side with their own counts, medians and quartiles, and the broker selects which set drives the applied multiple range or reconciles between them with the choice documented. Deal size and earnings are defined differently enough between a platform-captured record and a licensed database record that a blended median would be arithmetic without meaning.
# 2. User Stories
One story per user type that touches this feature. Format: "As a [role], I want to [action], so that [benefit]."
- As a broker, I want to filter to a set of comparable transactions by industry, size, geography and date, so that I can price a business against deals that actually resemble it.
- As a broker, I want to see how the platform's own closed deals price against the licensed database, so that I can tell a seller what businesses like theirs are really trading for rather than what a national database averages.
- As a broker, I want the applied multiple range to default to the interquartile range of the set I selected, so that my indicated value range is anchored in the data rather than in my own guess.
- As a broker, I want to move the low or high end of that range and record why, so that a business with better or worse characteristics than the set is priced accordingly and defensibly.
- As a broker in an industry the platform has not transacted in yet, I want third-party coverage to fill the gap, so that the feature is useful before the internal database matures.
- As a CPA or advisor reviewing the work, I want the source, count, basis and date range of every statistic disclosed, so that I can judge whether the comparable set supports the conclusion.
- As a seller who closed on this platform, I want my transaction to contribute only as an aggregate statistic that cannot be traced back to me, so that participating never reveals what I sold or for how much.
- As a broker, I want to know when a third-party record is probably the same deal as one already in the internal set, so that I am not unknowingly weighing one transaction twice.
- As a platform administrator, I want every cohort query, search, selection and applied multiple logged, so that any published indication can be reconstructed and any attempt to isolate a single transaction is detectable.
# 3. Functional Requirements
Numbered, testable statements the dev team can build against directly. Avoid prose — each line should be independently verifiable.
- This feature shall own the market approach for the VL module, producing an indicated enterprise value range that is passed to VL-0001 for the enterprise-to-equity bridge and the concluded range.
- The analysis shall produce an enterprise value indication only. It shall not compute equity value independently; conversion occurs solely through the VL-0001 bridge.
- The feature shall produce no separate deliverable. Its output shall contribute a section to the VL-0001 PDF report and dedicated sheets to the VL-0001 Excel workbook.
- The system shall maintain two distinct transaction sources — the internal proprietary database and licensed third-party data — and shall present them as separate sets throughout.
- The system shall not merge internal and third-party records into any combined count, median, quartile, or other statistic.
- Internal transaction records shall surface only as aggregate statistics. No internal transaction shall be displayed as a row, and no internal per-transaction value shall appear in any interface, report, workbook, export, or API response, at any permission level, including for Centuriuum internal administrators.
- Internal cohorts shall be assembled exclusively from fixed, system-defined combinations of industry taxonomy node, size band, region grouping, and closing period window. Free-form or arbitrary filter combinations shall not be available against the internal source.
- The system shall enforce an absolute minimum internal cohort size, below which no internal statistic of any kind renders and the interface reports that internal data is unavailable for that cohort. This floor shall not be overridable by any user or role.
- The system shall suppress any internal statistic that a single transaction would disproportionately determine beyond a defined concentration threshold, even where the minimum cohort size is met.
- Internal cohorts shall exclude the valuing user's own in-progress deals.
- The system shall log every internal cohort query with its defining parameters, resulting count, and requesting user, so that attempts to narrow toward an individual transaction are detectable.
- Internal statistics shall be computed separately for SDE-basis transactions and EBITDA-basis transactions, and the two shall never be combined into a single statistic.
- Each internal statistic set shall display its own contributing transaction count and its earnings basis.
- The broker shall select the basis set matching the subject company's convention, and the system shall indicate where the subject's convention has no corresponding internal set.
- Internal records shall be excluded from multiple computation where they lack sufficient consideration-structure data to normalize the basis, and the count excluded shall be disclosed with the cohort.
- Third-party transaction data shall be accessed through the same internal data contract and provider adapter pattern established in VL-0003, so that a single provider decision and integration serves both features.
- The system shall allow free-form search of third-party transaction data by industry classification, revenue size band, earnings size band, geography, and transaction date range.
- Third-party transactions shall display as rows showing, where the provider supplies them: target descriptor, buyer, transaction date, deal size, revenue, EBITDA or SDE, and the implied EV/Revenue and EV/EBITDA or EV/SDE multiples.
- Third-party search shall be driven by the client's platform industry taxonomy node mapped to the provider's classification scheme through the maintained mapping established in VL-0003, with the mapped classification displayed to the user.
- The broker shall be able to include or exclude individual third-party transactions from the working set, and exclusion shall require a recorded rationale that prints in the deliverable.
- Third-party statistics shall be computed separately by earnings basis where the provider distinguishes SDE from EBITDA.
- The system shall detect suspected duplicates between the internal and third-party sets by proximity of industry, size, transaction date, and geography.
- Where a suspected duplicate is detected, the system shall retain the internal record and exclude the third-party record from the third-party set, and shall disclose the number of records removed as suspected duplicates.
- The system shall not identify to any user which specific third-party record was removed as a suspected duplicate, since doing so would disclose that a named third-party transaction is a platform deal.
- For each set and each basis, the system shall compute mean, median, first quartile and third quartile for EV/Revenue and for the applicable earnings multiple, and shall display the contributing count for each statistic separately.
- The system shall apply a defined and documented outlier rule, shall flag outliers, shall exclude them from computed statistics, and shall disclose the number excluded.
- The system shall display, for each set, the date range of the transactions contributing to it, so the recency of the evidence is visible.
- Every statistic shall carry its source, basis, count, and date range wherever it is displayed or printed.
- The broker shall select which set — internal or third-party — drives the applied multiple range, and where both are available the selection shall require a recorded rationale.
- The applied multiple range shall default to the first and third quartile of the selected set's earnings multiple.
- The broker shall be able to adjust either endpoint of the applied multiple range, and any adjustment shall require a recorded rationale that prints in the assumptions schedule.
- The system shall display the subject company's position relative to the selected set on defined comparison factors, including size, revenue growth, margin, and customer concentration derived from DB-0002, to support the broker's positioning of the range.
- The applied multiple range shall be applied to the subject's adjusted earnings on the matching basis, as sourced from QE-0004, to produce an indicated enterprise value range.
- The system shall not apply an EBITDA-basis multiple to SDE, or an SDE-basis multiple to EBITDA, under any setting.
- Where the selected set's basis differs from the deliverable's presentation convention, the system shall present the reconciliation between SDE and adjusted EBITDA, including the market-rate owner replacement salary, consistent with VL-0002 and VL-0003.
- The PDF report and Excel workbook shall include, for each set used: the source, the earnings basis, the contributing count, the date range, the computed statistics, the outlier and duplicate exclusion counts, and the cohort definition or search parameters.
- The PDF report and Excel workbook shall include the selected set with rationale, the applied multiple range with any endpoint rationales, the subject's adjusted earnings, and the resulting indicated enterprise value range.
- The deliverables shall include third-party transaction rows only to the extent permitted by the provider's licence terms, applying the same redistribution constraints established in VL-0003.
- The deliverables shall contain no internal per-transaction record, and this exclusion shall be enforced server-side at generation time rather than by template omission.
- On finalization of the parent VL-0001 valuation, the system shall freeze the internal cohort definition and statistics, the third-party working set and statistics, the selected set, the applied multiple range, and all as-of dates, so the report remains reproducible.
- The system shall log to the Activity & Audit Log (SY-0003): internal cohort queried with parameters and count, third-party search executed with parameters and result count, transaction included or excluded with rationale, suspected duplicates removed with count, outliers excluded with count, set selected with rationale, applied multiple range set or adjusted with rationale, and the freeze on finalization.
# 4. Data Requirements
What tables/fields does this feature read from or write to? Reference the relevant Database module table blocks (DB-0001 through DB-0010) wherever applicable so every feature traces back to the reconciled data structure.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| De-identified internal transaction records (closing period, industry node, region, revenue, earnings measure and basis, consideration and structure, transaction form, real estate and inventory treatment, buyer type, size bands) | Read | Proprietary multiples database populated at close by BY-0006, which owns the field set, de-identification at write, and consent capture |
| Seller consent to contribute de-identified transaction data | Read | BY-0006 — enforcement occurs at capture; this feature consumes only records already cleared for contribution |
| Internal cohort definitions, size bands, region groupings, period windows | Read | Platform reference data; fixed definitions only, no free-form filtering against the internal source |
| Third-party transaction records (target descriptor, buyer, date, deal size, revenue, earnings, implied multiples, classification codes) | Read | Licensed third-party provider via the VL-0003 internal data contract and adapter — provider decision shared with BR-0005 |
| Industry taxonomy and provider classification mapping | Read | Shared platform reference data used by CM-0005, VL-0001, VL-0002 and VL-0003; single source |
| Working set membership, inclusions and exclusions with rationales | Write | New VL-module table block, scoped to the valuation |
| Computed statistics by source and basis, with counts, date ranges, outlier and duplicate exclusion counts | Write | New VL-module table block; internal per-transaction values never persisted to any deliverable-serving structure |
| Suspected duplicate detection results | Write | New VL-module table block; internal only, never surfaced at record level to any user |
| Selected set, applied multiple range, endpoint rationales | Write | New VL-module table block; printed in the assumptions schedule |
| Subject adjusted EBITDA and SDE | Read | QE-0004 — SDE/EBITDA Tab |
| Owner replacement salary for basis reconciliation | Read | VL-0002 input, reused rather than redefined |
| Subject comparison factors (size, growth, margin, customer concentration) | Read | RP-0001 and DB-0002 — GL Data |
| Indicated enterprise value range | Write | Passed to VL-0001 for the enterprise-to-equity bridge and the concluded range |
| Frozen snapshot on finalization (cohort definition, statistics, working set, selected set, applied range, as-of dates) | Write | New VL-module table block |
| Internal transaction identity (company, deal, seller, broker, firm) | Not stored or readable | Deliberately absent — de-identification occurs at write in BY-0006, and no surface in this feature can resolve a statistic back to a transaction |
| Cohort, search, curation, selection and freeze events | Write | SY-0003 — Activity & Audit Log |

# 5. Access & Security
Confirm roles and deal isolation explicitly on every spec — never assume it.
- Roles with access: Broker — query internal cohorts, search third-party data, curate the working set with rationales, select the driving set, set the applied multiple range. Firm administrator — same rights within their firm. Accountant / QoE preparer — read access to the sets, statistics, and deliverable sections on deals they have access to, with no finalize or publish rights.
- Roles explicitly excluded: Company / Seller user — no access to the analysis workspace; a seller sees output only through published VL-0001 deliverables under DR-0001. Buyer — no access to any set, statistic, applied multiple, or indication, at any status, under any circumstance. Bank — no access.
- No user of any role shall be able to read an individual internal transaction record. The proprietary database is accessible only through aggregate statistics produced server-side, and this restriction applies equally to Centuriuum internal administrators.
- The confidentiality controls established in VL-0001 apply to the internal source unchanged and are not relaxed by this feature: de-identification at write in BY-0006, aggregate-only display, fixed cohort definitions, an absolute non-overridable minimum cohort size, single-transaction concentration suppression, exclusion of the valuing user's own in-progress deals, and logging of every cohort query with its parameters and result count.
- Free-form search is available against third-party data only. It shall not be possible to query the internal source on arbitrary parameter combinations, because repeated narrowing of a cohort is how an individual transaction is isolated.
- Duplicate detection results shall not be exposed at record level. A user shall never be shown which third-party transaction was removed as a suspected internal duplicate, since that would identify a named transaction as a platform deal and defeat de-identification from the other direction.
- Deal isolation confirmed: the analysis is scoped to a single valuation within a single company/deal, or to a single prospect record private to the creating user's firm. Working sets, curation rationales, selected sets, applied multiple ranges, indications and frozen snapshots are visible only within that deal or that firm, with no cross-deal or cross-firm visibility. The proprietary multiples database is the single deliberate exception to per-deal isolation, bounded by construction as described above and governed at capture by BY-0006.
- No client-identifying information shall be transmitted to the third-party provider. Searches shall be executed on industry classification, size, geography and date parameters only, so that a provider request cannot disclose that a particular company is for sale.
# 6. UI / UX Notes
Layout, interaction notes, or wireframe reference. State platform scope explicitly per feature.
- Platform: Web only. Cohort selection, third-party search, working set curation, and applied range setting are web-only, consistent with VL-0001 through VL-0003. Generated PDF deliverables are viewable on any device through the data room viewer where published.
- Wireframe reference: N/A
The workspace should present the two sources as parallel panels rather than one blended list, because that is what they are. Each panel carries its own header stating source, earnings basis, contributing count, and date range, so a broker comparing a platform median against a licensed-database median can see at a glance which rests on more evidence and which is more recent.
The internal panel shows statistics and the cohort definition in plain language — the industry node, size band, region grouping and period window that produced it — and nothing else. Where the cohort falls below the floor it should say that internal data is unavailable for this cohort and why a minimum exists, rather than showing an empty table. Brokers will ask why they cannot see the underlying deals; the interface should answer that once, clearly, as a feature of the product rather than a limitation of it — the same protection applies to their own clients.
The third-party panel is the searchable, row-level surface: filters across industry, size, geography and date, with rows showing target, buyer, date, deal size, revenue, earnings and implied multiples. Excluding a row should prompt for a reason in the moment, as in VL-0003, since curation of a comparable set toward a desired answer is the main integrity risk in a market approach.
The applied range control should show the selected set's quartiles as the anchor, with the chosen low and high visibly positioned against the distribution, so a broker moving an endpoint sees how far from the data they have travelled. The subject's comparison factors — size, growth, margin, concentration relative to the set — belong beside that control, since they are the justification for where in the range the business sits.
Outlier and duplicate exclusions should be visible as counts with an explanation available, never silent. A statistic that quietly dropped four transactions is a different statistic, and a reviewer who discovers that later will distrust everything else in the report.
# 7. Dependencies
Upstream features that must exist first. This is the single most valuable section for sequencing the build.

| Related Feature | Relationship | Notes |
|---|---|---|
| BY - 0006 — closed-deal data capture | Depends on | Hard dependency and the owner of the comp record field set, de-identification at write, and seller consent capture. Those requirements move out of VL-0001 and into BY-0006; this feature consumes only records already cleared and de-identified. Without BY-0006 there is no proprietary database and this feature runs on third-party data alone. |
| VL-0001 — Valuation Model | Depends on | Parent feature. Supplies the enterprise-to-equity bridge, the concluded range, both deliverables, and the finalization freeze. VL-0001 requires amendment: the market approach requirements move here, the closed-deal capture requirements move to BY-0006, the finalization freeze must extend to this feature's snapshot, and Related IDs should name VL-0004. |
| VL-0003 — Public Company Comparables | Depends on | Supplies the provider adapter pattern, the internal data contract, the taxonomy-to-classification mapping, and the licence-driven constraints on what provider data may appear in deliverables. Both features must consume one integration, not two. |
| BR - 0005 — shared market data provider decision | Depends on | The third-party transaction data provider (DealStats/BVR, Pratt's Stats, PitchBook) is part of the same provider and licence decision as VL-0003 and BR-0005, and should be negotiated as one commercial arrangement. |
| QE-0004 — SDE/EBITDA Tab | Depends on | Source of the subject's adjusted EBITDA and SDE, to which the applied multiple range is applied on the matching basis. |
| VL-0002 — DCF Analysis | Related | Supplies the market-rate owner replacement salary used in the SDE to EBITDA reconciliation, so the figure is defined once across the module. |
| DB-0002 — GL Data and RP-0001 — Profit & Loss | Depends on | Source of the subject comparison factors — size, revenue growth, margin, and customer concentration — used to position the applied range within the set. |
| Industry taxonomy and classification mapping | Depends on | Single shared reference across CM-0005 and the VL module. Internal cohort definitions and third-party searches must describe the same industry. |
| Admin console / firm settings (cross-cutting gap) | Depends on | Provider credentials and firm entitlement for third-party data, and administration of internal cohort definitions and thresholds. |
| Legal / compliance (cross-cutting gap) | Depends on | Third-party licence review for row-level display and redistribution, and the consent language underpinning contribution to the proprietary database. |
| SY-0003 — Activity & Audit Log | Depends on | Cohort queries with parameters and counts, searches, curation with rationales, selections, and freezes. Platform-wide audit trail is a known cross-cutting gap. |
| DR-0001 — Core Data Room | Related | Destination of the parent valuation's published deliverables. This analysis has no independent publication path. |

# 8. Out of Scope / Deferred
- Row-level display of internal transactions in any form, including de-identified or banded rows, in any surface or export.
- Free-form or arbitrary filtering against the internal proprietary database.
- Merging internal and third-party records into a single blended statistic.
- Mixing SDE-basis and EBITDA-basis transactions within one statistic, and conversion of SDE-basis records to an EBITDA basis using captured owner compensation — deferred pending confidence in that field's capture quality.
- Capture of closed-deal data, definition of the comp record field set, de-identification, and consent collection — owned by BY-0006.
- Independent computation of equity value. All conversion occurs through the VL-0001 bridge.
- Announced-but-unclosed transactions and rumoured deals.
- Public-company M&A transaction multiples as a distinct method, and trading comparables, which are owned by VL-0003.
- Regression or statistical modelling of multiples against size, growth or margin, and automated positioning of the applied range within the set.
- Time-series analysis of multiple trends, market condition indices, and period-adjustment of historical multiples.
- Cross-firm benchmarking dashboards or any reporting product built on the proprietary database.
- Non-North-American transactions and multi-currency deal values, consistent with the deferral in DB-0002.
- Any flow of this analysis into the CIM, the Teaser, a listing price, or any buyer-facing document, consistent with VL-0001.
# 9. Open Questions
- Reference file access: the project knowledge files (Centuriuum_Product_List.xlsx, Centuriuum_Spec_Conventions_and_Decisions.docx) could not be read when this spec was drafted. Confirm the VL module label, confirm BY-0006's identity and scope, and confirm nothing here contradicts a locked decision in the conventions doc.
- VL-0001 amendments required, and they are now substantial: (a) the market approach requirements move to VL-0004; (b) the closed-deal capture requirements — comp record field set, de-identification at write, consent — move to BY-0006; (c) the finalization freeze must extend to this feature's snapshot; (d) Related IDs should name VL-0004. Combined with the amendments already logged in VL-0002 and VL-0003, VL-0001 now needs one consolidated revision pass rather than four separate edits.
- Requirements to be raised against BY-0006: the comp record field set specified in VL-0001, de-identification at the point of write, consent capture and withdrawal handling, and — critically — capture of the earnings basis of each transaction (SDE or EBITDA) and of owner compensation, without which basis-separated statistics cannot be produced. If BY-0006 is already specified, these need to be added to it.
- Internal thresholds: the absolute minimum cohort size and the single-transaction concentration cap are set in VL-0001 and inherited here. They should be confirmed once and applied consistently, and the credibility threshold from VL-0001 also applies to internal statistics displayed in this feature.
- Third-party licence terms for row-level display: VL-0003 concluded that per-company market data cannot appear in deliverables. Transaction databases are licensed differently and often do permit reporting individual transactions in client work product. Confirm with counsel per provider, because row-level display in the deliverable is materially more useful here than in trading comps and the answer may differ between the two features.
- Basis conversion: this spec defers converting SDE-basis records to EBITDA using captured owner compensation, which would materially deepen cohorts while the database is young. Revisit once BY-0006 capture quality is established, since deeper cohorts are the main constraint on this feature's usefulness in its first years.
- Duplicate detection rule: what proximity constitutes a suspected duplicate across industry, size, date and geography, and what is the tolerance? A rule that is too loose removes genuine third-party comparables; too tight and the same deal counts twice. Recommend erring toward retaining third-party records and disclosing the residual risk.
- Outlier rule: needs a concrete definition to be testable — for example exclusion beyond a defined interquartile range factor, applied per source and per basis. Confirm the rule and whether it should differ between the internal and third-party sets given their different data quality.
- Deal size definition across sources: internal records capture consideration structure, while third-party databases report price on varying bases including or excluding inventory, real estate and earnouts. Confirm the normalization rule and whether third-party records lacking structure detail should be excluded from multiple computation as internal ones are.
- Recency weighting: should older transactions be excluded beyond a defined age, weighted down, or simply disclosed by date range as specified here? Market conditions move multiples materially over a few years.
- Where both sets are available and disagree materially, should the system require the broker to reconcile the difference in writing, in the way VL-0001 requires a reconciliation across approaches? Recommend yes, since a divergence between platform and national data is exactly the insight a seller should see.
- Cold start: until BY-0006 has produced meaningful volume, this feature runs almost entirely on third-party data, which makes the third-party licence a launch dependency rather than a supplement. Confirm the sequencing expectation so the commercial arrangement is not treated as optional.
- Assumption to confirm: the applied multiple range defaults to the first and third quartile of the selected set. For a small cohort just above the minimum floor, quartiles are unstable. Should the default fall back to a median-anchored band below a defined count?
- Assumption to confirm: where the subject's earnings convention has no corresponding internal set, the broker uses the third-party set of that basis rather than applying a cross-basis multiple. Confirm no cross-basis application is ever permitted.
# 10. Acceptance Criteria
- The feature produces an indicated enterprise value range that appears in VL-0001's concluded range and bridge, and produces no separate report or workbook of its own.
- Internal and third-party sets are displayed separately with their own counts, medians, quartiles, bases and date ranges, and no combined statistic across the two sources exists anywhere in the product.
- No internal transaction is displayed as a row in any interface, report, workbook, export, or API response, at any permission level including internal administrator.
- Internal cohorts can only be assembled from fixed system-defined definitions; no free-form parameter combination is available against the internal source through any surface.
- An internal cohort below the absolute minimum renders no statistic, reports internal data unavailable, and cannot be overridden by any user or role.
- An internal statistic that a single transaction would disproportionately determine is suppressed even where the minimum cohort size is met.
- The valuing user's own in-progress deals never contribute to an internal cohort.
- Every internal cohort query is logged with parameters, resulting count and requesting user.
- Internal statistics are computed separately for SDE-basis and EBITDA-basis transactions, each showing its own count and basis, and no statistic combines the two.
- Third-party data is searchable by industry classification, revenue band, earnings band, geography and date range, and results display as rows with target, buyer, date, deal size, revenue, earnings and implied multiples where the provider supplies them.
- Third-party search runs through the same provider adapter and internal data contract as VL-0003, and the mapped industry classification used is displayed to the user.
- Excluding a third-party transaction requires a recorded rationale, and those rationales print in the deliverable.
- Suspected duplicates between sources are detected, the third-party record is dropped, the count removed is disclosed, and no user is shown which specific record was removed.
- Outliers are flagged, excluded from statistics, and the number excluded is disclosed per set and basis.
- The applied multiple range defaults to the first and third quartile of the selected set, and adjusting either endpoint requires a rationale that prints in the assumptions schedule.
- Selecting which set drives the applied range requires a rationale where both sets are available.
- The applied range is applied to the subject's QE-0004 adjusted earnings on the matching basis, producing an indicated enterprise value range, and no equity value is computed in this feature.
- There is no setting or path under which an EBITDA-basis multiple is applied to SDE or an SDE-basis multiple to EBITDA.
- Where the selected set's basis differs from the deliverable's presentation convention, the SDE to adjusted EBITDA reconciliation including the owner replacement salary is presented.
- The subject's comparison factors — size, growth, margin, customer concentration — are displayed relative to the selected set.
- Deliverables state, for each set used, the source, basis, count, date range, statistics, cohort definition or search parameters, and outlier and duplicate exclusion counts.
- Deliverables contain no internal per-transaction record, and this holds even when a deliverable is generated through a modified template or a direct API call.
- No client-identifying value is transmitted to the third-party provider in any search request.
- Finalizing the parent valuation freezes the internal cohort definition and statistics, the third-party working set and statistics, the selected set, the applied range and all as-of dates, and regenerating the deliverable reproduces the same figures.
- Every cohort query, search, inclusion, exclusion with rationale, duplicate removal, outlier exclusion, set selection, range adjustment and freeze appears in the Activity & Audit Log (SY-0003).
- A buyer cannot access any set, statistic, applied multiple or indication at any status, and a user without assigned role/deal access cannot view any part of this analysis for that deal or prospect.

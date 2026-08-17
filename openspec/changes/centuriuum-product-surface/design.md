## Context

See `proposal.md`. Input is the `Centuriuum Product Listing` spreadsheet: 93 features, 15 modules, one
row each, summaries ranging from a single sentence ("Generate statement of cash flow. Lower priority")
to 500-word specifications with named dependencies (`BR - 0010`, `SE - 0004`, `BY - 0007`). That
variance is itself information — the long rows are the features someone has actually thought through,
and they cluster in sell-side process management and valuation, which is where the product's
differentiation is claimed to be.

The existing OpenSpec repo describes a re-architecture of what exists. This describes what is
intended. Both are needed; they answer different questions and must not be merged into one document.

## Goals / Non-Goals

**Goals:** every feature placed in exactly one capability; requirements testable rather than
aspirational; dependency edges explicit, especially the ones the source list states only in prose;
contradictions and dangling IDs surfaced rather than smoothed over.

**Non-Goals:** implementation detail, estimates, product decisions, amending the cutover order.

## Decisions

### D1 — Capability boundaries follow cohesion, not the module column

Thirteen of the fifteen modules map to a capability one-to-one. Three do not, and forcing them to
would produce capabilities nobody could reason about:

- **Broker (16 features) splits three ways.** `broker-workspace` is the broker's own operating surface
  (profile, deal tracker, NDA, listings, cross-posting, sourcing, ERP). `deal-marketing` is the
  sell-side process — buyer list, teaser distribution and NDA gating, outreach pipeline, engagement
  analytics, seller status report — five features that share one state machine and one data spine.
  `deal-execution` is everything post-offer: engagement and fee management, IOI/LOI intake, offer
  comparison, exclusivity and post-LOI milestones, LOI templates. These three have different consumers,
  different lifecycles, and near-zero shared state; as one capability they would be unreviewable.
- **`SE - 0004` (Activity & Audit Log) becomes its own capability.** It is consumed by document
  watermarking (`DR - 0006`), buyer engagement analytics (`BR - 0010`), the seller status report
  (`BR - 0011`), and e-signature (`SY - 0004`). The source list says it plainly: "build early rather
  than retrofitted".
- **`SY - 0004` (E-Signature) becomes its own capability.** Same reason, stated in the row itself: "a
  single reusable signature service consumed by every module that needs an executed document, specified
  once here rather than rebuilt separately inside each."

### D2 — Requirements are written as behavior, not as intent

The source rows are written as intent ("Need to have wizard to allow for report pulling at ease").
Each becomes a `SHALL` statement with scenarios that can fail. Where a row states only a wish with no
determinable behavior — `BY - 0005`'s "super end game" off-market deal sourcing, `BR - 0006`'s "some
concept of the buyer ERP" — the requirement is written narrowly around the part that is decidable and
the rest is registered as an open question. Writing a confident specification over an undecided
product idea is worse than admitting the gap: it manufactures agreement that does not exist.

### D3 — Sketch fidelity is a deliberate stopping point

Each feature gets a requirement and one to three scenarios. That is enough to review scope, find
missing dependencies, and argue about boundaries — and not enough to build from. The step from sketch
to buildable is a per-feature change; `data-retrieve-wizard` (14 requirements, 40 scenarios, 6 open
questions, from a single spreadsheet row plus a 4-page feature doc) shows the expansion ratio to
expect. Ninety-three of those now would be perhaps 3,000 requirements written against product
decisions that have not been made.

### D4 — Four capabilities gate the rest, and three of them are not scheduled

Reading the dependency edges out of the source list:

| Gate | Gates what | Currently |
|---|---|---|
| `access-control` (SE-0001/0002/0003) | Every module. Nothing is correct without per-company role scoping. | Partly built (`canAccessCompany`); `companies-domain` / `users-domain` in flight |
| `activity-log` (SE-0004) | `DR - 0006` watermarking, `BR - 0010` engagement analytics, `BR - 0011` status report, `SY - 0004` audit certificates | **Not scheduled.** Cannot be retrofitted — it is a *capture* problem; data not logged is gone |
| `financial-data` (DB-0001…0010) | All of `reports`, `qoe`, `projection-model`, `valuations` — 39 features | Partly specced via `reports-domain`; the table structure `DB - 0001` is undecided |
| `e-signature` (SY-0004) | `BR - 0002` NDA, `BR - 0012` engagement letters, `BR - 0013` IOI/LOI, `BY - 0007` attestations | **Not scheduled** |

`VL - 0006` (Purpose & Standard of Value) is a fifth, narrower gate — it gates the valuations module
only, and the source row says so: "Gates all other VL features - build first."

### D5 — Recommended build order, and where it departs from the plan

The cutover order in `docs/MODERNIZATION_PLAN.md` §5 (config/contracts/db → auth → companies/users/
folders → uploads/requests/messages → reports → quickbooks → extraction) is sound as a *migration*
sequence. Layered against the product surface it needs two amendments:

1. **`activity-log` moves early — before `data-room` document control.** Not a preference: log capture
   must exist before the events worth logging occur, and `DR - 0006` and `BR - 0010` are both
   unbuildable without the history. Retrofitting yields a log with no past.
2. **`quickbooks` moves earlier than "second to last".** The Data Retrieve Wizard is the write path for
   `financial-data`, which gates 39 downstream features. As long as it sits near the end of the order,
   everything above it is fed by hand-uploaded spreadsheets.

Everything else in the plan's order holds. The sequence itself is the topological layering computed in
§D7 below — an earlier hand-grouped version of this section was wrong in three places and has been
replaced by the computed order rather than patched.

### D6 — `reports` is one capability with two authors

`RP - 0001..0003` (generate P&L, BS, Cash Flow from loaded GL data) and the in-flight `reports-domain`
change (key-report *version* lifecycle, and the seam over the 9,088-line `manualGlMultiYearService`)
are the same capability seen from the product side and the migration side. They are kept as one
capability with the overlap stated, rather than split into `reports` and `reports-legacy`, which would
guarantee two specs drifting against one implementation.

### D7 — The dependency graph, and the build order computed from it

`requires` means X cannot be built correctly without Y. It is distinguished from `feeds` — X produces
data Y consumes — because the two point in opposite directions and conflating them is what made the
first pass of §D5 wrong. 49 requires-edges across 21 capabilities; the graph is **acyclic**.

| Capability | Requires |
|---|---|
| `access-control` | — |
| `activity-log` | access-control |
| `platform-services` | access-control |
| `user-profiles` | access-control |
| `financial-data` | access-control |
| `deal-qa` | access-control |
| `data-room` | access-control, activity-log |
| `external-integrations` | access-control, platform-services |
| `reports` | financial-data |
| `data-retrieve-wizard` | data-room, financial-data |
| `e-signature` | access-control, data-room, activity-log |
| `bank-portal` | access-control, data-room, platform-services |
| `qoe` | financial-data, reports, deal-qa, external-integrations (payroll) |
| `projection-model` | qoe |
| `cim` | qoe, reports, deal-qa |
| `broker-workspace` | access-control, data-room, e-signature |
| `valuations` | qoe, projection-model, external-integrations (market data) |
| `buyer-workspace` | access-control, data-room, broker-workspace |
| `deal-marketing` | broker-workspace, buyer-workspace, cim, e-signature, activity-log, data-room |
| `deal-execution` | deal-marketing, e-signature, valuations, projection-model, buyer-workspace, platform-services |
| `company-portal` | access-control, deal-marketing |

**Feed edges (data flows back; not build dependencies):** `data-retrieve-wizard` → `financial-data`
(pull output populates GL/COA/TB); `data-room` → `activity-log` (view/download events);
`deal-execution` → `buyer-workspace` (retrade and dead-LOI history becomes BY-0007 track record);
`buyer-workspace` → `valuations` (BY-0006 closed-deal multiples become the VL-0004 proprietary comps
database); `cim` → `qoe` (QE-0008 compares the CIM against the recalculated bridge).

**Computed layering** — each layer depends only on layers above it:

```
L0  access-control
L1  activity-log · platform-services · financial-data · deal-qa · user-profiles
L2  data-room · external-integrations · reports
L3  e-signature · data-retrieve-wizard · qoe · bank-portal
L4  broker-workspace · cim · projection-model
L5  buyer-workspace · valuations
L6  deal-marketing
L7  deal-execution · company-portal
```

**Where this corrected the earlier hand-grouped order:**

1. **`data-room` was in the fourth tier; it belongs in L2.** `data-retrieve-wizard`, `e-signature`,
   `broker-workspace`, `buyer-workspace`, and `bank-portal` all require it — six dependents, second
   only to `access-control`. Shipping the wizard before the templated file structure it writes into is
   not possible.
2. **`external-integrations` was called "periphery, gated on the provider cost decision"; it is L2.**
   `qoe` needs payroll (`DR - 0007`) to substantiate add-backs at source level and `valuations` needs
   market data for comps. Only the market-data half is gated on the cost decision — the payroll half is
   not, and treating them as one deferred item would block the QoE add-back bridge for no reason. Build
   payroll with `qoe`; defer market data with `valuations`.
3. **`broker-workspace` and `buyer-workspace` were "periphery"; they are prerequisites for
   `deal-marketing`.** The NDA template lives on the broker profile and the qualification grade
   (`BY - 0007`) is the gate `BR - 0008` enforces — the sell-side process cannot be built over absent
   counterparty records.
4. **`deal-qa` was sequenced after `qoe`; it precedes it.** `QE - 0015` generates questions *into* the
   Q&A surface, and `QE - 0006`/`QE - 0007` read commentary back out of it.

**Critical chain: 8 deep, ending at `deal-execution`.** `access-control → financial-data → reports →
qoe → projection-model → valuations → deal-marketing → deal-execution`. Offer comparison
(`BR - 0014`) — the feature the product list makes the strongest claim for — sits at the end of the
longest path in the product. Nothing shortens that chain except cutting scope from `BR - 0014` itself.

**Most depended-upon:** `access-control` (12 dependents), `data-room` (6), then `activity-log`,
`platform-services`, `financial-data`, `qoe`, `e-signature` (3 each). The first two are where a wrong
decision is most expensive.

**Blocked by the six features that have no row** (Register A): `deal-execution` is blocked on
`VL - 0009` (deal structure engine), `VL - 0007` (SBA output), `VL - 0010` (version lock), and
`QA - 0003` (diligence request list); `valuations` on `VL - 0008` (asset approach) and `VL - 0010`.
Both sit at the deep end of the critical chain, so the decisions are not urgent by date — but
`VL - 0009` is a modeling engine, not a screen, and it is the one most likely to be underestimated
because no row exists to estimate.

### D8 — Cross-references are recorded as stated, then flagged

Where the source list references an identifier that does not exist in it, the requirement records the
relationship in the terms the source used and the dangling ID goes into the register below. Silently
"fixing" `BO - 0002` to `BR - 0008` would be a guess presented as a fact, and if the guess is wrong it
is invisible.

## Risks / Trade-offs

- **Sketch specs read as commitments.** A requirement written in `SHALL` form looks decided. Mitigation:
  every capability spec opens with its fidelity level and the open questions it depends on.
- **The map ages.** 93 features across an evolving product; this is accurate on the day it merges.
  Mitigation: the map's value is highest right now, during sequencing. It is cheap to regenerate and
  should not be treated as a maintained artifact after the dependency decisions are taken.
- **Capability boundaries are a judgment call.** The three-way Broker split (D1) is defensible and not
  the only defensible answer. It is worth disagreeing with early, since it shapes the change breakdown.
- **Scope shock.** Placing all 93 features in one document makes the gap between the current codebase
  and the intended product legible for the first time. That is the point, but it is a number the
  business has not previously had to look at.

## Migration Plan

Not applicable — specification only, no code and no data. The sequence is: review the capability
boundaries (D1), resolve the ID register below, take or reject the build-order amendments (D5), then
open per-feature changes at `data-retrieve-wizard` fidelity in that order.

## Open Questions

### Register A — dangling feature IDs

Fifteen identifiers are referenced by the source list but do not appear in it. The likely reading is a
renumbering of the broker-side features into `BR - 0007..0016` whose cross-references were not updated.
**Every mapping below is inference, not fact, and needs Josh's confirmation.**

| Referenced | Referenced by | Probable target |
|---|---|---|
| `BO - 0001` | BR-0008, BR-0009 | `BR - 0007` Buyer List Builder & Tiering |
| `BO - 0002` | BR-0010, BY-0007, CM-0005, SY-0004 | `BR - 0008` Teaser Distribution & NDA Gating |
| `BO - 0003` | BR-0011, BR-0013, BY-0007 | `BR - 0009` Outreach Pipeline & Follow-Up Cadence |
| `BO - 0004` | BR-0011, BR-0014, DR-0006 | `BR - 0010` Buyer Engagement Analytics |
| `BO - 0005` | BR-0011 | `BR - 0015` Exclusivity & Post-LOI Milestone Tracking |
| `BO - 0006` | BR-0010 | `BR - 0011` Client (Seller) Status Report |
| `LO - 0001` | BR-0014, SY-0004 | `BR - 0013` IOI / LOI Intake & Version Control |
| `LO - 0002` | BR-0013, BR-0016 | `BR - 0014` Offer Comparison & Bid Analysis |
| `IN - 0005` | BR-0008, BR-0012, BR-0013, BR-0016 | `SY - 0004` E-Signature Service |
| `VL - 0007` | BR-0015 | Unknown — an SBA financing output; **no VL row covers it** |
| `VL - 0008` | VL-0006 | Unknown — the asset approach; **no VL row covers it** |
| `VL - 0009` | BR-0012, BR-0014 | Unknown — a deal-structure engine; **no VL row covers it** |
| `VL - 0010` | BR-0013, DR-0008, VL-0006 | Unknown — valuation version snapshot/lock; **no VL row covers it** |
| `RP - 0004` | BR-0009 | Unknown — firm-level analytics; **no RP row covers it** |
| `QA - 0003` | BR-0015 | Unknown — a diligence request list; **no QA row covers it** |

The bottom six matter more than the top nine. A renumbering is clerical; six referenced features with
no row means **`deal-execution` and `valuations` depend on capabilities nobody has written down**. In
particular `VL - 0009` (the structure engine converting offer terms to risk-adjusted present value)
carries the analytical weight of `BR - 0014`, the feature the product list describes as the analysis
"sellers most need and least often receive."

Additionally: `BY - 0005` and `BY - 0006` say "Can be recycled with BK - 0005", but the Bank module has
only `BK - 0001`. Probably `BR - 0005` (Deal sourcing), which matches the subject.

### Register B — contradictions and gaps

1. **`SY - 0004` is used for two different things.** It is specified as the E-Signature Service, but
   `BR - 0009` and `BR - 0015` reference it as the source of "tasks and reminders". Either a task/
   notification service is missing from the list, or those references mean a different ID. *(Blocks:
   nothing immediately; distorts the dependency graph.)*
2. **No notification capability exists.** The Data Retrieve Wizard spec names a "Notifications hub
   (cross-cutting gap)" as a dependency; `BY - 0003` (deal notifications), `BR - 0009` (stall alerts),
   `BR - 0015` (milestone reminders) and `SE - 0004` (anomaly alerting) all need one. There is no row
   for it. *(Blocks: those four features, partially.)*
3. **No document-versioning capability exists.** The wizard spec names it as a cross-cutting gap;
   `CM - 0005`, `BR - 0013` and `VL - 0010` all assume it. `DB - 0010` is adjacent but is about table
   sharing, not versioning. *(Blocks: `data-retrieve-wizard` FR-11, `deal-execution` version control.)*
4. **`DB - 0001` (Table Structure) is the foundation of 39 features and is one sentence long.** The row
   itself notes the ambiguity ("Debated putting this under system"). *(Blocks: `financial-data` and
   everything above it. Highest-leverage unresolved item on the list.)*
5. **`DB - 0010` (Table Blocks) raises an unresolved architecture question** — whether the QoE provider
   and the broker link different files to the same underlying tables — and is marked "Important
   architecture item to consider." It shapes the `financial-data` data model. *(Blocks: `financial-data`
   design.)*
6. **The external data provider decision is unmade and recurs in four places** (`DR - 0008`,
   `VL - 0003`, `VL - 0004`, `BR - 0005`, `BY - 0005`). `DR - 0008` correctly frames it as one
   integration serving several features. It is the largest recurring cost in the platform and gates the
   comps half of the valuation module. *(Blocks: `VL - 0003`, `VL - 0004`, `external-integrations`.)*
7. **Valuation credentialing carries real liability.** `VL - 0006` requires suppressing
   opinion-of-value language when no CVA/ABV/ASA credential is on file, and `BR - 0016` notes
   unauthorized-practice-of-law exposure on LOI templates. Both need a decision from someone who owns
   that risk, not from engineering. *(Blocks: shipping `valuations` and `deal-execution` externally.)*
8. **`DR - 0007` (payroll) is more load-bearing than its position suggests** — the row says so directly:
   owner compensation is the most disputed add-back in any lower-middle-market SDE bridge, and the
   detail is not in the GL. It sits in the Data Room module but is really a `qoe` input. *(Blocks:
   substantiating `QE - 0004` add-backs at source level.)*
9. **AI metering (`SY - 0001`) is stated as undetermined** while AI features appear across the QoE, CIM,
   redaction and offer-intake surfaces. Cost exposure is unbounded until it is decided. *(Blocks:
   nothing technically; a commercial risk.)*

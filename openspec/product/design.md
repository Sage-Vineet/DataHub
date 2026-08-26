## Context

See `proposal.md`. Input is now two sources, not one.

**The `Centuriuum Product Listing` spreadsheet** — now **98 features across 14 modules**, one row each,
summaries ranging from a single sentence ("Generate statement of cash flow. Lower priority") to
500-word specifications with named dependencies. That variance is itself information — the long rows
are the features someone has actually thought through, and they cluster in sell-side process management
and valuation, which is where the product's differentiation is claimed to be.

**Fifty-nine feature specification documents** (Josh Tonnesen, 14 Aug 2026), one per feature, each in a
fixed ten-section format: purpose and business context, user stories, functional requirements, data
requirements, access and security, UI/UX notes, dependencies, out-of-scope, open questions, acceptance
criteria. These are the authoritative statement of behaviour for the features they cover. Where a
document and the spreadsheet summary disagree, the document governs.

Both sources are vendored at **`docs/product/`** — originals under `source/`, text conversions under
`markdown/`, provenance and regeneration in its README. Where a requirement here and its source
document disagree, the document governs.

**What changed between the two revisions of the product list.** The first pass of this change was
written against a 93-feature, 15-module version. The current list differs materially:

- The **`SE` (Security) module was folded into `SY` (System)** and the System module renumbered:
  `SE - 0001` → `SY - 0001` (role-based access), `SE - 0002` → `SY - 0002` (company access),
  `SE - 0004` → `SY - 0003` (activity log); the previous `SY - 0001/0002/0003` (metering, user
  creation, referral tracking) became `SY - 0004/0005/0006`; and e-signature moved from `SY - 0004` to
  `SY - 0007`. `SE - 0003` (deal team) left the security module entirely and became `DR - 0009` in the
  Data Room.
- **Six features that Register A recorded as referenced-but-missing now exist as rows**: `VL - 0007`,
  `VL - 0008`, `VL - 0009`, `VL - 0010`, `QA - 0003`, and — as the deal team — `DR - 0009`. `RP - 0004`
  (firm analytics) is the only referenced identifier still with no row.
- **`VL` grew from 6 features to 10**, and `DR` from 8 to 9.

Every capability spec in this change now carries an **ID note** recording which identifiers in its
source material are stale and what they map to, because the feature documents themselves still contain
the pre-renumbering references in their bodies and dependency tables.

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
- **`SY - 0003` (Activity & Audit Log) becomes its own capability.** It is consumed by document
  watermarking (`DR - 0006`), buyer engagement analytics (`BR - 0010`), the seller status report
  (`BR - 0011`), and e-signature (`SY - 0007`). Its own specification says it plainly: "intentionally
  built early rather than retrofitted".
- **`SY - 0007` (E-Signature) becomes its own capability.** Same reason, stated in the specification
  itself: a single reusable signature service consumed by `BR - 0002`, `BR - 0012`, `BR - 0013` and
  `BY - 0007` rather than rebuilt separately inside each.
- **`DR - 0009` (Deal Team) follows its module, not its old home.** In the previous numbering the deal
  team roster was `SE - 0003` and sat in `access-control`, since it is a view of who holds a grant. Its
  own specification makes it a Data Room feature with behaviour access control does not have — manual
  off-platform entries, per-role visibility marking, and a hard rule that a buyer never sees another
  buyer — so it moved to `data-room` and `access-control` no longer claims it.

### D2 — Requirements are written as behavior, not as intent

The source rows are written as intent ("Need to have wizard to allow for report pulling at ease").
Each becomes a `SHALL` statement with scenarios that can fail. Where a row states only a wish with no
determinable behavior — `BY - 0005`'s "super end game" off-market deal sourcing, `BR - 0006`'s "some
concept of the buyer ERP" — the requirement is written narrowly around the part that is decidable and
the rest is registered as an open question. Writing a confident specification over an undecided
product idea is worse than admitting the gap: it manufactures agreement that does not exist.

### D3 — Fidelity is now per-feature, and stated per-feature

The first pass of this change was uniformly at *sketch* fidelity, because a spreadsheet row was all
there was. With 59 feature specification documents in hand that is no longer the right stopping point,
and holding every capability at sketch would discard specified behaviour that already exists.

Fidelity is therefore now recorded per capability, and where a capability is mixed, per requirement:

| Fidelity | Meaning | Coverage |
|---|---|---|
| **specified** | Requirements derived from a feature specification document — its functional requirements, dependencies, and acceptance criteria | 59 features |
| **product-list detail** | No specification document, but a substantive multi-paragraph product-list summary naming behaviour and dependencies | `VL - 0005` … `VL - 0010`, `DR - 0006` |
| **sketch** | A one-to-three sentence product-list row; a requirement and a scenario or two, enough to review scope and not enough to build from | remainder — all of `BR`, all of `BY`, all of `PJ`, `BK - 0001`, `DR - 0005`, `DR - 0008`, `DB - 0010`, `RP - 0003` |

The specified capabilities are `access-control`, `activity-log`, `platform-services`, `e-signature`,
`user-profiles`, `data-room` (except `DR - 0005`), `external-integrations` (`DR - 0007` only),
`financial-data` (except `DB - 0010`), `reports` (`RP - 0001`/`RP - 0002`), `deal-qa`, `cim`,
`company-portal`, `qoe`, and `valuations` (`VL - 0001` … `VL - 0004`).

The sketch capabilities are exactly the ones with no specification document. Every requirement in them
is traceable to a product-list summary and nothing more; each such capability says so in its header. A
sketch feature gets its own change at `data-retrieve-wizard` fidelity when it is scheduled — but the
39 features still at sketch or product-list fidelity are now the *minority* of the surface, and the
open question is no longer "when do we deepen these" but "who writes the remaining 39 documents".

### D4 — Four capabilities gate the rest, and three of them are not scheduled

Reading the dependency edges out of the source list:

| Gate | Gates what | Currently |
|---|---|---|
| `access-control` (SY-0001/0002) | Every module. Nothing is correct without per-company role scoping. | Partly built (`canAccessCompany`); `companies-domain` / `users-domain` in flight. **Now specified** |
| `activity-log` (SY-0003) | `DR - 0006` watermarking, `BR - 0010` engagement analytics, `BR - 0011` status report, `SY - 0007` audit certificates, `VL - 0010` assumption history | Change `activity-log-capture` (SE-0004) is in flight. Cannot be retrofitted — it is a *capture* problem; data not logged is gone. **Now specified** |
| `financial-data` (DB-0001…0010) | All of `reports`, `qoe`, `projection-model`, `valuations` — 42 features | Partly specced via `reports-domain`; `DB - 0001` is **now specified** and `DB - 0010` remains undecided |
| `e-signature` (SY-0007) | `BR - 0002` NDA, `BR - 0012` engagement letters, `BR - 0013` IOI/LOI, `BY - 0007` attestations | **Not scheduled.** Now specified |

`VL - 0006` (Purpose & Standard of Value) is a fifth, narrower gate — it gates the valuations module
only, and the source row says so: "gating input at the start of every valuation engagement". It now has
a row and a detailed summary, but no specification document.

**The gate positions did not move, but three of the four are no longer speculative.** Where this table
previously said "not scheduled" against features nobody had written down, three of the four gates now
have implementation-ready specifications and can be estimated. `e-signature` is the one still
unscheduled with four named consumers waiting on it.

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

3. **`e-signature` is now the single largest unscheduled gate.** It has four named consumers
   (`BR - 0002`, `BR - 0012`, `BR - 0013`, `BY - 0007`), an implementation-ready specification, and no
   position in the cutover order at all. Unlike `activity-log` it *can* be retrofitted — but every week
   it is absent is a week those four features cannot start.

Everything else in the plan's order holds. The sequence itself is the topological layering computed in
§D7 below — an earlier hand-grouped version of this section was wrong in three places and has been
replaced by the computed order rather than patched.

### D6 — `reports` is one capability with two authors

`RP - 0001..0003` (generate P&L, BS, Cash Flow from loaded GL data) and the in-flight `reports-domain`
change (key-report *version* lifecycle, and the seam over the 9,088-line `manualGlMultiYearService`)
— note that `DB - 0001`'s specification now defines the Key Reports slot-and-version model directly,
which is the same object `reports-domain` migrates, so the two must be reconciled rather than merely
noted —
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

**Blocked-by, revised.** The six features previously recorded as having no row now all have one, so
nothing in the graph is blocked on a feature nobody has written down. What remains is a
*specification-depth* constraint rather than an existence one:

- `deal-execution` reads `VL - 0009` (deal structure engine) for both `BR - 0012` fee modelling and
  `BR - 0014` offer comparison, `VL - 0007` for the SBA output, and `VL - 0010` for version lock;
  `QA - 0003` is now specified and no longer blocks it.
- `valuations` reads `VL - 0008` for the asset approach and `VL - 0010` for the audit log; both have
  detailed summaries and neither has a specification document.
- `VL - 0006` gates the rest of `valuations` and likewise has a summary but no document.

`VL - 0009` remains the item most likely to be underestimated. It is a modelling engine, not a screen —
entity-type-dependent tax treatment, probability-weighted earnout discounting, and a
seller-net-after-tax bridge — and it sits behind the feature the product list makes its strongest claim
for. It has a row and a rich summary now, which makes it estimable in a way it was not; it does not
make it small.

### D8 — Renumbering is now applied, with the old identifiers recorded

The first pass recorded cross-references in the terms the source used and pushed the dangling IDs into
Register A, on the grounds that silently "fixing" `BO - 0002` to `BR - 0008` would be a guess presented
as fact. The 59 feature documents settle it: each carries its own feature ID in its header table, which
pins the mapping directly rather than by inference.

The specs therefore now use the **current** identifiers throughout, and each capability header carries
an ID note recording which identifiers its own source material still uses and what they map to. This is
the reverse of D8's original policy and is the right call now, because the ambiguity that justified it
is resolved. The one place the old policy still applies is the `BR` and `BY` capabilities, where the
product-list summaries are the only source and still contain the pre-renumbering references — those are
mapped in Register A and the mappings are stated as mappings, not silently applied inside requirement
text.

## Risks / Trade-offs

- **Mixed fidelity reads as uniform.** 448 requirements in one document set all written in `SHALL`
  form; a reader cannot tell by tone which are drawn from a signed-off specification and which restate
  a one-line spreadsheet summary. Mitigation: every capability header states its fidelity, and mixed
  capabilities state it per requirement. This is a heavier mitigation than the last pass needed and it
  is still the most likely way this document set misleads someone.
- **The map ages, and it has already aged once.** The first pass was written against a 93-feature list
  and was stale within weeks — an entire module was renumbered underneath it. Mitigation: the ID notes
  in each capability make the next reconciliation mechanical rather than archaeological. The map's
  value is highest during sequencing; it should be regenerated, not maintained by hand.
- **Requirements derived from documents can drift from those documents.** 59 source documents were
  compressed into requirements here; the documents remain the authority. Mitigation: every requirement
  carries its feature ID, so any requirement can be checked against its source in one step. There is no
  automated check that they stay in sync.
- **Capability boundaries are a judgment call.** The three-way Broker split (D1) is defensible and not
  the only defensible answer. It is worth disagreeing with early, since it shapes the change breakdown.
- **Scope shock, larger than last time.** Placing all 98 features in one document set — now 448
  requirements rather than roughly 120 — makes the gap between the current codebase and the intended
  product legible. That is the point, but the number is substantially bigger than the first pass
  suggested, and the growth came from reading the specifications rather than from scope being added.

## Migration Plan

Not applicable — specification only, no code and no data. The sequence is: review the capability
boundaries (D1), confirm Register A's reconciliation (now evidence-backed rather than inferred), take
or reject the build-order amendments (D5), resolve the Register B items that block the data spine
(§5) and the four cross-cutting capabilities that have no ID (§1, §2, §3, §10), then open per-feature
changes in §D7 layer order. The 39 features still at sketch or product-list fidelity need
specification documents before they are scheduled; the 59 that have them are ready to be broken into
implementation changes directly.

## Open Questions

### Register A — feature ID reconciliation (resolved)

The fifteen dangling identifiers are **resolved**. The 59 feature specification documents each carry
their feature ID in a header table, which pins the mapping directly instead of by inference, and the
renumbered product list supplies rows for the six features that previously had none. What follows is
the reconciliation of record. Only the last row still needs a product decision.

**Module renumbering — the `SE` module folded into `SY`:**

| Old | New | Feature | Evidence |
|---|---|---|---|
| `SE - 0001` | `SY - 0001` | Role Based Access Setup | `SY - 0001` document header; its own body still says `SE - 0001` |
| `SE - 0002` | `SY - 0002` | Company Access Setup | `SY - 0002` document header; its own body still says `SE - 0002` |
| `SE - 0003` | `DR - 0009` | Deal Team | `DR - 0009` document header; moved module, not just number |
| `SE - 0004` | `SY - 0003` | Activity & Audit Log | `SY - 0003` document header |
| `SY - 0001` | `SY - 0004` | AI & Compute Usage Metering | `SY - 0004` document header |
| `SY - 0002` | `SY - 0005` | User Creation | `SY - 0005` document header |
| `SY - 0003` | `SY - 0006` | Referral Tracking | `SY - 0006` document header |
| `SY - 0004` | `SY - 0007` | E-Signature Service | `SY - 0007` document header |

**Broker-side renumbering — the `BO` and `LO` modules folded into `BR`:**

| Old | New | Feature | Evidence |
|---|---|---|---|
| `BO - 0001` | `BR - 0007` | Buyer List Builder & Tiering | `BR - 0008` cites exclusion and conflict flags "set in `BO - 0001`" |
| `BO - 0002` | `BR - 0008` | Teaser Distribution & NDA Gating | `BR - 0007` cites the distribution step "in `BO - 0002`" |
| `BO - 0003` | `BR - 0009` | Outreach Pipeline & Follow-Up Cadence | `BR - 0011` cites "funnel counts by stage from `BO - 0003`" |
| `BO - 0004` | `BR - 0010` | Buyer Engagement Analytics | `BR - 0011` cites "engagement trend from `BO - 0004`" |
| `BO - 0005` | `BR - 0015` | Exclusivity & Post-LOI Milestone Tracking | `BR - 0011` cites "milestones and deadlines from `BO - 0005`" |
| `BO - 0006` | `BR - 0011` | Client (Seller) Status Report | `BR - 0015` cites "the seller status report in `BO - 0006`" |
| `LO - 0001` | `BR - 0013` | IOI / LOI Intake & Version Control | `BR - 0016` cites "version history from `LO - 0001`"; `SY - 0007` cites "IOIs and LOIs in `LO - 0001`" |
| `LO - 0002` | `BR - 0014` | Offer Comparison & Bid Analysis | `BR - 0013` "feeds `LO - 0002` comparison"; `BR - 0016` cites "the gap analysis produced in `LO - 0002`" |
| `IN - 0005` | `SY - 0007` | E-Signature Service | `BR - 0008` and `BR - 0012` both cite "the e-signature service in `IN - 0005`" |

**Previously missing features that now exist as rows:**

| Referenced | Status | Where specified |
|---|---|---|
| `VL - 0007` SBA / Lender-Ready Valuation Output | Row exists, no document | `valuations`, product-list detail |
| `VL - 0008` Asset / Net Asset Value Approach | Row exists, no document | `valuations`, product-list detail |
| `VL - 0009` Deal Structure Impact on Value | Row exists, no document | `valuations`, product-list detail |
| `VL - 0010` Version Control & Assumption Audit Log | Row exists, no document | `valuations`, product-list detail |
| `QA - 0003` Q&A Module Purpose | Row **and** document | `deal-qa`, specified |
| `DR - 0009` Deal Team (was `SE - 0003`) | Row **and** document | `data-room`, specified |

**Not references at all:**

`BK - 0005` and `DS - 0001` appear only in the list's notes column as retired identifiers available for
reuse — "can be recycled with `BK - 0005`" against `BY - 0006`, "can be recycled with `DS - 0001`"
against `BR - 0005`. They are not references to missing features, and the previous inference that
`BK - 0005` probably meant `BR - 0005` was wrong in kind, not just in target.

**Still unresolved — one item, and it needs a product decision:**

| Referenced | Referenced by | Status |
|---|---|---|
| `RP - 0004` firm-level analytics | `BR - 0009` ("pass-reason data feeds firm analytics in `RP - 0004`") | **No row and no document.** Either the Reports module is missing a fourth feature, or `BR - 0009`'s aggregated pass-reason analysis has no home |

Additionally, several `BR` summaries reference **`SY - 0004` as a task and notification service** —
"generate tasks in `SY - 0004`", "notifies the deal team through `SY - 0004`", "milestones write tasks
and reminders through `SY - 0004`". In the current numbering `SY - 0004` is AI and compute usage
metering. These are references to the notifications hub, which still has no feature ID (Register B §1).

### Register B — contradictions and gaps

Renumbered against the current list, and revised against the 59 feature documents. Items 4, 6, 7 and 8
were previously stated as gaps and are now settled by a specification; they are recorded as closed
rather than deleted, so the reasoning stays visible.

1. **No notification capability exists, and it is now assumed by eleven specified features.** The
   `SY - 0005`, `SY - 0006`, `US - 0001`, `US - 0003`, `US - 0005`, `CP - 0001`, `CP - 0002`,
   `QA - 0001`, `CM - 0004`, `QE - 0013` and `DR - 0007` specifications each name a "Notifications Hub
   (cross-cutting gap)" as a dependency and each explicitly declines to build a local version. Several
   `BR` summaries reference it as `SY - 0004`, which is metered usage. There is still no row.
   *(Blocks: partially, every feature above — welcome emails, Q&A assignment alerts, request reminders,
   Buy Box match alerts, and export-ready notices all route through it.)* **This is now the most
   widely-assumed missing capability on the list.**
2. **No onboarding / invite flow capability exists.** `SY - 0001`, `SY - 0002`, `SY - 0005`,
   `US - 0004`, `US - 0005`, `DR - 0001` and `SY - 0006` all depend on an invite mechanism — generating
   the link, choosing a suggested role, expiry, resend, and the approval path for a self-registered
   user requesting access. `SY - 0005` states plainly that it "assumes an invite record exists" and
   "does not design that mechanism". No feature owns it. *(Blocks: every grant to a user not already on
   the platform.)*
3. **No document-versioning capability exists.** `CM - 0005`, `BR - 0013`, `VL - 0010`, `DR - 0004` and
   `SY - 0007` all assume one; `SY - 0007` explicitly defers "general versioning behaviour" to it.
   Several features have built their own local versioning in the meantime — `DB - 0001` slot versions,
   `DR - 0001` file versions, `DB - 0008` return versions, `QE - 0011` extraction versions — which is
   four conventions where there should be one. *(Blocks: `data-retrieve-wizard` FR-11, `deal-execution`
   version control; already causing divergence.)*
4. **~~`DB - 0001` (Table Structure) is one sentence long.~~ Closed.** `DB - 0001` now has a full
   specification: the Key Reports slot model, explicit user-created versions, the active-version
   concept, confirmed-overwrite semantics, generic parse-at-ingestion, and ingestion run logging. It is
   no longer the highest-leverage unresolved item. **It does need reconciling against the in-flight
   `reports-domain` change**, which migrates the same object (§D6).
5. **`DB - 0010` (Table Blocks) is still unresolved and is now the only undecided item in the data
   spine.** `DB - 0001`'s specification explicitly "assumes that scoping exists but does not design
   it", and the product list marks `DB - 0010` "N/A — more conceptual than spec doc. Should be covered
   elsewhere." Nothing covers it elsewhere. *(Blocks: the `financial-data` data model — specifically
   whether a QoE provider and a broker can link different files against one stored table.)*
6. **The external data provider decision is unmade and is now costed in more detail.** `DR - 0008`
   frames it as one integration serving `VL - 0003`, `VL - 0004`, `BR - 0005` and `BY - 0005`, and both
   `VL - 0003` and `VL - 0004` now specify against a provider-agnostic internal data contract with a
   per-provider adapter — which is the right shape and means the *integration* work is decoupled from
   the *commercial* decision. What is still blocked is entitlement: `VL - 0003` specifies that where no
   provider is connected the feature reports itself unavailable, so the public comparables and
   third-party precedent transaction halves of the valuation module simply do not exist until someone
   signs a contract. *(Blocks: `VL - 0003`, the third-party half of `VL - 0004`, `BR - 0005`,
   `BY - 0005`.)*
7. **Valuation credentialing and UPL exposure — unchanged, and now more concrete.** `VL - 0006`
   requires suppressing opinion-of-value language when no CVA/ABV/ASA credential is on file, and
   selects between USPAP, AICPA SSVS No. 1 and NACVA compliance frameworks by engagement purpose.
   `VL - 0001` requires prominent non-appraisal language on every report. `VL - 0007` requires a
   statement of independence and no contingent fee arrangement, signed by a qualified individual — for
   a brokerage whose fee *is* contingent. `BR - 0016` notes unauthorized-practice-of-law exposure on
   LOI templates. These need a risk owner outside engineering. *(Blocks: shipping `valuations` and
   `deal-execution` externally.)*
8. **~~`DR - 0007` (payroll) is more load-bearing than its position suggests.~~ Partly closed.** It now
   has a specification, and that specification is explicit that it is *retrieval only* — reports land in
   the data room as static files and employee-level parsing is "a separate, not-yet-specced feature". So
   the load-bearing part, substantiating owner compensation at source level for the `QE - 0004` bridge,
   is **still missing** and now has a name and no ID. *(Blocks: substantiating `QE - 0004` add-backs at
   source level.)*
9. **AI metering is decided in shape and undecided in commercial terms.** `SY - 0004` now specifies
   full event capture, a rate reference table, an internal dashboard and projected spend — and states
   explicitly that the system "shall not block, throttle, or otherwise restrict any user's usage based
   on volume in this phase". Cost exposure is therefore *measured* but still unbounded, across the AI
   surfaces in `QE - 0007`, `QE - 0015`, `DB - 0007`, `DR - 0004`, `CM - 0004`, `QE - 0001`,
   `QE - 0002`, `QE - 0009` and `QE - 0010`. *(Blocks: nothing technically; a commercial risk that has
   grown, not shrunk, since the last pass.)*
10. **An internal admin / ops console is assumed by three features and does not exist.** `SY - 0004`
    needs it for the usage dashboard and rate table, `SY - 0006` for the platform-wide referral
    reconciliation view, and `SY - 0001` for support staff to correct a mis-selected profile type. No
    row. *(Blocks: the internal-facing half of each.)*
11. **Data retention is deferred in four specifications independently.** `SY - 0003` retains log records
    indefinitely "pending a formal policy", `SY - 0004` retains usage events indefinitely on the same
    basis, `DB - 0001` retains all report versions "or per a retention policy to be defined", and
    `DR - 0004` depends on a "standard data retention/deletion window" for destroyed originals to be
    genuinely unrecoverable. Four features are waiting on one policy nobody owns. *(Blocks: nothing
    immediately; `DR - 0004`'s destruction guarantee is legally load-bearing and currently rests on an
    undefined window.)*
12. **The workbook quality-control review has no feature.** The delivered guidance set includes a
    quality control guide defining a seven-step review of a completed QoE workbook — procedural
    documentation, P&L review for unusual items and missed add-backs, SDE/Adjusted EBITDA accuracy,
    balance sheet, working capital, risks and opportunities, and narrative and formatting — producing a
    prioritized flag list for the director, who makes every final call. It is the firm's actual review
    process and no `QE` feature covers it. `QE - 0005`'s completion tracker is adjacent but tracks
    sub-module status, not review findings. *(Blocks: nothing specified; it is the largest piece of the
    firm's existing workflow with no home in the product surface.)*
13. **`DB - 0004` recalculation is destructive by specification, with a manual-backup escape hatch.**
    The trial balance overwrites prior calculated values on a new GL version and "shall not
    automatically retain a copy"; the mitigation is that a user may manually export a backup first.
    Every other version-bearing object on the platform versions rather than overwrites. This is either
    a deliberate exception worth stating as one, or an inconsistency. *(Blocks: nothing; flagged
    because it contradicts the platform-wide versioning convention the same document set asserts
    elsewhere.)*

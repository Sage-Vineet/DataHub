> **Scope note (18 Aug 2026).** The capability specs and the design analysis this change
> produced now live in the **product surface register** at `openspec/product/`, which is
> deliberately outside `openspec/changes/` so that no archive path can sync 448 requirements
> of unbuilt intent into the baseline. See `openspec/product/README.md`.
>
> What remains here is the part that genuinely resolves: the open decisions in `tasks.md`
> (§4.x scope questions and §5.x sequencing calls). This change closes when those are
> answered — not when the surface is fully specified.

## Why

The `Centuriuum Product Listing` (now **98 features across 14 modules**) together with **59 per-feature
specification documents** (Josh Tonnesen, 14 Aug 2026) is the first material that describes the **whole
product**, not a slice of it. Both are vendored at `docs/product/` and are authoritative over anything
restated here. Until now the OpenSpec repo has held re-architecture changes
— auth, companies, folders, uploads, requests, messages, reports — each specified against the legacy
behavior it replaces. That is the right frame for a rewrite and the wrong frame for a roadmap: it can
say what today's code does, and nothing about the ~80% of the product surface that does not exist yet.

Without a surface map, three things go wrong, and two of them already have:

- **Cross-cutting capabilities get rediscovered inside features.** The product list itself shows this:
  e-signature is described inside NDA (`BR - 0002`), then re-described inside engagement letters,
  IOI/LOI, and buyer attestations before being pulled out as `SY - 0004`. The activity log
  (`SE - 0004`) is a prerequisite for document watermarking and the entire buyer-engagement analytics
  feature, and is explicitly flagged "build early rather than retrofitted".
- **Re-architecture sequencing gets made blind.** The cutover order in
  `docs/MODERNIZATION_PLAN.md` §5 was drawn from the legacy code's shape. Some of what it treats as an
  endpoint — `reports`, `quickbooks` — is the *foundation* of eight later modules.
- **Feature IDs drift, and have now drifted twice.** The first revision of this change was written
  against a 93-feature list that referenced 15 identifiers not present in it. The current list has
  renumbered again — the entire `SE` module folded into `SY`, the System module shifted by three,
  and the deal team moved from `SE - 0003` to `DR - 0009` — and the feature documents themselves still
  carry the pre-renumbering identifiers inside their bodies and dependency tables. Every week that
  passes makes that harder to reconcile, which is why the reconciliation is now recorded as evidence
  rather than inference.

This change establishes the **whole-surface capability map**: every one of the 98 features placed in a
capability, expressed as testable requirements rather than paragraphs of intent, with the dependency
edges between them made explicit — and, for the 59 features that now have specification documents,
carried to the fidelity those documents support rather than left at sketch.

**Cutover-order domain:** none — this is a **specification-only change**. It adds no code and touches
no runtime. It is the map the domain changes are sequenced against.

## What Changes

- **20 capability specs covering all 98 features**, at **448 requirements**. Fidelity is now recorded
  per capability rather than uniform (`design.md` §D3): **specified** where a feature specification
  document exists (59 features), **product-list detail** where the summary is substantive but no
  document exists (`VL - 0005` … `VL - 0010`, `DR - 0006`), and **sketch** for the remainder — all of
  `BR`, all of `BY`, all of `PJ`, and seven other rows. The sketch features become their own changes at
  `data-retrieve-wizard` fidelity when scheduled; the specified ones can be broken into implementation
  changes directly.
- **Full ID reconciliation.** Every capability spec carries an ID note mapping the stale identifiers in
  its own source material to current ones. The 15 previously dangling identifiers are resolved against
  document header IDs rather than inferred; only `RP - 0004` remains without a row.
- **Module → capability mapping**, where the product list's modules are reorganized for cohesion:
  the 16-feature Broker module splits into `broker-workspace` / `deal-marketing` / `deal-execution`;
  the Security module's audit log and the System module's e-signature service become their own
  capabilities because both are consumed platform-wide.
- **Dependency graph and build-order recommendation** (`design.md`), including the four capabilities
  that gate large parts of the surface.
- **Reconciliation register** (`design.md` Register A) now evidence-backed and resolved, and a revised
  contradictions register (Register B) — four previous items closed by the new specifications, four new
  ones opened by them: no notifications hub (now assumed by eleven specified features), no onboarding /
  invite flow (assumed by seven), no internal admin console (assumed by three), and a data retention
  policy four features are independently waiting on.

## Capabilities

### New Capabilities

| Capability | Product-list features | Reqs | Fidelity |
|---|---|---|---|
| `user-profiles` | US-0001 … US-0005 | 18 | specified |
| `access-control` | SY-0001, SY-0002 | 9 | specified |
| `activity-log` | SY-0003 | 10 | specified |
| `platform-services` | SY-0004, SY-0005, SY-0006 | 19 | specified |
| `e-signature` | SY-0007 | 9 | specified |
| `data-room` | DR-0001 … DR-0006, DR-0009 | 29 | specified except DR-0005 |
| `external-integrations` | DR-0007, DR-0008 | 10 | DR-0007 specified; DR-0008 sketch |
| `financial-data` | DB-0001 … DB-0010 | 40 | specified except DB-0010 |
| `reports` | RP-0001 … RP-0003 | 12 | RP-0001/0002 specified; RP-0003 sketch |
| `qoe` | QE-0001 … QE-0015 | 82 | specified |
| `projection-model` | PJ-0001 … PJ-0005 | 10 | sketch |
| `valuations` | VL-0001 … VL-0010 | 51 | VL-0001…0004 specified; rest product-list detail |
| `deal-qa` | QA-0001 … QA-0003 | 14 | specified |
| `cim` | CM-0001 … CM-0005 | 56 | specified |
| `broker-workspace` | BR-0001 … BR-0006 | 11 | sketch |
| `deal-marketing` | BR-0007 … BR-0011 | 19 | sketch |
| `deal-execution` | BR-0012 … BR-0016 | 23 | sketch |
| `buyer-workspace` | BY-0001 … BY-0007 | 11 | sketch |
| `bank-portal` | BK-0001 | 5 | sketch |
| `company-portal` | CP-0001, CP-0002 | 10 | specified |

Two features moved capability since the first revision. `DR - 0009` (Deal Team, formerly `SE - 0003`)
moved from `access-control` to `data-room`, following its module and its own specification. `SY - 0007`
(E-Signature, formerly `SY - 0004`) kept its capability and changed its number.

`DR - 0003` (Data Retrieve Wizard) is referenced by `data-room` but specified in full by the separate
`data-retrieve-wizard` change, which is at implementation fidelity.

## Impact

- **Code:** none. No package, module, schema, or route is added or changed by this change.
- **Data:** none.
- **Runtime behavior:** none.
- **Existing specs:** `auth`, `design-system`, and `platform/api-gateway` are unaffected and remain
  authoritative for their areas. The `reports` capability here describes the *product* reports surface
  (`RP - 0001..0003`); the in-flight `reports-domain` change describes the key-report **version
  lifecycle**. They converge on one capability and the overlap is called out in `design.md`.
- **Sequencing:** `design.md` recommends re-ordering parts of `docs/MODERNIZATION_PLAN.md` §5 in light
  of the product dependencies. That recommendation is a proposal for the CTO to accept or reject — this
  change does not amend the plan.
- **Branch:** `ba/product-surface-specs` off `ba/rearch`; `main` remains frozen. No legacy impact.

## Non-goals

- **Replacing the feature specification documents.** The 59 documents remain the authority for the
  features they cover; the requirements here are derived from them, carry the feature ID that identifies
  the source, and are not a substitute for reading it. Where a requirement and its source document
  disagree, the document governs.
- **Deepening the 39 features that have no document.** They stay at sketch or product-list fidelity.
  Writing a confident specification over an undecided product idea manufactures agreement that does not
  exist; those features need documents, not more requirements derived from one-line summaries.
- **Estimation.** The source list carries `TBD` in every Dev Effort cell; nothing here invents one.
- **Deciding the open product questions.** They are registered in `design.md` with what each one blocks,
  and left open.
- **Amending the modernization plan or the cutover order.** A recommendation is made; the decision is
  not taken here.
- **Any commitment to the external data providers** named in `DR - 0008` / `VL - 0003` / `VL - 0004`.
  That is a recurring-cost decision, flagged as one, not made here.

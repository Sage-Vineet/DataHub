This is a **specification-only change**. It adds no code, no schema, and no runtime behavior, so the
project rule requiring a vitest/supertest task per backend-behavior task does not apply — no task below
changes backend behavior. The per-feature changes this map produces each carry their own test tasks.

## 1. Capability specs (all 98 product-list features covered, 448 requirements, 636 scenarios)
- [x] 1.1 Foundation: `access-control` (SY-0001/0002), `activity-log` (SY-0003), `user-profiles` (US-0001…0005)
- [x] 1.2 Shared services: `platform-services` (SY-0004/0005/0006), `e-signature` (SY-0007)
- [x] 1.3 Data spine: `financial-data` (DB-0001…0010), `reports` (RP-0001…0003), `deal-qa` (QA-0001…0003)
- [x] 1.4 Analysis: `qoe` (QE-0001…0015), `projection-model` (PJ-0001…0005), `valuations` (VL-0001…0010)
- [x] 1.5 Documents: `data-room` (DR-0001…0006, DR-0009), `external-integrations` (DR-0007/0008), `cim` (CM-0001…0005)
- [x] 1.6 Process: `broker-workspace` (BR-0001…0006), `deal-marketing` (BR-0007…0011), `deal-execution` (BR-0012…0016)
- [x] 1.7 Counterparties: `buyer-workspace` (BY-0001…0007), `bank-portal` (BK-0001), `company-portal` (CP-0001/0002)

## 2. Reconciliation against the 59 feature specification documents
- [x] 2.1 Module renumbering applied across all 20 capability specs — `SE` folded into `SY`, System
      shifted by three, `SE - 0003` → `DR - 0009` moved from `access-control` to `data-room`
- [x] 2.2 Per-capability ID notes recording which identifiers each source still uses and their targets
- [x] 2.3 Five previously-missing features specified: `QA - 0003` and `DR - 0009` at specified fidelity;
      `VL - 0005` … `VL - 0010` at product-list-detail fidelity
- [x] 2.4 `access-control`, `activity-log`, `platform-services`, `e-signature`, `user-profiles`,
      `data-room`, `external-integrations`, `financial-data`, `reports`, `deal-qa`, `cim`,
      `company-portal`, `qoe`, `valuations` carried from sketch to specified fidelity
- [x] 2.5 Downstream contracts stated where a specified capability constrains a sketch one —
      `VL - 0002` on `projection-model`; `US - 0001` / `CP - 0002` / `SY - 0007` on `broker-workspace`
- [x] 2.6 Coverage verified mechanically: all 98 rows have at least one requirement; no capability
      claims a feature that is not a row
- [x] 2.7 Narrative authoring guidance (working capital, SDE narrative, risks & opportunities, and the
      general instruction file) folded into `qoe` as requirements where it constrains behaviour rather
      than style — sourcing, gap-flag separation, citation reading, engagement isolation, the
      three-section working capital structure, the math display, and the firm policies
- [x] 2.8 In-flight changes reconciled: `activity-log-capture` renumbered `SE - 0004` → `SY - 0003` and
      `SY - 0004` → `SY - 0007`; `data-retrieve-wizard` reconciled against the revised `DR - 0003`
      document (four behaviours added, two requirements amended) — see that change's own task list

- [x] 2.9 Source material vendored at `docs/product/` — originals, deterministic text conversions, the
      converter, and a README covering provenance, authority, and how to reconcile the next revision

## 3. Cross-cutting analysis
- [x] 3.1 Gating capabilities re-stated against the new numbering (`design.md` §D4)
- [x] 3.2 Departures from `docs/MODERNIZATION_PLAN.md` §5 (§D5) — `e-signature` added as the third
      amendment, now the largest unscheduled gate with four named consumers
- [x] 3.3 Full capability dependency graph — 49 requires-edges, feed edges separated, acyclic,
      8-layer topological order, critical chain, blocked-by (§D7)
- [x] 3.4 Register A rewritten as an **evidence-backed reconciliation** — the 15 dangling IDs resolved
      against document header IDs; `BK - 0005` / `DS - 0001` identified as retired-ID notes rather than
      references; `RP - 0004` the only reference still without a row
- [x] 3.5 Register B revised — four items closed by the new specifications, four new ones opened
- [x] 3.6 Fidelity policy replaced (§D3): per-capability and per-requirement rather than uniform sketch
- [x] 3.7 `DR - 0003` carried to implementation fidelity as the separate `data-retrieve-wizard` change

## 4. Review (product — blocking on the decisions, not on this change merging)
- [x] 4.1 ~~Josh confirms or corrects Register A's ID mappings~~ — resolved by the document header IDs;
      Josh should still sanity-check the six `BO`/`LO` mappings inferred from summary cross-references
- [x] 4.2 ~~Decide the six referenced features that have no row~~ — all six now have rows
- [ ] 4.3 **The workbook quality-control review has no feature** (Register B §12). The seven-step
      review in the delivered QC guide is the firm's actual process and nothing in `QE` covers it
- [ ] 4.4 **`RP - 0004` (firm-level analytics) has no row.** `BR - 0009`'s aggregated pass-reason
      analysis — the feedback the product list calls genuinely valuable to a brokerage — has no home
- [ ] 4.5 Decide whether **notifications**, **onboarding / invite flow**, **document versioning**, and
      an **internal admin console** become their own capabilities (Register B §1, §2, §3, §10). All
      four are now assumed by specified features that explicitly decline to build a local version;
      notifications alone is assumed by eleven
- [ ] 4.6 Confirm or reject the three-way Broker module split (`design.md` §D1) and the move of the
      deal team from `access-control` to `data-room`
- [ ] 4.7 Commission specification documents for the 39 features that have none — all of `BR`, all of
      `BY`, all of `PJ`, `BK - 0001`, `DR - 0005`, `DR - 0008`, `DB - 0010`, `RP - 0003`, and
      `VL - 0005` … `VL - 0010`. `VL - 0006` gates the rest of the valuation module and `VL - 0009`
      gates `BR - 0014`; those two are the ones to write first

## 5. Review (engineering)
- [ ] 5.1 Accept or reject moving `activity-log` early — it cannot be retrofitted (§D5.1). The
      in-flight `activity-log-capture` change already moves in this direction
- [ ] 5.2 Accept or reject moving `quickbooks` / `data-retrieve-wizard` earlier in the cutover order (§D5.2)
- [ ] 5.3 Schedule `e-signature` (§D5.3) — specified, unscheduled, and blocking four features
- [x] 5.4 ~~Resolve `DB - 0001` table structure~~ — now specified (Key Reports slots, explicit
      versions, active-version semantics, confirmed overwrite, generic parse at ingestion)
- [ ] 5.5 **Reconcile `DB - 0001` against the in-flight `reports-domain` change** (§D6) — both now
      define the key-report version lifecycle and they must not diverge
- [ ] 5.6 Resolve `DB - 0010` cross-module table sharing — the last undecided item in the data spine,
      and `DB - 0001` explicitly assumes it exists without designing it (Register B §5)
- [ ] 5.7 Decide whether `DB - 0004`'s destructive trial-balance recalculation is a deliberate
      exception to the platform-wide versioning convention (Register B §13)
- [ ] 5.8 Own the data retention policy four specifications are independently waiting on — `DR - 0004`'s
      destruction guarantee is legally load-bearing and currently rests on an undefined window
      (Register B §11)

## 6. Commercial / risk decisions (owners outside engineering)
- [ ] 6.1 Market and transaction data provider — largest recurring cost; `VL - 0003` and `VL - 0004`
      now specify against a provider-agnostic adapter, so the integration is decoupled from the
      contract, but neither feature exists until one is signed (Register B §6)
- [ ] 6.2 Valuation credentialing, compliance framework selection, and UPL exposure — `VL - 0006`
      selects between USPAP / SSVS / NACVA by engagement purpose and `VL - 0007` requires a statement
      of no contingent fee arrangement from a brokerage whose fee is contingent (Register B §7)
- [ ] 6.3 AI metering commercial model — `SY - 0004` now specifies full capture and explicitly no
      throttling, so exposure is measured and still unbounded across nine AI surfaces (Register B §9)

## 7. Wrap up
- [ ] 7.1 `openspec validate centuriuum-product-surface --strict` — the CLI is not installed in this
      worktree; artifact structure was checked by hand against the existing changes
- [x] 7.2 No code, schema, or runtime touched; `main` untouched; Conventional Commits
- [ ] 7.3 After review, open per-feature changes in the §D7 layer order. The 59 specified features can
      go straight to implementation changes; the 39 others need documents first (4.6)

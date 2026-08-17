This is a **specification-only change**. It adds no code, no schema, and no runtime behavior, so the
project rule requiring a vitest/supertest task per backend-behavior task does not apply — no task below
changes backend behavior. The per-feature changes this map produces each carry their own test tasks.

## 1. Capability specs (all 93 product-list features covered)
- [x] 1.1 Foundation: `access-control` (SE-0001/0002/0003), `activity-log` (SE-0004), `user-profiles` (US-0001…0005)
- [x] 1.2 Shared services: `platform-services` (SY-0001/0002/0003), `e-signature` (SY-0004)
- [x] 1.3 Data spine: `financial-data` (DB-0001…0010), `reports` (RP-0001…0003), `deal-qa` (QA-0001/0002)
- [x] 1.4 Analysis: `qoe` (QE-0001…0015), `projection-model` (PJ-0001…0005), `valuations` (VL-0001…0006)
- [x] 1.5 Documents: `data-room` (DR-0001…0006), `external-integrations` (DR-0007/0008), `cim` (CM-0001…0005)
- [x] 1.6 Process: `broker-workspace` (BR-0001…0006), `deal-marketing` (BR-0007…0011), `deal-execution` (BR-0012…0016)
- [x] 1.7 Counterparties: `buyer-workspace` (BY-0001…0007), `bank-portal` (BK-0001), `company-portal` (CP-0001/0002)

## 2. Cross-cutting analysis
- [x] 2.1 Gating capabilities (`design.md` §D4)
- [x] 2.2 Departures from `docs/MODERNIZATION_PLAN.md` §5 (§D5)
- [x] 2.6 Full capability dependency graph — 49 requires-edges, feed edges separated, acyclic,
      8-layer topological order, critical chain, blocked-by-missing (§D7). Corrected §D5's
      hand-grouped order in four places
- [x] 2.3 Register A — 15 dangling feature IDs with probable targets
- [x] 2.4 Register B — 9 contradictions and capability gaps, each with what it blocks
- [x] 2.5 DR-0003 carried to implementation fidelity as the separate `data-retrieve-wizard` change

## 3. Review (product — blocking on the decisions, not on this change merging)
- [ ] 3.1 Josh confirms or corrects Register A's ID mappings — clerical for the nine `BO`/`LO`/`IN` refs
- [ ] 3.2 **Decide the six referenced features that have no row**: `VL - 0007` (SBA output),
      `VL - 0008` (asset approach), `VL - 0009` (deal structure engine), `VL - 0010` (valuation version
      lock), `RP - 0004` (firm analytics), `QA - 0003` (diligence request list). `VL - 0009` is the
      most consequential — `BR - 0014` is not buildable without it
- [ ] 3.3 Decide whether notifications and document versioning become their own capabilities
      (Register B §2, §3) — both are assumed by features already specced, including the wizard
- [ ] 3.4 Confirm or reject the three-way Broker module split (`design.md` §D1)

## 4. Review (engineering)
- [ ] 4.1 Accept or reject moving `activity-log` early — it cannot be retrofitted (§D5.1)
- [ ] 4.2 Accept or reject moving `quickbooks` / `data-retrieve-wizard` earlier in the cutover order (§D5.2)
- [ ] 4.3 Resolve `DB - 0001` table structure — gates `financial-data` and the 39 features above it
- [ ] 4.4 Resolve `DB - 0010` cross-module table sharing — shapes the `financial-data` data model
- [ ] 4.5 Confirm the `reports` two-author overlap with the in-flight `reports-domain` change (§D6)

## 5. Commercial / risk decisions (owners outside engineering)
- [ ] 5.1 Market and transaction data provider — largest recurring cost; gates `VL - 0003`/`VL - 0004`
      and the sourcing features (Register B §6)
- [ ] 5.2 Valuation credentialing and UPL exposure on LOI templates — needs a risk owner (Register B §7)
- [ ] 5.3 AI metering model — unbounded cost exposure until decided (`SY - 0001`, Register B §9)

## 6. Wrap up
- [ ] 6.1 `openspec validate centuriuum-product-surface --strict` — the CLI is not installed in this
      worktree; artifact structure was checked by hand against the existing changes
- [x] 6.2 No code, schema, or runtime touched; `main` untouched; Conventional Commits
- [ ] 6.3 After review, open per-feature changes at `data-retrieve-wizard` fidelity in the §D7 layer order

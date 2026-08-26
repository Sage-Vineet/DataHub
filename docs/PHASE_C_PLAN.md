# Phase C — Production cutover, and the product foundation it unlocks

> Status: proposed · Owner: CTO / platform · Date: 2026-08-17
> Follows `docs/REARCH_LOG.md` §18 ("Next: Phase C onward").
> Product context: `openspec/changes/centuriuum-product-surface/` (capability map + dependency graph).

## 1. Where the program actually stands

**Migration side.** Nine domains are built, tested, and merged — auth, companies, users, folders,
uploads, requests, messages, the reports first slice, plus the gateway. §18 delivered the first working
cutover in the program: under compose, `BETTER_AUTH_ENABLED=true` had `/auth/login` answered by the
TypeScript module while `/api/auth/*` still proxied to legacy QBO. That is a real milestone, and it is
also the honest boundary of what has been proven: **it worked in compose, not in staging, and no domain
serves production traffic.** `auth-production-cutover` stands at 0/23. No legacy handler has been
deleted.

**Product side.** The surface map places all 93 features of the product list into 20 capabilities with
a 49-edge acyclic dependency graph (`design.md` §D7). Roughly 80% of the intended product does not
exist in any form.

**The problem this phase has to solve:** those two facts are usually treated as two programs competing
for the same people. For this phase specifically, they are not — see §2.

## 2. The collision, and why it resolves in our favour

Six of the eight foundation capabilities in the product graph (layers L0–L2) map onto domains that are
**already built and waiting to be cut over**:

| Product capability | Layer | Migration domain | State | So the work is… |
|---|---|---|---|---|
| `access-control` | L0 | companies · users · folders | built, never served | **cutover**, not build |
| `financial-data` | L1 | reports (first slice) + DB tables | slice built; `DB - 0001` undecided | cutover **+ one decision** |
| `data-room` | L2 | folders · uploads | built, never served | **cutover**, not build |
| `reports` | L2 | reports | slice built; GL engine on legacy | cutover, staged |
| `data-retrieve-wizard` | L3 | quickbooks | legacy only | build (spec is ready) |
| `platform-services` | L1 | — (partial) | not started | build |
| `activity-log` | L1 | **none** | not started | **greenfield** |
| `e-signature` | L1/L3 | **none** | not started | **greenfield** |

The implication is the plan: **Phase C buys migration progress and product foundation with the same
money**, provided we flip domains in the product graph's dependency order rather than an order chosen
only from the legacy code's shape. The two exceptions — `activity-log` and `e-signature` — have no
legacy equivalent, so they can be built greenfield in the new stack without competing for cutover
attention.

This is the concrete form of §D5's recommendation to amend the cutover order. It costs nothing to
adopt: the domains are already built.

## 3. Objectives

Phase C is done when:

1. **At least one domain serves production traffic through the gateway, and its legacy handlers are
   deleted.** Until a handler is deleted, the parallel rewrite is pure cost — double maintenance with
   none of the benefit. This is the phase's primary objective and the program's risk #1.
2. **The domains chosen to go first are the product graph's foundation** (`access-control`,
   `data-room`, `financial-data`), so cutover progress compounds into product capability.
3. **Activity-log capture has begun**, including for traffic still served by legacy (§6, risk 3).
4. **The four blocking product decisions are made, or explicitly deferred with a named owner and a
   record of what the deferral blocks.**

## 4. Workstreams

### C1 — Staging from a production snapshot *(blocks C2 and C3)*

- Seed staging from a production snapshot; run `db:pull`; reconcile the drift against
  `packages/db` and record the baseline.
- Verify `JWT_SECRET` parity between legacy and the module stack — a mismatch invalidates every
  session at flip time and would read as an auth outage.
- Resolve `backend/sql/schema.sql`: line 278 indexes `bank_transactions(client_id)`, a column the
  table does not declare, so the file does not apply to a clean database. Either fix it or retire it in
  favour of the Drizzle baseline — but stop carrying a schema file that cannot build the schema.
- **Exit:** staging boots from the snapshot; `/healthz` in-process and a proxied legacy health check
  both green; drift documented; flag parsing verified strict (a mistyped flag must fail the boot, not
  silently mean "off").

### C2 — Parity harness and the first flip: `auth`

- Build the parity harness once, as reusable infrastructure: replay a representative request set
  against legacy and module, diff status/shape/semantics, report per-endpoint.
- Work `auth-production-cutover` (0/23) against staging, then canary in production through the
  gateway.
- Soak, then **delete the legacy auth handlers**.
- **Exit:** auth served by the module in production for a green soak, legacy handlers deleted, rollback
  proven by exercising it once deliberately rather than assuming it.

### C3 — Flip the foundation domains, in product-graph order

Order follows §D7 layering, not the legacy code's shape:

1. `companies` → `users` → `folders` — this **is** `access-control` (L0), the capability with 12
   dependents.
2. `uploads` — completes `data-room` (L2), the capability with 6 dependents.
3. `reports` first slice — the beachhead for `financial-data` (L1); the GL engine stays behind
   `ReportSyncPort`.

Each domain: parity harness → canary → soak → **delete legacy handlers**. A domain is not done at the
flip; it is done at the deletion.

- **Exit:** three foundation capabilities served by modules with legacy deleted; `docs/REARCH_LOG.md`
  records each.

### C4 — Greenfield: `activity-log` capture

Built new in the module stack, so it carries no cutover risk and does not compete with C2/C3.

- **Capture first, surface later.** Ship authentication events, document events, and permission events
  (`SE - 0004`) with append-only, tamper-evident storage. Defer search, filtering, export, and anomaly
  alerting to a later change — they can be built over history, and history cannot be built later.
- Capture must cover traffic still served by legacy (§6, risk 3).
- **Exit:** the three event families are captured for both stacks; storage proven append-only by test;
  a documented retention policy exists.

### C5 — Product decisions *(parallel; costs decision-maker time, not engineering capacity)*

| Decision | Owner | Blocks | Note |
|---|---|---|---|
| `DB - 0001` table structure (with `DB - 0010` sharing model) | CTO + Josh | `financial-data` and the 39 features above it | Highest-leverage item on the list; C3.3 flips a domain that sits on this |
| Split `external-integrations`: payroll now, market data later | CTO | QoE add-back substantiation | Unblocks payroll without touching the cost decision |
| Do `notifications` and `document-versioning` become capabilities? | Josh | wizard FR-11/FR-14, four other features | Assumed by specs already written |
| Scope `VL - 0009` (deal structure engine) | Josh | `deal-execution`, `BR - 0014` | A modeling engine with no row; easiest thing on the list to underestimate |

Also standing, unchanged: market-data provider selection (recurring cost), valuation credentialing and
UPL exposure (needs a risk owner), AI metering model.

## 5. Sequencing

```
C1 staging + snapshot ──┬─> C2 parity harness + auth flip ──> C3 foundation domains ──> delete legacy
                        │
C4 activity-log capture ┘   (independent of C1; start immediately)

C5 product decisions        (parallel throughout; C5.1 must land before C3.3)
```

The only hard ordering constraints: C1 precedes C2 and C3; C5.1 (`DB - 0001`) precedes C3.3 (reports).
C4 depends on nothing and has the earliest-expiring value, so it starts first even though it is listed
fourth.

**No durations are given.** The product list carries `TBD` in every effort cell and I have no velocity
data for this team; inventing week counts here would be the least defensible content in the document.
Estimates should be attached by the people doing the work, against these exit criteria.

## 6. Risks

1. **The production snapshot carries real customer financial data and PII into staging.** Decide the
   handling rule before the snapshot is taken, not after: anonymize, or treat staging as production for
   access purposes. This is a decision, not a task.
2. **Flipping `reports` before `DB - 0001` is settled** means cutting a domain over and then reshaping
   its data model — paying the cutover cost twice. Hence the C5.1 → C3.3 constraint.
3. **`activity-log` built only in the new stack captures only new-stack traffic.** Most traffic will be
   legacy for most of this phase, so a log that ignores legacy leaves exactly the gap the capability
   exists to prevent. Capture must sit at the gateway or be written by both stacks. This is the single
   most consequential design decision in C4 and it is easy to miss.
4. **Double maintenance widens while domains sit built-but-unflipped.** This is the cost the phase
   exists to stop; every deferred deletion extends it.
5. **Deleting legacy handlers is irreversible in a way flag-flipping is not.** Deletion must follow a
   green soak and a deliberately exercised rollback, not a clean dashboard.
6. **Product decisions may arrive slower than engineering can absorb them.** C1–C4 are deliberately
   structured so that only C3.3 blocks on a decision.

## 7. Explicitly not in this phase

- **`quickbooks` / `extraction` cutover.** The wizard moves up the order (§D5.2) but still needs
  `financial-data` settled first; `data-retrieve-wizard` is specced and ready to build when it does.
- **Any L4+ capability** — `cim`, `deal-marketing`, `deal-execution`, `valuations`. They sit behind six
  layers of prerequisites; starting them now would be building on foundations that are still moving.
- **`frontend-ui-adoption`** (0/19) — unless a flip requires it.
- **Secrets rotation and history purge** (0/23) — CTO-owned, destructive, deferred by explicit decision.
- **`e-signature`** — greenfield and unblocked, but it competes for attention with C4 and is not on the
  critical path this phase.

## 8. OpenSpec changes this phase opens

- Existing: `auth-production-cutover` (0/23) → C2.
- New: **`staging-parity-harness`** (C1 + the reusable harness), **`activity-log-capture`** (C4),
  **`financial-data-foundation`** (C5.1's decision, written up as `DB - 0001`/`DB - 0010` at
  `data-retrieve-wizard` fidelity).
- Per-domain cutover changes for C3 follow the existing domain-change pattern.

## Why

Nine domains are built, tested, and merged. **None of them serves a production request.** Every domain
change ends `[~] deferred: needs a real environment (ops)`, `auth-production-cutover` stands at 0/23,
and no legacy handler has ever been deleted. §18 of `docs/REARCH_LOG.md` proved the cutover *mechanism*
works — under compose, with a hand-run checklist. What does not exist is the thing that makes a flip a
decision rather than a leap: **an environment holding production-shaped data, and a repeatable way to
show that the module answers a request the same way legacy does.**

Every per-domain cutover change writes its own parity checklist by hand (`auth-production-cutover`
task 4.3 is a prose list of six cases). That approach does not scale to nine domains, is not
re-runnable after a regression, and produces no artifact anyone can point at when deciding to delete
legacy code. Deleting a legacy handler is the only irreversible step in the whole program, and right
now it would be authorized by a checklist someone ticked once.

This change builds the environment and the tool, once, for every domain that follows.

**Cutover-order domain:** none in particular — this is **cutover platform** work (`docs/MODERNIZATION_PLAN.md`
§5), the shared mechanics behind every route-group flip. It is workstream C1 + C2's harness half in
`docs/PHASE_C_PLAN.md`.

## What Changes

- **Staging seeded from a production snapshot**, with a documented, enforced data-handling rule —
  including rewriting every email address at seed time, because a staging system holding real customer
  addresses and a live Graph emailer can send real mail to real customers.
- **Schema drift reconciled and recorded.** `db:pull` against the snapshot, diffed against
  `packages/db/src/schema.ts`, with the result committed as a baseline artifact rather than a one-off
  observation.
- **`backend/sql/schema.sql` resolved.** Line 278 indexes `bank_transactions(client_id)`, a column the
  table does not declare, so the file cannot build a clean database. Fix it or retire it in favour of
  the Drizzle baseline — but stop carrying a schema file that does not work.
- **The parity harness** — a runnable tool that replays a request set against legacy and against the
  module engine, compares them on status and normalized shape, and emits a per-endpoint verdict report.
  The request set is **derived from source** (reusing `route-contract.test.ts`'s legacy-surface
  derivation), not hand-listed, so it cannot quietly fall behind the routes it is meant to cover.
- **Safety rails:** the harness refuses to run against a production database, and mutating requests are
  opt-in and staging-only.
- **A rollback drill** — the flag-off path exercised deliberately once, not assumed from a clean
  dashboard.

## Capabilities

### New Capabilities
- `platform/cutover-parity`: the observable behavior of the parity harness and the staging environment
  it runs against — request-set derivation, comparison semantics, per-endpoint verdicts, divergence
  reporting, and the production-safety refusals.

## Impact

- **New code:** `apps/api/src/parity/*` (harness, comparator, report), a `parity` script in
  `apps/api/package.json`, seed/anonymization tooling for the snapshot, drift baseline artifact under
  `packages/db/`.
- **Changed code:** possibly `backend/sql/schema.sql` (fix or retire).
- **Data:** none in production. Staging is seeded from a snapshot; the anonymization rule is part of
  the seed path, not a manual step afterwards.
- **Runtime behavior:** unchanged. The harness is a tool; it adds no request-path code.
- **Legacy impact:** none directly — but this change is the precondition for deleting legacy handlers,
  which every domain cutover change depends on.
- **Branch:** `ba/product-surface-specs` off `ba/rearch`; `main` frozen.

## Non-goals

- **Flipping any domain.** This change makes flips decidable; `auth-production-cutover` and the
  per-domain changes do the flipping. The boundary is deliberate: a tool that also performs the cutover
  would couple the evidence to the action.
- **Re-specifying auth's parity cases.** `auth-production-cutover` tasks 3.2 and 4.3 already enumerate
  them; this change gives them a harness to run in and does not restate them.
- **Load, soak, or performance testing.** Parity is about *equivalence of response*, not throughput.
  Latency comparison is recorded as information, never as a pass/fail gate.
- **Automating the flip decision.** The harness reports; a person decides. A green report is necessary
  and not sufficient — the request set only covers what it covers, which is why coverage is reported
  alongside the verdicts.
- **Production observability/dashboards.** Separate concern, separate change.

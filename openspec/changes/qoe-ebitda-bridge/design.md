## Context

`QE - 0004` (SDE/EBITDA) is the spine of the QoE engagement: everything downstream — the CIM's
Adjusted EBITDA exhibit, the projection model, the valuation — reads the number this tab produces.
It sits entirely downstream of `financial-data`, which is one of the four capabilities
`openspec/product/design.md` §D4 identifies as gating the rest.

The source material for this change is the engagement workbook Josh Tonnesen walked the team through
on 5 May 2026, plus the 25 Jul 2026 database dump attached to the UAT thread. The workbook is the
specification of intent; the dump is what the system actually produced. Comparing them is what
established the two defects in the proposal, and the workbook's figures are now the acceptance bar.

## Goals / Non-Goals

**Goals.** A defensible Reported EBITDA and Adjusted EBITDA/SDE for any ingested engagement, with
every figure traceable to a ledger row and asserted against a known-correct workbook.

**Non-Goals.** The rest of the QoE surface, and the balance-sheet / trial-balance defects that do not
feed this calculation.

## Decisions

### D1 — A pure engine package, with a thin module over it

```
packages/financial-engine/     pure TS, zero I/O, golden tests
        ↑
apps/api/src/modules/qoe/      ports + service + router, behind QOE_MODULE_ENABLED
        ↑
apps/api/src/gateway.ts        modules mount ahead of the legacy proxy
```

The engine performs no I/O at all: callers load rows from wherever they live and hand them in. That is
what makes the golden suite the deliverable rather than a nicety — the arithmetic can be asserted
exhaustively without a database, and the same functions serve the HTTP path.

The module follows the eight existing `apps/api/src/modules/*` exactly. `/qoe` is a prefix legacy does
not define, so mounting it adds surface rather than shadowing anything, and the legacy
`/ebitda-adjustments` routes stay reachable as a rollback target.

### D2 — The engine derives net income; it never reads `profit_loss_entries`

Reported EBITDA begins at net income, and the extracted P&L is inverted (see the proposal). Rather
than block this change on the foundation fix, `income-statement.ts` computes the statement from
`general_ledger_entries` joined to `chart_of_accounts.statement_type`, applying the sign in exactly
one place.

This is not a shim. The sign cannot be inferred from the ledger amount — QuickBooks exports revenue
and expenses both positive — so it must come from the account's type, and an unclassified P&L account
is therefore a hard error (`UnclassifiedAccountError`) rather than a silent zero. When the foundation
change lands, it adopts this module rather than writing a second one.

### D3 — Classification is a stored flag, and absence means zero

`chart_of_accounts.ebitda_role` carries `interest_income | interest_expense | income_tax |
depreciation | amortization | owner_compensation`. An account with no role contributes nothing.

That default is the whole point. The bridge this replaces guessed from account names and, on real
data, guessed wrong in the expensive direction — inventing an income-tax add-back on a company that
has no income tax expense. A missing add-back is visible to a reviewer; an invented one is not. The
bridge therefore also returns `unflaggedAccounts` so what was skipped is disclosed rather than
discovered later in a workpaper review.

### D4 — `addback_kind` is a new axis, not a replacement for `type_key`

`ebitda_adjustment_types` seeds eight *categories* (`personal_expense`, `officer_compensation`, …).
`QE - 0004`'s four types — PNL Account/Vendor, Balance Sheet Change, Manual Adjustment, Recast — are a
*sourcing mechanism*, orthogonal to category. Modelling one as the other would make "an officer
compensation add-back sourced from the GL" inexpressible. Both are stored.

### D5 — The add-back tables are redesigned and the data migrated

The legacy `ebitda_adjustments` set (043/045) has the right bones — monthly values, vendor scope,
attachments, comments, audit log, soft delete — and the wrong shape: no sourcing kind, no data source,
no grouping, no granularity, no recast baseline, no Q&A citations. Seven bolted-on columns would leave
a table that reads as two designs stacked, so `qoe_addbacks` is a clean design with a data migration.

The per-kind rules are enforced in three places — the zod contract, the engine, and a CHECK
constraint — so no write path can bypass them. The migration derives `kind` from `is_manual` +
`linked_account_id`, and gives rows with no explanation a placeholder naming their origin rather than
dropping them: losing a reviewer's work silently is worse than an ugly note.

The `INSERT ... SELECT` is wrapped in dynamic SQL because `ebitda_adjustments` does not exist in a
database built from `packages/db` alone, and a plain statement would fail to *parse* there — which no
`WHERE` guard prevents.

### D6 — `general_ledger_entries.coa_id` is declared here, reconciling real drift

The bridge joins ledger rows to the chart of accounts on `coa_id`. That column exists in the deployed
UAT database — it appears in the 25 Jul 2026 dump alongside `split_coa_id`, `date_id` and
`entity_type` — but is created by **no migration in this repository**. The deployed schema has drifted
ahead of the migration set.

It is declared here with `IF NOT EXISTS`, which is a no-op where it already exists. The alternative,
joining on `account_name`, is not viable: UAT issue #4 reports duplicate account names, and a name
join silently merges distinct accounts.

The same investigation found the repo's column is `vendor_name` where the deployed database has
`vendor`/`customer`/`entity_type`. The migration set here is treated as authoritative and the Drizzle
model maps to it.

### D7 — Parity is the contract at the HTTP boundary

Three defects fixed in this change share one cause: the TypeScript modules returned *their* shape
rather than legacy's, and the SPA reads legacy's. The reports module now serializes to legacy's
camelCase envelope at the router, leaving the internal contract snake_case. The boundary is the right
seam — the internal shape is ours to choose, the wire shape is not.

## Risks / Trade-offs

- **The bridge sits on a foundation with known defects.** Net income is handled by D2; the
  balance-sheet and trial-balance defects do not feed `QE - 0004` but do feed `QE - 0001`/`QE - 0003`.
  The foundation change should land before tax reconciliation resumes.
- **`ebitda_role` starts empty on existing versions.** Until it is populated the bridge shows Reported
  EBITDA equal to net income and lists every P&L account as unflagged. That is the safe direction and
  it is disclosed on screen, but it needs a backfill before an engagement is worked.
- **The rewrite deletes ~3,300 lines of frontend that renders in UAT today.** It is behind
  `QOE_MODULE_ENABLED` and the legacy routes remain, but Josh is mid-UAT and should be told when to
  switch.
- **The fixture is anonymized real client data.** The generator asserts every year's revenue, expenses
  and net income before writing, so an anonymization mistake fails the build rather than producing a
  fixture that asserts fiction.

## Migration Plan

1. Apply `packages/db/migrations/0002_qoe_bridge.sql` (idempotent; carries legacy add-backs across).
2. Populate `chart_of_accounts.ebitda_role` for active versions.
3. Enable `QOE_MODULE_ENABLED`; the SPA's EBITDA tab reads `/qoe/bridge`.
4. Soak, then remove the legacy `/ebitda-adjustments` routes and `ebitda_adjustments*` tables.

Rollback is the flag plus `0002_qoe_bridge.down.sql`, both exercised.

## Open Questions

- Should `market_rate_replacement_salary` live on the company or the engagement? It is on the company
  today, matching `profit_metric`, but a broker may run two engagements with different assumptions.
- The `income_tax` role has no consumer on this engagement (the company has none). It is specified and
  tested but unexercised by real data.

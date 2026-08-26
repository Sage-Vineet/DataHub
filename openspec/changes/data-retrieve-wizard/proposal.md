## Why

`DR - 0003 Data Retrieve Wizard` (Josh Tonnesen, 2026-08-12) is the **primary on-ramp for financial
data into the platform**. Today a QoE or CIM engagement starts with the broker chasing the seller for
reports exported by hand, one at a time, in whatever shape the seller's accounting package emitted —
the most error-prone, highest-latency step in the whole engagement. The wizard replaces that with a
single action inside the Data Room: connect the source, pick a date range, and land a complete,
correctly-scoped, known-format report set in the reconciled data structure.

Everything downstream depends on it. `DB - 0002` (GL Data), `DB - 0003` (COA), `DB - 0004` (Trial
Balance) and the entire QoE/Reports surface are fed by whatever this wizard produces, so its output
contract — static, versioned, per-report files in the templated file tree — is load-bearing well
beyond the wizard itself.

**Cutover-order domain:** `quickbooks` (per `docs/MODERNIZATION_PLAN.md` §5), consuming `uploads`,
`folders`, and `reports`. The legacy codebase already carries a QuickBooks OAuth integration; this
change specifies the wizard behavior the rebuilt `quickbooks` module must honor, and the seams
(`ReportSourcePort`, `DesktopBackupParserPort`) that keep non-QBO sources additive.

## What Changes

- **New capability `data-retrieve-wizard`** — the observable behavior of the wizard: source choice,
  Intuit-hosted OAuth, date-range selection, key-report retrieval, per-report progress, partial-failure
  retry, versioned landing in the Data Room file tree, and completion notification.
- **`ReportSourcePort`** — the seam every source implements (`quickbooks-online`, `quickbooks-desktop`,
  later Xero/Sage). Adding a source SHALL NOT restructure the wizard entry flow (FR-2).
- **Extensible key-report registry** — the required report set is configuration, not a hardcoded list
  of ten (FR-5).
- **`DesktopBackupParserPort`** — the `.qbb` path's seam. This change ships the **upload + queue** half
  and an explicitly not-yet-implemented parser; extraction is a separate spike (see Open Questions).
- **Pull versioning** — each run is a new immutable version; re-runs never overwrite (FR-11).
- **Connection credential store** — Intuit OAuth tokens scoped per company connection, held outside
  the `DB` module and never exposed through any read API.

## Capabilities

### New Capabilities
- `data-retrieve-wizard`: launch-gated wizard that pulls a configured key-report set from a connected
  source into the Data Room as static, versioned files, with per-report progress, partial-failure
  retry, and completion notification.

### Modified Capabilities
- `data-room`: gains the "Retrieve Reports" entry point and the auto-created Key Reports subfolder.
- `financial-data`: gains the wizard as the primary write path feeding GL / COA / Trial Balance.

## Impact

- **New code:** `apps/api/src/modules/quickbooks/*` (wizard orchestration, `ReportSourcePort`, QBO
  adapter, connection store), `packages/contracts` (wizard/pull schemas), `packages/db` (`data_pulls`,
  `data_pull_reports`, `source_connections`), `apps/web` wizard flow.
- **Data:** new pull/version tables; retrieved reports land in existing Data Room file storage.
- **Legacy impact:** the legacy QuickBooks OAuth routes stay live behind the gateway until the
  `quickbooks` route-group is flipped; rollback is the flag.
- **Branch:** `ba/product-surface-specs` off `ba/rearch`; `main` remains frozen.

## Non-goals

- **Live/ongoing sync with QuickBooks Online.** Point-in-time pull only — explicitly not a live
  financial data connection (§8 of the source spec). The absence of a standing connection is a
  *feature*: the analysis cannot shift under a reviewer mid-engagement.
- **`.qbb` parsing itself.** Extracting the report set from a QuickBooks Desktop backup is a separate
  technical effort needing its own spike and spec; this change specifies the upload path and the port,
  and the Desktop path stays behind a flag until the parser lands.
- **Sources beyond QBO and QB Desktop** (Xero, Sage) — the architecture must allow them; they are not
  built here.
- **Any validation, reconciliation, or analysis of the retrieved reports** — that is `DB - 0005`
  (Validations) and the QoE surface, not the wizard.
- **Mobile.** Web only (§6).

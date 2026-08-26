## Context

See `proposal.md`. `DR - 0003` arrives as a written feature spec with two paths (QBO API, QB Desktop
backup) at very different readiness levels: the QBO path is "Ready for Dev", the Desktop path is
blocked on a parsing engine that has not been specced or spiked. It also depends on two capabilities
the source spec itself flags as cross-cutting gaps — document versioning and a notifications hub.

The legacy codebase already carries a QuickBooks OAuth integration and file storage; `uploads` and
`folders` have been cut over to modules, and `reports` has its version lifecycle migrated. So the
wizard is mostly **orchestration over capabilities that exist**, plus one genuinely new thing (the
pull/version record) and one genuinely unknown thing (`.qbb` extraction).

## Goals / Non-Goals

**Goals:** one authorization-gated flow that lands a complete key-report set as static versioned files
in the templated tree; per-report progress and selective retry; strict per-deal isolation of
connections and output; a source seam that makes Xero/Sage additive.

**Non-Goals:** live sync; `.qbb` parsing; sources beyond QBO/Desktop; any validation or reconciliation
of retrieved data (that is `DB - 0005`); mobile.

## Decisions

### D1 — `ReportSourcePort` is the only thing the wizard talks to

The wizard orchestrator never references QuickBooks. It resolves a `ReportSourcePort` from a registry
keyed by source id and calls a uniform surface: `authorize()`, `supportedRange()`, `listReports()`,
`fetchReport(reportKey, range)`. The QBO adapter implements it over the Intuit API; the Desktop adapter
implements it over `DesktopBackupParserPort`. This is what makes FR-2's "additional sources without
restructuring the entry flow" true in practice rather than aspirationally — the flow is written once
against the port.

**Consequence:** a source that cannot support a step (Desktop has no OAuth) declares that in its
descriptor and the wizard renders the step it does support (file upload) in the same slot.

### D2 — The key-report set is a registry row, not a constant

FR-5 is explicit that the list is "intentionally extensible, not hardcoded to 10". Each entry is
`{ key, displayName, sourceReportId per source, required, order }`. A pull snapshots the registry it
ran against into `data_pull_reports`, so a later registry change never rewrites the history of an
earlier pull, and the completion summary of an old version stays accurate.

**Trade-off:** snapshotting duplicates report metadata per pull. That is the point — pulls are
evidentiary records in an engagement, and a report set that silently changes retroactively would
undermine every downstream QoE artifact.

### D3 — A pull is a versioned aggregate; the file writes are its children

`data_pulls` (id, company_id, source, date_range, status, initiated_by, started_at, completed_at,
version_number) with `data_pull_reports` (pull_id, report_key, status, file_id, error, attempts).
Per-report rows are what make FR-12 progress and FR-13 selective retry falsifiable: progress is a count
over the children, retry re-runs only children in `failed`, and a successful retry mutates the child
rather than creating a sibling pull.

**Versioning:** `version_number` is per company, assigned at create — the same auto-numbering shape
already used by `key_report_versions` in the `reports` module. FR-11 is then a property of the write
path (append a new pull) rather than a behavior anyone can forget to implement.

### D4 — Files are written only after the report is in hand

A report's file is written to the Data Room on successful fetch of *that* report, not in a batch at the
end. A pull that fails halfway therefore leaves the succeeded reports usable — which is what FR-13
promises — and the retry path has nothing to clean up. The destination subfolder is resolved (creating
it if absent) once, at pull start, through the `folders` module so the templated structure of
`DR - 0002` stays the single authority on tree shape.

### D5 — Connection credentials live outside the financial data path

`source_connections` holds the Intuit token set encrypted at rest, keyed by `(company_id, source)`, and
is reachable only by the source adapters. No serializer for it is exposed; the wizard's connection API
returns `{ status, connectedAt, realmDisplayName }` and nothing else. §5 of the source spec and AC-6
both hinge on this, and the cheapest way to guarantee "never visible in Centuriuum" is to have no read
path that could ever return it.

### D6 — Per-deal isolation is enforced at the repository, not the UI

Every query in the module takes `company_id` from the authorized session context, not from the request
body. A connection for company A is unreachable from company B because the lookup key includes the
company — there is no code path that could return it, so the isolation claim in §5 does not depend on
a caller remembering to filter.

### D7 — The Desktop path ships behind its own flag and fails loudly

`DESKTOP_SOURCE_ENABLED` defaults off. With the flag off the source is listed but disabled with a
reason (D1's descriptor); with the flag on and no parser bound, a submitted pull records
`awaiting_processing` and surfaces that state. What we will not do is write placeholder files or report
success — a half-populated Key Reports folder is worse than an obviously pending one, because
everything downstream treats those files as authoritative.

### D8 — Notifications and checklist marking go through ports, not direct writes

FR-14 depends on a notifications hub that does not exist yet as its own feature. The wizard emits a
`pull.completed` event and calls `NotificationPort` / `ChecklistPort`; both have no-op-with-log
implementations until the hub and Deal Tracker land. The pull completes and the files are correct
either way — the notification is not on the critical path.

## Risks / Trade-offs

- **The Desktop path may stay dark for a long time.** `.qbb` is a proprietary backup format; the
  realistic options are a QB Desktop-compatible library, an intermediary conversion service, or
  requiring the user to export a supported format instead. Mitigation: D1/D7 keep the wizard shippable
  and honest with only the QBO path live. The spike is a hard prerequisite to promising this path to a
  customer.
- **Intuit API rate limits and long-running pulls.** Eight-plus reports over a multi-year range can
  exceed a request lifetime. Mitigation: the pull is a background job from the start (D3 makes progress
  observable), not a synchronous request that we later have to convert.
- **Token expiry mid-pull.** Intuit refresh tokens expire; a re-run months later may find a dead
  connection. Mitigation: the pull's first act is a connection health check that routes the user back
  to re-authorize rather than failing report-by-report.
- **Unbounded version retention.** Every re-run is a full report set retained forever (open question
  below). Storage grows linearly with re-runs per company. Mitigation: retention policy is a decision
  we can defer safely because pulls are cheap to enumerate and delete later; deciding wrong now is
  harder to undo than deciding late.
- **The wizard is the single point of truth for downstream financial data.** A silent partial success
  would corrupt every QoE artifact built on it. Mitigation: FR-13's per-report status is mandatory, not
  cosmetic — the completion summary is the contract.

## Migration Plan

1. Contracts + `packages/db`: `source_connections`, `data_pulls`, `data_pull_reports`, key-report
   registry; reconcile via `db:pull`.
2. `ReportSourcePort` + registry + QBO adapter over the Intuit API; connection store with encryption
   at rest; connection health check.
3. Pull orchestrator as a background job: resolve destination folder, snapshot the registry, fetch
   per report, write file on success, record status per child.
4. Router + wizard endpoints (start, connection status, confirm range, progress, retry, summary);
   tenant guard via `canAccessCompany` **plus** the upload-permission check of FR-1.
5. Web wizard: the six steps of §6, progress view polling the pull, completion summary.
6. Desktop path: upload acceptance + `DesktopBackupParserPort` stub behind `DESKTOP_SOURCE_ENABLED`.
7. Mount behind `QUICKBOOKS_MODULE_ENABLED`; soak against a sandbox Intuit company; retire the legacy
   QuickBooks OAuth routes after a green soak.
- **Rollback:** flag off → legacy serves the QuickBooks route-group; pulls already written are files in
  the Data Room and remain readable.

## Open Questions

Carried from §9 of the source spec, plus two the design surfaces. These are decisions for Josh /
product, not blockers on starting the QBO path.

1. **`.qbb` extraction approach** — QB-compatible parsing library, intermediary conversion service, or
   redirect the user to a different export format? Needs its own technical spike before the Desktop
   path can be committed to a customer. *(blocks the Desktop path only)*
2. **Version retention** — is there a cap on retained pulls per company, or unlimited? Affects storage
   policy, not the write path.
3. **Partial-failure gating** — may a user proceed with QoE/CIM work on the reports that succeeded, or
   is the engagement gated until the full set is retrieved? The spec as written assumes *proceed*;
   confirm. *(affects `DB - 0005` and the Deal Tracker, not the wizard's own behavior)*
4. **Full key-report list at launch** — the seven named plus AR/AP Aging Summary vs Detail as separate
   reports; is Statement of Cash Flows required at launch? D2 makes this cheap to change, so it need
   not block build.
5. **Which QBO report variants** — GL and Aging reports have accrual/cash and summary/detail variants;
   a QoE needs a specific one. Unspecified in the source doc.
6. **Multi-entity QBO realms** — if a seller's Intuit login exposes several companies, does the wizard
   let the user pick the realm, and is one realm per company/deal enforced? §5's isolation rule implies
   yes, but the selection step is not specified.

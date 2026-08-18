## Context

See `proposal.md`. Legacy `requestService.js` validates + normalizes requests (category/response-
type/priority/status enums, future due-date, submission source, approval), derives reminder
frequency from priority, supports bulk create, approval, per-request narrative (1:1), reminder
events, and links documents to requests. We keep behavior and drop the Supabase/`pg` dual path.

## Goals / Non-Goals

**Goals:** parity for the request endpoints; validation + reminder-frequency + approval rules in one
typed place; tenant scoping via the shared guard.

**Non-Goals:** reminder delivery (email/cron); documents/messages; changing the enum sets.

## Decisions

### D1 — Blueprint + shared guard
`modules/requests/` follows the domain blueprint and uses `requireSession` + `canAccessCompany`.
A request's company is on the row, so read/update/delete guard against `request.company_id`; the
company-scoped list/create guard against the path `:companyId`.

### D2 — Validation + normalization in the contract + service
zod enforces the enum sets, required fields, and `due_date` format. The service applies the
priority→reminder-frequency default (critical/high→1, medium→2, low→7, explicit override honored),
derives `approved_by`/`approved_at` when `approval_status = approved`, and enforces a future due
date on create (parity), with an `allow_past` escape for bulk/imports.

### D3 — Narrative is 1:1, reminders + request-documents are 1:N
`request_narratives` has a unique `request_id` (upsert on update). `request_reminders` appends an
event `(request_id, sent_by, sent_at)`. `request_documents` links a `document_id` with a `visible`
flag. All cascade when the request is deleted (existing FKs).

### D4 — Drop the dual path
Drizzle only; the legacy circuit-breaker/`pg`-fallback is not ported (ADR-0002).

## Risks / Trade-offs

- **Enum drift vs prod** → the contract enums mirror legacy constants; reconcile via `db:pull`.
- **Bulk create partial failure** → validate all items first; insert in one transaction so a bad
  item fails the batch cleanly (parity-safe).
- **Reminder delivery out of scope** → the module is the source of truth for frequency + events; a
  sender consumes it later.

## Migration Plan

1. Contracts + `packages/db` (`requests` full, `request_reminders`, `request_narratives`,
   `request_documents`); reconcile via `db:pull`.
2. Repository (Drizzle + in-memory): CRUD, bulk, approve, reminders, narrative upsert, doc links.
3. Service (validation/normalization/approval/reminder-frequency) + router; tests ≥90%.
4. Mount behind `REQUESTS_MODULE_ENABLED`; soak; delete legacy request handlers.
- **Rollback:** flag off → legacy serves the routes.

## Open Questions

- Confirm the `requests` extra columns (`reminder_frequency_days`, `submission_source`,
  `approval_status`, `approved_by`, `approved_at`) exist in prod via `db:pull` before cutover.

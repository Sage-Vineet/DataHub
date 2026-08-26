## Why

`requests` is the broker↔client work-item domain: a company's document/narrative requests with
priority-driven reminders, an approval flow, and links to the documents that fulfil them. It sits
alongside `uploads` in the cutover order and consolidates the request rules (validation, reminder
frequency, approval) in one typed place.

**Cutover-order domain:** `requests` (per `docs/MODERNIZATION_PLAN.md` §5, with uploads/messages).

## What Changes

- **`packages/contracts`** — zod schemas + enums for request create/update/bulk, narrative update,
  reminder, and the request + reminder responses; the priority→reminder-frequency helper.
- **`packages/db`** — model `requests` (full columns incl. reminder frequency + approval), plus
  `request_reminders`, `request_narratives`, and `request_documents`.
- **`apps/api/src/modules/requests`** — router + service + repository (Drizzle + in-memory) +
  contract + tests. Ports the endpoints and rules: list-by-company, get, create (+ bulk), update,
  approve, delete, reminders, narrative get/update, request-document link/list.
- **Cross-domain via ports** — none new; the request row carries `company_id`, so tenant scoping
  reuses the shared `canAccessCompany`.
- **Gateway cutover** — flip the request routes behind `REQUESTS_MODULE_ENABLED`; instant rollback.

## Capabilities

### New Capabilities
- `requests`: broker↔client requests as observable behavior — tenant-scoped list/get, validated
  create (single + bulk) with priority-driven reminder frequency, update, approval, delete,
  reminder events, per-request narrative, and links to fulfilling documents.

## Impact

- **New code:** `packages/contracts` (request schemas), `packages/db` (`requests` full + reminders/
  narratives/request_documents), `apps/api/src/modules/requests/*`, gateway routing entry.
- **Data:** same Postgres via Drizzle — no migration.
- **Runtime behavior:** unchanged request contracts; the Supabase-vs-`pg` dual path is dropped.
- **Branch:** `ba/rearch`; `main` frozen. Legacy request handlers retired after a green soak.

## Non-goals

- **Reminder *delivery*** (email/cron) — the module records reminder events + frequency; the sender
  is a later concern.
- **companies/users/uploads** — separate changes; referenced via existing FKs.
- No frontend changes (see `frontend-ui-adoption`).

## Why

`uploads` is the next Phase 2 domain after the core trio (companies → users → folders). It
owns file storage and the **documents** that hang off folders — the routes deliberately
left on legacy when `folders` migrated. Everything downstream (requests, reports,
QuickBooks, extraction) attaches documents, so this unblocks the second half of Phase 2.

**Cutover-order domain:** `uploads / documents` (per `docs/MODERNIZATION_PLAN.md` §5, after
folders).

## What Changes

- **`packages/contracts`** — zod schemas for document create/list and the upload +
  document response shapes; a document-activity event.
- **`packages/db`** — model `uploads` (blob as `bytea`), `documents` (folder-scoped
  metadata), and `document_activity`.
- **`apps/api/src/modules/uploads`** — router + service + repository (Drizzle + in-memory) +
  a **`StoragePort`** + contract + tests. Ports the upload + document + activity endpoints
  and rules: store/stream a blob, add/list/delete documents under a folder, archive, and
  record/read activity.
- **Drop the Supabase-Storage dependency** for the common path: blobs are stored as `bytea`
  in Postgres behind `StoragePort`, so an object-store (S3/GCS) adapter can swap in later
  with no contract change (ADR-0002 direction).
- **Cross-domain via ports** — a `FolderRefPort` resolves a folder's `company_id` for the
  tenant guard (reuses the shared `canAccessCompany`).
- **Gateway cutover** — flip the upload + document + document-activity routes behind
  `UPLOADS_MODULE_ENABLED`; folders keeps its own routes.

## Capabilities

### New Capabilities
- `uploads`: file storage and folder documents as observable behavior — store/stream a blob,
  tenant-scoped document add/list/delete under a folder, soft-delete archiving, and a
  document-activity log.

## Impact

- **New code:** `packages/contracts` (upload/document schemas), `packages/db` (`uploads`,
  `documents`, `document_activity`), `apps/api/src/modules/uploads/*`, `StoragePort` +
  `FolderRefPort` adapters, gateway routing entry.
- **Data:** same Postgres via Drizzle — no migration of existing rows.
- **Runtime behavior:** unchanged document/upload contracts; the Supabase-vs-`pg` dual path
  and the Supabase-Storage large-file branch are dropped (single typed `bytea` path).
- **Branch:** `ba/rearch`; `main` frozen. Legacy upload/document handlers retired after a
  green soak.

## Non-goals

- **Manual-GL upload sessions / orchestration** (`manualGlUpload*`) — that belongs to the
  later `reports`/`quickbooks` phases; only generic uploads + folder documents migrate now.
- **Object-store backend** (S3/GCS) — deferred behind `StoragePort`; the `bytea` adapter
  ships now.
- **requests / messages** — separate changes; documents are referenced there via existing FKs.
- No frontend changes (see `frontend-ui-adoption`).

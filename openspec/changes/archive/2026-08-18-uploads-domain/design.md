## Context

See `proposal.md`. Legacy stores blobs in the `uploads` table as `bytea` for small files and
in Supabase Storage for large ones (a hybrid in `controllers/uploads.js`), with `documents`
holding folder-scoped metadata (`file_url`, `upload_id`, `size`, `ext`, `status`). Document
routes were left on legacy when `folders` migrated. We keep the observable behavior, drop the
Supabase path, and abstract storage behind a port.

## Goals / Non-Goals

**Goals:** parity for upload + document + document-activity endpoints; a single typed
`bytea` storage path behind a swappable `StoragePort`; tenant scoping via the shared guard.

**Non-Goals:** manual-GL upload orchestration; an object-store backend; requests/messages.

## Decisions

### D1 — Blueprint + shared guards
`modules/uploads/` follows the `folders`/`companies` blueprint and uses `requireSession`
(Better Auth) + `canAccessCompany`. A document's company is resolved from its folder via a
`FolderRefPort`, then guarded.

### D2 — `StoragePort` with a `bytea`-in-Postgres adapter
`StoragePort.put(bytes, meta) → uploadId` and `StoragePort.get(uploadId) → {bytes, contentType,
fileName}`. The shipped adapter stores blobs in the `uploads.data bytea` column via Drizzle —
dropping the Supabase-Storage large-file branch (ADR-0002). An S3/GCS adapter can implement the
same port later with no contract change.

### D3 — Documents are folder-scoped metadata
`documents` rows reference `company_id` + `folder_id` + `upload_id`. Add/list/delete run under
the folder's tenant guard. Delete is a hard delete (parity); archive/unarchive set/clear
`archived_at` (soft delete), mirroring folders.

### D4 — Upload then attach
`POST /uploads` stores a blob and returns an `upload_id`; `POST /folders/:id/documents`
creates the document metadata referencing it. `GET /uploads/:id/content` streams the bytes
back with the stored content-type. This two-step matches the legacy SPA flow.

### D5 — Document activity is an append-only log
`document_activity` records `(document_id, actor_id, action, at)`. `POST /documents/:id/activity`
appends; `GET /documents/:id/activity` reads. Enough for parity; richer analytics is later.

## Risks / Trade-offs

- **Large blobs in `bytea`** → fine for the current file sizes; the `StoragePort` seam means we
  move to an object store without touching callers when size demands it. Note the trade-off.
- **Streaming** → `GET /uploads/:id/content` reads the row and streams the buffer; acceptable at
  current scale (the gateway already streams).
- **Cross-domain folder lookup** → `FolderRefPort` keeps the boundary explicit; back it with a
  direct read now, swap to the folders service later.

## Migration Plan

1. Contracts + `packages/db` (`uploads`, `documents`, `document_activity`); reconcile via `db:pull`.
2. `StoragePort` (`bytea` adapter) + `FolderRefPort`.
3. Repository (Drizzle + in-memory): upload put/get, document CRUD + archive, activity append/list.
4. Service + router (upload + document + activity endpoints); tests ≥90% incl. store→stream round-trip.
5. Mount behind `UPLOADS_MODULE_ENABLED`; soak; delete legacy upload/document handlers.
- **Rollback:** flag off → legacy serves the routes.

## Open Questions

- Confirm the `uploads.data` column is `bytea` in prod (`db:pull`) and the max size policy before
  retiring the Supabase-Storage branch.

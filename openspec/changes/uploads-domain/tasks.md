## 1. Contracts

- [x] 1.1 zod schemas (`packages/contracts/uploads.ts`): documentCreate, documentListQuery, uploadResponse, documentResponse, documentActivity event
- [x] 1.2 Contract tests

## 2. Data layer

- [x] 2.1 Model `uploads` (`data bytea`), `documents` (folder-scoped metadata), `document_activity` in `packages/db`
- [x] 2.2 Schema test asserts the columns

## 3. Ports & storage

- [x] 3.1 `StoragePort.put/get` + a `bytea`-in-Postgres adapter (drops the Supabase-Storage branch, D2)
- [x] 3.2 `FolderRefPort.companyIdFor(folderId)` — resolves the tenant for the guard (D1)

## 4. Repository (Drizzle + in-memory)

- [x] 4.1 uploads: insert blob, fetch blob; documents: create, listByFolder, getById, delete, setArchived
- [x] 4.2 document_activity: append, listByDocument
- [x] 4.3 In-memory adapter mirrors it all

## 5. Service

- [x] 5.1 storeUpload (via StoragePort) + getUploadContent
- [x] 5.2 addDocument (folder tenant guard) / listDocuments / deleteDocument / archive / unarchive
- [x] 5.3 recordActivity / listActivity (tenant-guarded via the document's folder)

## 6. Router

- [x] 6.1 `POST /uploads` (raw body), `GET /uploads/:id/content` (stream)
- [x] 6.2 `GET/POST /folders/:id/documents`, `DELETE /documents/:id`, `POST /documents/:id/archive|unarchive`
- [x] 6.3 `GET/POST /documents/:id/activity`; helmet + pino scoped; shared `requireAuth`

## 7. Tests (≥90% on the module)

- [x] 7.1 Upload store → stream round-trip (bytes + content-type preserved), real Postgres
- [x] 7.2 Document add/list/delete/archive under a folder; tenant denial (cross-company)
- [x] 7.3 Activity append/list; document delete cascades activity
- [x] 7.4 Contract validation (400) on malformed document create

## 8. Gateway cutover

- [x] 8.1 Mount upload + document + activity routes behind `UPLOADS_MODULE_ENABLED` (off → legacy); document the flag

## 9. Cutover & retire

- [~] 9.1 Enable in staging; parity checklist vs the real DB (upload, download, add/list/delete document, archive, activity)
- [~] 9.2 After a green soak, delete legacy `uploads`/`documents` handlers (leave manual-GL upload sessions on legacy)

## 10. Wrap up

- [x] 10.1 `openspec validate uploads-domain --strict` passes
- [x] 10.2 typecheck + lint + test green; module coverage ≥90%
- [x] 10.3 `main` untouched; Conventional Commits; update `docs/REARCH_LOG.md`

## Notes

- Riskiest: the store→stream round-trip through `bytea` (7.1) and the folder tenant guard on
  documents (7.2). Test both against real Postgres.
- Manual-GL upload sessions/orchestration stay on legacy (reports/quickbooks phases).

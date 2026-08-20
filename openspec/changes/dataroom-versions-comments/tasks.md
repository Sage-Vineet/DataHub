## 1. Contracts

- [x] 1.1 `packages/contracts/src/dataroom.ts` — `documentVersion`, `documentVersionList`,
      `commentCreate` (body + visibility), `commentResponse`, `uploadSessionCreate`,
      `uploadSessionStatus` (status + received chunk indices), `uploadSessionComplete`
- [x] 1.2 Re-export from `packages/contracts/src/index.ts` as `export * as dataroom` plus flat types,
      matching the existing block style
- [x] 1.3 `dataroom.test.ts` — snake_case wire shape, visibility enum rejects unknown values,
      chunk size and index bounds are enforced by the schema not the handler

## 2. Data layer

- [x] 2.1 `packages/db/migrations/0003_dataroom_qa.sql` (shared with `deal-qa-module`) —
      `document_versions`, `document_comments`, `upload_sessions`, `upload_chunks`; every statement
      `IF NOT EXISTS`
- [x] 2.2 Two additive columns: `documents.current_version_id`, `documents.version_count` — both
      `IF NOT EXISTS`, both defaulted, no FK on `current_version_id` (see `design.md` D1)
- [x] 2.3 Backfill a v1 `document_versions` row for every existing document with an `upload_id`, so
      no version list is ever empty
- [x] 2.4 `0003_dataroom_qa.down.sql`
- [x] 2.5 Drizzle declarations in `packages/db/src/schema.ts`; assertions in `schema.test.ts`
- [x] 2.6 Confirm `packages/db/src/drift.ts` records no *new* breaking drift

## 3. Module scaffold

- [x] 3.1 `apps/api/src/modules/dataroom/{ports,service,repository.drizzle,repository.memory,router,index}.ts`
      per `CONTRIBUTING.md` §4, using `apps/api/src/modules/companies/` as the reference
- [x] 3.2 Mount at `"/"` in `apps/api/src/server.ts` under `DATAROOM_MODULE_ENABLED`, with every
      route written as `/dataroom/...`
- [x] 3.3 **Do NOT add `dataroom` to `moduleSurfaces()`** in `apps/api/src/parity/routes.ts`; add a
      comment there recording why (see `design.md` D5)
- [x] 3.4 `withCommonMiddleware(router, [helmet(), pinoHttp(), express.json(), requireAuth])` —
      per route, never `router.use()`
- [x] 3.5 Vitest: `route-contract.test.ts` still green; `tools/parity/route-surface.json` unchanged

## 4. Versioning

- [x] 4.1 `GET /dataroom/documents/:id/versions`
- [x] 4.2 `GET /dataroom/versions/:versionId/content` — streams via the existing `StoragePort`
- [x] 4.3 `POST /dataroom/documents/:id/versions/:versionId/restore` — appends a version copying the
      prior `upload_id`; never mutates or deletes history
- [x] 4.4 Version numbering is server-assigned and gap-free per document
- [x] 4.5 Vitest (service, in-memory repo): append, list ordering, restore appends rather than
      rewrites, version numbers do not collide under concurrent append
- [x] 4.6 Integration test (PGlite, hand-written DDL per
      `uploads.integration.test.ts:12-43`): re-upload → v2 → v1 still readable → restore → v3

## 5. Comments

- [x] 5.1 `GET /dataroom/documents/:id/comments` — **internal comments filtered in the repository**,
      not the component
- [x] 5.2 `POST /dataroom/documents/:id/comments`, `DELETE /dataroom/comments/:id` (soft delete)
- [x] 5.3 `parent_id` ships on the table; no threading UI (see proposal Non-goals)
- [x] 5.4 Vitest: a non-broker role cannot read an internal comment **through the API**, not merely
      in the UI; shared comments are returned to anyone with document access

## 6. Chunked upload

- [x] 6.1 `POST /dataroom/uploads/sessions` — clamps chunk size to 1–8 MB; `document_id` on the
      session means "this is a new version of that document"
- [x] 6.2 `GET /dataroom/uploads/sessions/:id` — returns status and received chunk indices (resume)
- [x] 6.3 `PUT /dataroom/uploads/sessions/:id/chunks/:index` — raw body via the per-route
      `bodyForRoute` pattern copied from `apps/api/src/modules/uploads/router.ts:34-41`;
      `ON CONFLICT (session_id, chunk_index) DO UPDATE`
- [x] 6.4 `POST /dataroom/uploads/sessions/:id/complete` — single-statement `string_agg` assembly,
      chunk delete, version insert, document repoint, session close; one transaction
- [x] 6.5 `DELETE /dataroom/uploads/sessions/:id`; lazy expiry sweep on session-create
- [x] 6.6 `ChunkedStoragePort` implemented as `DrizzleChunkedStoragePort` in the **dataroom**
      module rather than beside `ByteaStoragePort` in uploads. It writes an `uploads` row and
      nothing else, so putting it in uploads would have meant editing a shipped, parity-tested
      module for no gain — the port belongs with the capability that needs it
- [x] 6.7 Vitest: chunk idempotency, out-of-order arrival assembles correctly, missing chunk blocks
      completion, expiry sweep reclaims
- [x] 6.8 Integration test: 3-chunk upload assembles to byte-identical content (proves `string_agg`
      over `bytea` on the real path)

## 7. Access control on the new endpoints

- [x] 7.1 `canAccessCompany` on every new route (`apps/api/src/shared/access.ts`)
- [x] 7.2 Folder grant predicate applied to the new document-scoped reads only — zero-regression
      because nothing depends on their prior behaviour
- [x] 7.3 Vitest: cross-tenant document version, comment and session requests are all refused

## 8. Frontend

- [x] 8.1 `apps/web/src/lib/api.js` — version, comment and session wrappers appended in the style of
      the folder block at lines 1353-1417, copying `uploadFile`'s auth/header handling verbatim
      rather than abstracting it
- [x] 8.2 `uploadFileChunked(file, {fileName, folderId, documentId, onProgress})` orchestrator;
      at most 3 chunks in flight, one file at a time
- [x] 8.3 `fileExplorerStore.js` `uploadFiles` (line 473) — swap **only** the `uploadFile` call for
      the chunked path above an 8 MB threshold; leave `createFolderDocument`, the `fileNode`
      construction and the `insertChild` tree update untouched (the chunked path returns the same
      `{id, fileUrl}` shape)
- [x] 8.4 Replace the `(copy)` rename at lines 485-491 with a version when the feature is on;
      **keep the `(copy)` branch verbatim as the flag-off fallback**
- [x] 8.5 Extend `uploadProgress` to carry bytes and render a real progress bar
- [x] 8.6 `DocumentVersionsPanel.jsx`, `DocumentCommentsPanel.jsx`, `DocumentDetailDrawer.jsx`
      (tabs: Preview / Versions / Comments / Activity) — opened from the existing `FileActionMenu`
      (`FileExplorer.jsx:1265`). **Leave the existing activity modal mounted** so nothing regresses
      if the drawer is cut
- [x] 8.7 Each new panel returns null when its feature flag is off (`useFeature` from
      `demo-platform-hardening`) — never an empty tab
- [x] 8.8 iPad: an always-visible Upload button in `TopBar` (`FileExplorer.jsx:531`) wired to a
      hidden file input — **drag-and-drop never fires for files on iOS Safari**, so this is the only
      upload path there. Lift the existing `handleSidebarUpload` (lines 411-415) to the toolbar
- [ ] 8.9 iPad: 44px minimum tap targets on `IconTooltipButton` (282), `FolderActionMenu` (1202),
      `FileActionMenu` (1265); force grid view below `lg`; `100dvh` on the preview modal; a visible
      Open/Download beside the PDF iframe as an escape hatch

## 9. Demo verification

- [x] 9.1 Extend the `tools/demo/up.sh` curl block: a seeded document lists 3 versions; v1 content
      is retrievable; an internal comment is absent for a non-broker session; a chunked session
      completes. Each check flag-guarded so it skips rather than fails when the feature is off
- [ ] 9.2 Run the full demo script on a real iPad: upload with a live bar, re-upload, see v2, view
      v1, post an internal comment

## Why

`DR - 0001` (Core Data Room, Josh Tonnesen, 14 Aug 2026) requires three behaviours the data room
does not have, and each is load-bearing for the 24 Aug booth demo where the pitch is a data room
that beats Intralinks' "rough Dropbox" experience.

**Versioning does not exist at any layer.** There is no `document_versions` table, no `version`
column, no `parent_document_id`. Re-uploading a file with the same name is handled *in the browser*
by renaming it to `"<name> (copy).<ext>"` (`apps/web/src/store/fileExplorerStore.js:485-491`). The
spec is explicit — `openspec/product/specs/data-room/spec.md:57-65`: "a new version is created, the
prior version remains viewable, and it can be restored."

**There are no comments on documents.** No comment, annotation, note, or thread table keyed to
`documents` exists. What exists is `document_activity` (view/download events only). Diligence
commentary currently has nowhere to live except a message thread disconnected from the file it is
about.

**Upload is a single request with no progress and no resume.** `POST /uploads` takes the whole file
as a raw body (`apps/api/src/modules/uploads/router.ts:33`, 200 MB cap). A failure at 190 MB
restarts from zero, and the interface can only report "file N of M" — there is no within-file
progress. `POST /uploads/presign` exists solely to return 410. On conference wifi, in front of a
prospect, that is the most likely visible failure in the whole demo.

**Cutover-order domain:** `uploads` / `folders` (per `docs/MODERNIZATION_PLAN.md` §5). Both modules
are already built and flag-ready; this change adds capability *beside* them without altering the
paths they serve.

## What Changes

- **New `dataroom` module** at `apps/api/src/modules/dataroom/`, serving `/dataroom/*`. Every route
  is prefixed inside the router and the module is **deliberately not registered in
  `moduleSurfaces()`** (`apps/api/src/parity/routes.ts:111-124`) — that absence, not the prefix, is
  how `qoe` escapes `route-contract.test.ts`. Consequence: `tools/parity/route-surface.json` needs
  no regeneration and `INTENTIONAL_ADDITIONS` needs no entries.
- **Document versioning** — `documents` stays the stable identity and gains
  `current_version_id` / `version_count`; each upload of a matching name appends a
  `document_versions` row. Restore inserts a new version copying the prior row's `upload_id`, so
  history is append-only and no blob is duplicated.
- **Internal comments** — threads keyed to a document, each carrying a visibility of `internal`
  (broker and admin only) or `shared`.
- **Chunked, resumable upload** — session plus per-chunk rows, assembled server-side in a single
  SQL statement so no file is materialized in Node. Chunk `PUT` is idempotent by primary key, which
  is what makes resume free.
- **Within-file upload progress** in the SPA, replacing "file N of M".

## Capabilities

### New Capabilities
- `data-room/versioning`: re-upload appends a version rather than overwriting or renaming; prior
  versions remain viewable and restorable.
- `data-room/comments`: document-scoped comment threads with an internal/shared visibility split.
- `data-room/chunked-upload`: resumable multi-part upload with per-byte progress.

### Modified Capabilities
- `uploads`: gains a `ChunkedStoragePort` sibling to the existing `StoragePort`. **No router change**,
  so the parity surface is untouched.

## Impact

- **New code:** `apps/api/src/modules/dataroom/*`, `packages/contracts/src/dataroom.ts`,
  `apps/web/src/components/fileExplorer/{DocumentVersionsPanel,DocumentCommentsPanel,DocumentDetailDrawer}.jsx`.
- **Changed:** `apps/api/src/modules/uploads/adapters.drizzle.ts` and `index.ts` (export the chunked
  port — no router touched), `apps/web/src/lib/api.js`, `apps/web/src/store/fileExplorerStore.js`.
- **Data:** `document_versions`, `document_comments`, `upload_sessions`, `upload_chunks` added; two
  additive columns on `documents`, both `IF NOT EXISTS` and defaulted.
- **Legacy impact:** none. With `DATAROOM_MODULE_ENABLED=false` the system behaves exactly as today,
  including the client-side `(copy)` rename, which is retained verbatim as the fallback.
- **Depends on:** `demo-platform-hardening` for the migration runner and the feature-degradation
  context.

## Non-goals

- **Server-side enforcement of `folder_access`.** Grants are stored but honored only in the browser
  (`apps/web/src/components/fileExplorer/FileExplorer.jsx:2477-2509`); the sole server check is
  `canAccessCompany`. This is a real hole — an authenticated company member can call
  `GET /folders/:id/documents` directly and bypass every grant — and it is accepted for the demo by
  explicit decision (19 Aug dev check-in: sharing is "functional but not bulletproof… since it's a
  demo"). **This change does apply the predicate to its own new endpoints**, which is zero-regression
  because nothing depends on their prior behaviour. Closing it for the existing endpoints must
  happen before any real tenant data and is recorded here so it is not carried as folklore. Note the
  full fix must preserve two behaviours a naive implementation drops: a folder with no grants
  inherits its nearest ancestor's, and an ancestor of an accessible folder stays navigable
  read-only. Miss either and folders vanish from the tree.
- **Object storage.** Files stay in Postgres `bytea` behind `StoragePort`. No S3, no signed URLs,
  no CDN. The port exists so that swap is a later change with no contract impact.
- **Replacing the preview stack.** `pdfjs-dist` stays installed and unused; the existing `<iframe>`
  PDF preview, the `XLSX.read` spreadsheet preview and the bespoke OOXML docx reader are kept as-is.
  PowerPoint and CSV preview remain unsupported.
- **OCR on upload** (`DR - 0001`), **redaction** (`DR - 0004`), **watermarking and document control**
  (`DR - 0006`), **folder templates** (`DR - 0002`), **deal team** (`DR - 0009`), zip download of a
  folder, and data room search. All specified in `openspec/product/specs/data-room/spec.md`; none is
  needed for the demo.
- **Schema drift reconciliation.** The `document_activity` column-name divergence and the missing
  `uploads.storage_path` / `file_references` Drizzle declarations are left exactly as they are.
  **Amended:** the `document_status` divergence turned out to be load-bearing rather than
  cosmetic — the two vocabularies share no value, so document inserts through the Drizzle model
  cannot work against the real schema, and that affects the shipped `uploads` module too. This
  change works around it locally and records the finding; reconciling it needs its own change
  because both vocabularies are in live use. See `design.md` D4a.
- **Comment replies.** `parent_id` ships on the table; threading UI does not.

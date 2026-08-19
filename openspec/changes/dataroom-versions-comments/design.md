# Design notes — data room versioning, comments, chunked upload

## D1 — A version is a new `document_versions` row, not a new `documents` row

Three shapes were available. The choice is forced by how many things already point at
`documents.id`.

| Shape | Why not |
|---|---|
| A version is a new `documents` row | `documents.id` is load-bearing in `document_activity.document_id`, `request_documents.document_id`, `file_references` (with `ON DELETE RESTRICT`), `key_report_file_mappings`, and the SPA's tree-node identity in `fileExplorerStore.js`. Every one would silently point at a stale version, and `UploadsService.listDocuments` would need dedup logic — a change *inside* the shipped, flagged, parity-tested uploads module. |
| A version is a new `uploads` row with the FK repointed | Nowhere to put per-version metadata (author, note, ordering) and no history at all once the pointer moves. |
| **A version is a `document_versions` row; `documents` is the mutable pointer to current** | **Chosen.** Every existing FK keeps resolving, the uploads module's read path is untouched, and restore is a pointer swap. |

```sql
CREATE TABLE IF NOT EXISTS document_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_no    integer NOT NULL,
  upload_id     uuid REFERENCES uploads(id) ON DELETE SET NULL,
  file_name     text NOT NULL,
  size_bytes    bigint NOT NULL DEFAULT 0,
  content_type  text,
  note          text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_no)
);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS current_version_id uuid;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS version_count integer NOT NULL DEFAULT 1;
```

No FK on `current_version_id`: it would create a circular create-order dependency for no benefit
the service does not already guarantee.

**Restore copies the pointer, not the bytes.** Restoring v1 inserts v4 carrying v1's `upload_id`.
History stays append-only, and a restore of a 200 MB file costs one row.

**The migration backfills a v1 row for every existing document with an `upload_id`.** Without it the
first click on version history shows an empty list, and at a booth an empty list reads as a broken
feature rather than a new one.

## D2 — Internal comments get the simplest rule that is actually correct

`visibility = 'internal'` is readable only by `role IN ('broker','admin')`; `'shared'` is readable by
anyone who can read the document. One toggle in the composer, one predicate in the service.

Deliberately **not** built: per-comment audience lists, per-user mentions, resolution state. `DR - 0001`
does not ask for them, and each would need a UI that competes with the demo for Saturday.

Filtering happens in the repository, not the component — an internal comment must be absent from the
response, not hidden in the client. The client-side-only enforcement mistake already exists once in
this codebase, in `folder_access`, and is called out in the proposal's Non-goals; it should not be
made a second time in new code.

## D3 — Assembly is one SQL statement, so no file is materialized in Node

```sql
INSERT INTO uploads (file_name, content_type, size_bytes, data, uploaded_by, prefix)
SELECT $1, $2, sum(size_bytes)::int,
       string_agg(data, ''::bytea ORDER BY chunk_index), $3, 'documents'
FROM upload_chunks WHERE session_id = $4
RETURNING id;
```

Then delete the chunks, insert the `document_versions` row, repoint `documents`, mark the session
complete — one transaction. `string_agg` over `bytea` works in PG16 and in PGlite, so the
integration test exercises the real assembly path rather than a stand-in.

Chunk `PUT` is `ON CONFLICT (session_id, chunk_index) DO UPDATE`. Idempotency is what makes resume
free: the client asks which indices the server has and sends the rest.

Cleanup is a lazy sweep on session-create. There is no scheduler anywhere in this repository and
this change is not the place to introduce one.

## D4 — Booth safety limits

Four iPads issuing unbounded parallel 5 MB `bytea` inserts into a single-container Postgres will
wedge the demo, and the gateway's proxy timeout is 30s. So: chunk size clamped to 1–8 MB, at most
three chunks in flight per file, one file at a time, and an early rejection with a readable message
above the byte cap.

Below an 8 MB threshold the client keeps using the existing single-shot `uploadFile` — it is faster
and it is the proven path. Chunking earns its keep on large files only, which is also where the
progress bar is the story.

## D5 — The route-contract guard, and the mistake to avoid

`route-contract.test.ts` iterates `moduleSurfaces()` at `apps/api/src/parity/routes.ts:111-124`,
which lists exactly seven modules: companies, users, folders, uploads, requests, messages, reports.
**`qoe` is not in it.** That absence — not its `/qoe` prefix — is the entire mechanism by which it
escapes the guard.

So the `dataroom` module mounts at `"/"`, writes every route literally prefixed `/dataroom/...`, and
**stays out of `moduleSurfaces()`**. A comment goes in `routes.ts` saying why, because the natural
instinct on reading that list is to add the missing modules to it, and doing so turns every new
route into an orphan failure and forces a regeneration of the committed
`tools/parity/route-surface.json`.

Corollary: **do not add a single route to `modules/folders/router.ts` or `modules/uploads/router.ts`.**
One added route there fails the guard and changes the parity artifact. The only edit to the uploads
module is a new `ChunkedStoragePort` beside `ByteaStoragePort` in `adapters.drizzle.ts`, exported
from `index.ts` — no router involved.

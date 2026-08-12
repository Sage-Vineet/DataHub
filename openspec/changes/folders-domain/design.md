## Context

See `proposal.md` and the domain map. Legacy `folderService.js` (~12 fns) + `folderAccess` controllers handle the tree, a 22-folder default hierarchy (created under an in-process mutex with a self-heal in `getFolderTree`), soft-delete archiving, a file-link delete guard (409 via `fileReferenceService`), and access grants with a DB CHECK constraint (user XOR group). Documents/uploads share these routes but are deferred to the uploads phase. We keep behavior, drop the Supabase/`pg` fallback, and replace the mutex with a DB-level uniqueness guarantee.

## Goals / Non-Goals

**Goals:** parity for folder + folder-access endpoints; idempotent provisioning without an in-process lock; one typed path; provide the real `FolderProvisioningPort` that `companies` consumes.

**Non-Goals:** documents/uploads/activity; `buyer_groups` management; changing the default hierarchy's shape.

## Decisions

### D1 — Blueprint + shared guards
`modules/folders/` follows the `companies` blueprint and uses the shared guards: `requireSession` (Better Auth session → `req.user`, [ADR-0007](../../../docs/adr/0007-auth-library-vs-bespoke.md)) + `canAccessCompany` (tenant scoping) — not the bespoke `requireAuth`. Access-management endpoints additionally require broker/admin.

### D2 — Idempotent provisioning via a unique index, not a mutex
Define the 22-folder hierarchy as data (a constant tree) and create it with a **unique index** on `(company_id, parent_id, name)` + `onConflictDoNothing` inside a transaction. This makes provisioning safe under concurrency without the legacy per-company mutex, and keeps the self-heal (provision if the count is below expected) as an explicit call.

### D3 — File-link protection via a port
`FileLinkPort.assertFolderDeletable(folderId)` wraps the cross-domain `fileReferenceService` check; the service rejects delete with 409 if linked. Backed by a legacy adapter until Key Reports migrates.

### D4 — Access grants enforce "exactly one subject" in code and DB
The contract and service reject grants that name both or neither of `user_id`/`group_id`; the DB CHECK constraint remains as a backstop. Group grants store `group_id`; a light group-existence reference (read) validates it.

### D5 — Archiving is `archived_at`, delete cascades access
Archive/unarchive set/clear `archived_at`. Hard delete (unlinked only) relies on `folder_access ON DELETE CASCADE`. `packages/db` adds `folders.archived_at` and the `folder_access` table.

### D6 — This module owns `FolderProvisioningPort`
Its provisioning service becomes the real implementation behind the port `companies-domain` created; swap companies' legacy adapter to it at cutover.

## Risks / Trade-offs

- **Provisioning duplicates under concurrency** → the unique index + `onConflictDoNothing` is the guarantee (D2); add a test that runs provisioning twice.
- **File-link guard correctness** → the port mirrors legacy exactly; test the linked→409 and unlinked→delete paths.
- **Group reference integrity** → light existence check now; full validation when `buyer_groups` migrates.
- **Route overlap with documents** → migrate only folder + access routes; leave document sub-routes on legacy (the gateway routes by path).

## Migration Plan

1. Contracts + `packages/db` (`folders.archived_at`, `folder_access`, unique index); reconcile via `db:pull`.
2. `FileLinkPort` + group-ref adapters; the default-hierarchy constant.
3. Repository (Drizzle + in-memory): tree build, CRUD, move, archive, protected delete, idempotent provisioning, access CRUD.
4. Service + router (folder + access endpoints); tests to ≥90% incl. idempotent provisioning and the 409 guard.
5. Mount folder/access routes behind `FOLDERS_MODULE_ENABLED`; swap `companies`' provisioning port to this module; soak; delete legacy folder/access handlers.
- **Rollback:** flag off → legacy serves folder/access routes.

## Open Questions

- Whether to add the `(company_id, parent_id, name)` unique index as a Drizzle migration now or confirm it already exists in prod (the map notes "unique indexes now enforce uniqueness") — verify via `db:pull` first.

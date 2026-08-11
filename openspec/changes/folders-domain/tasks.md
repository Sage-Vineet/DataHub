## 1. Contracts

- [ ] 1.1 zod schemas: folderCreate (optional `parent_id`), folderUpdate (name/color), folderMove, and folderAccessCreate/Update (user XOR group; `can_read`/`can_write`/`can_download`)
- [ ] 1.2 Contract tests incl. the "exactly one subject" rule

## 2. Data layer

- [ ] 2.1 Extend `packages/db` folders with `archived_at`; model `folder_access` (+ CHECK: user XOR group) and a read reference to `buyer_groups`
- [ ] 2.2 Confirm/add the `(company_id, parent_id, name)` unique index (verify via `db:pull` first)
- [ ] 2.3 Schema test asserts the new columns/table

## 3. Ports & data

- [ ] 3.1 `FileLinkPort.assertFolderDeletable(id)` (wraps `fileReferenceService`) + legacy adapter
- [ ] 3.2 Light group-existence reference (read) for group grants
- [ ] 3.3 Default-hierarchy constant (the 22-folder tree) in the module

## 4. Repository (Drizzle + in-memory)

- [ ] 4.1 listByCompany, getTree (parent→children), create, update, move, archive/unarchive
- [ ] 4.2 Protected delete (calls `FileLinkPort`; cascades access)
- [ ] 4.3 Idempotent `ensureDefaultFolders` (transaction + unique index + `onConflictDoNothing`); self-heal helper
- [ ] 4.4 Access CRUD (list/create/update/delete for a folder)
- [ ] 4.5 In-memory adapter mirrors it all

## 5. Service

- [ ] 5.1 Tree/list (tenant-guarded; archived filter)
- [ ] 5.2 create/update/move (tenant-guarded)
- [ ] 5.3 archive/unarchive (soft delete)
- [ ] 5.4 delete → file-link guard (409 if linked) then remove
- [ ] 5.5 ensureDefaultFolders (idempotent) — exposed as the real `FolderProvisioningPort`
- [ ] 5.6 access grants: broker/admin only; enforce exactly-one-subject; permission flags

## 6. Router

- [ ] 6.1 Folder endpoints: list, tree, create, ensure-defaults, update, delete, move, archive, unarchive
- [ ] 6.2 Folder-access endpoints: list/create/update/delete
- [ ] 6.3 Validate via contracts; enforce access; helmet + pino scoped

## 7. Tests (≥90% on the module)

- [ ] 7.1 Tree build + archived filter; tenant denial
- [ ] 7.2 create/update/move parity
- [ ] 7.3 Provisioning: creates the standard set; running twice/concurrently makes no duplicates
- [ ] 7.4 Delete: linked → 409; unlinked → removed (access cascades)
- [ ] 7.5 Access grants: user-only/group-only accepted, both/neither rejected; non-privileged denied

## 8. Gateway cutover

- [ ] 8.1 Mount folder + folder-access routes behind `FOLDERS_MODULE_ENABLED` (off → legacy); leave document routes on legacy
- [ ] 8.2 Document the flag in `.env.example`

## 9. Cutover & retire

- [ ] 9.1 Enable in staging; parity checklist (tree, CRUD, move, archive, protected delete, provisioning, access) vs the real DB
- [ ] 9.2 Swap `companies-domain`'s `FolderProvisioningPort` to this module's service
- [ ] 9.3 After a green soak, delete legacy folder + folder-access handlers (leave document handlers for the uploads phase)

## 10. Wrap up

- [ ] 10.1 `openspec validate folders-domain --strict` passes
- [ ] 10.2 `turbo run typecheck lint test build` green; module coverage ≥90%
- [ ] 10.3 `main` untouched; Conventional Commits; update `docs/REARCH_LOG.md`

## Notes

- Do `companies-domain` and `users-domain` first (shared access guard + the provisioning port contract exist by then).
- Riskiest: idempotent provisioning (4.3/7.3) and the file-link delete guard (4.2/7.4).

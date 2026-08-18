## 1. Contracts

- [x] 1.1 zod schemas (`packages/contracts/folders.ts`): folderCreate (optional nullable `parent_id`), folderUpdate (name/color, non-empty), folderMove, folderAccessCreate/Update (user XOR group; `can_read`/`can_write`/`can_download`), folderListQuery (`include_archived`)
- [x] 1.2 Contract tests incl. the "exactly one subject" rule (`folders.test.ts`)

## 2. Data layer

- [x] 2.1 Extended `packages/db` folders with `archived_at`; modeled `folder_access` (+ CHECK: user XOR group) — a group is referenced by id (buyer_groups not modeled; out of scope)
- [x] 2.2 Added the `(company_id, coalesce(parent_id, sentinel), name)` unique index for idempotent provisioning (`db:pull` deferred — no live DB, same constraint as prior domains)
- [x] 2.3 Schema test asserts `folders.archived_at` + the `folder_access` columns

## 3. Ports & data

- [x] 3.1 `FileLinkPort.assertFolderDeletable(id)` + Drizzle adapter (checks `report_source_records.folder_id` for the folder/subtree → 409)
- [x] 3.2 `GroupRefPort.exists(groupId)` — light group-existence read (`buyer_groups`)
- [x] 3.3 Default-hierarchy constant as **data** (`hierarchy.ts`: 7 top-level + two manual-source subtrees; `EXPECTED_FOLDER_COUNT`)

## 4. Repository (Drizzle + in-memory)

- [x] 4.1 listByCompany (archived filter), getById, create, update, move, setArchived/unarchive
- [x] 4.2 Protected delete (service calls `FileLinkPort`; `folder_access` cascades via FK)
- [x] 4.3 Idempotent `ensureDefaultFolders` — transaction + `onConflictDoNothing` on the unique index + conflict-resolve; `countByCompany`/`needsProvisioning` self-heal signal
- [x] 4.4 Access CRUD (list/get/create/update/delete)
- [x] 4.5 In-memory adapter mirrors it all (dedupes on (company, parent, name) like the index)

## 5. Service

- [x] 5.1 Tree/list (tenant-guarded via shared `canAccessCompany`; archived filter); `buildTree`
- [x] 5.2 create/update/move (tenant-guarded, `created_by` recorded)
- [x] 5.3 archive/unarchive (soft delete via `archived_at`)
- [x] 5.4 delete → file-link guard (409 if linked) then remove (access cascades)
- [x] 5.5 `ensureDefaultFolders` (idempotent) — exposed as the real `FolderProvisioningPort`
- [x] 5.6 access grants: broker/admin only; exactly-one-subject (contract) + group-existence; permission flags

## 6. Router

- [x] 6.1 Folder endpoints: list, tree, create, ensure-defaults, update, delete, move, archive, unarchive
- [x] 6.2 Folder-access endpoints: list/create/update/delete
- [x] 6.3 Validated via contracts; access enforced; helmet + pino scoped. Mounted broadly under `/api` (only folder/access routes defined; document sub-routes fall through to legacy)

## 7. Tests (≥90% on the module)

- [x] 7.1 Tree build + archived filter; tenant denial (`service.test.ts`)
- [x] 7.2 create/update/move parity
- [x] 7.3 Provisioning: creates the standard set; running twice makes no duplicates — in-memory AND against real Postgres with the real unique index (`folders.integration.test.ts`)
- [x] 7.4 Delete: linked → 409; unlinked → removed with access cascade (real Postgres)
- [x] 7.5 Access grants: user-only/group-only accepted, both/neither → 400, non-privileged denied. Coverage ≥90% on the module

## 8. Gateway cutover

- [x] 8.1 Mounted folder + folder-access routes behind `FOLDERS_MODULE_ENABLED` (off → legacy); document routes left on legacy
- [x] 8.2 Documented the flag in `apps/api/.env.example`

## 9. Cutover & retire

- [~] 9.1 Enable in staging; parity checklist vs the real DB — **deferred**: needs a real environment (ops). Provisioning idempotency + delete guard proven against real Postgres locally.
- [x] 9.2 Swapped `companies-domain`'s `FolderProvisioningPort` to this module's service — `createFolderProvisioningPort(db)` injected into `createCompaniesModule` when both modules are enabled (server.ts)
- [~] 9.3 Delete legacy folder + folder-access handlers after a green soak — **deferred**: legacy stays the rollback target (document handlers stay for the uploads phase regardless)

## 10. Wrap up

- [x] 10.1 `openspec validate folders-domain --strict` passes
- [x] 10.2 typecheck + lint + test green (contracts 23, db 8, api 115); module coverage ≥90%
- [x] 10.3 `main` untouched; Conventional Commits; `docs/REARCH_LOG.md` updated

## Notes

- Riskiest surfaces — idempotent provisioning (4.3/7.3) and the file-link delete guard (4.2/7.4) — both proven against real Postgres (the real unique index makes a repeat `ensure` a no-op; a linked folder 409s, an unlinked one deletes and cascades access).
- Completes the Phase 2 core trio; the real `FolderProvisioningPort` (D6) now backs `companies` default-folder provisioning.
- Test suite now runs test files sequentially (`vitest.config.ts`) so many embedded-Postgres/Better-Auth instances don't contend under load.

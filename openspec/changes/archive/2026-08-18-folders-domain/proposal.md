## Why

`folders` completes the Phase 2 core trio (companies → users → **folders**). It owns the workspace structure every company gets: the folder tree, default-folder provisioning, archiving, and per-folder access grants (the permission model). Migrating it lands the real **default-folder provisioning** that `companies` currently reaches for via a port, and consolidates the folder permission rules in one typed place.

**Cutover-order domain:** `folders / folderAccess` (per `docs/MODERNIZATION_PLAN.md` §5, after users). **Scope note:** documents/uploads/activity (also mounted under folder routes today) belong to the later `uploads` phase and are **out of scope here** — only folder + folder-access endpoints migrate now.

## What Changes

- **`packages/contracts`** — zod schemas for folder create/update/move and folder-access create/update (user XOR group, permission flags).
- **`packages/db`** — extend `folders` (add `archived_at`) and model `folder_access` (+ a read reference to `buyer_groups`).
- **`apps/api/src/modules/folders`** — router + service + repository (Drizzle + in-memory) + contract + tests. Ports the folder + folder-access endpoints and rules: tree, CRUD, move, archive/unarchive, protected delete, default provisioning, access grants.
- **Real `FolderProvisioningPort` implementation** — `companies-domain` swaps its legacy adapter for this module's service.
- **Cross-domain via ports** — `FileLinkPort` (reject delete if a folder is linked to Key Reports → 409) and a light group-existence reference.
- **Gateway cutover** — flip the folder + folder-access routes behind `FOLDERS_MODULE_ENABLED`; document routes stay on legacy until the uploads phase.

## Capabilities

### New Capabilities
- `folders`: workspace folders and their access model as observable behavior — tenant-scoped tree/list, create/update/move, soft-delete archiving, file-link-protected hard delete, idempotent default-folder provisioning, and per-folder access grants (user or group, read/write/download).

## Impact

- **New code:** `packages/contracts` (folder + access schemas), `packages/db` (`folders.archived_at`, `folder_access`), `apps/api/src/modules/folders/*`, `FileLinkPort` + group-ref adapters, gateway routing entry.
- **Data:** same Postgres via Drizzle — no migration.
- **Runtime behavior:** unchanged (same folder/access contracts); dual-path removed; default provisioning made idempotent via a unique index instead of an in-process mutex.
- **Branch:** `ba/rearch`; `main` frozen. Legacy folder/access handlers retired after a green soak.

## Non-goals

- **Documents, uploads, and document-activity** — the `uploads` phase (even though they share folder routes today).
- **`buyer_groups` management** — a later domain; here we only reference a group by id in an access grant.
- **companies/users** — separate changes.
- No frontend changes (see `frontend-ui-adoption`).

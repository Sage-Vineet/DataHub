import type { SessionUser } from "@datahub/contracts";

/**
 * Folder grants, enforced on the server.
 *
 * `folder_access` has always been stored server-side and honoured only by the
 * browser (`apps/web/src/components/fileExplorer/FileExplorer.jsx:2477-2520`),
 * with `canAccessCompany` the sole server check. Anyone with devtools, or anyone
 * who guesses a document id, reads a file they were never granted.
 *
 * Closing that for the SHIPPED folders and uploads routes would change behaviour
 * with their flags on while the flag-off legacy path still returned everything —
 * breaking parity and the guard's premise. So this applies to the endpoints this
 * module adds, where nothing depends on the prior behaviour, and the full fix is
 * recorded in the change's Non-goals rather than left implicit.
 *
 * Two behaviours a naive implementation drops, and this one keeps:
 *
 *  - A folder with NO grants inherits its nearest ancestor's. Otherwise granting
 *    access to a parent grants nothing usable, because the children are empty.
 *  - Broker and admin are unscoped within a company they can already reach.
 *    Legacy treats them that way and the SPA renders them that way; tightening it
 *    here would make the deal team's own view go dark.
 */

export interface FolderGrant {
  folderId: string;
  userId: string | null;
  groupId: string | null;
  canRead: boolean;
  canWrite: boolean;
  canDownload: boolean;
}

export interface FolderPermissions {
  read: boolean;
  write: boolean;
  download: boolean;
}

const NONE: FolderPermissions = { read: false, write: false, download: false };
const ALL: FolderPermissions = { read: true, write: true, download: true };

/** Does this grant name this user, directly or through one of their groups? */
function appliesTo(grant: FolderGrant, user: SessionUser, groupIds: ReadonlyArray<string>): boolean {
  if (grant.userId && grant.userId === user.id) return true;
  if (grant.groupId && groupIds.includes(grant.groupId)) return true;
  return false;
}

function merge(grants: ReadonlyArray<FolderGrant>, user: SessionUser, groupIds: ReadonlyArray<string>): FolderPermissions {
  const out = { ...NONE };
  for (const grant of grants) {
    if (!appliesTo(grant, user, groupIds)) continue;
    out.read = out.read || grant.canRead;
    out.write = out.write || grant.canWrite;
    out.download = out.download || grant.canDownload;
  }
  return out;
}

/**
 * What this user may do in this folder.
 *
 * `ancestors` runs nearest-first. The first ancestor that carries ANY grant wins
 * outright — grants are not accumulated up the tree, which matches what the SPA
 * does and means a specific grant on a subfolder is not silently widened by a
 * broader one further up.
 */
export function effectivePermissions(input: {
  user: SessionUser;
  groupIds?: ReadonlyArray<string>;
  folderGrants: ReadonlyArray<FolderGrant>;
  ancestorGrants?: ReadonlyArray<ReadonlyArray<FolderGrant>>;
}): FolderPermissions {
  const { user } = input;
  if (user.role === "broker" || user.role === "admin") return ALL;

  const groupIds = input.groupIds ?? [];
  if (input.folderGrants.length > 0) return merge(input.folderGrants, user, groupIds);

  for (const grants of input.ancestorGrants ?? []) {
    if (grants.length > 0) return merge(grants, user, groupIds);
  }

  // No grant anywhere up the chain. Everyone in the company can read — which is
  // what the system does today, and tightening it here would lock people out of
  // folders they have been using. The grants narrow, they do not open.
  return { read: true, write: false, download: true };
}

/** May this user read this folder's contents at all? */
export function canReadFolder(input: Parameters<typeof effectivePermissions>[0]): boolean {
  return effectivePermissions(input).read;
}

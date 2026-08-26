import type { SessionUser } from "@datahub/contracts";

/**
 * Whether a caller may read, download from, or write to a folder.
 *
 * `folder_access` has always carried the right shape — a subject that is either
 * a user or a buyer group, and three separate capabilities, including the
 * view-versus-download split that is the commercially meaningful one in a deal
 * room. Nothing consulted it. `requireFolderAccess` checked company membership
 * and stopped, so every grant was enforced in the browser and nowhere else, and
 * any authenticated member of the company could list any folder's documents by
 * calling the API directly.
 *
 * ## The default for an ungranted folder is ALLOW, deliberately
 *
 * The stricter reading — no grant, no access — is what a mature data room does,
 * and it is wrong to adopt here in one step. Not one folder in the product has a
 * grant on it today: the client resolves every role that actually exists to
 * "unrestricted" (`role === 'broker'` bypasses, and every other real role is
 * mapped to `'client'`, which also bypasses), so `folder_access` is decorative
 * on both sides. Switching the server to deny-by-default would therefore not
 * tighten an existing rule — it would empty every data room in the product for
 * everyone except brokers, on the first deploy.
 *
 * So: a folder nobody has configured behaves exactly as it does now. A folder
 * somebody HAS configured starts meaning what it says. That makes the feature
 * real without making it retroactive, and the stricter default becomes a
 * decision to take deliberately, with grants in place, rather than a side effect
 * of fixing enforcement.
 *
 * ## Inheritance
 *
 * Grants inherit down the tree: a folder with no grants of its own takes the
 * nearest ancestor that has some. This mirrors what the client already computes,
 * so a permissions panel and the API cannot disagree about the same folder — and
 * it is the only reading under which restricting a parent is meaningful, since
 * otherwise any child would be an open door around it.
 */

export interface FolderAccessGrant {
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

export const UNRESTRICTED: FolderPermissions = { read: true, write: true, download: true };
const DENIED: FolderPermissions = { read: false, write: false, download: false };

/**
 * The deal-owning side is never gated by a grant.
 *
 * Brokers and admins run the room — they are who issues grants in the first
 * place, and a broker who could lock themselves out of a folder by misconfiguring
 * it would make the feature unusable at exactly the moment it matters.
 */
export function ownsTheRoom(user: SessionUser): boolean {
  return user.role === "broker" || user.role === "admin";
}

/**
 * Resolve one caller's permissions on one folder.
 *
 * `ancestry` is the folder and its ancestors, nearest first, so the first entry
 * carrying any grant at all is the one that governs. `grants` may span the whole
 * ancestry; only those for the governing folder are considered.
 */
export function resolveFolderPermissions(input: {
  user: SessionUser;
  ancestry: readonly string[];
  grants: readonly FolderAccessGrant[];
  groupIds: readonly string[];
}): FolderPermissions {
  if (ownsTheRoom(input.user)) return UNRESTRICTED;

  const governing = input.ancestry.find((folderId) =>
    input.grants.some((grant) => grant.folderId === folderId),
  );
  // Nobody has configured this folder or anything above it.
  if (!governing) return UNRESTRICTED;

  const groups = new Set(input.groupIds);
  const applicable = input.grants.filter(
    (grant) =>
      grant.folderId === governing &&
      ((grant.userId !== null && grant.userId === input.user.id) ||
        (grant.groupId !== null && groups.has(grant.groupId))),
  );
  if (applicable.length === 0) return DENIED;

  // Several grants can reach one person — directly and through a group. The most
  // permissive wins, because a grant is an addition of trust, never a cap on it.
  return applicable.reduce<FolderPermissions>(
    (acc, grant) => ({
      read: acc.read || grant.canRead,
      write: acc.write || grant.canWrite,
      download: acc.download || grant.canDownload,
    }),
    { ...DENIED },
  );
}

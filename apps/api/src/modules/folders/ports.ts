/** A folder as the module works with it (camelCase; `archivedAt` is ISO or null). */
export interface FolderRecord {
  id: string;
  companyId: string;
  parentId: string | null;
  name: string;
  color: string | null;
  createdBy: string;
  archivedAt: string | null;
}

export interface FolderAccessRecord {
  id: string;
  folderId: string;
  userId: string | null;
  groupId: string | null;
  canRead: boolean;
  canWrite: boolean;
  canDownload: boolean;
  /** NOT NULL in the table — a grant always records who made it. */
  createdBy: string;
}

export interface CreateFolderInput {
  companyId: string;
  parentId: string | null;
  name: string;
  color: string | null;
  createdBy: string;
}

export interface CreateAccessInput {
  folderId: string;
  userId: string | null;
  groupId: string | null;
  canRead: boolean;
  canWrite: boolean;
  canDownload: boolean;
  /** NOT NULL in the table — a grant always records who made it. */
  createdBy: string;
}

export interface FoldersRepository {
  listByCompany(companyId: string, includeArchived: boolean): Promise<FolderRecord[]>;
  getById(id: string): Promise<FolderRecord | null>;
  countByCompany(companyId: string): Promise<number>;
  create(input: CreateFolderInput): Promise<FolderRecord>;
  update(id: string, patch: { name?: string; color?: string | null }): Promise<FolderRecord | null>;
  move(id: string, parentId: string | null): Promise<FolderRecord | null>;
  setArchived(id: string, archived: boolean): Promise<FolderRecord | null>;
  /** Hard delete; folder_access cascades via FK (design D5). */
  delete(id: string): Promise<void>;
  /** Idempotent default-folder provisioning (unique index + conflict-do-nothing). */
  ensureDefaultFolders(companyId: string, createdBy: string): Promise<FolderRecord[]>;

  // Access grants.
  listAccess(folderId: string): Promise<FolderAccessRecord[]>;
  getAccessById(id: string): Promise<FolderAccessRecord | null>;
  createAccess(input: CreateAccessInput): Promise<FolderAccessRecord>;
  updateAccess(
    id: string,
    patch: { canRead?: boolean; canWrite?: boolean; canDownload?: boolean },
  ): Promise<FolderAccessRecord | null>;
  deleteAccess(id: string): Promise<void>;
}

/**
 * Cross-domain guard (design D3): refuse to delete a folder whose subtree is
 * linked to another module (e.g. Key Reports). Throws a 409 HttpError if linked.
 * Legacy-backed until Key Reports migrates.
 */
export interface FileLinkPort {
  assertFolderDeletable(folderId: string): Promise<void>;
}

/** Light group-existence reference for group grants (design D4). */
export interface GroupRefPort {
  exists(groupId: string): Promise<boolean>;
}

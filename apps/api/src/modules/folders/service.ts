import type {
  FolderAccessCreate,
  FolderAccessResponse,
  FolderAccessUpdate,
  FolderCreate,
  FolderResponse,
  FolderTreeNode,
  FolderUpdate,
  SessionUser,
} from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { EXPECTED_FOLDER_COUNT } from "./hierarchy.js";
import type {
  FileLinkPort,
  FolderAccessRecord,
  FolderRecord,
  FoldersRepository,
  GroupRefPort,
} from "./ports.js";

export interface FoldersServiceDeps {
  repo: FoldersRepository;
  fileLink: FileLinkPort;
  groups: GroupRefPort;
}

export class FoldersService {
  private readonly repo: FoldersRepository;
  private readonly fileLink: FileLinkPort;
  private readonly groups: GroupRefPort;

  constructor(deps: FoldersServiceDeps) {
    this.repo = deps.repo;
    this.fileLink = deps.fileLink;
    this.groups = deps.groups;
  }

  async list(viewer: SessionUser, companyId: string, includeArchived: boolean): Promise<FolderResponse[]> {
    this.requireCompanyAccess(viewer, companyId);
    const rows = await this.repo.listByCompany(companyId, includeArchived);
    return rows.map(toFolderResponse);
  }

  async tree(viewer: SessionUser, companyId: string, includeArchived: boolean): Promise<FolderTreeNode[]> {
    this.requireCompanyAccess(viewer, companyId);
    const rows = await this.repo.listByCompany(companyId, includeArchived);
    return buildTree(rows);
  }

  async create(viewer: SessionUser, companyId: string, input: FolderCreate): Promise<FolderResponse> {
    this.requireCompanyAccess(viewer, companyId);
    const folder = await this.repo.create({
      companyId,
      parentId: input.parent_id ?? null,
      name: input.name,
      color: input.color ?? null,
      createdBy: viewer.id,
    });
    return toFolderResponse(folder);
  }

  async update(viewer: SessionUser, id: string, input: FolderUpdate): Promise<FolderResponse> {
    await this.requireFolderAccess(viewer, id);
    const patch: { name?: string; color?: string | null } = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.color !== undefined) patch.color = input.color ?? null;
    const updated = await this.repo.update(id, patch);
    return toFolderResponse(updated!);
  }

  async move(viewer: SessionUser, id: string, parentId: string | null): Promise<FolderResponse> {
    await this.requireFolderAccess(viewer, id);
    const updated = await this.repo.move(id, parentId);
    return toFolderResponse(updated!);
  }

  async archive(viewer: SessionUser, id: string): Promise<FolderResponse> {
    await this.requireFolderAccess(viewer, id);
    return toFolderResponse((await this.repo.setArchived(id, true))!);
  }

  async unarchive(viewer: SessionUser, id: string): Promise<FolderResponse> {
    await this.requireFolderAccess(viewer, id);
    return toFolderResponse((await this.repo.setArchived(id, false))!);
  }

  /** Hard delete — blocked (409) if the folder is linked to another module (D3). */
  async delete(viewer: SessionUser, id: string): Promise<void> {
    await this.requireFolderAccess(viewer, id);
    await this.fileLink.assertFolderDeletable(id); // throws 409 if linked
    await this.repo.delete(id);
  }

  /** Provision the default hierarchy for a company (idempotent). The real `FolderProvisioningPort`. */
  async ensureDefaultFolders(companyId: string, createdBy: string): Promise<FolderResponse[]> {
    const created = await this.repo.ensureDefaultFolders(companyId, createdBy);
    return created.map(toFolderResponse);
  }

  /** Endpoint wrapper with a tenant guard; self-heals if the count is below expected. */
  async ensureDefaultsForCompany(viewer: SessionUser, companyId: string): Promise<FolderResponse[]> {
    this.requireCompanyAccess(viewer, companyId);
    const created = await this.repo.ensureDefaultFolders(companyId, viewer.id);
    return created.map(toFolderResponse);
  }

  /** Whether a company is below its expected default-folder count (self-heal signal). */
  async needsProvisioning(companyId: string): Promise<boolean> {
    return (await this.repo.countByCompany(companyId)) < EXPECTED_FOLDER_COUNT;
  }

  // ── Access grants (broker/admin only, design D4) ──────────────────────────

  async listAccess(viewer: SessionUser, folderId: string): Promise<FolderAccessResponse[]> {
    await this.requireFolderAccess(viewer, folderId);
    return (await this.repo.listAccess(folderId)).map(toAccessResponse);
  }

  async createAccess(viewer: SessionUser, folderId: string, input: FolderAccessCreate): Promise<FolderAccessResponse> {
    await this.requireFolderAccess(viewer, folderId);
    this.requireManager(viewer);
    if (input.group_id != null && !(await this.groups.exists(input.group_id))) {
      throw new BadRequestError("The referenced group does not exist.");
    }
    const created = await this.repo.createAccess({
      folderId,
      userId: input.user_id ?? null,
      groupId: input.group_id ?? null,
      canRead: input.can_read ?? true,
      canWrite: input.can_write ?? false,
      canDownload: input.can_download ?? false,
      createdBy: viewer.id,
    });
    return toAccessResponse(created);
  }

  async updateAccess(viewer: SessionUser, accessId: string, input: FolderAccessUpdate): Promise<FolderAccessResponse> {
    const access = await this.requireAccessManageable(viewer, accessId);
    const patch: { canRead?: boolean; canWrite?: boolean; canDownload?: boolean } = {};
    if (input.can_read !== undefined) patch.canRead = input.can_read;
    if (input.can_write !== undefined) patch.canWrite = input.can_write;
    if (input.can_download !== undefined) patch.canDownload = input.can_download;
    const updated = await this.repo.updateAccess(access.id, patch);
    return toAccessResponse(updated!);
  }

  async deleteAccess(viewer: SessionUser, accessId: string): Promise<void> {
    const access = await this.requireAccessManageable(viewer, accessId);
    await this.repo.deleteAccess(access.id);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private requireCompanyAccess(viewer: SessionUser, companyId: string): void {
    if (!canAccessCompany(viewer, companyId)) {
      throw new ForbiddenError("You do not have permission to access this company's folders.");
    }
  }

  private requireManager(viewer: SessionUser): void {
    if (viewer.role !== "admin" && viewer.role !== "broker") {
      throw new ForbiddenError("Only brokers or admins can manage folder access.");
    }
  }

  private async requireFolderAccess(viewer: SessionUser, folderId: string): Promise<FolderRecord> {
    const folder = await this.repo.getById(folderId);
    if (!folder) throw new NotFoundError("Folder not found.");
    this.requireCompanyAccess(viewer, folder.companyId);
    return folder;
  }

  private async requireAccessManageable(viewer: SessionUser, accessId: string): Promise<FolderAccessRecord> {
    const access = await this.repo.getAccessById(accessId);
    if (!access) throw new NotFoundError("Access grant not found.");
    await this.requireFolderAccess(viewer, access.folderId);
    this.requireManager(viewer);
    return access;
  }
}

export function toFolderResponse(r: FolderRecord): FolderResponse {
  return {
    id: r.id,
    company_id: r.companyId,
    parent_id: r.parentId,
    name: r.name,
    color: r.color,
    created_by: r.createdBy,
    archived_at: r.archivedAt,
  };
}

function toAccessResponse(r: FolderAccessRecord): FolderAccessResponse {
  return {
    id: r.id,
    folder_id: r.folderId,
    user_id: r.userId,
    group_id: r.groupId,
    can_read: r.canRead,
    can_write: r.canWrite,
    can_download: r.canDownload,
    created_by: r.createdBy,
  };
}

/** Build a parent→children tree from a flat folder list (parity with legacy buildTree). */
export function buildTree(rows: FolderRecord[]): FolderTreeNode[] {
  const nodes = new Map<string, FolderTreeNode>();
  for (const r of rows) nodes.set(r.id, { ...toFolderResponse(r), children: [] });
  const roots: FolderTreeNode[] = [];
  for (const r of rows) {
    const node = nodes.get(r.id)!;
    const parent = r.parentId ? nodes.get(r.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

import type {
  DocumentActivityResponse,
  DocumentCreate,
  DocumentResponse,
  SessionUser,
  UploadResponse,
} from "@datahub/contracts";
import {
  ownsTheRoom,
  resolveFolderPermissions,
  UNRESTRICTED,
  type FolderPermissions,
} from "./folder-access.js";
import { canAccessCompany } from "../../shared/access.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type {
  ActivityRecord,
  DocumentRecord,
  DocumentsRepository,
  FolderRefPort,
  StoragePort,
  StoredBlob,
} from "./ports.js";

export interface UploadsServiceDeps {
  storage: StoragePort;
  repo: DocumentsRepository;
  folders: FolderRefPort;
}

export class UploadsService {
  private readonly storage: StoragePort;
  private readonly repo: DocumentsRepository;
  private readonly folders: FolderRefPort;

  constructor(deps: UploadsServiceDeps) {
    this.storage = deps.storage;
    this.repo = deps.repo;
    this.folders = deps.folders;
  }

  /** Store a blob and return its upload metadata. */
  async storeUpload(
    user: SessionUser,
    bytes: Buffer,
    fileName: string,
    contentType: string,
  ): Promise<UploadResponse> {
    const meta = await this.storage.put(bytes, { fileName, contentType, uploadedBy: user.id });
    return { id: meta.id, file_name: meta.fileName, content_type: meta.contentType, size_bytes: meta.sizeBytes };
  }

  /** Fetch a stored blob's bytes + content type (404 if unknown). */
  async getUploadContent(uploadId: string): Promise<StoredBlob> {
    const blob = await this.storage.get(uploadId);
    if (!blob) throw new NotFoundError("Upload not found.");
    return blob;
  }

  /** Add a document under a folder (tenant-guarded via the folder's company). */
  async addDocument(user: SessionUser, folderId: string, input: DocumentCreate): Promise<DocumentResponse> {
    const companyId = await this.requireFolderAccess(user, folderId, "write");
    const doc = await this.repo.createDocument({
      companyId,
      folderId,
      name: input.name,
      fileUrl: input.file_url ?? null,
      uploadId: input.upload_id,
      size: input.size,
      ext: input.ext,
      status: input.status ?? "active",
      uploadedBy: user.id,
    });
    return toDocumentResponse(doc);
  }

  async listDocuments(user: SessionUser, folderId: string, includeArchived: boolean): Promise<DocumentResponse[]> {
    await this.requireFolderAccess(user, folderId);
    return (await this.repo.listByFolder(folderId, includeArchived)).map(toDocumentResponse);
  }

  async deleteDocument(user: SessionUser, documentId: string): Promise<void> {
    await this.requireDocumentAccess(user, documentId, "write");
    await this.repo.delete(documentId);
  }

  async archiveDocument(user: SessionUser, documentId: string): Promise<DocumentResponse> {
    await this.requireDocumentAccess(user, documentId);
    return toDocumentResponse((await this.repo.setArchived(documentId, true))!);
  }

  async unarchiveDocument(user: SessionUser, documentId: string): Promise<DocumentResponse> {
    await this.requireDocumentAccess(user, documentId);
    return toDocumentResponse((await this.repo.setArchived(documentId, false))!);
  }

  async recordActivity(user: SessionUser, documentId: string, action: string): Promise<DocumentActivityResponse> {
    await this.requireDocumentAccess(user, documentId);
    return toActivityResponse(await this.repo.appendActivity(documentId, user.id, action));
  }

  async listActivity(user: SessionUser, documentId: string): Promise<DocumentActivityResponse[]> {
    await this.requireDocumentAccess(user, documentId);
    return (await this.repo.listActivity(documentId)).map(toActivityResponse);
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Resolve the folder's company and enforce access; returns the company id. */
  /**
   * Two gates, in order: the tenant boundary, then the folder's own grants.
   *
   * The second used to be missing entirely. `folder_access` carried per-user and
   * per-group grants with separate read/write/download capabilities, a panel
   * wrote them, and nothing on the server ever read them — so every grant was
   * advisory and any member of the company could list any folder's documents by
   * calling the API directly. See folder-access.ts for why an ungranted folder
   * stays open rather than becoming denied.
   */
  private async requireFolderAccess(
    user: SessionUser,
    folderId: string,
    capability: keyof FolderPermissions = "read",
  ): Promise<string> {
    const companyId = await this.folders.companyIdFor(folderId);
    if (!companyId) throw new NotFoundError("Folder not found.");
    if (!canAccessCompany(user, companyId)) {
      throw new ForbiddenError("You do not have permission to access this folder's documents.");
    }
    const permissions = await this.permissionsFor(user, folderId);
    if (!permissions[capability]) {
      throw new ForbiddenError("You do not have permission to access this folder's documents.");
    }
    return companyId;
  }

  private async permissionsFor(user: SessionUser, folderId: string): Promise<FolderPermissions> {
    if (ownsTheRoom(user)) return UNRESTRICTED;
    const ancestry = await this.folders.ancestryOf(folderId);
    const [grants, groupIds] = await Promise.all([
      this.folders.grantsFor(ancestry),
      this.folders.groupIdsFor(user.id),
    ]);
    return resolveFolderPermissions({ user, ancestry, grants, groupIds });
  }

  private async requireDocumentAccess(
    user: SessionUser,
    documentId: string,
    capability: keyof FolderPermissions = "read",
  ): Promise<DocumentRecord> {
    const doc = await this.repo.getById(documentId);
    if (!doc) throw new NotFoundError("Document not found.");
    if (!canAccessCompany(user, doc.companyId)) {
      throw new ForbiddenError("You do not have permission to access this document.");
    }
    // A document is only as reachable as the folder holding it; otherwise a
    // restricted folder could be walked around by addressing its contents.
    const permissions = await this.permissionsFor(user, doc.folderId);
    if (!permissions[capability]) {
      throw new ForbiddenError("You do not have permission to access this document.");
    }
    return doc;
  }
}

export function toDocumentResponse(d: DocumentRecord): DocumentResponse {
  return {
    id: d.id,
    company_id: d.companyId,
    folder_id: d.folderId,
    name: d.name,
    file_url: d.fileUrl,
    upload_id: d.uploadId,
    size: d.size,
    ext: d.ext,
    status: d.status,
    uploaded_by: d.uploadedBy,
    uploaded_by_name: d.uploadedByName ?? null,
    uploaded_at: d.uploadedAt,
    archived_at: d.archivedAt,
  };
}

function toActivityResponse(a: ActivityRecord): DocumentActivityResponse {
  return { id: a.id, document_id: a.documentId, actor_id: a.actorId, action: a.action, at: a.at };
}

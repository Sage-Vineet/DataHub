import type { DocumentStatus } from "@datahub/contracts";
import type { FolderAccessGrant } from "./folder-access.js";

export interface StoredBlobMeta {
  fileName: string;
  contentType: string;
  uploadedBy: string | null;
}

export interface StoredBlob {
  fileName: string;
  contentType: string;
  bytes: Buffer;
}

export interface UploadMeta {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * Blob storage behind a swappable port (design D2). The shipped adapter stores
 * bytes in Postgres `uploads.data` (bytea); an S3/GCS adapter can implement the
 * same interface later with no contract change.
 */
export interface StoragePort {
  put(bytes: Buffer, meta: StoredBlobMeta): Promise<UploadMeta>;
  get(uploadId: string): Promise<StoredBlob | null>;
}

/** Resolve a folder's company for the tenant guard (design D1) — kept as a port. */
export interface FolderRefPort {
  companyIdFor(folderId: string): Promise<string | null>;
  /**
   * The folder and its ancestors, nearest first, so grant inheritance can be
   * resolved without this module knowing how the folder tree is stored.
   */
  ancestryOf(folderId: string): Promise<string[]>;
  /** Grants covering any folder in `folderIds`. */
  grantsFor(folderIds: readonly string[]): Promise<FolderAccessGrant[]>;
  /** Buyer groups the user belongs to. */
  groupIdsFor(userId: string): Promise<string[]>;
}

export interface DocumentRecord {
  id: string;
  companyId: string;
  folderId: string;
  name: string;
  fileUrl: string | null;
  uploadId: string | null;
  size: string;
  ext: string;
  status: DocumentStatus;
  uploadedBy: string;
  /**
   * Resolved display name for `uploadedBy`; null when that user has been
   * removed, undefined on paths that do not join the user table.
   *
   * Only the id used to reach the client, and the file explorer has no
   * directory to resolve it against — so every document read
   * "Uploaded by: Unknown" in a product whose value proposition is provenance.
   */
  uploadedByName?: string | null;
  /**
   * When it arrived.
   *
   * Carried because the file explorer sorts and labels by it, and because a
   * data room whose whole value is provenance was showing documents with no
   * indication of when any of them appeared.
   */
  uploadedAt: string | null;
  archivedAt: string | null;
}

export interface CreateDocumentInput {
  companyId: string;
  folderId: string;
  name: string;
  fileUrl: string | null;
  uploadId: string | null;
  size: string;
  ext: string;
  status: DocumentStatus;
  uploadedBy: string;
}

export interface ActivityRecord {
  id: string;
  documentId: string;
  actorId: string | null;
  action: string;
  at: string;
}

/** Document metadata + activity (the blob itself goes through StoragePort). */
export interface DocumentsRepository {
  createDocument(input: CreateDocumentInput): Promise<DocumentRecord>;
  listByFolder(folderId: string, includeArchived: boolean): Promise<DocumentRecord[]>;
  getById(id: string): Promise<DocumentRecord | null>;
  /**
   * The document a stored blob belongs to, so a byte read can be authorized.
   *
   * `GET /uploads/:id/content` addresses the blob, not the document, and a blob
   * carries no tenant of its own — so without this the only byte-serving route
   * in the module had nothing to check and served any upload to any signed-in
   * caller. Matches the current `documents.upload_id` OR any historical
   * `document_versions.upload_id`, because restoring a version repoints the
   * document while older versions keep pointing at their own bytes.
   */
  findByUploadId(uploadId: string): Promise<DocumentRecord | null>;
  delete(id: string): Promise<void>;
  setArchived(id: string, archived: boolean): Promise<DocumentRecord | null>;
  appendActivity(documentId: string, actorId: string | null, action: string): Promise<ActivityRecord>;
  listActivity(documentId: string): Promise<ActivityRecord[]>;
}

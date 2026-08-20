import type { CommentVisibility } from "@datahub/contracts";

/**
 * The data room capabilities the shipped `folders` and `uploads` modules do not
 * have: document versioning, comments, and chunked upload.
 *
 * This module deliberately owns no path `uploads` owns. `uploads` answers on the
 * paths legacy already serves and is parity-tested against them; adding a route
 * there would fail the route-contract guard and force a regeneration of the
 * committed route surface. So the new capability lives on `/dataroom/*` and
 * reaches the shared blob store through a port instead.
 */

// ── versions ────────────────────────────────────────────────────────────────

export interface DocumentVersionRecord {
  id: string;
  documentId: string;
  versionNo: number;
  uploadId: string | null;
  fileName: string;
  sizeBytes: number;
  contentType: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface AppendVersionInput {
  documentId: string;
  uploadId: string | null;
  fileName: string;
  sizeBytes: number;
  contentType: string | null;
  note: string | null;
  createdBy: string | null;
}

/**
 * Version history for a document.
 *
 * `append` allocates the next version number and repoints the document, in one
 * transaction. Allocation belongs here rather than in the service because two
 * concurrent uploads of the same file must not be able to agree on a number.
 */
export interface DocumentVersionsRepository {
  listFor(documentId: string): Promise<DocumentVersionRecord[]>;
  getById(versionId: string): Promise<DocumentVersionRecord | null>;
  append(input: AppendVersionInput): Promise<DocumentVersionRecord>;
  /** Current version id and count, as the document itself records them. */
  currentFor(documentId: string): Promise<{ currentVersionId: string | null; versionCount: number }>;
  /** Find a document in a folder by name — how a re-upload becomes a version. */
  findDocumentByName(folderId: string, name: string): Promise<{ id: string } | null>;
}

// ── comments ────────────────────────────────────────────────────────────────

export interface CommentRecord {
  id: string;
  documentId: string;
  companyId: string;
  versionId: string | null;
  parentId: string | null;
  body: string;
  visibility: CommentVisibility;
  pageNumber: number | null;
  authorId: string;
  authorName: string | null;
  createdAt: string;
}

export interface CreateCommentInput {
  documentId: string;
  companyId: string;
  versionId: string | null;
  parentId: string | null;
  body: string;
  visibility: CommentVisibility;
  pageNumber: number | null;
  authorId: string;
}

export interface CommentsRepository {
  /**
   * List a document's comments.
   *
   * `includeInternal` is a QUERY parameter, not a post-filter: an internal
   * comment must be absent from the result for a counterparty, not present and
   * hidden by the caller. The same mistake already exists once in this codebase
   * — `folder_access` grants are stored server-side and honoured only in the
   * browser — and is not repeated here.
   */
  listFor(documentId: string, includeInternal: boolean): Promise<CommentRecord[]>;
  create(input: CreateCommentInput): Promise<CommentRecord>;
  getById(id: string): Promise<CommentRecord | null>;
  softDelete(id: string): Promise<void>;
}

// ── chunked upload ──────────────────────────────────────────────────────────

export interface UploadSessionRecord {
  id: string;
  companyId: string | null;
  folderId: string | null;
  documentId: string | null;
  fileName: string;
  contentType: string;
  totalBytes: number;
  chunkSize: number;
  totalChunks: number;
  receivedCount: number;
  status: "open" | "completed" | "aborted";
  uploadId: string | null;
  createdBy: string | null;
  expiresAt: string;
}

export interface CreateSessionInput {
  companyId: string;
  folderId: string;
  documentId: string | null;
  fileName: string;
  contentType: string;
  totalBytes: number;
  chunkSize: number;
  totalChunks: number;
  createdBy: string | null;
}

export interface UploadSessionsRepository {
  create(input: CreateSessionInput): Promise<UploadSessionRecord>;
  getById(id: string): Promise<UploadSessionRecord | null>;
  /** Which chunk indices are stored — the answer that makes resume possible. */
  receivedIndices(sessionId: string): Promise<number[]>;
  /** Idempotent by (session, index): a re-sent chunk replaces, never duplicates. */
  putChunk(sessionId: string, index: number, bytes: Buffer): Promise<void>;
  markCompleted(sessionId: string, uploadId: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  /**
   * Reclaim sessions past their expiry.
   *
   * Called opportunistically on session creation rather than on a schedule:
   * there is no scheduler anywhere in this repository, and introducing one to
   * sweep a demo-scale table would be the larger change.
   */
  sweepExpired(): Promise<number>;
}

/**
 * Assemble a completed session's chunks into a stored blob.
 *
 * A port rather than repository code because the assembly is a single SQL
 * statement (`string_agg` over `bytea`, ordered by index) whose entire point is
 * that no file is ever materialized in Node — a detail that belongs next to the
 * blob store it writes into, alongside the existing `StoragePort`.
 */
export interface ChunkedStoragePort {
  assemble(
    sessionId: string,
    meta: { fileName: string; contentType: string; uploadedBy: string | null },
  ): Promise<{ id: string; sizeBytes: number }>;
}

/**
 * Folder grants, for the server-side predicate.
 *
 * `forFolderChain` returns the folder's own grants first, then each ancestor's
 * nearest-first — the shape `effectivePermissions` consumes, resolved in one
 * query rather than by walking the tree a level at a time.
 */
export interface FolderGrantsPort {
  forFolderChain(folderId: string): Promise<{
    own: ReadonlyArray<import("./access.js").FolderGrant>;
    ancestors: ReadonlyArray<ReadonlyArray<import("./access.js").FolderGrant>>;
  }>;
  groupIdsFor(userId: string): Promise<string[]>;
}

/** What the module needs to know about a document without owning the table. */
export interface DocumentRefPort {
  describe(documentId: string): Promise<{
    id: string;
    companyId: string;
    folderId: string;
    name: string;
    uploadId: string | null;
  } | null>;
  companyIdForFolder(folderId: string): Promise<string | null>;
  /** Repoint a document at a version, and keep its count honest. */
  setCurrentVersion(documentId: string, versionId: string, versionCount: number): Promise<void>;
  create(input: {
    companyId: string;
    folderId: string;
    name: string;
    uploadId: string;
    sizeBytes: number;
    ext: string;
    uploadedBy: string;
  }): Promise<{ id: string }>;
}

/** Emit a semantic activity event. No-op when the activity log is disabled. */
export interface DataRoomActivityPort {
  emit(event: {
    type:
      | "document.version.created"
      | "document.version.restored"
      | "document.comment.added";
    companyId: string;
    subjectId: string;
    actorId: string | null;
  }): void;
}

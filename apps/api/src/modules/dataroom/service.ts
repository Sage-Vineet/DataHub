import type { SessionUser } from "@datahub/contracts";
import type {
  CommentCreate,
  CommentResponse,
  DocumentVersionList,
  DocumentVersionResponse,
  UploadSessionComplete,
  UploadSessionCreate,
  UploadSessionResponse,
} from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { effectivePermissions } from "./access.js";
import type {
  ChunkedStoragePort,
  CommentRecord,
  CommentsRepository,
  DataRoomActivityPort,
  DocumentRefPort,
  FolderGrantsPort,
  DocumentVersionRecord,
  DocumentVersionsRepository,
  UploadSessionsRepository,
} from "./ports.js";

export interface DataRoomServiceDeps {
  versions: DocumentVersionsRepository;
  comments: CommentsRepository;
  sessions: UploadSessionsRepository;
  storage: ChunkedStoragePort;
  documents: DocumentRefPort;
  /**
   * Folder grants. Optional: omitted, the endpoints fall back to company scoping
   * alone, which is what the rest of the system does today.
   */
  grants?: FolderGrantsPort;
  activity?: DataRoomActivityPort;
}

/** Only the deal-owning side reads internal commentary. */
function isDealSide(user: SessionUser): boolean {
  return user.role === "broker" || user.role === "admin";
}

function toVersionResponse(
  v: DocumentVersionRecord,
  currentVersionId: string | null,
): DocumentVersionResponse {
  return {
    id: v.id,
    document_id: v.documentId,
    version_no: v.versionNo,
    upload_id: v.uploadId,
    file_name: v.fileName,
    size_bytes: v.sizeBytes,
    content_type: v.contentType,
    note: v.note,
    created_by: v.createdBy,
    created_at: v.createdAt,
    is_current: v.id === currentVersionId,
  };
}

function toCommentResponse(c: CommentRecord): CommentResponse {
  return {
    id: c.id,
    document_id: c.documentId,
    company_id: c.companyId,
    version_id: c.versionId,
    parent_id: c.parentId,
    body: c.body,
    visibility: c.visibility,
    page_number: c.pageNumber,
    author_id: c.authorId,
    author_name: c.authorName,
    created_at: c.createdAt,
  };
}

export class DataRoomService {
  private readonly deps: DataRoomServiceDeps;

  constructor(deps: DataRoomServiceDeps) {
    this.deps = deps;
  }

  /**
   * Resolve a document and prove the caller may reach it.
   *
   * Every entry point below goes through here. The tenant rule is the shared
   * `canAccessCompany`, so this module cannot drift from the one the rest of the
   * app enforces.
   */
  private async requireDocument(user: SessionUser, documentId: string) {
    const doc = await this.deps.documents.describe(documentId);
    if (!doc) throw new NotFoundError("Document not found.");
    if (!canAccessCompany(user, doc.companyId)) {
      throw new ForbiddenError("You do not have access to this document.");
    }
    // Folder grants, on the endpoints this module adds. Applying them to the
    // shipped folders and uploads routes would change behaviour with their flags
    // on while flag-off legacy still returned everything — see access.ts.
    if (this.deps.grants) {
      const [chain, groupIds] = await Promise.all([
        this.deps.grants.forFolderChain(doc.folderId),
        this.deps.grants.groupIdsFor(user.id),
      ]);
      const perms = effectivePermissions({
        user,
        groupIds,
        folderGrants: chain.own,
        ancestorGrants: chain.ancestors,
      });
      if (!perms.read) {
        throw new ForbiddenError("You do not have access to this document.");
      }
    }
    return doc;
  }

  private async requireFolder(user: SessionUser, folderId: string): Promise<string> {
    const companyId = await this.deps.documents.companyIdForFolder(folderId);
    if (!companyId) throw new NotFoundError("Folder not found.");
    if (!canAccessCompany(user, companyId)) {
      throw new ForbiddenError("You do not have access to this folder.");
    }
    return companyId;
  }

  // ── versions ──────────────────────────────────────────────────────────────

  async listVersions(user: SessionUser, documentId: string): Promise<DocumentVersionList> {
    await this.requireDocument(user, documentId);
    const [versions, current] = await Promise.all([
      this.deps.versions.listFor(documentId),
      this.deps.versions.currentFor(documentId),
    ]);
    return {
      document_id: documentId,
      version_count: current.versionCount,
      versions: versions.map((v) => toVersionResponse(v, current.currentVersionId)),
    };
  }

  /** The stored blob behind one version, for download or preview. */
  async versionUploadId(user: SessionUser, versionId: string): Promise<string> {
    const version = await this.deps.versions.getById(versionId);
    if (!version) throw new NotFoundError("Version not found.");
    await this.requireDocument(user, version.documentId);
    if (!version.uploadId) throw new NotFoundError("This version has no stored content.");
    return version.uploadId;
  }

  /**
   * Make an earlier version current again.
   *
   * Appends a NEW version carrying the old one's blob rather than moving the
   * pointer backwards. Two reasons: history stays append-only, so what a reader
   * saw at any past moment remains reconstructable; and restoring a 200 MB file
   * costs one row, because only the pointer is copied.
   */
  async restoreVersion(
    user: SessionUser,
    documentId: string,
    versionId: string,
    note: string | null,
  ): Promise<DocumentVersionResponse> {
    const doc = await this.requireDocument(user, documentId);
    const source = await this.deps.versions.getById(versionId);
    if (!source || source.documentId !== documentId) {
      throw new NotFoundError("Version not found on this document.");
    }

    const restored = await this.deps.versions.append({
      documentId,
      uploadId: source.uploadId,
      fileName: source.fileName,
      sizeBytes: source.sizeBytes,
      contentType: source.contentType,
      note: note ?? `Restored from v${source.versionNo}`,
      createdBy: user.id,
    });

    this.deps.activity?.emit({
      type: "document.version.restored",
      companyId: doc.companyId,
      subjectId: documentId,
      actorId: user.id,
    });

    const current = await this.deps.versions.currentFor(documentId);
    return toVersionResponse(restored, current.currentVersionId);
  }

  // ── comments ──────────────────────────────────────────────────────────────

  async listComments(user: SessionUser, documentId: string): Promise<CommentResponse[]> {
    await this.requireDocument(user, documentId);
    // The visibility rule is applied by the query, so an internal comment is
    // absent from the response rather than filtered by whoever renders it.
    const rows = await this.deps.comments.listFor(documentId, isDealSide(user));
    return rows.map(toCommentResponse);
  }

  async addComment(
    user: SessionUser,
    documentId: string,
    input: CommentCreate,
  ): Promise<CommentResponse> {
    const doc = await this.requireDocument(user, documentId);
    if (input.visibility === "internal" && !isDealSide(user)) {
      throw new ForbiddenError("Only the deal team can leave internal comments.");
    }
    const created = await this.deps.comments.create({
      documentId,
      companyId: doc.companyId,
      versionId: input.version_id ?? null,
      parentId: input.parent_id ?? null,
      body: input.body,
      visibility: input.visibility,
      pageNumber: input.page_number ?? null,
      authorId: user.id,
    });

    this.deps.activity?.emit({
      type: "document.comment.added",
      companyId: doc.companyId,
      subjectId: documentId,
      actorId: user.id,
    });

    return toCommentResponse(created);
  }

  async deleteComment(user: SessionUser, commentId: string): Promise<void> {
    const comment = await this.deps.comments.getById(commentId);
    if (!comment) throw new NotFoundError("Comment not found.");
    if (!canAccessCompany(user, comment.companyId)) {
      throw new ForbiddenError("You do not have access to this comment.");
    }
    // The author, or the deal-owning side. A counterparty cannot remove commentary
    // someone else left on evidence they both rely on.
    if (comment.authorId !== user.id && !isDealSide(user)) {
      throw new ForbiddenError("You can only delete your own comments.");
    }
    await this.deps.comments.softDelete(commentId);
  }

  // ── chunked upload ────────────────────────────────────────────────────────

  async openSession(
    user: SessionUser,
    input: UploadSessionCreate,
  ): Promise<UploadSessionResponse> {
    const companyId = await this.requireFolder(user, input.folder_id);

    // Naming a document makes this a new version of it; otherwise a same-name
    // upload into the folder is treated as one, which is what DR-0001 asks for.
    let documentId = input.document_id ?? null;
    if (documentId) {
      const doc = await this.requireDocument(user, documentId);
      if (doc.folderId !== input.folder_id) {
        throw new BadRequestError("That document is not in the folder you named.");
      }
    } else {
      const existing = await this.deps.versions.findDocumentByName(
        input.folder_id,
        input.file_name,
      );
      documentId = existing?.id ?? null;
    }

    await this.deps.sessions.sweepExpired();

    const session = await this.deps.sessions.create({
      companyId,
      folderId: input.folder_id,
      documentId,
      fileName: input.file_name,
      contentType: input.content_type,
      totalBytes: input.total_bytes,
      chunkSize: input.chunk_size,
      totalChunks: Math.ceil(input.total_bytes / input.chunk_size),
      createdBy: user.id,
    });
    return this.describeSession(session.id);
  }

  async describeSession(sessionId: string): Promise<UploadSessionResponse> {
    const session = await this.deps.sessions.getById(sessionId);
    if (!session) throw new NotFoundError("Upload session not found.");
    const received = await this.deps.sessions.receivedIndices(sessionId);
    return {
      id: session.id,
      status: session.status,
      file_name: session.fileName,
      content_type: session.contentType,
      total_bytes: session.totalBytes,
      chunk_size: session.chunkSize,
      total_chunks: session.totalChunks,
      received,
      document_id: session.documentId,
      upload_id: session.uploadId,
      expires_at: session.expiresAt,
    };
  }

  private async requireOpenSession(user: SessionUser, sessionId: string) {
    const session = await this.deps.sessions.getById(sessionId);
    if (!session) throw new NotFoundError("Upload session not found.");
    if (!session.companyId || !canAccessCompany(user, session.companyId)) {
      throw new ForbiddenError("You do not have access to this upload.");
    }
    if (session.status !== "open") {
      throw new BadRequestError(`This upload is already ${session.status}.`);
    }
    return session;
  }

  async getSession(user: SessionUser, sessionId: string): Promise<UploadSessionResponse> {
    const session = await this.deps.sessions.getById(sessionId);
    if (!session) throw new NotFoundError("Upload session not found.");
    if (!session.companyId || !canAccessCompany(user, session.companyId)) {
      throw new ForbiddenError("You do not have access to this upload.");
    }
    return this.describeSession(sessionId);
  }

  async putChunk(
    user: SessionUser,
    sessionId: string,
    index: number,
    bytes: Buffer,
  ): Promise<UploadSessionResponse> {
    const session = await this.requireOpenSession(user, sessionId);
    if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
      throw new BadRequestError(
        `Chunk index must be between 0 and ${session.totalChunks - 1}.`,
      );
    }
    if (bytes.length === 0) throw new BadRequestError("A chunk cannot be empty.");
    if (bytes.length > session.chunkSize) {
      throw new BadRequestError("Chunk is larger than the size this session agreed.");
    }
    // Idempotent: re-sending a chunk replaces it. That is what makes resume work
    // — the client asks which indices landed and sends only the rest.
    await this.deps.sessions.putChunk(sessionId, index, bytes);
    return this.describeSession(sessionId);
  }

  /**
   * Assemble the chunks into a stored blob and produce a document version.
   *
   * Refuses to complete while any chunk is missing. A file assembled from a
   * partial set would be silently corrupt — the worst possible outcome here,
   * because it looks like a success.
   */
  async completeSession(
    user: SessionUser,
    sessionId: string,
  ): Promise<UploadSessionComplete> {
    const session = await this.requireOpenSession(user, sessionId);
    const received = await this.deps.sessions.receivedIndices(sessionId);
    if (received.length !== session.totalChunks) {
      const missing = [];
      for (let i = 0; i < session.totalChunks; i++) {
        if (!received.includes(i)) missing.push(i);
      }
      throw new BadRequestError(
        `Upload is incomplete — ${missing.length} chunk(s) missing, starting at ${missing[0]}.`,
      );
    }

    const blob = await this.deps.storage.assemble(sessionId, {
      fileName: session.fileName,
      contentType: session.contentType,
      uploadedBy: user.id,
    });

    let documentId = session.documentId;
    if (!documentId) {
      const created = await this.deps.documents.create({
        companyId: session.companyId!,
        folderId: session.folderId!,
        name: session.fileName,
        uploadId: blob.id,
        sizeBytes: blob.sizeBytes,
        ext: session.fileName.includes(".") ? session.fileName.split(".").pop()! : "",
        uploadedBy: user.id,
      });
      documentId = created.id;
    }

    const version = await this.deps.versions.append({
      documentId,
      uploadId: blob.id,
      fileName: session.fileName,
      sizeBytes: blob.sizeBytes,
      contentType: session.contentType,
      note: null,
      createdBy: user.id,
    });

    await this.deps.sessions.markCompleted(sessionId, blob.id);

    this.deps.activity?.emit({
      type: "document.version.created",
      companyId: session.companyId!,
      subjectId: documentId,
      actorId: user.id,
    });

    return {
      document_id: documentId,
      upload_id: blob.id,
      version_no: version.versionNo,
      version_id: version.id,
    };
  }

  async abortSession(user: SessionUser, sessionId: string): Promise<void> {
    await this.requireOpenSession(user, sessionId);
    await this.deps.sessions.abort(sessionId);
  }
}

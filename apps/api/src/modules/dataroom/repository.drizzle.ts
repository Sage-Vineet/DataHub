import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { CommentVisibility } from "@datahub/contracts";
import type {
  AppendVersionInput,
  ChunkedStoragePort,
  CommentRecord,
  CommentsRepository,
  CreateCommentInput,
  CreateSessionInput,
  DocumentRefPort,
  DocumentVersionRecord,
  DocumentVersionsRepository,
  UploadSessionRecord,
  UploadSessionsRepository,
} from "./ports.js";

const {
  documentComments,
  documentVersions,
  documents,
  folders,
  uploadChunks,
  uploadSessions,
  uploads,
  users,
} = schema;

const iso = (value: Date | string | null): string =>
  value === null ? "" : value instanceof Date ? value.toISOString() : value;

export class DrizzleDocumentVersionsRepository implements DocumentVersionsRepository {
  constructor(private readonly db: Db) {}

  async listFor(documentId: string): Promise<DocumentVersionRecord[]> {
    const rows = await this.db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(desc(documentVersions.versionNo));
    return rows.map(toVersion);
  }

  async getById(versionId: string): Promise<DocumentVersionRecord | null> {
    const rows = await this.db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.id, versionId))
      .limit(1);
    return rows[0] ? toVersion(rows[0]) : null;
  }

  /**
   * Append a version and repoint the document, in one transaction.
   *
   * The version number is allocated from what is already stored rather than from
   * anything the caller passed. Two uploads of the same file racing must not be
   * able to agree on a number — the unique index on (document_id, version_no)
   * makes the loser fail rather than silently overwrite, and doing the read and
   * the write in one transaction is what keeps that from being the common case.
   */
  async append(input: AppendVersionInput): Promise<DocumentVersionRecord> {
    return this.db.transaction(async (tx) => {
      const [next] = await tx
        .select({ n: sql<number>`coalesce(max(${documentVersions.versionNo}), 0) + 1` })
        .from(documentVersions)
        .where(eq(documentVersions.documentId, input.documentId));
      const versionNo = Number(next?.n ?? 1);

      const [row] = await tx
        .insert(documentVersions)
        .values({
          documentId: input.documentId,
          versionNo,
          uploadId: input.uploadId,
          fileName: input.fileName,
          sizeBytes: input.sizeBytes,
          contentType: input.contentType,
          note: input.note,
          createdBy: input.createdBy,
        })
        .returning();

      await tx
        .update(documents)
        .set({
          currentVersionId: row!.id,
          versionCount: versionNo,
          uploadId: input.uploadId,
        })
        .where(eq(documents.id, input.documentId));

      return toVersion(row!);
    });
  }

  async currentFor(documentId: string) {
    const rows = await this.db
      .select({
        currentVersionId: documents.currentVersionId,
        versionCount: documents.versionCount,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    return {
      currentVersionId: rows[0]?.currentVersionId ?? null,
      versionCount: rows[0]?.versionCount ?? 0,
    };
  }

  async findDocumentByName(folderId: string, name: string): Promise<{ id: string } | null> {
    const rows = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.folderId, folderId),
          eq(documents.name, name),
          isNull(documents.archivedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}

function toVersion(row: typeof documentVersions.$inferSelect): DocumentVersionRecord {
  return {
    id: row.id,
    documentId: row.documentId,
    versionNo: row.versionNo,
    uploadId: row.uploadId,
    fileName: row.fileName,
    sizeBytes: Number(row.sizeBytes),
    contentType: row.contentType,
    note: row.note,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
  };
}

export class DrizzleCommentsRepository implements CommentsRepository {
  constructor(private readonly db: Db) {}

  /**
   * Visibility is a WHERE clause, not a post-filter.
   *
   * An internal comment must be absent from a counterparty's response, not
   * present and hidden by whoever renders it. This codebase already contains the
   * other version of that mistake once — `folder_access` grants are stored
   * server-side and honoured only in the browser — and it is not repeated here.
   */
  async listFor(documentId: string, includeInternal: boolean): Promise<CommentRecord[]> {
    const visible = includeInternal
      ? undefined
      : eq(documentComments.visibility, "shared" satisfies CommentVisibility);
    const rows = await this.db
      .select({ comment: documentComments, authorName: users.name })
      .from(documentComments)
      .leftJoin(users, eq(users.id, documentComments.authorId))
      .where(
        and(
          eq(documentComments.documentId, documentId),
          isNull(documentComments.deletedAt),
          ...(visible ? [visible] : []),
        ),
      )
      .orderBy(asc(documentComments.createdAt));
    return rows.map((r) => toComment(r.comment, r.authorName));
  }

  async create(input: CreateCommentInput): Promise<CommentRecord> {
    const [row] = await this.db
      .insert(documentComments)
      .values({
        documentId: input.documentId,
        companyId: input.companyId,
        versionId: input.versionId,
        parentId: input.parentId,
        body: input.body,
        visibility: input.visibility,
        pageNumber: input.pageNumber,
        authorId: input.authorId,
      })
      .returning();
    const names = await this.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, input.authorId))
      .limit(1);
    return toComment(row!, names[0]?.name ?? null);
  }

  async getById(id: string): Promise<CommentRecord | null> {
    const rows = await this.db
      .select({ comment: documentComments, authorName: users.name })
      .from(documentComments)
      .leftJoin(users, eq(users.id, documentComments.authorId))
      .where(and(eq(documentComments.id, id), isNull(documentComments.deletedAt)))
      .limit(1);
    return rows[0] ? toComment(rows[0].comment, rows[0].authorName) : null;
  }

  /** Soft delete: the thread keeps its shape and the audit trail keeps its subject. */
  async softDelete(id: string): Promise<void> {
    await this.db
      .update(documentComments)
      .set({ deletedAt: new Date() })
      .where(eq(documentComments.id, id));
  }
}

function toComment(
  row: typeof documentComments.$inferSelect,
  authorName: string | null,
): CommentRecord {
  return {
    id: row.id,
    documentId: row.documentId,
    companyId: row.companyId,
    versionId: row.versionId,
    parentId: row.parentId,
    body: row.body,
    visibility: row.visibility as CommentVisibility,
    pageNumber: row.pageNumber,
    authorId: row.authorId,
    authorName,
    createdAt: iso(row.createdAt),
  };
}

export class DrizzleUploadSessionsRepository implements UploadSessionsRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreateSessionInput): Promise<UploadSessionRecord> {
    const [row] = await this.db
      .insert(uploadSessions)
      .values({
        companyId: input.companyId,
        folderId: input.folderId,
        documentId: input.documentId,
        fileName: input.fileName,
        contentType: input.contentType,
        totalBytes: input.totalBytes,
        chunkSize: input.chunkSize,
        totalChunks: input.totalChunks,
        createdBy: input.createdBy,
        expiresAt: new Date(Date.now() + 6 * 3600_000),
      })
      .returning();
    return toSession(row!);
  }

  async getById(id: string): Promise<UploadSessionRecord | null> {
    const rows = await this.db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, id))
      .limit(1);
    return rows[0] ? toSession(rows[0]) : null;
  }

  async receivedIndices(sessionId: string): Promise<number[]> {
    const rows = await this.db
      .select({ chunkIndex: uploadChunks.chunkIndex })
      .from(uploadChunks)
      .where(eq(uploadChunks.sessionId, sessionId))
      .orderBy(asc(uploadChunks.chunkIndex));
    return rows.map((r) => r.chunkIndex);
  }

  /**
   * Store one chunk, idempotently.
   *
   * The upsert on (session_id, chunk_index) is what makes resume free: a client
   * that lost its connection re-sends whatever it is unsure about, and a chunk
   * that already landed is simply replaced rather than duplicated or rejected.
   */
  async putChunk(sessionId: string, index: number, bytes: Buffer): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(uploadChunks)
        .values({ sessionId, chunkIndex: index, sizeBytes: bytes.length, data: bytes })
        .onConflictDoUpdate({
          target: [uploadChunks.sessionId, uploadChunks.chunkIndex],
          set: { data: bytes, sizeBytes: bytes.length, receivedAt: new Date() },
        });
      await tx
        .update(uploadSessions)
        .set({
          receivedCount: sql`(SELECT count(*)::int FROM ${uploadChunks} WHERE ${uploadChunks.sessionId} = ${sessionId})`,
          updatedAt: new Date(),
        })
        .where(eq(uploadSessions.id, sessionId));
    });
  }

  async markCompleted(sessionId: string, uploadId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(uploadSessions)
        .set({ status: "completed", uploadId, updatedAt: new Date() })
        .where(eq(uploadSessions.id, sessionId));
      // Chunk bytes do not outlive the session: leaving them would double the
      // storage cost of every upload for no benefit.
      await tx.delete(uploadChunks).where(eq(uploadChunks.sessionId, sessionId));
    });
  }

  async abort(sessionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(uploadSessions)
        .set({ status: "aborted", updatedAt: new Date() })
        .where(eq(uploadSessions.id, sessionId));
      await tx.delete(uploadChunks).where(eq(uploadChunks.sessionId, sessionId));
    });
  }

  /**
   * Reclaim sessions past their expiry, chunks cascading with them.
   *
   * Called opportunistically when a session opens rather than on a schedule.
   * There is no scheduler anywhere in this repository, and adding one to sweep a
   * table this size would be the larger change by some margin.
   */
  async sweepExpired(): Promise<number> {
    const rows = await this.db
      .delete(uploadSessions)
      .where(
        and(
          or(eq(uploadSessions.status, "open"), eq(uploadSessions.status, "aborted")),
          lt(uploadSessions.expiresAt, new Date()),
        ),
      )
      .returning({ id: uploadSessions.id });
    return rows.length;
  }
}

function toSession(row: typeof uploadSessions.$inferSelect): UploadSessionRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    folderId: row.folderId,
    documentId: row.documentId,
    fileName: row.fileName,
    contentType: row.contentType,
    totalBytes: Number(row.totalBytes),
    chunkSize: row.chunkSize,
    totalChunks: row.totalChunks,
    receivedCount: row.receivedCount,
    status: row.status as UploadSessionRecord["status"],
    uploadId: row.uploadId,
    createdBy: row.createdBy,
    expiresAt: iso(row.expiresAt),
  };
}

/**
 * Assemble a session's chunks into an `uploads` row.
 *
 * One statement, and that is the entire point: `string_agg(data, '' ORDER BY
 * chunk_index)` concatenates in the database, so a 200 MB upload is never
 * materialized in Node. Streaming it through the process would put the API's
 * memory ceiling in the path of every large file — which, on a machine also
 * serving a demo, is how one upload takes everything else down with it.
 */
export class DrizzleChunkedStoragePort implements ChunkedStoragePort {
  constructor(private readonly db: Db) {}

  async assemble(
    sessionId: string,
    meta: { fileName: string; contentType: string; uploadedBy: string | null },
  ): Promise<{ id: string; sizeBytes: number }> {
    const rows = await this.db.execute<{ id: string; size_bytes: number }>(sql`
      INSERT INTO ${uploads} (file_name, content_type, size_bytes, data, uploaded_by, prefix)
      SELECT ${meta.fileName}, ${meta.contentType},
             sum(${uploadChunks.sizeBytes})::int,
             string_agg(${uploadChunks.data}, ''::bytea ORDER BY ${uploadChunks.chunkIndex}),
             ${meta.uploadedBy}, 'documents'
      FROM ${uploadChunks}
      WHERE ${uploadChunks.sessionId} = ${sessionId}
      RETURNING id, size_bytes
    `);
    const row = (rows as unknown as { rows?: Array<{ id: string; size_bytes: number }> }).rows
      ? (rows as unknown as { rows: Array<{ id: string; size_bytes: number }> }).rows[0]
      : (rows as unknown as Array<{ id: string; size_bytes: number }>)[0];
    if (!row) throw new Error("assembly produced no upload row");
    return { id: row.id, sizeBytes: Number(row.size_bytes) };
  }
}

export class DrizzleDocumentRefPort implements DocumentRefPort {
  constructor(private readonly db: Db) {}

  async describe(documentId: string) {
    const rows = await this.db
      .select({
        id: documents.id,
        companyId: documents.companyId,
        folderId: documents.folderId,
        name: documents.name,
        uploadId: documents.uploadId,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    return rows[0] ?? null;
  }

  async companyIdForFolder(folderId: string): Promise<string | null> {
    const rows = await this.db
      .select({ companyId: folders.companyId })
      .from(folders)
      .where(eq(folders.id, folderId))
      .limit(1);
    return rows[0]?.companyId ?? null;
  }

  async setCurrentVersion(
    documentId: string,
    versionId: string,
    versionCount: number,
  ): Promise<void> {
    await this.db
      .update(documents)
      .set({ currentVersionId: versionId, versionCount })
      .where(eq(documents.id, documentId));
  }

  async create(input: {
    companyId: string;
    folderId: string;
    name: string;
    uploadId: string;
    sizeBytes: number;
    ext: string;
    uploadedBy: string;
  }): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(documents)
      .values({
        companyId: input.companyId,
        folderId: input.folderId,
        name: input.name,
        uploadId: input.uploadId,
        // `documents.size` is a text column in the legacy schema — a display
        // string, not a number. Kept as-is rather than reconciled here.
        size: String(input.sizeBytes),
        ext: input.ext,
        fileUrl: null,
        uploadedBy: input.uploadedBy,
        versionCount: 0,
      })
      .returning({ id: documents.id });
    return { id: row!.id };
  }
}

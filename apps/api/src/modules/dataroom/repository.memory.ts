import { randomUUID } from "node:crypto";
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

/**
 * In-memory adapters for the service suite.
 *
 * One shared store, five small adapters over it — rather than one class
 * implementing all five ports, which cannot work: `listFor` and `create` mean
 * different things to the versions, comments and sessions repositories, and a
 * single class can only have one of each. That is also how the Drizzle side is
 * arranged, where one connection backs several repositories.
 *
 * The store models the parts of the database the service depends on for
 * correctness — version-number allocation, the current-version pointer,
 * visibility filtering in the query, and chunk idempotency — so a passing service
 * test is testing behaviour rather than a stub agreeing with itself.
 */

export interface MemDocument {
  id: string;
  companyId: string;
  folderId: string;
  name: string;
  uploadId: string | null;
  currentVersionId: string | null;
  versionCount: number;
}

export class DataRoomStore {
  readonly documents = new Map<string, MemDocument>();
  readonly folders = new Map<string, string>();
  readonly versions: DocumentVersionRecord[] = [];
  readonly comments: CommentRecord[] = [];
  readonly sessions = new Map<string, UploadSessionRecord>();
  readonly chunks = new Map<string, Map<number, Buffer>>();
  readonly blobs = new Map<string, Buffer>();
  readonly names = new Map<string, string>();
  /** How many times the expiry sweep ran, so a test can assert it did. */
  swept = 0;
  private clock = 0;

  /** Monotonic and distinct, so ordering assertions do not depend on clock resolution. */
  now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  futureIso(ms: number): string {
    return new Date(this.clock + ms).toISOString();
  }

  seedFolder(folderId: string, companyId: string): void {
    this.folders.set(folderId, companyId);
  }

  seedDocument(doc: {
    id: string;
    companyId: string;
    folderId: string;
    name: string;
    uploadId?: string | null;
  }): MemDocument {
    const record: MemDocument = {
      id: doc.id,
      companyId: doc.companyId,
      folderId: doc.folderId,
      name: doc.name,
      uploadId: doc.uploadId ?? null,
      currentVersionId: null,
      versionCount: 0,
    };
    this.documents.set(doc.id, record);
    this.folders.set(doc.folderId, doc.companyId);
    return record;
  }

  seedUserName(userId: string, name: string): void {
    this.names.set(userId, name);
  }
}

export class MemoryVersionsRepository implements DocumentVersionsRepository {
  constructor(private readonly store: DataRoomStore) {}

  async listFor(documentId: string): Promise<DocumentVersionRecord[]> {
    return this.store.versions
      .filter((v) => v.documentId === documentId)
      .sort((a, b) => b.versionNo - a.versionNo);
  }

  async getById(versionId: string): Promise<DocumentVersionRecord | null> {
    return this.store.versions.find((v) => v.id === versionId) ?? null;
  }

  async append(input: AppendVersionInput): Promise<DocumentVersionRecord> {
    const doc = this.store.documents.get(input.documentId);
    if (!doc) throw new Error(`no such document ${input.documentId}`);
    // Allocation lives with the store, mirroring the real repository: the number
    // is derived from what is already stored, never from a caller's count.
    const versionNo =
      this.store.versions.filter((v) => v.documentId === input.documentId).length + 1;
    const record: DocumentVersionRecord = {
      id: randomUUID(),
      documentId: input.documentId,
      versionNo,
      uploadId: input.uploadId,
      fileName: input.fileName,
      sizeBytes: input.sizeBytes,
      contentType: input.contentType,
      note: input.note,
      createdBy: input.createdBy,
      createdAt: this.store.now(),
    };
    this.store.versions.push(record);
    doc.currentVersionId = record.id;
    doc.versionCount = versionNo;
    doc.uploadId = input.uploadId;
    return record;
  }

  async currentFor(documentId: string) {
    const doc = this.store.documents.get(documentId);
    return {
      currentVersionId: doc?.currentVersionId ?? null,
      versionCount: doc?.versionCount ?? 0,
    };
  }

  async findDocumentByName(folderId: string, name: string): Promise<{ id: string } | null> {
    for (const doc of this.store.documents.values()) {
      if (doc.folderId === folderId && doc.name === name) return { id: doc.id };
    }
    return null;
  }
}

export class MemoryCommentsRepository implements CommentsRepository {
  constructor(private readonly store: DataRoomStore) {}

  async listFor(documentId: string, includeInternal: boolean): Promise<CommentRecord[]> {
    // Filtering here stands in for the WHERE clause, so a service test proves the
    // internal comment never leaves the store rather than being hidden later.
    return this.store.comments.filter(
      (c) => c.documentId === documentId && (includeInternal || c.visibility === "shared"),
    );
  }

  async create(input: CreateCommentInput): Promise<CommentRecord> {
    const record: CommentRecord = {
      id: randomUUID(),
      documentId: input.documentId,
      companyId: input.companyId,
      versionId: input.versionId,
      parentId: input.parentId,
      body: input.body,
      visibility: input.visibility,
      pageNumber: input.pageNumber,
      authorId: input.authorId,
      authorName: this.store.names.get(input.authorId) ?? null,
      createdAt: this.store.now(),
    };
    this.store.comments.push(record);
    return record;
  }

  async getById(id: string): Promise<CommentRecord | null> {
    return this.store.comments.find((c) => c.id === id) ?? null;
  }

  async softDelete(id: string): Promise<void> {
    const index = this.store.comments.findIndex((c) => c.id === id);
    if (index >= 0) this.store.comments.splice(index, 1);
  }
}

export class MemorySessionsRepository implements UploadSessionsRepository {
  constructor(private readonly store: DataRoomStore) {}

  async create(input: CreateSessionInput): Promise<UploadSessionRecord> {
    const record: UploadSessionRecord = {
      id: randomUUID(),
      companyId: input.companyId,
      folderId: input.folderId,
      documentId: input.documentId,
      fileName: input.fileName,
      contentType: input.contentType,
      totalBytes: input.totalBytes,
      chunkSize: input.chunkSize,
      totalChunks: input.totalChunks,
      receivedCount: 0,
      status: "open",
      uploadId: null,
      createdBy: input.createdBy,
      expiresAt: this.store.futureIso(6 * 3600_000),
    };
    this.store.sessions.set(record.id, record);
    this.store.chunks.set(record.id, new Map());
    return record;
  }

  async getById(id: string): Promise<UploadSessionRecord | null> {
    return this.store.sessions.get(id) ?? null;
  }

  async receivedIndices(sessionId: string): Promise<number[]> {
    return [...(this.store.chunks.get(sessionId)?.keys() ?? [])].sort((a, b) => a - b);
  }

  async putChunk(sessionId: string, index: number, bytes: Buffer): Promise<void> {
    const map = this.store.chunks.get(sessionId);
    if (!map) throw new Error(`no such session ${sessionId}`);
    map.set(index, bytes);
    const session = this.store.sessions.get(sessionId);
    if (session) session.receivedCount = map.size;
  }

  async markCompleted(sessionId: string, uploadId: string): Promise<void> {
    const session = this.store.sessions.get(sessionId);
    if (!session) return;
    session.status = "completed";
    session.uploadId = uploadId;
    // Chunk bytes do not outlive the session they belonged to.
    this.store.chunks.delete(sessionId);
  }

  async abort(sessionId: string): Promise<void> {
    const session = this.store.sessions.get(sessionId);
    if (!session) return;
    session.status = "aborted";
    this.store.chunks.delete(sessionId);
  }

  async sweepExpired(): Promise<number> {
    this.store.swept += 1;
    return 0;
  }
}

export class MemoryChunkedStorage implements ChunkedStoragePort {
  constructor(private readonly store: DataRoomStore) {}

  async assemble(sessionId: string): Promise<{ id: string; sizeBytes: number }> {
    const map = this.store.chunks.get(sessionId);
    if (!map) throw new Error(`no chunks for session ${sessionId}`);
    // Ordered by index, never by arrival — the property the SQL `string_agg …
    // ORDER BY chunk_index` exists to guarantee, asserted on this side too.
    const ordered = [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    const bytes = Buffer.concat(ordered);
    const id = randomUUID();
    this.store.blobs.set(id, bytes);
    return { id, sizeBytes: bytes.length };
  }
}

export class MemoryDocumentRef implements DocumentRefPort {
  constructor(private readonly store: DataRoomStore) {}

  async describe(documentId: string) {
    const doc = this.store.documents.get(documentId);
    if (!doc) return null;
    return {
      id: doc.id,
      companyId: doc.companyId,
      folderId: doc.folderId,
      name: doc.name,
      uploadId: doc.uploadId,
    };
  }

  async companyIdForFolder(folderId: string): Promise<string | null> {
    return this.store.folders.get(folderId) ?? null;
  }

  async setCurrentVersion(
    documentId: string,
    versionId: string,
    versionCount: number,
  ): Promise<void> {
    const doc = this.store.documents.get(documentId);
    if (!doc) return;
    doc.currentVersionId = versionId;
    doc.versionCount = versionCount;
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
    const id = randomUUID();
    this.store.seedDocument({
      id,
      companyId: input.companyId,
      folderId: input.folderId,
      name: input.name,
      uploadId: input.uploadId,
    });
    return { id };
  }
}

/** One store, five adapters — the shape the service is composed with. */
export function memoryDataRoom(store = new DataRoomStore()) {
  return {
    store,
    versions: new MemoryVersionsRepository(store),
    comments: new MemoryCommentsRepository(store),
    sessions: new MemorySessionsRepository(store),
    storage: new MemoryChunkedStorage(store),
    documents: new MemoryDocumentRef(store),
  };
}

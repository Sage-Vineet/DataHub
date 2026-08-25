import type { FolderAccessGrant } from "./folder-access.js";
import { randomUUID } from "node:crypto";
import type {
  ActivityRecord,
  CreateDocumentInput,
  DocumentRecord,
  DocumentsRepository,
  FolderRefPort,
  StoragePort,
  StoredBlob,
  StoredBlobMeta,
  UploadMeta,
} from "./ports.js";

/** In-memory `DocumentsRepository` for tests. */
export class InMemoryDocumentsRepository implements DocumentsRepository {
  private readonly docs = new Map<string, DocumentRecord>();
  private readonly activity = new Map<string, ActivityRecord>();

  seed(doc: DocumentRecord): DocumentRecord {
    this.docs.set(doc.id, doc);
    return doc;
  }

  async createDocument(input: CreateDocumentInput): Promise<DocumentRecord> {
    const record: DocumentRecord = {
      id: randomUUID(),
      archivedAt: null,
      uploadedAt: new Date().toISOString(),
      ...input,
    };
    this.docs.set(record.id, record);
    return record;
  }

  async listByFolder(folderId: string, includeArchived: boolean): Promise<DocumentRecord[]> {
    return [...this.docs.values()].filter(
      (d) => d.folderId === folderId && (includeArchived || d.archivedAt === null),
    );
  }

  async getById(id: string): Promise<DocumentRecord | null> {
    return this.docs.get(id) ?? null;
  }

  async findByUploadId(uploadId: string): Promise<DocumentRecord | null> {
    for (const doc of this.docs.values()) if (doc.uploadId === uploadId) return doc;
    return null;
  }

  async delete(id: string): Promise<void> {
    this.docs.delete(id);
    for (const [aid, a] of this.activity) if (a.documentId === id) this.activity.delete(aid);
  }

  async setArchived(id: string, archived: boolean): Promise<DocumentRecord | null> {
    const d = this.docs.get(id);
    if (!d) return null;
    const updated = { ...d, archivedAt: archived ? new Date(0).toISOString() : null };
    this.docs.set(id, updated);
    return updated;
  }

  async appendActivity(documentId: string, actorId: string | null, action: string): Promise<ActivityRecord> {
    const record: ActivityRecord = { id: randomUUID(), documentId, actorId, action, at: new Date(0).toISOString() };
    this.activity.set(record.id, record);
    return record;
  }

  async listActivity(documentId: string): Promise<ActivityRecord[]> {
    return [...this.activity.values()].filter((a) => a.documentId === documentId);
  }
}

/** In-memory `StoragePort` for tests — keeps blobs in a Map. */
export class InMemoryStoragePort implements StoragePort {
  private readonly blobs = new Map<string, StoredBlob>();

  async put(bytes: Buffer, meta: StoredBlobMeta): Promise<UploadMeta> {
    const id = randomUUID();
    this.blobs.set(id, { fileName: meta.fileName, contentType: meta.contentType, bytes });
    return { id, fileName: meta.fileName, contentType: meta.contentType, sizeBytes: bytes.length };
  }

  async get(uploadId: string): Promise<StoredBlob | null> {
    return this.blobs.get(uploadId) ?? null;
  }
}

/** In-memory `FolderRefPort` for tests. */
export class InMemoryFolderRefPort implements FolderRefPort {
  private readonly map = new Map<string, string>();
  private readonly parents = new Map<string, string>();
  private readonly grants: FolderAccessGrant[] = [];
  private readonly groups = new Map<string, string[]>();

  set(folderId: string, companyId: string, parentId?: string): void {
    this.map.set(folderId, companyId);
    if (parentId) this.parents.set(folderId, parentId);
  }
  grant(entry: FolderAccessGrant): void {
    this.grants.push(entry);
  }
  joinGroup(userId: string, groupId: string): void {
    this.groups.set(userId, [...(this.groups.get(userId) ?? []), groupId]);
  }

  async companyIdFor(folderId: string): Promise<string | null> {
    return this.map.get(folderId) ?? null;
  }
  async ancestryOf(folderId: string): Promise<string[]> {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = folderId;
    while (current && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      current = this.parents.get(current);
    }
    return chain;
  }
  async grantsFor(folderIds: readonly string[]): Promise<FolderAccessGrant[]> {
    return this.grants.filter((entry) => folderIds.includes(entry.folderId));
  }
  async groupIdsFor(userId: string): Promise<string[]> {
    return this.groups.get(userId) ?? [];
  }
}

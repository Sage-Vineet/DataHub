import { and, asc, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { DocumentStatus } from "@datahub/contracts";
import type {
  ActivityRecord,
  CreateDocumentInput,
  DocumentRecord,
  DocumentsRepository,
} from "./ports.js";

const { documents, documentActivity } = schema;
type DocRow = typeof documents.$inferSelect;
type ActRow = typeof documentActivity.$inferSelect;

function toDoc(row: DocRow): DocumentRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    folderId: row.folderId,
    name: row.name,
    fileUrl: row.fileUrl,
    uploadId: row.uploadId,
    size: row.size,
    ext: row.ext,
    status: row.status as DocumentStatus,
    uploadedBy: row.uploadedBy,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

function toActivity(row: ActRow): ActivityRecord {
  return {
    id: row.id,
    documentId: row.documentId,
    actorId: row.actorId,
    action: row.action,
    at: row.at.toISOString(),
  };
}

export class DrizzleDocumentsRepository implements DocumentsRepository {
  constructor(private readonly db: Db) {}

  async createDocument(input: CreateDocumentInput): Promise<DocumentRecord> {
    const rows = await this.db
      .insert(documents)
      .values({
        companyId: input.companyId,
        folderId: input.folderId,
        name: input.name,
        fileUrl: input.fileUrl,
        uploadId: input.uploadId,
        size: input.size,
        ext: input.ext,
        status: input.status,
        uploadedBy: input.uploadedBy,
      })
      .returning();
    return toDoc(rows[0]!);
  }

  async listByFolder(folderId: string, includeArchived: boolean): Promise<DocumentRecord[]> {
    const where = includeArchived
      ? eq(documents.folderId, folderId)
      : and(eq(documents.folderId, folderId), isNull(documents.archivedAt));
    const rows = await this.db.select().from(documents).where(where).orderBy(asc(documents.uploadedAt));
    return rows.map(toDoc);
  }

  async getById(id: string): Promise<DocumentRecord | null> {
    const rows = await this.db.select().from(documents).where(eq(documents.id, id)).limit(1);
    return rows[0] ? toDoc(rows[0]) : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(documents).where(eq(documents.id, id));
  }

  async setArchived(id: string, archived: boolean): Promise<DocumentRecord | null> {
    const rows = await this.db
      .update(documents)
      .set({ archivedAt: archived ? new Date() : null })
      .where(eq(documents.id, id))
      .returning();
    return rows[0] ? toDoc(rows[0]) : null;
  }

  async appendActivity(documentId: string, actorId: string | null, action: string): Promise<ActivityRecord> {
    const rows = await this.db
      .insert(documentActivity)
      .values({ documentId, actorId, action })
      .returning();
    return toActivity(rows[0]!);
  }

  async listActivity(documentId: string): Promise<ActivityRecord[]> {
    const rows = await this.db
      .select()
      .from(documentActivity)
      .where(eq(documentActivity.documentId, documentId))
      .orderBy(asc(documentActivity.at));
    return rows.map(toActivity);
  }
}

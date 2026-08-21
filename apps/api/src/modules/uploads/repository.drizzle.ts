import { and, asc, eq, isNull, sql } from "drizzle-orm";
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

  /**
   * Write BOTH generations of columns, in one row, with raw SQL.
   *
   * `document_activity` carries legacy's `user_id` + `activity_type` (both NOT
   * NULL, the second a `document_activity_type` enum) alongside this module's
   * `actor_id` + `action` + `at`. packages/db declares only the second set, so
   * a Drizzle insert leaves legacy's NOT NULL columns empty and every write
   * fails — which is exactly what it did: `POST /documents/:id/activity` was a
   * 500 in production while the read returned a healthy-looking empty list.
   *
   * Writing one set and not the other is not an option while both engines are
   * live: legacy reads `activity_type`, this module reads `action`, and a row
   * carrying only one is invisible to the other side's view of the same file.
   * The two vocabularies happen to be identical (`view | download`), so one row
   * satisfies both honestly rather than by coincidence.
   *
   * Raw SQL rather than widening the Drizzle model, for the same reason
   * `dataroom-versions-comments` design D4a gives for `document_status`: the
   * model describes the schema we are migrating toward, and these columns are
   * ones we are migrating away from. Both disappear together when legacy's
   * document handlers are retired.
   */
  async appendActivity(documentId: string, actorId: string | null, action: string): Promise<ActivityRecord> {
    const rows = await this.db.execute<ActRow>(sql`
      INSERT INTO document_activity (document_id, actor_id, action, user_id, activity_type)
      VALUES (${documentId}, ${actorId}, ${action}, ${actorId}, ${action}::document_activity_type)
      RETURNING id, document_id AS "documentId", actor_id AS "actorId", action, at
    `);
    const row = (Array.isArray(rows) ? rows[0] : rows.rows?.[0]) as ActRow | undefined;
    if (!row) throw new Error("document_activity insert returned no row.");
    return toActivity({ ...row, at: new Date(row.at as unknown as string) });
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

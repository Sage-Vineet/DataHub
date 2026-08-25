import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { DocumentStatus } from "@datahub/contracts";
import type {
  ActivityRecord,
  CreateDocumentInput,
  DocumentRecord,
  DocumentsRepository,
} from "./ports.js";

const { documents, documentActivity, users } = schema;
type DocRow = typeof documents.$inferSelect;
type ActRow = typeof documentActivity.$inferSelect;

/**
 * A timestamp as ISO text, whatever the driver handed back.
 *
 * `createDocument` goes through raw SQL rather than the query builder, and
 * there the driver returns a timestamp as a STRING while the builder returns a
 * Date. Calling `.toISOString()` on the string throws — which surfaced as a
 * 500 on every document creation, from a mapper that looked obviously correct.
 */
function toIsoString(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

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
    uploadedAt: toIsoString(row.uploadedAt),
    archivedAt: toIsoString(row.archivedAt),
  };
}

function toActivity(row: ActRow): ActivityRecord {
  return {
    id: row.id,
    documentId: row.documentId,
    actorId: row.actorId,
    // The column is nullable and every writer supplies one, so this is only
    // ever a row that predates the writer. An activity with no action cannot
    // be rendered either way.
    action: row.action ?? "",
    at: row.at.toISOString(),
  };
}

export class DrizzleDocumentsRepository implements DocumentsRepository {
  constructor(private readonly db: Db) {}

  /**
   * Raw SQL for the same reason `dataroom` uses it (design D4a), and this is the
   * path that never got the fix.
   *
   * Two columns make a Drizzle insert impossible against the deployed schema:
   *
   *   `status`    NOT NULL with no default, and the deployed `document_status`
   *               enum is `verified | under-review | rejected` while packages/db
   *               declares `active | processing | error` — no value in common.
   *               The service's `?? "active"` default is therefore a label the
   *               column rejects outright.
   *   `file_url`  NOT NULL with no default, while the service passes
   *               `?? null` when a caller does not supply one.
   *
   * Either alone is fatal. The result was that POST /folders/:id/documents —
   * the plain, non-chunked upload path — 500'd in production while its tests
   * passed, because the test DDL declared file_url nullable and status as free
   * text. The chunked path went through `dataroom`, which had been fixed, so the
   * single-shot fallback that docs/DEMO_FREEZE_CHECKLIST.md offers as the safe
   * option when resumable upload is switched off was the broken one.
   *
   * `''` and `'under-review'` are exactly what dataroom writes, so a document
   * created either way is now the same row.
   */
  async createDocument(input: CreateDocumentInput): Promise<DocumentRecord> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute<DocRow>(sql`
        INSERT INTO documents
          (company_id, folder_id, name, file_url, upload_id, size, ext, status, uploaded_by)
        VALUES (
          ${input.companyId}, ${input.folderId}, ${input.name}, ${input.fileUrl ?? ""},
          ${input.uploadId}, ${input.size}, ${input.ext}, 'under-review', ${input.uploadedBy}
        )
        RETURNING id, company_id AS "companyId", folder_id AS "folderId", name,
                  file_url AS "fileUrl", upload_id AS "uploadId", size, ext,
                  status, uploaded_by AS "uploadedBy", uploaded_at AS "uploadedAt",
                  archived_at AS "archivedAt"
      `).then((r) => (Array.isArray(r) ? r : (r as { rows: DocRow[] }).rows));
      const doc = toDoc(rows[0]!);

      /**
       * v1, in the same transaction as the document.
       *
       * `documents.version_count` DEFAULTS TO 1, so a document created without a
       * version row claims one version and lists none — the drawer rendered
       * "1 version" above an empty list. Worse, the next same-name upload takes
       * the chunked path, which allocates `max(version_no) + 1` from an empty
       * table and produces a *second* "v1" while orphaning the first blob. So
       * the demo's "re-upload and watch v2 appear" could not happen for any file
       * uploaded during the demo, only for pre-seeded ones.
       *
       * Writing it here rather than in the SPA (by lowering the chunk threshold)
       * fixes it for every caller — seeds and future clients included — and
       * keeps the single-shot path, which the freeze checklist offers as the
       * safe fallback when resumable upload is switched off.
       *
       * Size and content type come from the stored blob rather than the caller:
       * `documents.size` is display text and `ext` is not a MIME type, while
       * `uploads` holds both for real.
       */
      if (input.uploadId) {
        await tx.execute(sql`
          INSERT INTO document_versions
            (document_id, version_no, upload_id, file_name, size_bytes, content_type, created_by)
          SELECT ${doc.id}, 1, u.id, ${input.name}, u.size_bytes, u.content_type, ${input.uploadedBy}
          FROM uploads u WHERE u.id = ${input.uploadId}
        `);
        await tx.execute(sql`
          UPDATE documents d
          SET current_version_id = v.id, version_count = 1
          FROM document_versions v
          WHERE v.document_id = d.id AND v.version_no = 1 AND d.id = ${doc.id}
        `);
      }
      return doc;
    });
  }

  /**
   * Documents in a folder, each with its uploader's name resolved.
   *
   * A left join, not a second query per row: the name is wanted on every row of
   * every listing, and the file explorer has no directory of its own to resolve
   * the id against — which is why every document read "Uploaded by: Unknown".
   * Left, so a document whose uploader has been removed still lists.
   */
  async listByFolder(folderId: string, includeArchived: boolean): Promise<DocumentRecord[]> {
    const where = includeArchived
      ? eq(documents.folderId, folderId)
      : and(eq(documents.folderId, folderId), isNull(documents.archivedAt));
    const rows = await this.db
      .select({ doc: documents, uploaderName: users.name })
      .from(documents)
      .leftJoin(users, eq(users.id, documents.uploadedBy))
      .where(where)
      .orderBy(asc(documents.uploadedAt));
    return rows.map((r) => ({ ...toDoc(r.doc), uploadedByName: r.uploaderName ?? null }));
  }

  async getById(id: string): Promise<DocumentRecord | null> {
    const rows = await this.db.select().from(documents).where(eq(documents.id, id)).limit(1);
    return rows[0] ? toDoc(rows[0]) : null;
  }

  /**
   * Raw SQL, not the query builder: this has to reach `document_versions`, which
   * belongs to the dataroom module's schema slice, and a cross-module table
   * import here would couple the two in the wrong direction. The union is the
   * point — a version's blob stays addressable after a restore repoints
   * `documents.upload_id` at a different one.
   */
  async findByUploadId(uploadId: string): Promise<DocumentRecord | null> {
    // Aliased column by column, like `createDocument` above: `db.execute` hands
    // back the driver's raw snake_case names, and `toDoc` reads camelCase. A
    // bare `SELECT d.*` therefore yields a record whose every field is
    // undefined — which fails *closed* here, as a 403 on a document the caller
    // owns, so it is quiet rather than obviously wrong.
    const rows = await this.db.execute<DocRow>(sql`
      SELECT d.id, d.company_id AS "companyId", d.folder_id AS "folderId", d.name,
             d.file_url AS "fileUrl", d.upload_id AS "uploadId", d.size, d.ext,
             d.status, d.uploaded_by AS "uploadedBy", d.uploaded_at AS "uploadedAt",
             d.archived_at AS "archivedAt"
      FROM documents d
      WHERE d.upload_id = ${uploadId}
         OR EXISTS (
           SELECT 1 FROM document_versions v
           WHERE v.document_id = d.id AND v.upload_id = ${uploadId}
         )
      LIMIT 1
    `).then((r) => (Array.isArray(r) ? r : (r as { rows: DocRow[] }).rows));
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

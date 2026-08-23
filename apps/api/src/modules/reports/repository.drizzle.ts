import { and, asc, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { ReportVersionStatus } from "@datahub/contracts";
import type {
  CreateVersionInput,
  LinkDocumentInput,
  LinkedDocument,
  MappingRecord,
  MappingsRepository,
  ReportsRepository,
  UpdateVersionPatch,
  VersionRecord,
} from "./ports.js";

const { documents, fileReferences, keyReportFileMappings, keyReportVersions } = schema;

/** What `file_references.linked_module` says for a key-report link. */
const KEY_REPORTS_MODULE = "key_reports";
type Row = typeof keyReportVersions.$inferSelect;

function toRecord(r: Row): VersionRecord {
  return {
    id: r.id,
    companyId: r.companyId,
    versionNumber: r.versionNumber,
    versionName: r.versionName,
    status: r.status as ReportVersionStatus,
    isActive: r.isActive,
    resolvedBatchId: r.resolvedBatchId,
    lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    createdBy: r.createdBy,
  };
}

export class DrizzleReportsRepository implements ReportsRepository {
  constructor(private readonly db: Db) {}

  async listByCompany(companyId: string): Promise<VersionRecord[]> {
    const rows = await this.db.select().from(keyReportVersions).where(eq(keyReportVersions.companyId, companyId)).orderBy(asc(keyReportVersions.versionNumber));
    return rows.map(toRecord);
  }

  async getById(id: string): Promise<VersionRecord | null> {
    const rows = await this.db.select().from(keyReportVersions).where(eq(keyReportVersions.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  private async nextNumber(tx: Db, companyId: string): Promise<number> {
    const rows = await tx
      .select({ n: keyReportVersions.versionNumber })
      .from(keyReportVersions)
      .where(eq(keyReportVersions.companyId, companyId))
      .orderBy(desc(keyReportVersions.versionNumber))
      .limit(1);
    return (rows[0]?.n ?? 0) + 1;
  }

  async create(input: CreateVersionInput): Promise<VersionRecord> {
    return this.db.transaction(async (tx) => {
      const versionNumber = await this.nextNumber(tx as unknown as Db, input.companyId);
      const rows = await tx
        .insert(keyReportVersions)
        .values({
          companyId: input.companyId,
          versionNumber,
          versionName: input.versionName,
          status: "draft",
          isActive: false,
          metadata: input.metadata,
          createdBy: input.createdBy,
        })
        .returning();
      return toRecord(rows[0]!);
    });
  }

  async update(id: string, patch: UpdateVersionPatch): Promise<VersionRecord | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.versionName !== undefined) set.versionName = patch.versionName;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.metadata !== undefined) set.metadata = patch.metadata;
    const rows = await this.db.update(keyReportVersions).set(set).where(eq(keyReportVersions.id, id)).returning();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(keyReportVersions).where(eq(keyReportVersions.id, id));
  }

  async duplicate(id: string, createdBy: string): Promise<VersionRecord | null> {
    const source = await this.getById(id);
    if (!source) return null;
    return this.create({ companyId: source.companyId, versionName: source.versionName, metadata: source.metadata, createdBy });
  }

  async activate(id: string): Promise<VersionRecord | null> {
    return this.db.transaction(async (tx) => {
      const found = await tx.select().from(keyReportVersions).where(eq(keyReportVersions.id, id)).limit(1);
      const target = found[0];
      if (!target) return null;
      // Clear the company's active flag first, then set the target (partial unique invariant).
      await tx.update(keyReportVersions).set({ isActive: false }).where(eq(keyReportVersions.companyId, target.companyId));
      const rows = await tx
        .update(keyReportVersions)
        .set({ isActive: true, updatedAt: new Date() })
        .where(eq(keyReportVersions.id, id))
        .returning();
      return toRecord(rows[0]!);
    });
  }
}

/** Mappings, and the file references that hold their documents in place. */
export class DrizzleMappingsRepository implements MappingsRepository {
  constructor(private readonly db: Db) {}

  private static toRecord(row: typeof keyReportFileMappings.$inferSelect): MappingRecord {
    return {
      id: row.id,
      versionId: row.versionId,
      companyId: row.companyId,
      reportCategory: row.reportCategory,
      documentId: row.documentId ?? null,
      uploadId: row.uploadId ?? null,
      fileName: row.fileName ?? null,
      year: row.year ?? null,
      status: row.status,
      linkedBy: row.linkedBy ?? null,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    };
  }

  async listByVersion(versionId: string): Promise<MappingRecord[]> {
    const rows = await this.db
      .select()
      .from(keyReportFileMappings)
      .where(eq(keyReportFileMappings.versionId, versionId))
      .orderBy(asc(keyReportFileMappings.createdAt));
    return rows.map(DrizzleMappingsRepository.toRecord);
  }

  async getById(mappingId: string): Promise<MappingRecord | null> {
    const [row] = await this.db
      .select()
      .from(keyReportFileMappings)
      .where(eq(keyReportFileMappings.id, mappingId))
      .limit(1);
    return row ? DrizzleMappingsRepository.toRecord(row) : null;
  }

  async link(input: LinkDocumentInput): Promise<MappingRecord> {
    // `onConflictDoUpdate` rather than `doNothing`: nothing would return no
    // row, and the caller needs the mapping back either way. Re-linking also
    // refreshes the file name and inferred year, which is right — the document
    // may have been renamed since.
    const [row] = await this.db
      .insert(keyReportFileMappings)
      .values({
        versionId: input.versionId,
        companyId: input.companyId,
        reportCategory: input.reportCategory,
        documentId: input.documentId,
        uploadId: input.uploadId,
        fileName: input.fileName,
        year: input.year,
        status: "linked",
        linkedBy: input.linkedBy,
      })
      .onConflictDoUpdate({
        target: [
          keyReportFileMappings.versionId,
          keyReportFileMappings.reportCategory,
          keyReportFileMappings.documentId,
        ],
        set: {
          fileName: input.fileName,
          year: input.year,
          uploadId: input.uploadId,
          status: "linked",
        },
      })
      .returning();
    return DrizzleMappingsRepository.toRecord(row!);
  }

  async delete(mappingId: string): Promise<void> {
    await this.db.delete(keyReportFileMappings).where(eq(keyReportFileMappings.id, mappingId));
  }

  async countForDocument(versionId: string, documentId: string): Promise<number> {
    const rows = await this.db
      .select({ id: keyReportFileMappings.id })
      .from(keyReportFileMappings)
      .where(
        and(
          eq(keyReportFileMappings.versionId, versionId),
          eq(keyReportFileMappings.documentId, documentId),
        ),
      );
    return rows.length;
  }

  async getDocument(documentId: string): Promise<LinkedDocument | null> {
    const [row] = await this.db
      .select({
        id: documents.id,
        companyId: documents.companyId,
        name: documents.name,
        uploadId: documents.uploadId,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    return row ? { ...row, name: row.name ?? null, uploadId: row.uploadId ?? null } : null;
  }

  async addFileReference(input: {
    companyId: string;
    documentId: string;
    linkedEntityId: string;
    createdBy: string | null;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    // Re-linking the same document must not stack references, or the count the
    // Data Room reads never falls back to zero and the file becomes permanent.
    const existing = await this.db
      .select({ id: fileReferences.id })
      .from(fileReferences)
      .where(
        and(
          eq(fileReferences.documentId, input.documentId),
          eq(fileReferences.linkedEntityId, input.linkedEntityId),
          eq(fileReferences.linkedModule, KEY_REPORTS_MODULE),
        ),
      )
      .limit(1);
    if (existing.length > 0) return;

    await this.db.insert(fileReferences).values({
      companyId: input.companyId,
      documentId: input.documentId,
      linkedModule: KEY_REPORTS_MODULE,
      linkedEntityId: input.linkedEntityId,
      createdBy: input.createdBy,
      metadata: input.metadata,
    });
  }

  async removeFileReference(documentId: string, linkedEntityId: string): Promise<void> {
    await this.db
      .delete(fileReferences)
      .where(
        and(
          eq(fileReferences.documentId, documentId),
          eq(fileReferences.linkedEntityId, linkedEntityId),
          eq(fileReferences.linkedModule, KEY_REPORTS_MODULE),
        ),
      );
  }
}

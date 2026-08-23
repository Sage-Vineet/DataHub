import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import { emptyMapping, type ColumnMapping, type MappingResult } from "./column-mapping.js";
import type { GlImportRepository, StoredMapping, UploadRecord } from "./ports.js";

const { documents, glImportMappings, uploads } = schema;

export class DrizzleGlImportRepository implements GlImportRepository {
  constructor(private readonly db: Db) {}

  async getUpload(uploadId: string): Promise<UploadRecord | null> {
    const [row] = await this.db
      .select({
        id: uploads.id,
        fileName: uploads.fileName,
        contentType: uploads.contentType,
        data: uploads.data,
      })
      .from(uploads)
      .where(eq(uploads.id, uploadId))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      fileName: row.fileName,
      contentType: row.contentType,
      // `bytea` arrives as a Buffer already; the coercion is for the driver
      // that hands back a Uint8Array instead.
      data: Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data as Uint8Array),
    };
  }

  async uploadBelongsToCompany(companyId: string, uploadId: string): Promise<boolean> {
    // Reached through `documents`, because an upload row carries no company of
    // its own. Without this an id from another tenant would be parsed and
    // returned — the file contents, to somebody with no right to them.
    const [row] = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.companyId, companyId), eq(documents.uploadId, uploadId)))
      .limit(1);
    return Boolean(row);
  }

  async getMapping(companyId: string, uploadId: string): Promise<StoredMapping | null> {
    const [row] = await this.db
      .select()
      .from(glImportMappings)
      .where(
        and(eq(glImportMappings.companyId, companyId), eq(glImportMappings.uploadId, uploadId)),
      )
      .limit(1);
    if (!row) return null;
    return {
      uploadId: row.uploadId,
      mapping: emptyMapping((row.mapping ?? {}) as Partial<ColumnMapping>),
      detected: (row.detected ?? {}) as Partial<MappingResult>,
      confirmedBy: row.confirmedBy ?? null,
      confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    };
  }

  async saveMapping(input: {
    companyId: string;
    uploadId: string;
    mapping: ColumnMapping;
    detected: Partial<MappingResult>;
    confirmedBy: string | null;
  }): Promise<StoredMapping> {
    const now = new Date();
    // One mapping per file; re-confirming replaces. Two rows would make "the
    // mapping for this upload" a question of which was found first.
    const [row] = await this.db
      .insert(glImportMappings)
      .values({
        companyId: input.companyId,
        uploadId: input.uploadId,
        mapping: input.mapping,
        detected: input.detected,
        confirmedBy: input.confirmedBy,
        confirmedAt: now,
      })
      .onConflictDoUpdate({
        target: [glImportMappings.companyId, glImportMappings.uploadId],
        set: {
          mapping: input.mapping,
          detected: input.detected,
          confirmedBy: input.confirmedBy,
          confirmedAt: now,
          updatedAt: now,
        },
      })
      .returning();

    return {
      uploadId: row!.uploadId,
      mapping: emptyMapping((row!.mapping ?? {}) as Partial<ColumnMapping>),
      detected: (row!.detected ?? {}) as Partial<MappingResult>,
      confirmedBy: row!.confirmedBy ?? null,
      confirmedAt: row!.confirmedAt ? row!.confirmedAt.toISOString() : null,
    };
  }
}

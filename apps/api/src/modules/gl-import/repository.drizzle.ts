import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import { emptyMapping, type ColumnMapping, type MappingResult } from "./column-mapping.js";
import type {
  GlImportRepository,
  LedgerWriter,
  StoredMapping,
  UploadOrigin,
  UploadRecord,
  WriteLedgerInput,
} from "./ports.js";

const { documents, generalLedgerEntries, glImportMappings, uploads } = schema;

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

/** Writes ledger rows, and finds the document an upload arrived as. */
export class DrizzleLedgerWriter implements LedgerWriter {
  constructor(private readonly db: Db) {}

  async originOf(companyId: string, uploadId: string): Promise<UploadOrigin | null> {
    const [row] = await this.db
      .select({ documentId: documents.id, companyId: documents.companyId })
      .from(documents)
      .where(and(eq(documents.companyId, companyId), eq(documents.uploadId, uploadId)))
      .limit(1);
    return row ?? null;
  }

  async writeEntries(input: WriteLedgerInput): Promise<{ inserted: number; skipped: number }> {
    if (input.entries.length === 0) return { inserted: 0, skipped: 0 };

    let inserted = 0;
    // In batches, because a ledger is tens of thousands of rows and one
    // statement with that many parameters exceeds what the protocol carries.
    const BATCH = 500;
    for (let start = 0; start < input.entries.length; start += BATCH) {
      const slice = input.entries.slice(start, start + BATCH);
      const written = await this.db
        .insert(generalLedgerEntries)
        .values(
          slice.map((entry) => ({
            versionId: input.versionId,
            companyId: input.companyId,
            sourceFileId: input.documentId,
            transactionDate: entry.transactionDate,
            fiscalYear: entry.fiscalYear,
            accountName: entry.accountName,
            accountNumber: entry.accountNumber,
            accountType: entry.accountType,
            description: entry.description,
            reference: entry.reference,
            transactionType: entry.transactionType,
            amount: entry.amount,
            debit: entry.debit,
            credit: entry.credit,
            rowNumber: entry.rowNumber,
            transactionHash: entry.transactionHash,
            rowType: "TRANSACTION",
          })),
        )
        // Nothing, not update: a row already in the ledger is the same row, and
        // rewriting it would change `updated_at` on every re-import for no
        // reason. This is what makes importing a file twice a no-op.
        .onConflictDoNothing({
          target: [
            generalLedgerEntries.versionId,
            generalLedgerEntries.sourceFileId,
            generalLedgerEntries.transactionHash,
          ],
          // `where` is the index predicate here, not a row filter — this is a
          // partial index and Postgres needs the predicate to recognise it.
          where: sql`${generalLedgerEntries.transactionHash} IS NOT NULL`,
        })
        .returning({ id: generalLedgerEntries.id });
      inserted += written.length;
    }

    return { inserted, skipped: input.entries.length - inserted };
  }
}

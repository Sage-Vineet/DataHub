import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { DocumentBytesPort, TaxReturnDocumentPort } from "./tax-return.js";

const { documents, keyReportFileMappings, uploads } = schema;

/**
 * Finding a company's tax return.
 *
 * Every query filters on `company_id`, which is the whole point: the version
 * this replaces looked a PDF up on the filesystem by filename and could reach
 * any document on the machine. A version id from another company resolves to
 * nothing here, because the join demands the company as well.
 */
export class DrizzleTaxReturnDocumentPort implements TaxReturnDocumentPort {
  constructor(private readonly db: Db) {}

  async forVersion(
    companyId: string,
    versionId: string,
  ): Promise<Array<{ id: string; name: string | null }>> {
    const rows = await this.db
      .select({ id: documents.id, name: documents.name })
      .from(keyReportFileMappings)
      .innerJoin(documents, eq(documents.id, keyReportFileMappings.documentId))
      .where(
        and(
          eq(keyReportFileMappings.versionId, versionId),
          eq(keyReportFileMappings.reportCategory, "tax_return"),
          // The company on BOTH sides. The mapping carries one and the
          // document carries one, and a mismatch between them is exactly the
          // shape a cross-company read would take.
          eq(keyReportFileMappings.companyId, companyId),
          eq(documents.companyId, companyId),
        ),
      )
      .orderBy(desc(documents.uploadedAt));
    return rows;
  }

  async latest(companyId: string): Promise<{ id: string; name: string | null } | null> {
    // By name, because a document does not carry what kind of statement it is
    // until something has been read out of it — and this runs before that.
    // Narrow rather than broad: a false positive here reads the wrong document
    // and reports its figures as the company's tax position.
    const rows = await this.db
      .select({ id: documents.id, name: documents.name })
      .from(documents)
      .where(
        and(
          eq(documents.companyId, companyId),
          eq(documents.ext, "pdf"),
        ),
      )
      .orderBy(desc(documents.uploadedAt));

    return (
      rows.find((row) => /tax|1120|1065|return/i.test(String(row.name ?? ""))) ?? null
    );
  }
}

/** The bytes behind a document, from the upload it came from. */
export class DrizzleDocumentBytesPort implements DocumentBytesPort {
  constructor(private readonly db: Db) {}

  async bytesFor(documentId: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
    const [row] = await this.db
      .select({ data: uploads.data, contentType: uploads.contentType, ext: documents.ext })
      .from(documents)
      .innerJoin(uploads, eq(uploads.id, documents.uploadId))
      .where(eq(documents.id, documentId))
      .limit(1);

    if (!row?.data) return null;
    return {
      bytes: Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data as never),
      // The stored content type, falling back to the extension. A model asked
      // to read `application/octet-stream` refuses; asked to read a PDF it
      // reads one.
      mimeType: row.contentType ?? (row.ext === "pdf" ? "application/pdf" : "application/octet-stream"),
    };
  }
}

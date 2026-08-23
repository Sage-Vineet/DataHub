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
      mimeType: mimeTypeFor(row.contentType, row.ext),
    };
  }
}

/**
 * Which documents hold a company's bank statements.
 *
 * The key-report version's linked `bank_statement` documents when one is
 * named, and every PDF whose name suggests a statement otherwise. Both filter
 * on the company — a version id from elsewhere resolves to nothing.
 */
export class DrizzleBankStatementDocumentPort {
  constructor(private readonly db: Db) {}

  async forCompany(
    companyId: string,
    options: { sourceKey: string; keyReportVersionId?: string },
  ): Promise<Array<{ id: string; name: string | null }>> {
    if (options.keyReportVersionId) {
      const linked = await this.db
        .select({ id: documents.id, name: documents.name })
        .from(keyReportFileMappings)
        .innerJoin(documents, eq(documents.id, keyReportFileMappings.documentId))
        .where(
          and(
            eq(keyReportFileMappings.versionId, options.keyReportVersionId),
            eq(keyReportFileMappings.reportCategory, "bank_statement"),
            eq(keyReportFileMappings.companyId, companyId),
            eq(documents.companyId, companyId),
          ),
        )
        .orderBy(desc(documents.uploadedAt));
      // A version that links statements is the answer. Falling through when it
      // links none would mix the version's documents with the company's
      // others, which is the thing selecting a version is meant to prevent.
      if (linked.length > 0) return linked;
    }

    const rows = await this.db
      .select({ id: documents.id, name: documents.name })
      .from(documents)
      .where(eq(documents.companyId, companyId))
      .orderBy(desc(documents.uploadedAt));

    // By name, because a document does not carry what kind of statement it is
    // until something has been read out of it. Narrow rather than broad: a
    // false positive here sends a P&L to a bank-statement prompt, which
    // answers `[]` — a wasted call, but not a wrong figure.
    return rows.filter((row) =>
      /bank|statement|chequing|checking|savings/i.test(String(row.name ?? "")),
    );
  }
}

/** What extension a browser gives an upload it could not identify. */
const GENERIC_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

const BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  csv: "text/csv",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

/**
 * The content type to send a model.
 *
 * `uploads.content_type` is NOT NULL, so it is always something — but a browser
 * that could not identify a file sends `application/octet-stream`, and a model
 * asked to read that refuses. The extension is the better guess in exactly that
 * case, and only in that case: a stored type that says something specific is
 * what the uploader's own browser determined and beats an extension anybody can
 * rename.
 */
export function mimeTypeFor(contentType: string | null, ext: string | null): string {
  const stored = String(contentType ?? "").trim().toLowerCase();
  if (!GENERIC_TYPES.has(stored)) return stored;
  return BY_EXTENSION[String(ext ?? "").trim().toLowerCase()] ?? "application/octet-stream";
}

/**
 * A company's document of one statement kind, generalised.
 *
 * `DrizzleTaxReturnDocumentPort` is this with the category and the name
 * pattern fixed. Kept separate rather than merged because the tax-return one
 * is referenced by name in several places and renaming it would be churn — but
 * a third caller wanting a third category should use this rather than copy it.
 */
export class DrizzleStatementDocumentPort {
  constructor(
    private readonly db: Db,
    private readonly category: string,
    /** How a document of this kind is usually named, for the fallback. */
    private readonly namePattern: RegExp,
  ) {}

  async forVersion(
    companyId: string,
    versionId: string,
  ): Promise<Array<{ id: string; name: string | null }>> {
    return this.db
      .select({ id: documents.id, name: documents.name })
      .from(keyReportFileMappings)
      .innerJoin(documents, eq(documents.id, keyReportFileMappings.documentId))
      .where(
        and(
          eq(keyReportFileMappings.versionId, versionId),
          eq(keyReportFileMappings.reportCategory, this.category),
          // The company on BOTH sides — see the tax-return port above.
          eq(keyReportFileMappings.companyId, companyId),
          eq(documents.companyId, companyId),
        ),
      )
      .orderBy(desc(documents.uploadedAt));
  }

  async latest(companyId: string): Promise<{ id: string; name: string | null } | null> {
    const rows = await this.db
      .select({ id: documents.id, name: documents.name })
      .from(documents)
      .where(eq(documents.companyId, companyId))
      .orderBy(desc(documents.uploadedAt));
    return rows.find((row) => this.namePattern.test(String(row.name ?? ""))) ?? null;
  }
}

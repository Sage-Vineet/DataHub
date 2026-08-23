import { and, asc, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type {
  ListFilter,
  SaveExtractInput,
  SourceTreeEntry,
  StatementExtract,
  StatementsRepository,
} from "./ports.js";

const { documents, folders, keyReportFileMappings, statementExtracts } = schema;

type Row = typeof statementExtracts.$inferSelect;

/** The join shape every read here selects, so one mapper serves them all. */
const SELECTION = {
  id: statementExtracts.id,
  companyId: statementExtracts.companyId,
  documentId: statementExtracts.documentId,
  documentName: documents.name,
  statementType: statementExtracts.statementType,
  uploadId: statementExtracts.uploadId,
  sourceKey: statementExtracts.sourceKey,
  periodStart: statementExtracts.periodStart,
  periodEnd: statementExtracts.periodEnd,
  asOfDate: statementExtracts.asOfDate,
  fiscalYear: statementExtracts.fiscalYear,
  payload: statementExtracts.payload,
  extractedAt: statementExtracts.extractedAt,
  updatedAt: statementExtracts.updatedAt,
} as const;

type Selected = {
  [K in keyof typeof SELECTION]: K extends keyof Row ? Row[K] : string | null;
};

function toExtract(row: Selected): StatementExtract {
  return {
    id: row.id,
    companyId: row.companyId,
    documentId: row.documentId,
    documentName: row.documentName ?? null,
    statementType: row.statementType,
    uploadId: row.uploadId ?? null,
    sourceKey: row.sourceKey,
    periodStart: row.periodStart ?? null,
    periodEnd: row.periodEnd ?? null,
    asOfDate: row.asOfDate ?? null,
    fiscalYear: row.fiscalYear ?? null,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    extractedAt: row.extractedAt ? row.extractedAt.toISOString() : null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

export class DrizzleStatementsRepository implements StatementsRepository {
  constructor(private readonly db: Db) {}

  private base() {
    return this.db
      .select(SELECTION)
      .from(statementExtracts)
      .innerJoin(documents, eq(documents.id, statementExtracts.documentId));
  }

  async list(companyId: string, filter: ListFilter): Promise<StatementExtract[]> {
    const clauses = [eq(statementExtracts.companyId, companyId)];
    if (filter.sourceKey) clauses.push(eq(statementExtracts.sourceKey, filter.sourceKey));
    if (filter.statementType) {
      clauses.push(eq(statementExtracts.statementType, filter.statementType));
    }
    if (filter.fiscalYear !== undefined) {
      clauses.push(eq(statementExtracts.fiscalYear, filter.fiscalYear));
    }

    const rows = await this.base()
      .where(and(...clauses))
      // Newest first: the list is a "which one did you mean" picker, and the
      // one somebody just uploaded is the likeliest answer.
      .orderBy(desc(statementExtracts.extractedAt));
    return rows.map(toExtract);
  }

  async latest(
    companyId: string,
    statementType: string,
    filter: { sourceKey?: string },
  ): Promise<StatementExtract | null> {
    const clauses = [
      eq(statementExtracts.companyId, companyId),
      eq(statementExtracts.statementType, statementType),
    ];
    if (filter.sourceKey) clauses.push(eq(statementExtracts.sourceKey, filter.sourceKey));

    const [row] = await this.base()
      .where(and(...clauses))
      .orderBy(desc(statementExtracts.extractedAt))
      .limit(1);
    return row ? toExtract(row) : null;
  }

  async getById(companyId: string, id: string): Promise<StatementExtract | null> {
    const [row] = await this.base()
      .where(and(eq(statementExtracts.companyId, companyId), eq(statementExtracts.id, id)))
      .limit(1);
    return row ? toExtract(row) : null;
  }

  async forDocument(
    companyId: string,
    documentId: string,
    statementType: string,
  ): Promise<StatementExtract | null> {
    const [row] = await this.base()
      .where(
        and(
          eq(statementExtracts.companyId, companyId),
          eq(statementExtracts.documentId, documentId),
          eq(statementExtracts.statementType, statementType),
        ),
      )
      .limit(1);
    return row ? toExtract(row) : null;
  }

  async save(input: SaveExtractInput): Promise<StatementExtract> {
    // Re-extracting the same statement from the same file replaces it. The
    // alternative is a pile of near-identical rows where "latest" is whichever
    // extraction ran last, which is not a fact about the company's finances.
    const [row] = await this.db
      .insert(statementExtracts)
      .values({
        companyId: input.companyId,
        documentId: input.documentId,
        statementType: input.statementType,
        uploadId: input.uploadId,
        sourceKey: input.sourceKey,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        asOfDate: input.asOfDate,
        fiscalYear: input.fiscalYear,
        payload: input.payload,
        extractedBy: input.extractedBy,
      })
      .onConflictDoUpdate({
        target: [
          statementExtracts.companyId,
          statementExtracts.documentId,
          statementExtracts.statementType,
        ],
        set: {
          uploadId: input.uploadId,
          sourceKey: input.sourceKey,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          asOfDate: input.asOfDate,
          fiscalYear: input.fiscalYear,
          payload: input.payload,
          extractedBy: input.extractedBy,
          // Bumped so "latest" means the most recent EXTRACTION, not the first
          // time this document was ever seen.
          extractedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning({ id: statementExtracts.id });

    const saved = await this.getById(input.companyId, row!.id);
    // The row was just written inside this call; a null here would mean the
    // company id disagreed with itself.
    return saved!;
  }

  async delete(companyId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(statementExtracts)
      .where(and(eq(statementExtracts.companyId, companyId), eq(statementExtracts.id, id)))
      .returning({ id: statementExtracts.id });
    return rows.length > 0;
  }

  async sourceTree(
    companyId: string,
    filter: { sourceKey?: string },
  ): Promise<SourceTreeEntry[]> {
    const clauses = [eq(statementExtracts.companyId, companyId)];
    if (filter.sourceKey) clauses.push(eq(statementExtracts.sourceKey, filter.sourceKey));

    const rows = await this.db
      .select({
        documentId: statementExtracts.documentId,
        documentName: documents.name,
        folderName: folders.name,
        uploadedAt: documents.uploadedAt,
        extractId: statementExtracts.id,
        statementType: statementExtracts.statementType,
        fiscalYear: statementExtracts.fiscalYear,
        asOfDate: statementExtracts.asOfDate,
        extractedAt: statementExtracts.extractedAt,
      })
      .from(statementExtracts)
      .innerJoin(documents, eq(documents.id, statementExtracts.documentId))
      .leftJoin(folders, eq(folders.id, documents.folderId))
      .where(and(...clauses))
      .orderBy(desc(documents.uploadedAt), asc(statementExtracts.statementType));

    // Grouped in code rather than by a lateral join: the row count here is the
    // number of statements a company has uploaded, which is tens.
    const byDocument = new Map<string, SourceTreeEntry>();
    for (const row of rows) {
      let entry = byDocument.get(row.documentId);
      if (!entry) {
        byDocument.set(
          row.documentId,
          (entry = {
            documentId: row.documentId,
            documentName: row.documentName ?? null,
            folderName: row.folderName ?? null,
            uploadedAt: row.uploadedAt ? row.uploadedAt.toISOString() : null,
            statements: [],
          }),
        );
      }
      entry.statements.push({
        statementType: row.statementType,
        extractId: row.extractId,
        fiscalYear: row.fiscalYear ?? null,
        asOfDate: row.asOfDate ?? null,
        extractedAt: row.extractedAt ? row.extractedAt.toISOString() : null,
      });
    }
    return [...byDocument.values()];
  }

  async documentsForVersion(versionId: string, category: string): Promise<string[]> {
    const rows = await this.db
      .select({ documentId: keyReportFileMappings.documentId })
      .from(keyReportFileMappings)
      .where(
        and(
          eq(keyReportFileMappings.versionId, versionId),
          eq(keyReportFileMappings.reportCategory, category),
        ),
      )
      .orderBy(desc(keyReportFileMappings.createdAt));
    return rows.map((r) => r.documentId).filter((id): id is string => id !== null);
  }
}

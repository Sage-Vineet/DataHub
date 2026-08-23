import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import {
  pullKeyFor,
  type LatestFilter,
  type ListFilter,
  type SaveExtractInput,
  type SourceTreeEntry,
  type StatementExtract,
  type StatementsRepository,
} from "./ports.js";

export { pullKeyFor } from "./ports.js";

const { documents, folders, keyReportFileMappings, statementExtracts } = schema;

type Row = typeof statementExtracts.$inferSelect;

/** The join shape every read here selects, so one mapper serves them all. */
const SELECTION = {
  id: statementExtracts.id,
  companyId: statementExtracts.companyId,
  documentId: statementExtracts.documentId,
  documentName: documents.name,
  folderName: folders.name,
  syncRunId: statementExtracts.syncRunId,
  datasetVersionId: statementExtracts.datasetVersionId,
  reportParams: statementExtracts.reportParams,
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
    documentId: row.documentId ?? null,
    documentName: row.documentName ?? null,
    folderName: row.folderName ?? null,
    syncRunId: row.syncRunId ?? null,
    datasetVersionId: row.datasetVersionId ?? null,
    reportParams: (row.reportParams ?? {}) as Record<string, unknown>,
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
    // LEFT, not INNER: a statement pulled from an API has no document, and an
    // inner join would silently drop every one of them.
    return this.db
      .select(SELECTION)
      .from(statementExtracts)
      .leftJoin(documents, eq(documents.id, statementExtracts.documentId))
      // LEFT again: a document need not sit in a folder, and an inner join
      // here would drop every statement read out of a loose upload.
      .leftJoin(folders, eq(folders.id, documents.folderId));
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
    if (filter.documentIds) {
      // An empty list is "this version links no documents", which must return
      // nothing. `inArray` with an empty array is invalid SQL in some
      // dialects, so the impossible clause is spelled out.
      if (filter.documentIds.length === 0) return [];
      clauses.push(inArray(statementExtracts.documentId, [...filter.documentIds]));
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
    filter: LatestFilter,
  ): Promise<StatementExtract | null> {
    const clauses = [
      eq(statementExtracts.companyId, companyId),
      eq(statementExtracts.statementType, statementType),
    ];
    if (filter.sourceKey) clauses.push(eq(statementExtracts.sourceKey, filter.sourceKey));
    // A pull has no document behind it, and a document extract always has one
    // — migration 0016 makes that a constraint rather than a convention.
    if (filter.provenance === "pull") clauses.push(isNull(statementExtracts.documentId));
    if (filter.provenance === "document") clauses.push(isNotNull(statementExtracts.documentId));

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
    const provenance =
      input.provenance.from === "document"
        ? {
            documentId: input.provenance.documentId,
            uploadId: input.provenance.uploadId ?? null,
            syncRunId: null,
            datasetVersionId: null,
            reportParams: {},
            pullKey: null,
          }
        : {
            documentId: null,
            uploadId: null,
            syncRunId: input.provenance.syncRunId,
            datasetVersionId: input.provenance.datasetVersionId ?? null,
            reportParams: input.provenance.reportParams ?? {},
            pullKey: pullKeyFor({
              sourceKey: input.sourceKey,
              statementType: input.statementType,
              datasetVersionId: input.provenance.datasetVersionId ?? null,
              periodStart: input.periodStart,
              periodEnd: input.periodEnd,
              variant: input.provenance.variant ?? null,
            }),
          };

    const common = {
      sourceKey: input.sourceKey,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      asOfDate: input.asOfDate,
      fiscalYear: input.fiscalYear,
      payload: input.payload,
      extractedBy: input.extractedBy,
      // Bumped so "latest" means the most recent EXTRACTION, not the first
      // time this document or period was seen.
      extractedAt: new Date(),
      updatedAt: new Date(),
    };

    // Re-obtaining the same statement replaces it. The alternative is a pile
    // of near-identical rows where "latest" is whichever run finished last,
    // which is not a fact about the company's finances.
    //
    // The conflict target differs by provenance because the identity does: one
    // extract per statement per FILE, and for a pull one per period per
    // dataset version. Two partial indexes back these; naming the wrong one
    // would insert a duplicate rather than replace.
    const [row] =
      input.provenance.from === "document"
        ? await this.db
            .insert(statementExtracts)
            .values({
              companyId: input.companyId,
              statementType: input.statementType,
              ...provenance,
              ...common,
            })
            .onConflictDoUpdate({
              target: [
                statementExtracts.companyId,
                statementExtracts.documentId,
                statementExtracts.statementType,
              ],
              targetWhere: sql`${statementExtracts.documentId} IS NOT NULL`,
              set: { ...provenance, ...common },
            })
            .returning({ id: statementExtracts.id })
        : await this.db
            .insert(statementExtracts)
            .values({
              companyId: input.companyId,
              statementType: input.statementType,
              ...provenance,
              ...common,
            })
            .onConflictDoUpdate({
              target: [statementExtracts.companyId, statementExtracts.pullKey],
              targetWhere: sql`${statementExtracts.pullKey} IS NOT NULL`,
              set: { ...provenance, ...common },
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
    // Only file-sourced statements. The tree is a picture of what somebody
    // UPLOADED; a statement pulled from an API has no document to sit under,
    // and putting it in one would invent a file that does not exist.
    const clauses = [
      eq(statementExtracts.companyId, companyId),
      isNotNull(statementExtracts.documentId),
    ];
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
      // The WHERE clause guarantees this, but the type does not know it.
      const documentId = row.documentId;
      if (documentId === null) continue;

      let entry = byDocument.get(documentId);
      if (!entry) {
        byDocument.set(
          documentId,
          (entry = {
            documentId,
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

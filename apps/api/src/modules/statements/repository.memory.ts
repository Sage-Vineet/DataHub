import { randomUUID } from "node:crypto";
import type {
  ListFilter,
  SaveExtractInput,
  SourceTreeEntry,
  StatementExtract,
  StatementsRepository,
} from "./ports.js";

/**
 * The same store, in memory.
 *
 * `save` replaces on `(company, document, statementType)` and bumps
 * `extractedAt`, exactly as the unique index and the upsert do — a fake that
 * appended would let a test prove a "latest" that the database does not give.
 */
export class InMemoryStatementsRepository implements StatementsRepository {
  private readonly extracts = new Map<string, StatementExtract>();
  private readonly documentNames = new Map<string, { name: string; folder: string | null }>();
  private readonly versionDocuments = new Map<string, string[]>();
  private clock = 0;

  seedDocument(documentId: string, name: string, folder: string | null = null): void {
    this.documentNames.set(documentId, { name, folder });
  }

  /** Which documents a version files under a category, newest first. */
  seedVersionDocuments(versionId: string, category: string, documentIds: string[]): void {
    this.versionDocuments.set(`${versionId}:${category}`, documentIds);
  }

  private stamp(): string {
    // Monotonic and lexicographically sortable, so "newest" is well defined
    // without depending on a wall clock a test cannot control.
    return `2024-01-01T00:00:${String(this.clock++).padStart(2, "0")}.000Z`;
  }

  /**
   * The identity of a stored extract.
   *
   * Mirrors the two partial unique indexes: per FILE for a document-sourced
   * statement, per period and dataset version for a pulled one. A fake that
   * keyed both the same way would let a test prove a replacement the database
   * would not perform.
   */
  private key(companyId: string, input: SaveExtractInput): string {
    if (input.provenance.from === "document") {
      return `${companyId}:doc:${input.provenance.documentId}:${input.statementType}`;
    }
    return [
      companyId,
      "pull",
      input.sourceKey,
      input.statementType,
      input.provenance.datasetVersionId ?? "no-dataset",
      input.periodStart ?? "no-start",
      input.periodEnd ?? "no-end",
    ].join(":");
  }

  private mine(companyId: string): StatementExtract[] {
    return [...this.extracts.values()].filter((e) => e.companyId === companyId);
  }

  list(companyId: string, filter: ListFilter): Promise<StatementExtract[]> {
    return Promise.resolve(
      this.mine(companyId)
        .filter(
          (e) =>
            (!filter.sourceKey || e.sourceKey === filter.sourceKey) &&
            (!filter.statementType || e.statementType === filter.statementType) &&
            (filter.fiscalYear === undefined || e.fiscalYear === filter.fiscalYear),
        )
        .sort((a, b) => (b.extractedAt ?? "").localeCompare(a.extractedAt ?? "")),
    );
  }

  async latest(
    companyId: string,
    statementType: string,
    filter: { sourceKey?: string },
  ): Promise<StatementExtract | null> {
    const rows = await this.list(companyId, { statementType, ...filter });
    return rows[0] ?? null;
  }

  getById(companyId: string, id: string): Promise<StatementExtract | null> {
    const found = this.mine(companyId).find((e) => e.id === id);
    return Promise.resolve(found ?? null);
  }

  forDocument(
    companyId: string,
    documentId: string,
    statementType: string,
  ): Promise<StatementExtract | null> {
    return Promise.resolve(
      this.extracts.get(`${companyId}:doc:${documentId}:${statementType}`) ?? null,
    );
  }

  save(input: SaveExtractInput): Promise<StatementExtract> {
    const key = this.key(input.companyId, input);
    const existing = this.extracts.get(key);

    // Destructured through the discriminant so each branch reads only the
    // fields its own case has.
    const p = input.provenance;
    const provenance =
      p.from === "document"
        ? {
            documentId: p.documentId,
            uploadId: p.uploadId ?? null,
            syncRunId: null,
            datasetVersionId: null,
            reportParams: {} as Record<string, unknown>,
          }
        : {
            documentId: null,
            uploadId: null,
            syncRunId: p.syncRunId,
            datasetVersionId: p.datasetVersionId ?? null,
            reportParams: p.reportParams ?? {},
          };
    const document = provenance.documentId
      ? this.documentNames.get(provenance.documentId)
      : undefined;

    const record: StatementExtract = {
      id: existing?.id ?? randomUUID(),
      companyId: input.companyId,
      documentName: document?.name ?? null,
      ...provenance,
      statementType: input.statementType,
      sourceKey: input.sourceKey,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      asOfDate: input.asOfDate,
      fiscalYear: input.fiscalYear,
      payload: input.payload,
      extractedAt: this.stamp(),
      updatedAt: this.stamp(),
    };
    this.extracts.set(key, record);
    return Promise.resolve(record);
  }

  delete(companyId: string, id: string): Promise<boolean> {
    for (const [key, value] of this.extracts) {
      if (value.companyId === companyId && value.id === id) {
        this.extracts.delete(key);
        return Promise.resolve(true);
      }
    }
    return Promise.resolve(false);
  }

  async sourceTree(
    companyId: string,
    filter: { sourceKey?: string },
  ): Promise<SourceTreeEntry[]> {
    const rows = await this.list(companyId, filter);
    const byDocument = new Map<string, SourceTreeEntry>();
    for (const row of rows) {
      // The tree is a picture of uploaded FILES; a pulled statement has none.
      if (row.documentId === null) continue;
      const documentId = row.documentId;

      let entry = byDocument.get(documentId);
      if (!entry) {
        byDocument.set(
          documentId,
          (entry = {
            documentId,
            documentName: row.documentName,
            folderName: this.documentNames.get(documentId)?.folder ?? null,
            uploadedAt: null,
            statements: [],
          }),
        );
      }
      entry.statements.push({
        statementType: row.statementType,
        extractId: row.id,
        fiscalYear: row.fiscalYear,
        asOfDate: row.asOfDate,
        extractedAt: row.extractedAt,
      });
    }
    return [...byDocument.values()];
  }

  documentsForVersion(versionId: string, category: string): Promise<string[]> {
    return Promise.resolve(this.versionDocuments.get(`${versionId}:${category}`) ?? []);
  }
}

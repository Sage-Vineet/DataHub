/**
 * Statements read out of uploaded documents.
 *
 * The Reports page asks two questions of this: "what is the latest balance
 * sheet you have?" and "show me everything, so I can pick". Both are scoped to
 * a report source, because a company can have a QuickBooks export and a hand-
 * built spreadsheet on file at once and mixing them produces a statement that
 * is from neither.
 */

export const STATEMENT_TYPES = [
  "balance_sheet",
  "profit_and_loss",
  "cash_flow",
  "bank_reconciliation",
  "tax_return",
] as const;

export type StatementType = (typeof STATEMENT_TYPES)[number];

/**
 * The category a key-report version files each statement type under.
 *
 * Two vocabularies for the same five things — `profit_and_loss` here,
 * `profit_loss` on a mapping — which is a legacy accident, not a distinction.
 * Translated in one place so neither side has to know about the other.
 */
export const CATEGORY_OF_STATEMENT: Readonly<Record<StatementType, string | null>> = {
  balance_sheet: "balance_sheet",
  profit_and_loss: "profit_loss",
  // Cash flow is derived from the other two rather than uploaded, so no
  // document is ever filed under it.
  cash_flow: null,
  bank_reconciliation: "bank_statement",
  tax_return: "tax_return",
};

export interface StatementExtract {
  id: string;
  companyId: string;
  documentId: string;
  documentName: string | null;
  statementType: string;
  uploadId: string | null;
  sourceKey: string;
  periodStart: string | null;
  periodEnd: string | null;
  asOfDate: string | null;
  fiscalYear: number | null;
  payload: Record<string, unknown>;
  extractedAt: string | null;
  updatedAt: string | null;
}

export interface SaveExtractInput {
  companyId: string;
  documentId: string;
  statementType: StatementType;
  uploadId: string | null;
  sourceKey: string;
  periodStart: string | null;
  periodEnd: string | null;
  asOfDate: string | null;
  fiscalYear: number | null;
  payload: Record<string, unknown>;
  extractedBy: string | null;
}

export interface ListFilter {
  sourceKey?: string;
  statementType?: string;
  fiscalYear?: number;
}

/** One document a company has on file, with what has been read out of it. */
export interface SourceTreeEntry {
  documentId: string;
  documentName: string | null;
  folderName: string | null;
  uploadedAt: string | null;
  statements: Array<{
    statementType: string;
    extractId: string;
    fiscalYear: number | null;
    asOfDate: string | null;
    extractedAt: string | null;
  }>;
}

export interface StatementsRepository {
  list(companyId: string, filter: ListFilter): Promise<StatementExtract[]>;
  /** Most recently extracted of one type, or null. */
  latest(
    companyId: string,
    statementType: string,
    filter: { sourceKey?: string },
  ): Promise<StatementExtract | null>;
  getById(companyId: string, id: string): Promise<StatementExtract | null>;
  /** The extract taken from one specific document, if there is one. */
  forDocument(
    companyId: string,
    documentId: string,
    statementType: string,
  ): Promise<StatementExtract | null>;
  save(input: SaveExtractInput): Promise<StatementExtract>;
  delete(companyId: string, id: string): Promise<boolean>;
  /** Every document on file, with the statements read out of each. */
  sourceTree(companyId: string, filter: { sourceKey?: string }): Promise<SourceTreeEntry[]>;
  /**
   * The document a key-report version files under a category, newest first.
   *
   * Used to answer "the balance sheet for THIS version" rather than "the
   * latest one this company happens to have".
   */
  documentsForVersion(versionId: string, category: string): Promise<string[]>;
}

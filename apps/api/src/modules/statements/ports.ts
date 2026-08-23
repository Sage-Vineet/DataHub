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
  // The last two are not statements in the accounting sense — a general ledger
  // is a transaction listing and an account list is a chart of accounts. They
  // are what QuickBooks answers when the Reports page asks, and they are held
  // here because a second table with identical columns would be worse than a
  // table whose name is slightly wide. See migration 0014.
  "general_ledger",
  "account_list",
  // Entity lists rather than reports — see migration 0017, which also records
  // that this is the last type the name `statement_extracts` will stretch to.
  "customers",
  "invoices",
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
  general_ledger: "general_ledger",
  customers: null,
  invoices: null,
  // Pulled from QuickBooks rather than filed against a version, so no document
  // is ever linked under it.
  account_list: null,
};

export interface StatementExtract {
  id: string;
  companyId: string;
  /** Null when the statement came from an API pull rather than a file. */
  documentId: string | null;
  documentName: string | null;
  /** The folder the document sits in, when it came from one. */
  folderName: string | null;
  /** The run that pulled it, when it was pulled. */
  syncRunId: string | null;
  datasetVersionId: string | null;
  /** What the API was asked, for a pulled statement. */
  reportParams: Record<string, unknown>;
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

/**
 * Where a statement came from.
 *
 * A discriminated union rather than four optional fields, so "a document but
 * also a dataset version" and "neither" are both unrepresentable — the CHECK
 * in the database says the same thing, and a type that could express what the
 * database refuses is a runtime error waiting to be written.
 */
export type Provenance =
  | { from: "document"; documentId: string; uploadId?: string | null }
  | {
      from: "pull";
      /**
       * The run that pulled it, when it was one.
       *
       * Optional because a report fetched on demand — somebody asked for a
       * period no sync had covered — has no run behind it, and inventing a
       * `sync_runs` row per page load would fill the run history with things
       * nobody ran. The pull key is what names such a row; see migration 0015.
       */
      syncRunId?: string | null;
      datasetVersionId?: string | null;
      reportParams?: Record<string, unknown>;
      /**
       * What else makes this pull a different pull — the accounting basis, for
       * a QuickBooks report. Without it the same period on two bases shares
       * one key and the second replaces the first.
       */
      variant?: string | null;
    };

export interface SaveExtractInput {
  companyId: string;
  provenance: Provenance;
  statementType: StatementType;
  sourceKey: string;
  periodStart: string | null;
  periodEnd: string | null;
  asOfDate: string | null;
  fiscalYear: number | null;
  payload: Record<string, unknown>;
  extractedBy: string | null;
}

export interface LatestFilter {
  sourceKey?: string;
  /**
   * Where the extract came from.
   *
   * One statement type can hold both: a company's bank reconciliation exists
   * as a PULL from QuickBooks and as one extract per UPLOADED statement, with
   * different payload shapes. A caller that wants one and gets the other reads
   * an object with none of the fields it expects and renders nothing, so the
   * two are separable here rather than by guessing at the payload.
   */
  provenance?: "pull" | "document";
}

export interface ListFilter {
  sourceKey?: string;
  statementType?: string;
  fiscalYear?: number;
  /**
   * Only statements read out of these documents.
   *
   * How "the statements for THIS key-report version" is asked: the version
   * names its documents, and this narrows to what was read out of them. An
   * empty array means the version links nothing, which is a real answer and
   * must return nothing rather than everything.
   */
  documentIds?: readonly string[];
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
    filter: LatestFilter,
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

/**
 * The identity of a pulled statement, as one string.
 *
 * Pulling January twice is the same statement; pulling January and February is
 * two. An absent period is spelled rather than left empty, so "no period" and
 * "period starting nothing" cannot collide into the same key.
 */
export function pullKeyFor(input: {
  sourceKey: string;
  statementType: string;
  datasetVersionId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /**
   * What else makes this pull a different pull.
   *
   * The accounting basis, for a QuickBooks report. Without it the same period
   * on a cash basis and on an accrual basis share one key, so the second pull
   * REPLACES the first — and the page then shows whichever basis was fetched
   * most recently, with nothing on screen to say which. The two reports have
   * the same shape and the same accounts and different numbers, so there is no
   * way to notice from the figures.
   *
   * Caller-supplied and explicit rather than a hash of `report_params`: a hash
   * would make every incidental parameter part of the identity, so adding one
   * would silently start duplicating rows instead of replacing them.
   */
  variant?: string | null;
}): string {
  return [
    input.sourceKey,
    input.statementType,
    input.datasetVersionId ?? "no-dataset",
    input.periodStart ?? "no-start",
    input.periodEnd ?? "no-end",
    input.variant ?? "no-variant",
  ].join("|");
}

/**
 * The bank-reconciliation grid's editable parts.
 *
 * Two shapes, and they are not the same thing. An ADJUSTMENT is a correction to
 * one cell of a grid whose rows are otherwise derived — keyed by
 * `(month, rowKey)`, no identity of its own worth exposing. An ADD-BACK ITEM is
 * a row somebody added, with a name and a lifecycle: it is created, edited and
 * removed, and it has an id the caller holds on to.
 */

/**
 * The two halves of the reconciliation.
 *
 * A database CHECK constraint, not a convention — so a row filed under anything
 * else is rejected outright. Legacy did not check, which made a typo a 500 from
 * deep inside the driver rather than a 400 naming the field.
 */
export const ADDBACK_SECTIONS = ["deposits", "withdrawals"] as const;
export type AddbackSection = (typeof ADDBACK_SECTIONS)[number];

export interface AdjustmentRecord {
  month: string;
  rowKey: string;
  amount: number;
}

export interface AddbackItemRecord {
  id: string;
  section: string;
  name: string;
  source: string;
  monthAmounts: Record<string, number>;
  sortOrder: number;
  reportSource: string;
}

export interface CreateAddbackItemInput {
  companyId: string;
  section: string;
  name: string;
  source: string;
  monthAmounts: Record<string, number>;
  reportSource: string;
}

export interface BankReconciliationRepository {
  listAdjustments(companyId: string): Promise<AdjustmentRecord[]>;
  /** Write one cell. Idempotent on `(company_id, month, row_key)`. */
  setAdjustment(companyId: string, input: AdjustmentRecord): Promise<void>;

  listAddbackItems(
    companyId: string,
    filter: { reportSource: string; section?: string },
  ): Promise<AddbackItemRecord[]>;
  createAddbackItem(input: CreateAddbackItemInput): Promise<AddbackItemRecord>;
  /**
   * Update one item's monthly amounts.
   *
   * Scoped by company as well as id, and reports whether a row actually
   * matched — an update that quietly affects nothing must not answer "saved".
   */
  updateAddbackItemAmounts(
    companyId: string,
    id: string,
    monthAmounts: Record<string, number>,
  ): Promise<boolean>;
  deleteAddbackItem(companyId: string, id: string): Promise<boolean>;
}

/**
 * A line off a bank statement, as stored.
 *
 * One half of the comparison `/bank-vs-books` makes; `BookTransaction` is the
 * other. Amounts come back as numbers rather than the driver's numeric
 * strings, converted at the repository so nothing above it has to remember to.
 */
export interface BankTransaction {
  id: number;
  date: string;
  narration: string | null;
  amount: number;
}

/** A transaction off the books, flattened out of a general ledger. */
export interface BookTransaction {
  id: number;
  date: string;
  name: string | null;
  transactionType: string | null;
  amount: number;
}

/** What a caller writes when a ledger fetch produces transactions. */
export interface BookTransactionInput {
  date: string;
  name: string | null;
  transactionType: string | null;
  amount: number;
}

export interface ReconciliationTransactionsRepository {
  listBankTransactions(companyId: string): Promise<BankTransaction[]>;
  listBookTransactions(companyId: string): Promise<BookTransaction[]>;
  /**
   * Make the company's book transactions exactly these.
   *
   * A replace, in one transaction, because a partial ledger reconciles against
   * nothing useful and merging two fetches of overlapping periods doubles
   * every transaction in the overlap — which then reads as a duplicated
   * payment, the exact thing a reconciliation is meant to detect.
   */
  replaceBookTransactions(
    companyId: string,
    transactions: readonly BookTransactionInput[],
  ): Promise<number>;
}

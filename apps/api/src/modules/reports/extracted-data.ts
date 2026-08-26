/**
 * Reading back what extraction stored, a page at a time.
 *
 * The Key Reports page shows the raw rows behind a version so somebody can
 * check a figure against the file it came from. Five entry tables, one shape
 * of question: which type, which year, which page, and a search box.
 *
 * WHY THE TABLE CHOICE IS A CLOSED MAP
 * ------------------------------------
 * `dataType` comes off the query string, and it selects a TABLE. A map from a
 * fixed set of keys to a fixed set of tables makes an unknown value a 400
 * rather than something reaching a query builder — and makes adding a sixth
 * type a compile error at every site that must handle it, rather than a
 * silently unhandled case.
 */

import { and, asc, count, eq, gte, ilike, lte, or, type SQL } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import { BadRequestError } from "../../shared/errors.js";

const {
  bankStatementEntries,
  balanceSheetEntries,
  generalLedgerEntries,
  profitLossEntries,
  taxReturnEntries,
} = schema;

export const EXTRACTED_DATA_TYPES = [
  "profit_loss",
  "balance_sheet",
  "general_ledger",
  "tax_return",
  "bank_statement",
] as const;

export type ExtractedDataType = (typeof EXTRACTED_DATA_TYPES)[number];

export function isExtractedDataType(value: string): value is ExtractedDataType {
  return (EXTRACTED_DATA_TYPES as readonly string[]).includes(value);
}

/** How many rows one request may ask for. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

export interface ExtractedDataQuery {
  dataType: string;
  year?: number;
  page?: number;
  pageSize?: number;
  search?: string;
}

export interface ExtractedDataPage {
  dataType: ExtractedDataType;
  rows: Array<Record<string, unknown>>;
  page: number;
  pageSize: number;
  /** How many rows match the filter, not how many are on this page. */
  total: number;
  totalPages: number;
}

/**
 * A search term, as a LIKE pattern.
 *
 * `%` and `_` are wildcards, so a term containing one silently means something
 * else — searching for "50%" matches every account whose name starts "50",
 * and searching for "_" matches everything. Escaped so a person searching for
 * a character gets that character.
 *
 * The backslash is escaped first, or escaping the others would double-escape
 * a backslash the user typed.
 */
export function toLikePattern(term: string): string {
  const escaped = term.replace(/\\/g, "\\\\").replace(/[%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

/**
 * The five tables, and how each is asked its question.
 *
 * `yearIsDate` is the awkward one: a bank statement is filed by the month it
 * covers, stored as a date, so "which year" is a range rather than an equality.
 * Comparing a date column to an integer year matches nothing at all, which
 * reads as a year with no transactions in it.
 */
const TABLES = {
  profit_loss: {
    table: profitLossEntries,
    yearColumn: profitLossEntries.fiscalYear,
    yearIsDate: false,
    search: [
      profitLossEntries.accountName,
      profitLossEntries.accountNumber,
      profitLossEntries.category,
    ],
    order: [profitLossEntries.sortOrder, profitLossEntries.id],
  },
  balance_sheet: {
    table: balanceSheetEntries,
    yearColumn: balanceSheetEntries.fiscalYear,
    yearIsDate: false,
    search: [
      balanceSheetEntries.accountName,
      balanceSheetEntries.accountNumber,
      balanceSheetEntries.section,
    ],
    order: [balanceSheetEntries.sortOrder, balanceSheetEntries.id],
  },
  general_ledger: {
    table: generalLedgerEntries,
    yearColumn: generalLedgerEntries.fiscalYear,
    yearIsDate: false,
    search: [
      generalLedgerEntries.distributionAccount,
      generalLedgerEntries.memoDescription,
      generalLedgerEntries.transactionName,
    ],
    order: [generalLedgerEntries.rowNumber, generalLedgerEntries.id],
  },
  tax_return: {
    table: taxReturnEntries,
    yearColumn: taxReturnEntries.taxYear,
    yearIsDate: false,
    search: [
      taxReturnEntries.fieldName,
      taxReturnEntries.fieldLabel,
      taxReturnEntries.schedule,
      taxReturnEntries.section,
    ],
    order: [taxReturnEntries.id],
  },
  bank_statement: {
    table: bankStatementEntries,
    yearColumn: bankStatementEntries.statementMonth,
    yearIsDate: true,
    search: [
      bankStatementEntries.description,
      bankStatementEntries.bankAccount,
      bankStatementEntries.bankName,
    ],
    order: [bankStatementEntries.transactionDate, bankStatementEntries.id],
  },
} as const;

/** Clamp a page number to something that can be asked for. */
export function toPage(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Clamp a page size.
 *
 * Capped rather than honoured, because the caller is a query string and an
 * uncapped size is a request for a whole general ledger in one response — tens
 * of megabytes of JSON that the page cannot render and the server has to hold
 * in memory to serialise.
 */
export function toPageSize(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

export class ExtractedDataReader {
  constructor(private readonly db: Db) {}

  async read(versionId: string, query: ExtractedDataQuery): Promise<ExtractedDataPage> {
    if (!isExtractedDataType(query.dataType)) {
      throw new BadRequestError(
        `Unknown data type: ${query.dataType}. ` +
          `Expected one of ${EXTRACTED_DATA_TYPES.join(", ")}.`,
      );
    }
    const config = TABLES[query.dataType];

    const clauses: SQL[] = [eq(config.table.versionId, versionId)];

    if (query.year !== undefined && Number.isInteger(query.year) && query.year > 0) {
      if (config.yearIsDate) {
        // A range, not an equality: the column is a date, and comparing it to
        // an integer year matches nothing — which reads as a year with no
        // transactions rather than as a question asked wrongly.
        clauses.push(gte(config.yearColumn, `${query.year}-01-01`));
        clauses.push(lte(config.yearColumn, `${query.year}-12-31`));
      } else {
        clauses.push(eq(config.yearColumn, query.year));
      }
    }

    const term = String(query.search ?? "").trim();
    if (term !== "") {
      const pattern = toLikePattern(term);
      // Bound as a parameter by the query builder rather than concatenated.
      // Legacy built this filter as a string — `${col}.ilike.%${term}%` joined
      // by commas — so a term containing a comma or a bracket changed the
      // filter's structure rather than what it searched for.
      const matches = config.search.map((column) => ilike(column, pattern));
      const combined = or(...matches);
      if (combined) clauses.push(combined);
    }

    const where = and(...clauses);
    const page = toPage(query.page);
    const pageSize = toPageSize(query.pageSize);

    // Counted with the same filter, so "showing 50 of 4,312" is about the
    // question asked rather than about the table.
    const [totals] = await this.db
      .select({ total: count() })
      .from(config.table)
      .where(where);
    const total = totals?.total ?? 0;

    const rows = await this.db
      .select()
      .from(config.table)
      .where(where)
      // The secondary key is not decoration: sort orders repeat, and a page
      // boundary inside a group of equal keys drops or repeats rows between
      // pages with nothing to indicate it.
      .orderBy(...config.order.map((column) => asc(column)))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      dataType: query.dataType,
      rows: rows as Array<Record<string, unknown>>,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }
}

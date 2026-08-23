/**
 * Reading the rows out of a QuickBooks report.
 *
 * A QuickBooks report is a tree: `Rows.Row` holds sections, each with a
 * header, its own `Rows.Row`, and a summary. Data rows carry `ColData`, an
 * array of cells positionally matching the report's `Columns.Column`.
 *
 * THE COLUMNS ARE NOT AT FIXED POSITIONS
 * --------------------------------------
 * The version this replaces read `ColData[0]`, `[1]`, `[3]` and `[6]` as date,
 * type, name and amount. Those indices are right for one column set and wrong
 * for any other, and QuickBooks varies the set with the report, the minor
 * version and the account. Read positionally, a report with an extra column
 * silently shifts every field by one — dates land in the type column and the
 * running balance is read as the amount. Nothing errors, and every figure is
 * wrong.
 *
 * So the columns are resolved by `ColType` — QuickBooks' own machine-readable
 * name for what each column holds — with the human `ColTitle` as a fallback.
 *
 * AND THE TREE IS DEEPER THAN ONE LEVEL
 * -------------------------------------
 * It read `section.Rows.Row` once, so a report nesting accounts under
 * sub-accounts lost every transaction below the second level. Walked properly
 * here, to whatever depth the report has.
 */

/** One cell. */
interface ColData {
  value?: unknown;
  id?: unknown;
}

interface ReportRow {
  type?: unknown;
  ColData?: unknown;
  Header?: { ColData?: unknown } | unknown;
  Rows?: { Row?: unknown } | unknown;
  Summary?: unknown;
  group?: unknown;
}

/**
 * What kind of row this is.
 *
 * `data` — a transaction or a line of the statement.
 * `summary` — a section's total. Its value already contains its children's, so
 *   a reader wants one or the other and never both.
 * `header` — a section's label row, which carries the section name and
 *   sometimes a figure alongside it.
 */
export type ReportRowKind = "data" | "summary" | "header";

/** A row, with its cells addressed by what they hold rather than where. */
export interface QuickBooksReportRow {
  kind: ReportRowKind;
  /** How deep the row sits. 0 is the top level. */
  depth: number;
  /** Cell values keyed by `ColType`, e.g. `tx_date`, `subt_nat_amount`. */
  byType: Record<string, string>;
  /** The same values keyed by the column's visible title, lowercased. */
  byTitle: Record<string, string>;
  /** Every cell in order, for anything the two maps cannot express. */
  cells: string[];
  /**
   * The section headers above this row, outermost first.
   *
   * A general ledger's rows do not name their account — the section header
   * does. Losing the headers means losing which account every transaction
   * belongs to.
   */
  sectionPath: string[];
}

const textOf = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
};

const asArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  // QuickBooks collapses a single-element list to the element itself in some
  // responses. Treating that as "no rows" loses a report that has exactly one.
  if (value === null || value === undefined) return [];
  return [value];
};

/** The column names, in the order the cells arrive. */
export function columnsOf(report: unknown): Array<{ type: string; title: string }> {
  const columns = (report as { Columns?: { Column?: unknown } })?.Columns?.Column;
  return asArray(columns).map((column) => {
    const c = column as { ColType?: unknown; ColTitle?: unknown };
    return { type: textOf(c.ColType), title: textOf(c.ColTitle).toLowerCase() };
  });
}

/** The cells of a row, as plain strings. */
function cellsOf(row: ReportRow): string[] {
  return asArray(row.ColData).map((cell) => textOf((cell as ColData)?.value));
}

/** A section's own label, from its header row. */
function headerLabelOf(row: ReportRow): string {
  const header = row.Header as { ColData?: unknown } | undefined;
  const cells = asArray(header?.ColData).map((cell) => textOf((cell as ColData)?.value));
  return cells.find((cell) => cell !== "") ?? "";
}

/**
 * Every row in a report, flattened, labelled by kind.
 *
 * Headers and summaries come back alongside the data rows rather than being
 * dropped, because different readers want different ones: a ledger wants the
 * transactions, and a profit-and-loss wants the section TOTALS — its figures
 * are the summaries, and the data rows beneath them are the detail.
 *
 * Whoever reads this has to choose one or the other. A total and its own
 * children in the same sum double counts the section, which is a defect this
 * cannot prevent and can at least make visible.
 */
export function flattenReportRows(report: unknown): QuickBooksReportRow[] {
  const columns = columnsOf(report);
  const out: QuickBooksReportRow[] = [];

  const toRow = (
    cells: string[],
    kind: ReportRowKind,
    depth: number,
    sectionPath: string[],
  ): QuickBooksReportRow => {
    const byType: Record<string, string> = {};
    const byTitle: Record<string, string> = {};
    cells.forEach((value, index) => {
      const column = columns[index];
      if (!column) return;
      // First wins: a report repeating a column type means the later one is a
      // variant (a second amount column, say), and overwriting would make
      // which is read depend on column order.
      if (column.type && !(column.type in byType)) byType[column.type] = value;
      if (column.title && !(column.title in byTitle)) byTitle[column.title] = value;
    });
    return { kind, depth, byType, byTitle, cells, sectionPath: [...sectionPath] };
  };

  const walk = (rows: unknown, sectionPath: string[], depth: number): void => {
    for (const raw of asArray(rows)) {
      const row = raw as ReportRow;
      const type = textOf(row.type);
      const nested = (row.Rows as { Row?: unknown } | undefined)?.Row;

      if (type === "Data" && nested === undefined) {
        out.push(toRow(cellsOf(row), "data", depth, sectionPath));
        continue;
      }

      // A section, or a row that nests without saying what it is. Its header
      // names it, its children are its contents, and its summary is its total.
      const label = headerLabelOf(row);
      const header = row.Header as { ColData?: unknown } | undefined;
      if (header?.ColData !== undefined) {
        const cells = asArray(header.ColData).map((cell) => textOf((cell as ColData)?.value));
        out.push(toRow(cells, "header", depth, sectionPath));
      }

      const childPath = label ? [...sectionPath, label] : sectionPath;
      if (nested !== undefined) walk(nested, childPath, depth + 1);

      const summary = row.Summary as { ColData?: unknown } | undefined;
      if (summary?.ColData !== undefined) {
        const cells = asArray(summary.ColData).map((cell) => textOf((cell as ColData)?.value));
        // Emitted at the SECTION's depth and under the section's own path, not
        // its children's: a total belongs beside the thing it totals, and
        // filing it inside makes it look like one more of its own children.
        out.push(toRow(cells, "summary", depth, childPath));
      }
    }
  };

  walk((report as { Rows?: { Row?: unknown } })?.Rows?.Row, [], 0);
  return out;
}

/**
 * Only the data rows.
 *
 * The common case: a reader wants the transactions and not the section totals,
 * because a total alongside its own children double counts the section.
 */
export function dataRowsOf(report: unknown): QuickBooksReportRow[] {
  return flattenReportRows(report).filter((row) => row.kind === "data");
}

/**
 * A cell, by any of several column names.
 *
 * `ColType` first because it is QuickBooks' own machine-readable name; the
 * visible title is a fallback for a report that omits types.
 */
export function cellOf(
  row: QuickBooksReportRow,
  types: readonly string[],
  titles: readonly string[] = [],
): string {
  for (const type of types) {
    const value = row.byType[type];
    if (value !== undefined && value !== "") return value;
  }
  for (const title of titles) {
    const value = row.byTitle[title.toLowerCase()];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

/**
 * A money value as QuickBooks writes it.
 *
 * Thousands separators, currency symbols, and parentheses for negatives — the
 * accounting convention. Returns null rather than NaN for anything unreadable,
 * because NaN propagates into every total and turns a report into "NaN".
 */
export function toAmount(value: string | null | undefined): number | null {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  const negative = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[()]/g, "").replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -Math.abs(parsed) : parsed;
}

/** A ledger transaction, as the reconciliation needs it. */
export interface LedgerTransaction {
  date: string;
  transactionType: string | null;
  name: string | null;
  amount: number;
  /** The account the section header named, when there was one. */
  accountName: string | null;
}

/** QuickBooks' column types for a general ledger. */
const GL_COLUMNS = {
  date: ["tx_date", "txn_date"],
  dateTitles: ["date"],
  type: ["txn_type"],
  typeTitles: ["transaction type", "type"],
  name: ["name", "vend_name", "cust_name"],
  nameTitles: ["name"],
  amount: ["subt_nat_amount", "nat_amount", "amount", "subt_nat_home_amount"],
  amountTitles: ["amount"],
} as const;

/**
 * A general ledger, as transactions.
 *
 * A row without a date or without a readable amount is dropped: it is a
 * heading or a blank the report carries for layout, and storing it as a
 * transaction of zero on no date puts a phantom line in every reconciliation.
 */
export function toLedgerTransactions(report: unknown): LedgerTransaction[] {
  const out: LedgerTransaction[] = [];

  for (const row of dataRowsOf(report)) {
    const date = cellOf(row, GL_COLUMNS.date, GL_COLUMNS.dateTitles);
    const amount = toAmount(cellOf(row, GL_COLUMNS.amount, GL_COLUMNS.amountTitles));
    if (date === "" || amount === null) continue;

    out.push({
      date,
      transactionType: cellOf(row, GL_COLUMNS.type, GL_COLUMNS.typeTitles) || null,
      name: cellOf(row, GL_COLUMNS.name, GL_COLUMNS.nameTitles) || null,
      amount,
      // The deepest section header — a general ledger nests transactions under
      // the account they belong to, and the rows themselves do not name it.
      accountName: row.sectionPath.at(-1) ?? null,
    });
  }

  return out;
}

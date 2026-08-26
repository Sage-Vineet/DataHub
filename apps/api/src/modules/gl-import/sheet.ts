import * as XLSX from "xlsx";
import type { ColumnMapping } from "./column-mapping.js";
import { parseAmount } from "./column-mapping.js";

/**
 * Reading an uploaded spreadsheet.
 *
 * The only part of the import that touches a file format. Kept behind a narrow
 * surface — bytes in, columns and rows out — so everything downstream works on
 * plain objects and can be tested without a spreadsheet.
 *
 * CSV and XLSX both, because both arrive. A CSV has to be read as text: handing
 * SheetJS a UTF-8 buffer and calling it a workbook produces one column of
 * mojibake, which then maps to nothing and reads as an empty file.
 */

export class SheetParseError extends Error {
  constructor(fileName: string, cause: string) {
    super(
      `Unable to read "${fileName}". Upload a CSV, XLSX or XLS exported from ` +
        `your accounting system. (${cause})`,
    );
    this.name = "SheetParseError";
  }
}

export interface ParsedSheet {
  /** Header names, in the order the file has them. */
  columns: string[];
  rows: Array<Record<string, unknown>>;
  /** Which sheet was read, when the workbook had more than one. */
  sheetName: string;
  /** Every sheet in the file, so a caller can offer a choice. */
  sheetNames: string[];
}

/**
 * A header, or "" if it is not one.
 *
 * Control characters are stripped rather than trimmed: `String.trim` treats
 * NUL and friends as ordinary characters, so a binary file's bytes survive it
 * intact and read as a column name.
 */
function cleanHeader(value: unknown): string {
  return String(value ?? "")
    .split("")
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim();
}

const isCsv = (fileName: string, contentType: string): boolean =>
  fileName.toLowerCase().endsWith(".csv") || contentType.toLowerCase().includes("csv");

/**
 * Parse an uploaded workbook.
 *
 * The first sheet unless one is named. Most exports have one; those that have
 * several put the ledger first and notes after.
 */
export function parseSheet(input: {
  data: Buffer;
  fileName: string;
  contentType?: string;
  sheetName?: string;
}): ParsedSheet {
  const { data, fileName } = input;
  const contentType = input.contentType ?? "";

  let workbook: XLSX.WorkBook;
  try {
    workbook = isCsv(fileName, contentType)
      ? XLSX.read(data.toString("utf8"), { type: "string" })
      : XLSX.read(data, { type: "buffer" });
  } catch (err) {
    throw new SheetParseError(fileName, err instanceof Error ? err.message : String(err));
  }

  const sheetNames = workbook.SheetNames ?? [];
  if (sheetNames.length === 0) throw new SheetParseError(fileName, "it contains no sheets");

  const sheetName =
    input.sheetName && sheetNames.includes(input.sheetName) ? input.sheetName : sheetNames[0]!;
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new SheetParseError(fileName, `the sheet "${sheetName}" is empty`);

  // `defval: ""` so every row has every key. Without it a row whose last cells
  // are blank simply lacks them, and a column's profile is computed over the
  // rows that happen to mention it rather than over all of them.
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  // Taken from the sheet rather than from the first row, so a column that is
  // empty throughout still appears — somebody may need to map it, and a header
  // that vanishes because its column is blank is impossible to explain.
  const columns = (
    XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "", raw: false })[0] ?? []
  )
    .map((header) => cleanHeader(header))
    .filter(Boolean);

  // SheetJS is forgiving to a fault. Handed four arbitrary bytes it does not
  // throw and does not produce an empty sheet — it produces ONE column whose
  // name is those bytes. So "did anything parse" is not the test; "is any of
  // it a header a person could have typed" is. Without this, a photograph
  // uploaded by mistake reaches the mapping screen as a single unnameable
  // column with no explanation of what went wrong.
  if (columns.length === 0) {
    throw new SheetParseError(fileName, "no column headers could be read from it");
  }

  return { columns, rows, sheetName, sheetNames };
}

/** One ledger row, as the importer understands it. */
export interface ImportedRow {
  rowNumber: number;
  date: string | null;
  accountName: string;
  accountNumber: string | null;
  accountType: string | null;
  description: string | null;
  transactionType: string | null;
  reference: string | null;
  /** Signed: positive is a debit, negative a credit. */
  amount: number;
  debit: number | null;
  credit: number | null;
}

const text = (value: unknown): string => String(value ?? "").trim();

/** An ISO date, or null. Never a guess. */
export function toIsoDate(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/**
 * Apply a mapping to the parsed rows.
 *
 * THE SIGN CONVENTION, ONCE
 * -------------------------
 * A debit is positive and a credit negative, which is what
 * `general_ledger_entries.amount` holds. Where the file has both columns, a row
 * uses whichever is populated; where it has one signed column, that is taken as
 * it stands.
 *
 * A row with BOTH populated is not an error — some exports write a zero rather
 * than a blank — so the net is used. Preferring one over the other would drop
 * the smaller side of a genuinely two-sided line.
 *
 * Rows with no usable amount, or no account, are dropped and counted rather
 * than imported as zeroes: a zero row is indistinguishable from a real one that
 * happened to net out, and it would sit in the ledger forever.
 */
export function applyMapping(
  rows: ReadonlyArray<Record<string, unknown>>,
  mapping: ColumnMapping,
): { rows: ImportedRow[]; skipped: { noAccount: number; noAmount: number; noDate: number } } {
  const imported: ImportedRow[] = [];
  const skipped = { noAccount: 0, noAmount: 0, noDate: 0 };

  const cell = (row: Record<string, unknown>, field: keyof ColumnMapping): unknown =>
    mapping[field] ? row[mapping[field]] : undefined;

  rows.forEach((row, index) => {
    const accountName = text(cell(row, "account_name"));
    if (!accountName) {
      skipped.noAccount += 1;
      return;
    }

    const debit = parseAmount(cell(row, "debit"));
    const credit = parseAmount(cell(row, "credit"));
    const split = parseAmount(cell(row, "split_amount"));

    let amount: number | null = null;
    if (debit !== null || credit !== null) {
      amount = (debit ?? 0) - (credit ?? 0);
    } else if (split !== null) {
      amount = split;
    }

    if (amount === null) {
      skipped.noAmount += 1;
      return;
    }

    const date = toIsoDate(cell(row, "date"));
    if (!date) {
      // Counted separately: a file where every row lacks a date usually means
      // the date column was mapped wrongly, and that is worth saying rather
      // than reporting "no rows imported".
      skipped.noDate += 1;
      return;
    }

    imported.push({
      // +2 for the header row and for humans counting from one — this number
      // appears in an error message somebody reads next to the spreadsheet.
      rowNumber: index + 2,
      date,
      accountName,
      accountNumber: text(cell(row, "account_number")) || null,
      accountType: text(cell(row, "account_type")) || null,
      description: text(cell(row, "description")) || null,
      transactionType: text(cell(row, "transaction_type")) || null,
      reference: text(cell(row, "reference")) || null,
      amount,
      debit,
      credit,
    });
  });

  return { rows: imported, skipped };
}

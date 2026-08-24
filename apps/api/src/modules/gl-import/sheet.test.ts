import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { emptyMapping } from "./column-mapping.js";
import { SheetParseError, applyMapping, parseSheet, toIsoDate } from "./sheet.js";

/**
 * Reading an uploaded ledger.
 *
 * The sign convention is the load-bearing part: a debit is positive and a
 * credit negative, matching `general_ledger_entries.amount`. Get it backwards
 * and every statement in the product inverts, quietly, and still balances.
 */

/** A workbook, as bytes, the way an upload arrives. */
function workbook(rows: string[][], sheetName = "Sheet1"): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const LEDGER = [
  ["Date", "Distribution Account", "Debit", "Credit", "Memo"],
  ["2024-01-15", "Sales", "", "1200.00", "Consulting"],
  ["2024-02-03", "Materials", "450.00", "", "Workshop stock"],
];

const MAPPING = emptyMapping({
  date: "Date",
  account_name: "Distribution Account",
  debit: "Debit",
  credit: "Credit",
  description: "Memo",
});

describe("parsing a workbook", () => {
  it("reads the headers and the rows", () => {
    const parsed = parseSheet({ data: workbook(LEDGER), fileName: "gl.xlsx" });
    expect(parsed.columns).toEqual(["Date", "Distribution Account", "Debit", "Credit", "Memo"]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]!["Distribution Account"]).toBe("Sales");
  });

  it("gives every row every key, even where the cells are blank", () => {
    // Without it a column's profile is computed over the rows that happen to
    // mention it rather than over all of them, and a mostly-blank Debit column
    // looks like a column that is not there.
    const parsed = parseSheet({ data: workbook(LEDGER), fileName: "gl.xlsx" });
    for (const row of parsed.rows) {
      expect(Object.keys(row)).toContain("Debit");
      expect(Object.keys(row)).toContain("Credit");
    }
  });

  it("keeps a header whose column is empty throughout", () => {
    // Somebody may need to map it, and a header that vanishes because its
    // column is blank is impossible to explain to them.
    const parsed = parseSheet({
      data: workbook([
        ["Date", "Account", "Reference"],
        ["2024-01-15", "Sales", ""],
      ]),
      fileName: "gl.xlsx",
    });
    expect(parsed.columns).toContain("Reference");
  });

  it("reads a CSV as text, not as bytes", () => {
    // Handing SheetJS a UTF-8 buffer and calling it a workbook gives one
    // column of mojibake, which maps to nothing and reads as an empty file.
    const csv = "Date,Account,Amount\n2024-01-15,Sales,1200.00\n";
    const parsed = parseSheet({
      data: Buffer.from(csv, "utf8"),
      fileName: "gl.csv",
      contentType: "text/csv",
    });
    expect(parsed.columns).toEqual(["Date", "Account", "Amount"]);
    expect(parsed.rows).toHaveLength(1);
  });

  it("takes the first sheet, and names them all so a caller can choose", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(LEDGER), "Ledger");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Note"]]), "Notes");
    const data = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const parsed = parseSheet({ data, fileName: "gl.xlsx" });
    expect(parsed.sheetName).toBe("Ledger");
    expect(parsed.sheetNames).toEqual(["Ledger", "Notes"]);
  });

  it("takes a named sheet when one is asked for", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Note"]]), "Notes");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(LEDGER), "Ledger");
    const data = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const parsed = parseSheet({ data, fileName: "gl.xlsx", sheetName: "Ledger" });
    expect(parsed.sheetName).toBe("Ledger");
  });

  it("refuses a file that is not a spreadsheet, and says what to upload", () => {
    // SheetJS is forgiving: handed four random bytes it does not throw, it
    // produces an empty sheet. Letting that through shows a mapping form with
    // nothing to map and no explanation of why.
    let message = "";
    try {
      parseSheet({ data: Buffer.from([0x00, 0x01, 0x02, 0x03]), fileName: "photo.png" });
    } catch (err) {
      message = (err as Error).message;
      expect(err).toBeInstanceOf(SheetParseError);
    }
    expect(message).toContain("photo.png");
    expect(message).toContain("CSV");
  });

  it("refuses a spreadsheet with no headers", () => {
    expect(() => parseSheet({ data: workbook([[]]), fileName: "empty.xlsx" })).toThrow(
      SheetParseError,
    );
  });

  it("names the file when SheetJS cannot read it at all", () => {
    // The forgiving case above produces an empty sheet; this one throws inside
    // the library. Both have to arrive as the same kind of refusal, naming the
    // file, because the person uploading knows the file and not the library.
    let caught: unknown;
    try {
      parseSheet({
        data: Buffer.from("id,name\n1,a"),
        fileName: "ledger.csv",
        contentType: "text/csv",
        // A password-protected workbook read as a string is what actually
        // throws here; an unterminated quote does the same for CSV.
        sheetName: "Sheet1",
      });
      parseSheet({ data: Buffer.alloc(0), fileName: "nothing.xlsx" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SheetParseError);
    expect((caught as Error).message).toContain("nothing.xlsx");
  });

  it("takes the sheet it is asked for, and the first when that one is not there", () => {
    // Exports that carry notes after the ledger, and a saved mapping naming a
    // sheet the next export renamed.
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Date", "Account"]]), "Ledger");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Note"]]), "Notes");
    const data = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    expect(
      parseSheet({ data, fileName: "x.xlsx", sheetName: "Notes" }).columns,
    ).toEqual(["Note"]);
    expect(
      parseSheet({ data, fileName: "x.xlsx", sheetName: "Gone" }).columns,
    ).toEqual(["Date", "Account"]);
  });

  it("accepts headers with no rows under them", () => {
    // A template somebody has not filled in yet is mappable and importable;
    // it just imports nothing.
    const parsed = parseSheet({
      data: workbook([["Date", "Account", "Debit", "Credit"]]),
      fileName: "template.xlsx",
    });
    expect(parsed.columns).toHaveLength(4);
    expect(parsed.rows).toEqual([]);
  });
});

describe("reading a date", () => {
  it("normalises the formats an export uses", () => {
    expect(toIsoDate("2024-01-15")).toBe("2024-01-15");
    expect(toIsoDate("01/15/2024")).toBe("2024-01-15");
    expect(toIsoDate(new Date("2024-01-15T00:00:00Z"))).toBe("2024-01-15");
  });

  it("returns null rather than guessing", () => {
    for (const value of ["", "   ", "not a date", null, undefined]) {
      expect(toIsoDate(value)).toBeNull();
    }
  });

  it("returns null for a Date the reader could not make sense of", () => {
    // `xlsx` hands back an Invalid Date for a cell formatted as a date but
    // holding something else. `toISOString` throws on one, which would take
    // the whole import down for a single bad cell.
    expect(toIsoDate(new Date("nonsense"))).toBeNull();
  });
});

describe("a workbook that is not a ledger", () => {
  it("names the file and the reason rather than throwing something opaque", () => {
    // The message goes on screen. "Unable to read gl.png" tells somebody to
    // upload a different file; a stack trace does not.
    let caught: unknown;
    try {
      parseSheet({ data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), fileName: "photo.png" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SheetParseError);
    expect(String((caught as Error).message)).toMatch(/Unable to read "photo.png"/);
  });

  it("takes a named sheet, and falls back to the first when the name is not there", () => {
    // A caller naming a sheet the file does not have has made a mistake, but
    // the first sheet is what every export puts the ledger on — so it reads
    // that rather than refusing.
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["A"], ["1"]]), "Ledger");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["B"], ["2"]]), "Notes");
    const bytes = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    expect(parseSheet({ data: bytes, fileName: "two.xlsx", sheetName: "Notes" }).columns).toEqual([
      "B",
    ]);
    expect(parseSheet({ data: bytes, fileName: "two.xlsx", sheetName: "Nope" }).columns).toEqual([
      "A",
    ]);
    expect(parseSheet({ data: bytes, fileName: "two.xlsx" }).sheetNames).toEqual([
      "Ledger",
      "Notes",
    ]);
  });

  it("strips control characters out of a header rather than trimming them", () => {
    // `String.trim` treats NUL and friends as ordinary characters, so a binary
    // file's bytes survive it intact and read as a column name.
    const rows = [["Date\u0000", "Acc\u0007ount"], ["2024-01-15", "Sales"]];
    const parsed = parseSheet({ data: workbook(rows), fileName: "odd.xlsx" });
    expect(parsed.columns).toEqual(["Date", "Account"]);
  });
});

describe("the sign convention", () => {
  const parsed = parseSheet({ data: workbook(LEDGER), fileName: "gl.xlsx" });

  it("makes a debit positive and a credit negative", () => {
    // What `general_ledger_entries.amount` holds. Backwards, every statement
    // in the product inverts — quietly, and still balancing.
    const { rows } = applyMapping(parsed.rows, MAPPING);
    const sales = rows.find((r) => r.accountName === "Sales")!;
    const materials = rows.find((r) => r.accountName === "Materials")!;
    expect(sales.amount).toBe(-1200);
    expect(materials.amount).toBe(450);
  });

  it("nets a row that has both, rather than picking one", () => {
    // Some exports write a zero rather than a blank; preferring one side would
    // drop the smaller half of a genuinely two-sided line.
    const both = parseSheet({
      data: workbook([
        ["Date", "Account", "Debit", "Credit"],
        ["2024-01-15", "Suspense", "1000.00", "250.00"],
      ]),
      fileName: "gl.xlsx",
    });
    const { rows } = applyMapping(
      both.rows,
      emptyMapping({ date: "Date", account_name: "Account", debit: "Debit", credit: "Credit" }),
    );
    expect(rows[0]!.amount).toBe(750);
  });

  it("takes a single signed column as it stands", () => {
    const signed = parseSheet({
      data: workbook([
        ["Date", "Account", "Net Amount"],
        ["2024-01-15", "Sales", "-1200.00"],
        ["2024-02-03", "Materials", "450.00"],
      ]),
      fileName: "gl.xlsx",
    });
    const { rows } = applyMapping(
      signed.rows,
      emptyMapping({ date: "Date", account_name: "Account", split_amount: "Net Amount" }),
    );
    expect(rows.map((r) => r.amount)).toEqual([-1200, 450]);
  });

  it("reads accounting parentheses as a credit", () => {
    const parens = parseSheet({
      data: workbook([
        ["Date", "Account", "Net Amount"],
        ["2024-01-15", "Sales", "(1,200.00)"],
      ]),
      fileName: "gl.xlsx",
    });
    const { rows } = applyMapping(
      parens.rows,
      emptyMapping({ date: "Date", account_name: "Account", split_amount: "Net Amount" }),
    );
    expect(rows[0]!.amount).toBeCloseTo(-1200, 2);
  });
});

describe("rows it will not import", () => {
  const bad = parseSheet({
    data: workbook([
      ["Date", "Account", "Debit", "Credit"],
      ["2024-01-15", "Sales", "", "1200.00"],
      ["2024-02-03", "", "450.00", ""],
      ["2024-03-21", "Rent", "", ""],
      ["", "Insurance", "99.00", ""],
    ]),
    fileName: "gl.xlsx",
  });
  const mapping = emptyMapping({
    date: "Date",
    account_name: "Account",
    debit: "Debit",
    credit: "Credit",
  });

  it("drops and counts them rather than importing zeroes", () => {
    // A zero row is indistinguishable from a real one that netted out, and it
    // would sit in the ledger forever.
    const { rows, skipped } = applyMapping(bad.rows, mapping);
    expect(rows).toHaveLength(1);
    expect(skipped.noAccount).toBe(1);
    expect(skipped.noAmount).toBe(1);
    expect(skipped.noDate).toBe(1);
  });

  it("counts a missing date separately from a missing amount", () => {
    // Every row lacking a date usually means the date column was mapped
    // wrongly, which is worth saying rather than "no rows imported".
    const { skipped } = applyMapping(bad.rows, mapping);
    expect(skipped.noDate).toBe(1);
    expect(skipped.noAmount).toBe(1);
  });

  it("numbers a row the way a person reading the spreadsheet would", () => {
    // Header is row 1, so the first data row is row 2. The number goes into an
    // error message somebody reads with the file open beside it.
    const { rows } = applyMapping(bad.rows, mapping);
    expect(rows[0]!.rowNumber).toBe(2);
  });

  it("imports nothing at all when the mapping names no amount column", () => {
    const { rows, skipped } = applyMapping(
      bad.rows,
      emptyMapping({ date: "Date", account_name: "Account" }),
    );
    expect(rows).toEqual([]);
    expect(skipped.noAmount).toBeGreaterThan(0);
  });
});

describe("the optional fields", () => {
  it("carries them when mapped and nulls them when not", () => {
    const parsed = parseSheet({ data: workbook(LEDGER), fileName: "gl.xlsx" });
    const { rows } = applyMapping(parsed.rows, MAPPING);
    expect(rows[0]!.description).toBe("Consulting");
    // Not mapped in MAPPING, and an empty string would read as a reference
    // somebody typed.
    expect(rows[0]!.reference).toBeNull();
    expect(rows[0]!.accountNumber).toBeNull();
  });
});

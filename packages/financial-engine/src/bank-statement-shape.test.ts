import { describe, expect, it } from "vitest";
import {
  buildBankResponseShape,
  deduplicateStatements,
  normaliseExtractedStatement,
  scopeToYear,
  statementBalanceStatus,
  statementKey,
  toDisplayMonth,
  toMonthKey,
  type ExtractedBankStatement,
} from "./bank-statement-shape.js";

/**
 * The bank reconciliation's grid.
 *
 * The defect that drives most of this: the per-account totals row summed
 * starting and ending BALANCES across months. A balance is a position at a
 * moment and does not add over time — so a year of statements showed a row
 * reading roughly twelve times the real figure, on a page whose whole purpose
 * is agreeing balances with the bank.
 */

const statement = (over: Partial<ExtractedBankStatement> = {}): ExtractedBankStatement => ({
  bank_name: "Wells Fargo (0067)",
  bank_name_clean: "Wells Fargo",
  account_name: "Business Checking",
  account_number: "1234560067",
  period_start: "2024-01-01",
  period_end: "2024-01-31",
  beginning_balance: 10000,
  ending_balance: 12000,
  deposits: 5000,
  withdrawals: 3000,
  status: "Verified",
  ...over,
});

const month = (m: string, over: Partial<ExtractedBankStatement> = {}) =>
  statement({
    period_start: `2024-${m}-01`,
    period_end: `2024-${m}-28`,
    ...over,
  });

describe("reading a statement's month", () => {
  it("reads an ISO date", () => {
    expect(toMonthKey("2024-06-30")).toBe("2024-06");
  });

  it("reads an unambiguous slashed date", () => {
    // A day above twelve settles which half is the month.
    expect(toMonthKey("06/30/2024")).toBe("2024-06");
    expect(toMonthKey("30/06/2024")).toBe("2024-06");
  });

  it("refuses a month that could not be one", () => {
    expect(toMonthKey("2024-13-01")).toBeNull();
    expect(toMonthKey("")).toBeNull();
    expect(toMonthKey(null)).toBeNull();
    expect(toMonthKey("last June")).toBeNull();
  });

  it("labels a month the way the column heading reads", () => {
    expect(toDisplayMonth("2024-06")).toBe("Jun-2024");
    expect(toDisplayMonth("2024-12")).toBe("Dec-2024");
  });

  it("hands back anything it cannot label rather than inventing one", () => {
    expect(toDisplayMonth("nonsense")).toBe("nonsense");
  });
});

describe("the same statement twice", () => {
  it("keys on the account and the period", () => {
    expect(statementKey(statement())).toBe(statementKey(statement({ ending_balance: 999 })));
    expect(statementKey(statement())).not.toBe(statementKey(month("02")));
  });

  it("drops the repeat", () => {
    // A folder re-synced would otherwise add a month's deposits to themselves,
    // doubling the movement on a page whose purpose is agreeing that movement
    // with the bank.
    expect(deduplicateStatements([statement(), statement()])).toHaveLength(1);
  });

  it("keeps two genuinely different periods", () => {
    expect(deduplicateStatements([month("01"), month("02")])).toHaveLength(2);
  });
});

describe("the grid it builds", () => {
  const shape = buildBankResponseShape([
    month("01", { beginning_balance: 10000, ending_balance: 12000, deposits: 5000, withdrawals: 3000 }),
    month("02", { beginning_balance: 12000, ending_balance: 15000, deposits: 6000, withdrawals: 3000 }),
    month("03", { beginning_balance: 15000, ending_balance: 14000, deposits: 4000, withdrawals: 5000 }),
  ]);

  it("puts one row per account, with a column per month", () => {
    expect(shape.banks).toHaveLength(1);
    expect(shape.banks[0]!.accounts[0]!.months.map((m) => m.monthKey)).toEqual([
      "2024-01",
      "2024-02",
      "2024-03",
    ]);
    expect(shape.months).toEqual(["Jan-2024", "Feb-2024", "Mar-2024"]);
  });

  it("shows only the last four digits of an account number", () => {
    expect(shape.banks[0]!.account_number).toBe("0067");
  });

  it("sums the FLOWS across months", () => {
    const totals = shape.banks[0]!.accounts[0]!.totals;
    expect(totals.deposits).toBe(15000);
    expect(totals.withdrawals).toBe(11000);
  });

  it("does NOT sum the balances across months", () => {
    // The defect. Summing three months gave a starting balance of 37,000 and
    // an ending of 41,000 for an account that opened at 10,000 and closed at
    // 14,000.
    const totals = shape.banks[0]!.accounts[0]!.totals;
    expect(totals.startingBalance).toBe(10000);
    expect(totals.endingBalance).toBe(14000);
  });

  it("takes the first month's opening and the last month's closing", () => {
    // Whatever order the statements arrived in.
    const reversed = buildBankResponseShape([
      month("03", { beginning_balance: 15000, ending_balance: 14000 }),
      month("01", { beginning_balance: 10000, ending_balance: 12000 }),
    ]);
    const totals = reversed.banks[0]!.accounts[0]!.totals;
    expect(totals.startingBalance).toBe(10000);
    expect(totals.endingBalance).toBe(14000);
  });
});

describe("more than one account", () => {
  const shape = buildBankResponseShape([
    month("01", { bank_name: "Wells Fargo (0067)", ending_balance: 12000, deposits: 5000 }),
    month("01", {
      bank_name: "Chase (9911)",
      account_number: "9911",
      ending_balance: 8000,
      deposits: 2000,
    }),
  ]);

  it("gives each its own row", () => {
    expect(shape.banks.map((b) => b.bank_name).sort()).toEqual([
      "Chase (9911)",
      "Wells Fargo (0067)",
    ]);
  });

  it("DOES sum balances across accounts in one month", () => {
    // Across banks every figure adds: three accounts' balances at month end do
    // make up the company's cash. This is the sum the other one is not.
    expect(shape.totals[0]!.endingBalance).toBe(20000);
    expect(shape.totals[0]!.deposits).toBe(7000);
  });
});

describe("two statements in one month", () => {
  const shape = buildBankResponseShape([
    statement({
      period_start: "2024-01-01",
      period_end: "2024-01-15",
      deposits: 1000,
      withdrawals: 500,
      ending_balance: 10500,
    }),
    statement({
      period_start: "2024-01-16",
      period_end: "2024-01-31",
      deposits: 2000,
      withdrawals: 800,
      ending_balance: 11700,
    }),
  ]);

  it("adds the movements", () => {
    const [january] = shape.banks[0]!.accounts[0]!.months;
    expect(january!.deposits).toBe(3000);
    expect(january!.withdrawals).toBe(1300);
  });

  it("takes the LATEST closing balance, by date rather than by order", () => {
    // Array order depends on which folder was read first, which is not a fact
    // about the account.
    expect(shape.banks[0]!.accounts[0]!.months[0]!.endingBalance).toBe(11700);
  });

  it("takes the latest even when the later one arrived first", () => {
    const reversed = buildBankResponseShape([
      statement({ period_end: "2024-01-31", ending_balance: 11700 }),
      statement({ period_end: "2024-01-15", ending_balance: 10500 }),
    ]);
    expect(reversed.banks[0]!.accounts[0]!.months[0]!.endingBalance).toBe(11700);
  });
});

describe("figures and dates it was handed badly", () => {
  it("counts a statement it cannot date rather than dropping it silently", () => {
    // A statement nobody can date is a month missing from the grid, and the
    // page needs to be able to say so.
    const shape = buildBankResponseShape([
      month("01"),
      statement({ period_start: null, period_end: null }),
    ]);
    expect(shape.skipped).toBe(1);
    expect(shape.banks[0]!.accounts[0]!.months).toHaveLength(1);
  });

  it("groups a statement whose bank nobody named under one heading", () => {
    // `bank_name` is what the grid groups on. Left blank, every unnamed
    // statement would land under its own empty heading and the page would show
    // one account per file.
    const shape = buildBankResponseShape([
      month("01", { bank_name: null }),
      month("02", { bank_name: "   " }),
    ]);
    expect(shape.banks).toHaveLength(1);
    expect(shape.banks[0]!.bank_name).toBe("Unknown Bank");
    expect(shape.banks[0]!.accounts[0]!.months).toHaveLength(2);
  });

  it("cleans the account number out of the heading when nothing supplies a clean one", () => {
    // The heading reads "Wells Fargo", not "Wells Fargo (0067)" — the number
    // has its own column, and repeating it makes the heading unscannable.
    const shape = buildBankResponseShape([month("01", { bank_name_clean: null })]);
    expect(shape.banks[0]!.bank_name_clean).toBe("Wells Fargo");
  });

  it("fills in an account name and number a later statement knows", () => {
    /**
     * Extraction reads what is on the page, and the first page of a statement
     * run is often a summary that names neither. Leaving the account blank
     * because the FIRST file was thin puts an unlabelled row on the page while
     * the answer sits in the next file.
     */
    const shape = buildBankResponseShape([
      month("01", { account_name: null, account_number: null }),
      month("02", { account_name: "Business Checking", account_number: "1234560067" }),
    ]);
    expect(shape.banks[0]!.account_name).toBe("Business Checking");
    expect(shape.banks[0]!.account_number).toBe("0067");
  });

  it("keeps the account details the first statement gave", () => {
    // The other direction: a later statement must not overwrite what is
    // already known, or a thin summary page would blank a named account.
    const shape = buildBankResponseShape([
      month("01"),
      month("02", { account_name: null, account_number: null }),
    ]);
    expect(shape.banks[0]!.account_name).toBe("Business Checking");
    expect(shape.banks[0]!.account_number).toBe("0067");
  });

  it("dates a month by its key when the statement states no end date", () => {
    const shape = buildBankResponseShape([
      statement({ period_start: "2024-05-01", period_end: null }),
    ]);
    expect(shape.banks[0]!.accounts[0]!.months[0]!.statement_end_date).toBe("2024-05");
  });

  it("calls a statement with no stated status verified", () => {
    // The status column drives the review queue. Blank reads as neither
    // verified nor flagged, and the row falls out of both lists.
    const shape = buildBankResponseShape([month("01", { status: null })]);
    expect(shape.banks[0]!.accounts[0]!.months[0]!.status).toBe("Verified");
  });

  it("falls back to the period START when the end is missing", () => {
    const shape = buildBankResponseShape([
      statement({ period_start: "2024-05-01", period_end: null }),
    ]);
    expect(shape.banks[0]!.accounts[0]!.months[0]!.monthKey).toBe("2024-05");
  });

  it("adds fees to the withdrawals", () => {
    // A fee is money leaving the account. Kept out, the reconciliation is
    // short by exactly the fees and looks like an unexplained difference.
    const shape = buildBankResponseShape([month("01", { withdrawals: 3000, fees: 25 })]);
    expect(shape.banks[0]!.accounts[0]!.months[0]!.withdrawals).toBe(3025);
  });

  it("reads a figure written the way a statement writes it", () => {
    const shape = buildBankResponseShape([
      month("01", { deposits: "5,000.00", ending_balance: "(1,200.00)" }),
    ]);
    const [january] = shape.banks[0]!.accounts[0]!.months;
    expect(january!.deposits).toBe(5000);
    expect(january!.endingBalance).toBe(-1200);
  });

  it("carries a needs-review status up to the account", () => {
    const shape = buildBankResponseShape([
      month("01"),
      month("02", { status: "Needs Review" }),
    ]);
    expect(shape.banks[0]!.accounts[0]!.status).toBe("Needs Review");
  });

  it("names an account the statement did not", () => {
    const shape = buildBankResponseShape([
      statement({ bank_name: null, account_name: null, account_number: null }),
    ]);
    expect(shape.banks[0]!.bank_name).toBe("Unknown Bank");
    expect(shape.banks[0]!.accounts[0]!.account_name).toBe("Business Checking");
  });

  it("makes nothing of nothing", () => {
    expect(buildBankResponseShape([])).toEqual({
      banks: [],
      months: [],
      totals: [],
      skipped: 0,
    });
  });
});

describe("narrowing to one year", () => {
  const shape = buildBankResponseShape([
    statement({ period_start: "2023-12-01", period_end: "2023-12-31", beginning_balance: 9000, ending_balance: 10000, deposits: 1000, withdrawals: 0 }),
    month("01", { beginning_balance: 10000, ending_balance: 12000, deposits: 5000, withdrawals: 3000 }),
    month("02", { beginning_balance: 12000, ending_balance: 15000, deposits: 6000, withdrawals: 3000 }),
  ]);

  it("keeps only that year's months", () => {
    const scoped = scopeToYear(shape, 2024);
    expect(scoped.months).toEqual(["Jan-2024", "Feb-2024"]);
  });

  it("recomputes the totals from what survives", () => {
    // A totals row carried over describes months the page is no longer
    // showing.
    const scoped = scopeToYear(shape, 2024);
    const totals = scoped.banks[0]!.accounts[0]!.totals;
    expect(totals.startingBalance).toBe(10000);
    expect(totals.endingBalance).toBe(15000);
    expect(totals.deposits).toBe(11000);
  });

  it("drops an account with nothing in that year", () => {
    // Not a row with no data — not a row. An empty line reads as an account
    // holding nothing.
    const scoped = scopeToYear(shape, 2023);
    expect(scoped.banks).toHaveLength(1);
    expect(scopeToYear(shape, 2020).banks).toEqual([]);
  });

  it("leaves the grid alone when no year is asked for", () => {
    expect(scopeToYear(shape, null)).toBe(shape);
  });
});

describe("whether a statement adds up", () => {
  it("verifies one that does", () => {
    expect(
      statementBalanceStatus({
        beginning_balance: 10000,
        deposits: 5000,
        withdrawals: 3000,
        fees: 0,
        ending_balance: 12000,
      }),
    ).toBe("Verified");
  });

  it("flags one that does not", () => {
    // A statement that fails this was misread — a figure off the wrong line,
    // or a withdrawals total that was really a deposits total.
    expect(
      statementBalanceStatus({
        beginning_balance: 10000,
        deposits: 5000,
        withdrawals: 3000,
        ending_balance: 99999,
      }),
    ).toBe("Needs Review");
  });

  it("allows a pound, because a statement rounds and a model transcribes", () => {
    expect(
      statementBalanceStatus({
        beginning_balance: 10000,
        deposits: 5000,
        withdrawals: 3000,
        ending_balance: 12000.5,
      }),
    ).toBe("Verified");
  });

  it("counts the fees", () => {
    expect(
      statementBalanceStatus({
        beginning_balance: 10000,
        deposits: 5000,
        withdrawals: 3000,
        fees: 25,
        ending_balance: 11975,
      }),
    ).toBe("Verified");
  });
});

describe("normalising what a model returned", () => {
  const raw = {
    bankName: "Wells Fargo",
    accountName: "MSX Mobility LLC",
    accountNumber: "8209360067",
    statementStartDate: "2025-01-01",
    statementEndDate: "2025-01-31",
    startingBalance: 4306.99,
    deposits: 174012.41,
    withdrawals: 121647.89,
    fees: 0,
    endingBalance: 56671.51,
  };

  it("reads the camelCase shape the prompt asks for", () => {
    const s = normaliseExtractedStatement(raw);
    expect(s.bank_name_clean).toBe("Wells Fargo");
    expect(s.period_end).toBe("2025-01-31");
    expect(s.beginning_balance).toBe(4306.99);
  });

  it("reads the snake_case shape older extractions stored", () => {
    // Both are on file.
    const s = normaliseExtractedStatement({
      bank_name: "Chase",
      period_end: "2024-06-30",
      beginning_balance: 100,
      ending_balance: 200,
      deposits: 100,
    });
    expect(s.bank_name_clean).toBe("Chase");
    expect(s.period_end).toBe("2024-06-30");
  });

  it("reads a figure that carries a comma", () => {
    // The prompt says "no commas". A model that includes one anyway turned
    // that figure into ZERO under `Number(x) || 0` — a statement showing no
    // deposits for a month that had them.
    const s = normaliseExtractedStatement({ ...raw, deposits: "174,012.41" });
    expect(s.deposits).toBe(174012.41);
  });

  it("keeps only the last four digits of an account number", () => {
    // A full account number on a page anybody with data room access can open
    // is more of it than the reconciliation needs.
    expect(normaliseExtractedStatement(raw).account_number).toBe("0067");
  });

  it("puts the last four in the grouping key, so two accounts stay two rows", () => {
    expect(normaliseExtractedStatement(raw).bank_name).toBe("Wells Fargo (0067)");
  });

  it("forces withdrawals positive", () => {
    // A statement writes them as a positive total; a transcribed minus makes
    // the arithmetic add rather than subtract.
    expect(normaliseExtractedStatement({ ...raw, withdrawals: -121647.89 }).withdrawals).toBe(
      121647.89,
    );
  });

  it("corrects the opening balance taken off the closing line", () => {
    // The commonest misread. Recognisable because the period's own net
    // movement already equals the closing figure, which can only be true if
    // the account opened at nothing.
    const s = normaliseExtractedStatement({
      bankName: "Chase",
      startingBalance: 5000,
      deposits: 8000,
      withdrawals: 3000,
      endingBalance: 5000,
    });
    expect(s.beginning_balance).toBe(0);
  });

  it("leaves a real unchanged balance alone", () => {
    // An account that genuinely did not move has beginning = ending AND no
    // movement. The correction's second condition — that the period's own net
    // already equals the closing figure — is false here (0 ≠ 5000), so it does
    // not fire and the opening balance survives.
    const s = normaliseExtractedStatement({
      bankName: "Chase",
      startingBalance: 5000,
      deposits: 0,
      withdrawals: 0,
      endingBalance: 5000,
    });
    expect(s.beginning_balance).toBe(5000);
    expect(s.status).toBe("Verified");
  });

  it("marks a statement that does not add up", () => {
    const s = normaliseExtractedStatement({
      bankName: "Chase",
      startingBalance: 1000,
      deposits: 100,
      withdrawals: 0,
      endingBalance: 99999,
    });
    expect(s.status).toBe("Needs Review");
  });

  it("names a bank the statement did not", () => {
    expect(normaliseExtractedStatement({}).bank_name_clean).toBe("Unknown Bank");
  });
});

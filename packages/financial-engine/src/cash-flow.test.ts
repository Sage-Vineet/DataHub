import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/engagement.json" with { type: "json" };
import { rollForwardBalanceSheet, type BalanceSheetAnchor, type BalanceSheetResult } from "./balance-sheet.js";
import { buildCashFlow, PeriodMismatchError } from "./cash-flow.js";
import { buildIncomeStatement, type IncomeStatement } from "./income-statement.js";
import { buildPeriods, periodKey } from "./periods.js";
import type { Account, GlEntry } from "./types.js";

/**
 * The cash flow statement.
 *
 * The property that matters is articulation: operating + investing + financing
 * must equal the movement in the bank accounts. Everything else — which section
 * a line lands in, which way its sign points — is only correct insofar as it
 * makes that identity hold, so the reconciliation is asserted against the real
 * engagement rather than only on constructed cases.
 */

const P = (year: number) => periodKey(year, null);

/** A minimal two-period balance sheet, built by hand so signs are unambiguous. */
function sheet(
  lines: Array<{
    accountId: string;
    section: string;
    group: string | null;
    opening: number;
    y1: number;
    y2: number;
  }>,
): BalanceSheetResult {
  return {
    periods: [
      { fiscalYear: 2024, month: null },
      { fiscalYear: 2025, month: null },
    ] as BalanceSheetResult["periods"],
    lines: lines.map((l) => ({
      accountId: l.accountId,
      accountName: l.accountId,
      section: l.section,
      group: l.group,
      groupCertain: true,
      balances: { [P(2024)]: l.y1, [P(2025)]: l.y2 },
    })),
    openingBalances: Object.fromEntries(lines.map((l) => [l.accountId, l.opening])),
    retainedEarnings: {},
    openingRetainedEarnings: 0,
    netIncome: {},
    checks: [],
    tieOut: null,
    balances: true,
  };
}

const income = (y1: number, y2: number): IncomeStatement =>
  ({
    periods: [],
    revenue: {},
    expenses: {},
    netIncome: { [P(2024)]: y1, [P(2025)]: y2 },
    byAccount: new Map(),
    ledgerByAccount: new Map(),
  }) as unknown as IncomeStatement;

describe("which way the signs point", () => {
  it("treats a growing asset as cash consumed", () => {
    // Receivables going up means revenue was earned but not collected.
    const cf = buildCashFlow({
      income: income(0, 0),
      balanceSheet: sheet([
        { accountId: "ar", section: "asset", group: "Accounts Receivable", opening: 100, y1: 150, y2: 120 },
      ]),
    });

    const line = cf.lines[0]!;
    expect(line.amounts[P(2024)]).toBe(-50); // grew by 50 → consumed 50
    expect(line.amounts[P(2025)]).toBe(30); // fell by 30 → released 30
  });

  it("treats a growing liability as cash provided", () => {
    const cf = buildCashFlow({
      income: income(0, 0),
      balanceSheet: sheet([
        { accountId: "ap", section: "liability", group: "Other Current Liabilities", opening: 0, y1: 40, y2: 10 },
      ]),
    });

    expect(cf.lines[0]!.amounts[P(2024)]).toBe(40);
    expect(cf.lines[0]!.amounts[P(2025)]).toBe(-30);
  });

  it("measures the first period against the opening position, not from zero", () => {
    // Otherwise the opening period shows every balance as if it appeared from
    // nothing, and nothing reconciles.
    const cf = buildCashFlow({
      income: income(0, 0),
      balanceSheet: sheet([
        { accountId: "ar", section: "asset", group: "Accounts Receivable", opening: 100, y1: 100, y2: 100 },
      ]),
    });
    expect(cf.lines[0]!.amounts[P(2024)]).toBe(0);
  });
});

describe("sections", () => {
  const cf = buildCashFlow({
    income: income(0, 0),
    balanceSheet: sheet([
      { accountId: "ar", section: "asset", group: "Accounts Receivable", opening: 0, y1: 0, y2: 0 },
      { accountId: "cc", section: "liability", group: "Credit Cards", opening: 0, y1: 0, y2: 0 },
      { accountId: "fa", section: "asset", group: "Fixed Assets", opening: 0, y1: 0, y2: 0 },
      { accountId: "oa", section: "asset", group: "Other Assets", opening: 0, y1: 0, y2: 0 },
      { accountId: "ltl", section: "liability", group: "Long-term Liabilities", opening: 0, y1: 0, y2: 0 },
      { accountId: "eq", section: "equity", group: "Equity", opening: 0, y1: 0, y2: 0 },
    ]),
  });
  const sectionOf = (id: string) => cf.lines.find((l) => l.accountId === id)!.section;

  it("puts working capital in operating", () => {
    expect(sectionOf("ar")).toBe("operating");
    expect(sectionOf("cc")).toBe("operating");
  });

  it("puts long-lived assets in investing", () => {
    expect(sectionOf("fa")).toBe("investing");
    expect(sectionOf("oa")).toBe("investing");
  });

  it("puts debt and equity in financing", () => {
    expect(sectionOf("ltl")).toBe("financing");
    expect(sectionOf("eq")).toBe("financing");
  });

  it("falls back to operating for an ungrouped account rather than dropping it", () => {
    // A dropped line would break the reconciliation silently, which is worse
    // than filing it in the most likely section and showing the number.
    const stray = buildCashFlow({
      income: income(0, 0),
      balanceSheet: sheet([
        { accountId: "x", section: "asset", group: null, opening: 0, y1: 10, y2: 10 },
      ]),
    });
    expect(stray.lines[0]!.section).toBe("operating");
    expect(stray.operating[P(2024)]).toBe(-10);
  });
});

describe("cash is the thing being explained", () => {
  it("keeps bank accounts out of the lines", () => {
    const cf = buildCashFlow({
      income: income(0, 0),
      balanceSheet: sheet([
        { accountId: "bank", section: "asset", group: "Bank Accounts", opening: 10, y1: 10, y2: 10 },
        { accountId: "ar", section: "asset", group: "Accounts Receivable", opening: 0, y1: 0, y2: 0 },
      ]),
    });
    expect(cf.lines.map((l) => l.accountId)).toEqual(["ar"]);
  });

  it("sums every bank account into opening and closing cash", () => {
    const cf = buildCashFlow({
      income: income(0, 0),
      balanceSheet: sheet([
        { accountId: "chk", section: "asset", group: "Bank Accounts", opening: 100, y1: 120, y2: 90 },
        { accountId: "sav", section: "asset", group: "Bank Accounts", opening: 50, y1: 50, y2: 70 },
      ]),
    });
    expect(cf.openingCash[P(2024)]).toBe(150);
    expect(cf.closingCash[P(2024)]).toBe(170);
    expect(cf.closingCash[P(2025)]).toBe(160);
  });
});

describe("the reconciliation", () => {
  it("articulates on a sheet that balances", () => {
    // Net income 100, receivables up 30, cash up 70.
    const cf = buildCashFlow({
      income: income(100, 0),
      balanceSheet: sheet([
        { accountId: "bank", section: "asset", group: "Bank Accounts", opening: 0, y1: 70, y2: 70 },
        { accountId: "ar", section: "asset", group: "Accounts Receivable", opening: 0, y1: 30, y2: 30 },
      ]),
    });

    expect(cf.operating[P(2024)]).toBe(70); // 100 − 30
    expect(cf.netChange[P(2024)]).toBe(70);
    expect(cf.checks[0]).toMatchObject({ cashMovement: 70, difference: 0, reconciles: true });
    expect(cf.reconciles).toBe(true);
  });

  it("says so when it does not articulate", () => {
    // Cash moved 500 with nothing to explain it. A statement that hid this
    // would be worse than no statement.
    const cf = buildCashFlow({
      income: income(0, 0),
      balanceSheet: sheet([
        { accountId: "bank", section: "asset", group: "Bank Accounts", opening: 0, y1: 500, y2: 500 },
      ]),
    });

    expect(cf.reconciles).toBe(false);
    expect(cf.checks[0]).toMatchObject({ netChange: 0, cashMovement: 500, difference: -500 });
  });

  it("tolerates rounding but not a real break", () => {
    const nearly = buildCashFlow({
      income: income(100.004, 0),
      balanceSheet: sheet([
        { accountId: "bank", section: "asset", group: "Bank Accounts", opening: 0, y1: 100, y2: 100 },
      ]),
    });
    expect(nearly.reconciles).toBe(true);

    const off = buildCashFlow({
      income: income(100, 0),
      balanceSheet: sheet([
        { accountId: "bank", section: "asset", group: "Bank Accounts", opening: 0, y1: 101, y2: 101 },
      ]),
    });
    expect(off.reconciles).toBe(false);
  });
});

describe("equity that moved for a reason other than trading", () => {
  /** A sheet that tracks derived equity, as a real roll-forward does. */
  const withEquity = (over: Partial<BalanceSheetResult>): BalanceSheetResult => ({
    ...sheet([
      { accountId: "bank", section: "asset", group: "Bank Accounts", opening: 0, y1: 60, y2: 60 },
    ]),
    ...over,
  });

  it("shows an owner distribution as financing, and reconciles", () => {
    // Profit of 100, of which 40 was drawn out: cash is up 60, and the
    // difference is invisible to the income statement.
    const cf = buildCashFlow({
      income: income(100, 0),
      balanceSheet: withEquity({
        retainedEarnings: { [P(2024)]: -40, [P(2025)]: -40 },
        netIncome: { [P(2024)]: 100, [P(2025)]: 100 },
        openingRetainedEarnings: 0,
      }),
    });

    const line = cf.lines.find((l) => l.section === "financing")!;
    expect(line.accountName).toBe("Distributions and other equity movements");
    expect(line.amounts[P(2024)]).toBe(-40);
    expect(cf.financing[P(2024)]).toBe(-40);
    expect(cf.reconciles).toBe(true);
  });

  it("adds no line when equity moved only through profit", () => {
    const cf = buildCashFlow({
      income: income(60, 0),
      balanceSheet: withEquity({
        retainedEarnings: { [P(2024)]: 0, [P(2025)]: 0 },
        netIncome: { [P(2024)]: 60, [P(2025)]: 60 },
        openingRetainedEarnings: 0,
      }),
    });
    expect(cf.lines.filter((l) => l.section === "financing")).toEqual([]);
    expect(cf.reconciles).toBe(true);
  });

  it("leaves net income alone when the sheet does not track equity at all", () => {
    // The footgun: comparing against an untracked series reads as "equity never
    // moved", which would subtract the profit back out.
    const cf = buildCashFlow({
      income: income(70, 0),
      balanceSheet: sheet([
        { accountId: "bank", section: "asset", group: "Bank Accounts", opening: 0, y1: 70, y2: 70 },
      ]),
    });
    expect(cf.operating[P(2024)]).toBe(70);
    expect(cf.reconciles).toBe(true);
  });
});

describe("periods that do not line up", () => {
  it("refuses rather than reading a missing period as zero profit", () => {
    // The easy mistake: `rollForwardBalanceSheet` always rolls monthly, so an
    // annual income statement never matches. Silently, the statement would then
    // be wrong by exactly the profit of every period.
    const annualIncome = income(100, 200);
    const monthly: BalanceSheetResult = {
      ...sheet([{ accountId: "ar", section: "asset", group: "Accounts Receivable", opening: 0, y1: 0, y2: 0 }]),
      periods: [
        { fiscalYear: 2024, month: 1 },
        { fiscalYear: 2024, month: 2 },
      ] as BalanceSheetResult["periods"],
    };

    expect(() => buildCashFlow({ income: annualIncome, balanceSheet: monthly })).toThrow(
      PeriodMismatchError,
    );
  });

  it("names the periods it could not find", () => {
    const monthly: BalanceSheetResult = {
      ...sheet([]),
      periods: [{ fiscalYear: 2024, month: 1 }] as BalanceSheetResult["periods"],
    };
    try {
      buildCashFlow({ income: income(0, 0), balanceSheet: monthly });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PeriodMismatchError);
      expect((err as PeriodMismatchError).missing).toEqual(["2024-01"]);
      expect((err as Error).message).toMatch(/rolls monthly/);
    }
  });

  it("accepts an empty balance sheet without complaining", () => {
    // Nothing to reconcile is not a mismatch.
    const empty: BalanceSheetResult = { ...sheet([]), periods: [] as BalanceSheetResult["periods"] };
    const cf = buildCashFlow({ income: income(0, 0), balanceSheet: empty });
    expect(cf.checks).toEqual([]);
    expect(cf.reconciles).toBe(true);
  });
});

describe("the tolerance", () => {
  it("can be widened for a caller that expects coarser data", () => {
    const args = {
      income: income(100, 0),
      balanceSheet: sheet([
        { accountId: "bank", section: "asset", group: "Bank Accounts", opening: 0, y1: 105, y2: 105 },
      ]),
    };
    expect(buildCashFlow(args).reconciles).toBe(false);
    expect(buildCashFlow({ ...args, toleranceMinorUnits: 10 }).reconciles).toBe(true);
  });
});

describe("sparse and malformed input", () => {
  /**
   * Every lookup here defaults rather than throwing, because a balance sheet
   * assembled from an incomplete upload is the normal case mid-engagement. The
   * statement must still be produced — and must still report that it does not
   * reconcile, rather than crashing on the way to saying so.
   */
  const periods = [
    { fiscalYear: 2024, month: null },
    { fiscalYear: 2025, month: null },
  ] as BalanceSheetResult["periods"];

  const bare = (over: Partial<BalanceSheetResult>): BalanceSheetResult => ({
    periods,
    lines: [],
    openingBalances: {},
    retainedEarnings: {},
    openingRetainedEarnings: 0,
    netIncome: {},
    checks: [],
    tieOut: null,
    balances: true,
    ...over,
  });

  it("treats a line with no balance for a period as zero", () => {
    const cf = buildCashFlow({
      income: income(0, 0),
      balanceSheet: bare({
        lines: [
          {
            accountId: "ar",
            accountName: "AR",
            section: "asset",
            group: "Accounts Receivable",
            groupCertain: true,
            balances: { [P(2025)]: 50 }, // 2024 absent entirely
          },
        ],
      }),
    });
    expect(cf.lines[0]!.amounts[P(2024)]).toBe(0);
    expect(cf.lines[0]!.amounts[P(2025)]).toBe(-50);
  });

  it("treats an account with no opening balance as starting at zero", () => {
    const cf = buildCashFlow({
      income: income(0, 0),
      balanceSheet: bare({
        lines: [
          {
            accountId: "new",
            accountName: "New",
            section: "liability",
            group: "Long-term Liabilities",
            groupCertain: false,
            balances: { [P(2024)]: 25, [P(2025)]: 25 },
          },
        ],
      }),
    });
    expect(cf.lines[0]!.amounts[P(2024)]).toBe(25);
    expect(cf.lines[0]!.groupCertain).toBe(false);
  });

  it("carries a partly-tracked equity series without producing NaN", () => {
    const cf = buildCashFlow({
      income: income(10, 10),
      balanceSheet: bare({
        lines: [],
        // Only the second period is tracked.
        netIncome: { [P(2025)]: 10 },
      }),
    });
    for (const key of [P(2024), P(2025)]) {
      expect(Number.isFinite(cf.netChange[key]!)).toBe(true);
      expect(Number.isFinite(cf.financing[key]!)).toBe(true);
    }
  });

  it("files an unrecognised group in operating rather than dropping the line", () => {
    // A group the balance sheet learns to emit before this table knows it.
    const cf = buildCashFlow({
      income: income(0, 0),
      balanceSheet: bare({
        lines: [
          {
            accountId: "odd",
            accountName: "Odd",
            section: "asset",
            group: "Crypto Holdings" as never,
            groupCertain: false,
            balances: { [P(2024)]: 10, [P(2025)]: 10 },
          },
        ],
      }),
    });
    expect(cf.lines[0]!.section).toBe("operating");
    expect(cf.operating[P(2024)]).toBe(-10);
  });

  it("treats a bank account with no balance for a period as zero", () => {
    const cf = buildCashFlow({
      income: income(0, 0),
      balanceSheet: bare({
        lines: [
          {
            accountId: "chk",
            accountName: "Checking",
            section: "asset",
            group: "Bank Accounts",
            groupCertain: true,
            balances: { [P(2025)]: 80 }, // 2024 absent
          },
        ],
      }),
    });
    expect(cf.closingCash[P(2024)]).toBe(0);
    expect(cf.closingCash[P(2025)]).toBe(80);
  });

  it("elides the period list in the mismatch message when there are many", () => {
    const many: BalanceSheetResult = {
      ...bare({}),
      periods: [1, 2, 3, 4, 5].map((m) => ({ fiscalYear: 2024, month: m })) as BalanceSheetResult["periods"],
    };
    try {
      buildCashFlow({ income: income(0, 0), balanceSheet: many });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("…");
    }
  });

  it("reports zero cash rather than NaN when there are no bank accounts", () => {
    const cf = buildCashFlow({ income: income(5, 5), balanceSheet: bare({}) });
    expect(cf.openingCash[P(2024)]).toBe(0);
    expect(cf.closingCash[P(2024)]).toBe(0);
    // Profit with nowhere for the cash to go does not reconcile, and says so.
    expect(cf.reconciles).toBe(false);
  });
});

describe("against the real engagement", () => {
  const accounts = fixture.accounts as Account[];
  const entries = fixture.glEntries as GlEntry[];
  const idByName = new Map(accounts.map((a) => [a.name, a.id]));
  const sheets = fixture.balanceSheets as Array<{
    anchor: string;
    rows: Array<{ name: string; section: string; group: string | null; amount: number }>;
  }>;

  const anchor = (which: "starting" | "ending"): BalanceSheetAnchor => {
    const s = sheets.find((x) => x.anchor === which)!;
    return {
      kind: which,
      fiscalYear: which === "starting" ? 2021 : 2025,
      month: 12,
      rows: s.rows.map((r) => ({
        accountId: idByName.get(r.name) ?? r.name,
        accountName: r.name,
        section: r.section,
        group: r.group,
        amount: r.amount,
      })),
    };
  };

  const balanceSheet = rollForwardBalanceSheet({
    accounts,
    entries,
    anchors: [anchor("starting"), anchor("ending")],
    fiscalYears: fixture.fiscalYears,
  });
  // Monthly, to match: `rollForwardBalanceSheet` always rolls month by month,
  // and a statement keyed by year cannot be differenced against one keyed by
  // month — every lookup misses and reads as zero.
  const monthlyPeriods = buildPeriods(entries, fixture.fiscalYears, "monthly");
  const incomeStatement = buildIncomeStatement(accounts, entries, monthlyPeriods, "monthly");

  it("reconciles in every period of a real four-year engagement", () => {
    // The acid test. A sign error anywhere, or a group filed in the wrong
    // section, shows up here as a period that does not articulate.
    const cf = buildCashFlow({ income: incomeStatement, balanceSheet });

    const broken = cf.checks
      .filter((c) => !c.reconciles)
      .map((c) => `${c.period}: out by ${c.difference}`);
    expect(broken).toEqual([]);
    expect(cf.reconciles).toBe(true);
  });

  it("explains a cash movement that actually happened", () => {
    const cf = buildCashFlow({ income: incomeStatement, balanceSheet });
    const firstYear = cf.checks[0]!;
    // Not a tautology: the engagement's cash genuinely moves.
    expect(Math.abs(firstYear.cashMovement)).toBeGreaterThan(0);
    expect(cf.lines.length).toBeGreaterThan(5);
  });
});

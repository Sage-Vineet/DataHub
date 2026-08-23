import { describe, expect, it } from "vitest";
import { engagementFixture as fixture } from "@datahub/financial-engine";
import type { BalanceSheetAnchor } from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";
import { buildStatements, toBalanceSheetStatement, toCashFlowStatement } from "./statements.js";

/**
 * The statements presenter.
 *
 * Two things are being checked, and they are different in kind. The shape must
 * match what `FinancialStatementsView` walks — nested sections, groups keyed by
 * name, `totalLiabilitiesAndEquity` — because a correct number in the wrong
 * place renders as a blank row. And the numbers must still balance once they
 * have been rearranged, which is asserted against the real engagement.
 */

const accounts = fixture.accounts;
const entries = fixture.glEntries;
const idByName = new Map(accounts.map((a) => [a.name, a.id]));
const sheets = fixture.balanceSheets;

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

const engagement = (over: Partial<EngagementData> = {}): EngagementData => ({
  companyId: "company-1",
  companyName: "Acme Manufacturing",
  profitMetric: "adjusted_ebitda",
  marketRateReplacementSalary: null,
  fiscalYears: fixture.fiscalYears,
  accounts,
  entries,
  anchors: [anchor("starting"), anchor("ending")],
  ...over,
});

describe("what it refuses to build", () => {
  it("reports missing data rather than an empty statement, with no accounts", () => {
    const result = buildStatements(engagement({ accounts: [], entries: [] }));
    expect(result.missingData.join(" ")).toMatch(/Chart of Accounts/);
    expect(result.reports.balanceSheet.yearly).toEqual([]);
    // `validation` carries the same list — the view reads both.
    expect(result.validation).toEqual(result.missingData);
  });

  it("says so when the requested year has no data", () => {
    const result = buildStatements(engagement(), { year: 1999 });
    expect(result.missingData.join(" ")).toMatch(/FY1999/);
  });

  it("will not roll a balance sheet with nothing to roll from", () => {
    // A roll-forward from zero would be confidently wrong.
    const result = buildStatements(engagement({ anchors: [] }));
    expect(result.missingData.join(" ")).toMatch(/No balance sheet has been ingested/);
  });

  it("says so when there is no data for any year", () => {
    const result = buildStatements(engagement({ fiscalYears: [] }));
    expect(result.missingData.join(" ")).toMatch(/for any year/);
  });

  it("still names the company and currency when it cannot build", () => {
    const result = buildStatements(engagement({ accounts: [] }), { currency: "GBP" });
    expect(result).toMatchObject({ companyName: "Acme Manufacturing", currency: "GBP" });
  });
});

describe("the profit-and-loss slot", () => {
  it("is left empty on purpose", () => {
    // The view takes its P&L from the income-statement endpoint. Returning a
    // second, differently-derived one here would put two numbers on the wire
    // and invite someone to trust the wrong one — which is how legacy reported
    // $4,975,913 for a year whose net income was $47,568.
    const result = buildStatements(engagement());
    expect(result.reports.profitAndLoss).toEqual({ yearly: [], monthly: [] });
  });
});

describe("the balance sheet, arranged for the view", () => {
  const result = buildStatements(engagement());
  const yearly = result.reports.balanceSheet.yearly;

  it("produces one column per fiscal year", () => {
    expect(yearly.map((e) => e.year)).toEqual(fixture.fiscalYears);
  });

  it("puts each group under the section the view walks", () => {
    const statement = yearly[0]!.statement;
    // The exact paths `bsBuildRowDefs` reduces through.
    expect(statement.assets.currentAssets.groups["Bank Accounts"]).toBeDefined();
    expect(Object.keys(statement.assets.fixedAssets.groups)).toContain("Fixed Assets");
    expect(statement.liabilities.currentLiabilities.groups).toBeDefined();
  });

  it("gives every account a name and an amount", () => {
    const bank = buildStatements(engagement()).reports.balanceSheet.yearly[0]!.statement.assets
      .currentAssets.groups["Bank Accounts"]!;
    expect(bank.accounts.length).toBeGreaterThan(0);
    for (const account of bank.accounts) {
      expect(typeof account.name).toBe("string");
      expect(Number.isFinite(account.amount)).toBe(true);
    }
  });

  it("carries retained earnings and net income into equity", () => {
    // They are derived rather than rolled as lines, so a sheet that omitted
    // them would not balance.
    const names = yearly[0]!.statement.equity.accounts.map((a) => a.name);
    expect(names).toContain("Retained Earnings");
    expect(names).toContain("Net Income");
  });

  it("balances in every year", () => {
    for (const entry of yearly) {
      const s = entry.statement;
      expect(s.totalAssets, `FY${entry.year}`).toBeCloseTo(s.totalLiabilitiesAndEquity, 2);
      expect(s.totalLiabilitiesAndEquity).toBeCloseTo(s.totalLiabilities + s.totalEquity, 2);
    }
  });

  it("totals each section from its groups", () => {
    const section = yearly[0]!.statement.assets.currentAssets;
    const fromGroups = Object.values(section.groups).reduce((sum, g) => sum + g.total, 0);
    expect(section.total).toBeCloseTo(fromGroups, 2);
  });

  it("reports a year-end position, not a sum of months", () => {
    // A balance sheet is a moment. The yearly column must equal December.
    const december = result.reports.balanceSheet.monthly.filter(
      (m) => m.year === fixture.fiscalYears[0] && m.monthNumber === 12,
    )[0]!;
    expect(yearly[0]!.statement.totalAssets).toBeCloseTo(december.statement.totalAssets, 2);
  });

  it("produces a column for every month", () => {
    expect(result.reports.balanceSheet.monthly).toHaveLength(fixture.fiscalYears.length * 12);
    expect(result.reports.balanceSheet.monthly[0]).toMatchObject({ month: "January", monthNumber: 1 });
  });
});

describe("the cash flow, arranged for the view", () => {
  const result = buildStatements(engagement());
  const yearly = result.reports.cashFlow.yearly;

  it("uses the three section keys the view reads", () => {
    const statement = yearly[0]!.statement;
    expect(statement.operatingActivities.label).toBe("Operating Activities");
    expect(statement.investingActivities.items).toBeInstanceOf(Array);
    expect(typeof statement.financingActivities.total).toBe("number");
  });

  it("leads the operating section with net income", () => {
    expect(yearly[0]!.statement.operatingActivities.items[0]!.name).toBe("Net Income");
  });

  it("articulates: the three sections explain the movement in cash", () => {
    for (const entry of yearly) {
      const s = entry.statement;
      const sections =
        s.operatingActivities.total + s.investingActivities.total + s.financingActivities.total;
      expect(sections, `FY${entry.year} sections`).toBeCloseTo(s.netCashIncrease, 2);
      expect(s.endingCash - s.openingCash, `FY${entry.year} cash`).toBeCloseTo(s.netCashIncrease, 2);
    }
  });

  it("sums a year's movement but takes cash from its ends", () => {
    // Adding twelve opening balances together would be nonsense.
    const year = fixture.fiscalYears[0]!;
    const months = result.reports.cashFlow.monthly.filter((m) => m.year === year);
    const summedMovement = months.reduce((t, m) => t + m.statement.netCashIncrease, 0);

    expect(yearly[0]!.statement.netCashIncrease).toBeCloseTo(summedMovement, 2);
    expect(yearly[0]!.statement.openingCash).toBeCloseTo(months[0]!.statement.openingCash, 2);
    expect(yearly[0]!.statement.endingCash).toBeCloseTo(months.at(-1)!.statement.endingCash, 2);
  });

  it("drops lines that did not move, so the statement is readable", () => {
    for (const entry of yearly) {
      for (const item of entry.statement.investingActivities.items) {
        expect(Math.abs(item.amount)).toBeGreaterThan(0.005);
      }
    }
  });

  it("carries the year-end cash across to the next year's opening", () => {
    for (let i = 1; i < yearly.length; i++) {
      expect(yearly[i]!.statement.openingCash).toBeCloseTo(yearly[i - 1]!.statement.endingCash, 2);
    }
  });
});

describe("filtering to one year", () => {
  it("returns only that year, and still balances", () => {
    const year = fixture.fiscalYears[1]!;
    const result = buildStatements(engagement(), { year });

    expect(result.reports.balanceSheet.yearly.map((e) => e.year)).toEqual([year]);
    expect(result.reports.cashFlow.monthly.every((m) => m.year === year)).toBe(true);
    const s = result.reports.balanceSheet.yearly[0]!.statement;
    expect(s.totalAssets).toBeCloseTo(s.totalLiabilitiesAndEquity, 2);
  });
});

describe("a year with nothing in it", () => {
  it("is left out rather than shown as a year of zeroes", () => {
    // A fiscal year the company declares but has posted nothing to. A card of
    // zeroes reads as a year somebody checked and found empty; an absent year
    // reads as a year with no data, which is what it is.
    const years = [...fixture.fiscalYears, 2099];
    const result = buildStatements(engagement({ fiscalYears: years }));

    expect(result.reports.balanceSheet.yearly.map((e) => e.year)).not.toContain(2099);
    expect(result.reports.cashFlow.yearly.map((e) => e.year)).not.toContain(2099);
  });

  it("names every month it does report", () => {
    const result = buildStatements(engagement());
    expect(result.reports.balanceSheet.monthly.every((m) => m.month !== "")).toBe(true);
    expect(
      result.reports.balanceSheet.monthly.every(
        (m) => (m.monthNumber ?? 0) >= 1 && (m.monthNumber ?? 0) <= 12,
      ),
    ).toBe(true);
  });
});

describe("arranging one balance sheet", () => {
  /** Just enough of a rolled balance sheet to exercise the presenter. */
  const rolled = (over: Record<string, unknown> = {}) =>
    ({
      periods: [],
      openingBalances: {},
      openingRetainedEarnings: {},
      retainedEarnings: {},
      netIncome: {},
      checks: [],
      balances: true,
      lines: [],
      ...over,
    }) as never;

  const line = (name: string, group: string | null, amount: number | undefined) => ({
    accountId: name,
    accountName: name,
    section: "asset",
    group,
    groupCertain: true,
    balances: amount === undefined ? {} : { "2025-12": amount },
  });

  it("files each account under the section its group presents in", () => {
    const statement = toBalanceSheetStatement(
      rolled({
        lines: [
          line("Chequing", "Bank Accounts", 5_000),
          line("Delivery Van", "Fixed Assets", 20_000),
          line("Goodwill", "Other Assets", 1_000),
          line("Amex", "Credit Cards", -2_000),
          line("Mortgage", "Long-term Liabilities", -50_000),
        ],
      }),
      "2025-12",
    );

    expect(statement.assets.currentAssets.groups["Bank Accounts"]!.total).toBe(5_000);
    expect(statement.assets.fixedAssets.total).toBe(20_000);
    expect(statement.assets.otherAssets.total).toBe(1_000);
    expect(statement.liabilities.currentLiabilities.total).toBe(-2_000);
    expect(statement.liabilities.longTermLiabilities.total).toBe(-50_000);
    expect(statement.totalAssets).toBe(26_000);
  });

  it("puts an equity account in equity rather than in a section", () => {
    const statement = toBalanceSheetStatement(
      rolled({ lines: [line("Common Stock", "Equity", 1_000)] }),
      "2025-12",
    );
    expect(statement.equity.accounts).toEqual([{ name: "Common Stock", amount: 1_000 }]);
    expect(statement.assets.currentAssets.groups).toEqual({});
  });

  it("puts an account with no group somewhere visible rather than nowhere", () => {
    // A line dropped for want of a heading is a line missing from a statement
    // that still foots — the balance goes to the total and the row does not
    // appear.
    const statement = toBalanceSheetStatement(
      rolled({ lines: [line("Unclassified", null, 700)] }),
      "2025-12",
    );
    expect(statement.assets.currentAssets.groups["Other Current Assets"]!.accounts).toEqual([
      { name: "Unclassified", amount: 700 },
    ]);
  });

  it("puts an account whose group is not one of the nine into current assets", () => {
    const statement = toBalanceSheetStatement(
      rolled({ lines: [line("Odd One", "Something Else", 300)] }),
      "2025-12",
    );
    expect(statement.assets.currentAssets.total).toBe(300);
  });

  it("reads an account with nothing in this period as zero", () => {
    const statement = toBalanceSheetStatement(
      rolled({ lines: [line("Dormant", "Bank Accounts", undefined)] }),
      "2025-12",
    );
    expect(statement.assets.currentAssets.groups["Bank Accounts"]!.total).toBe(0);
  });

  it("adds retained earnings and current-year income to equity", () => {
    // Both are derived rather than rolled as lines, and a balance sheet without
    // them does not balance.
    const statement = toBalanceSheetStatement(
      rolled({
        lines: [line("Chequing", "Bank Accounts", 10_000)],
        retainedEarnings: { "2025-12": 6_000 },
        netIncome: { "2025-12": 4_000 },
      }),
      "2025-12",
    );
    expect(statement.equity.accounts).toEqual([
      { name: "Retained Earnings", amount: 6_000 },
      { name: "Net Income", amount: 4_000 },
    ]);
    expect(statement.equity.total).toBe(10_000);
    expect(statement.totalLiabilitiesAndEquity).toBe(10_000);
  });

  it("leaves out a zero retained earnings or net income", () => {
    // A row reading "Net Income 0.00" says somebody checked. An absent row says
    // there was none, which is what a period with no profit means.
    const statement = toBalanceSheetStatement(
      rolled({ retainedEarnings: {}, netIncome: {} }),
      "2025-12",
    );
    expect(statement.equity.accounts).toEqual([]);
  });
});

describe("arranging one cash flow", () => {
  const cash = (over: Record<string, unknown> = {}) =>
    ({
      periods: [],
      lines: [],
      netIncome: {},
      operating: {},
      investing: {},
      financing: {},
      netChange: {},
      openingCash: {},
      closingCash: {},
      checks: [],
      reconciles: true,
      ...over,
    }) as never;

  it("adds a line's movement across every period asked for", () => {
    const view = toCashFlowStatement(
      cash({
        lines: [
          {
            accountId: "ar",
            accountName: "Accounts Receivable",
            section: "operating",
            group: "Accounts Receivable",
            amounts: { "2025-01": -100, "2025-02": -50 },
          },
        ],
        netIncome: { "2025-01": 1_000, "2025-02": 500 },
        operating: { "2025-01": 900, "2025-02": 450 },
      }),
      ["2025-01", "2025-02"],
    );

    expect(view.operatingActivities.items).toEqual([
      { name: "Net Income", amount: 1_500 },
      { name: "Accounts Receivable", amount: -150 },
    ]);
    expect(view.operatingActivities.total).toBe(1_350);
  });

  it("leads the operating section with net income", () => {
    // Convention, and it is the one line that is not a balance movement.
    const view = toCashFlowStatement(cash({ netIncome: { "2025-01": 5 } }), ["2025-01"]);
    expect(view.operatingActivities.items[0]!.name).toBe("Net Income");
  });

  it("leaves out a line that moved by nothing", () => {
    // A row of 0.00 in a cash flow reads as a movement somebody measured.
    const view = toCashFlowStatement(
      cash({
        lines: [
          {
            accountId: "a",
            accountName: "Dormant",
            section: "investing",
            group: "Fixed Assets",
            amounts: { "2025-01": 0.001 },
          },
        ],
      }),
      ["2025-01"],
    );
    expect(view.investingActivities.items).toEqual([]);
  });

  it("reads a period a line does not mention as no movement", () => {
    const view = toCashFlowStatement(
      cash({
        lines: [
          {
            accountId: "a",
            accountName: "Loan",
            section: "financing",
            group: "Long-term Liabilities",
            amounts: { "2025-01": 1_000 },
          },
        ],
      }),
      ["2025-01", "2025-02"],
    );
    expect(view.financingActivities.items).toEqual([{ name: "Loan", amount: 1_000 }]);
  });

  it("takes opening cash from the first period and closing from the last", () => {
    const view = toCashFlowStatement(
      cash({
        openingCash: { "2025-01": 2_000, "2025-02": 2_500 },
        closingCash: { "2025-01": 2_500, "2025-02": 3_000 },
      }),
      ["2025-01", "2025-02"],
    );
    expect(view.openingCash).toBe(2_000);
    expect(view.endingCash).toBe(3_000);
  });

  it("reports no cash at either end for a request naming no periods", () => {
    const view = toCashFlowStatement(cash({ openingCash: { "2025-01": 999 } }), []);
    expect(view.openingCash).toBe(0);
    expect(view.endingCash).toBe(0);
  });

  it("reads a period with no stated cash position as zero", () => {
    const view = toCashFlowStatement(cash(), ["2025-01"]);
    expect(view.openingCash).toBe(0);
    expect(view.endingCash).toBe(0);
    expect(view.netCashIncrease).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { engagementFixture as fixture } from "@datahub/financial-engine";
import type { BalanceSheetAnchor } from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";
import { buildStatements } from "./statements.js";

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

import { describe, expect, it } from "vitest";
import type { Account, GlEntry } from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";
import { buildMonthlyDetail, resolveMonths } from "./monthly-detail-view.js";
import type { LedgerTransaction } from "./ports.js";

/**
 * The month-by-month P&L with its drill-down.
 *
 * The point of the view is that a reader who does not believe a figure can open
 * it, so the assertions are about that correspondence: each account's months
 * add to its total, the transactions under it add to the month, and a section
 * adds to its accounts. If any of those three fails, the drill-down is a
 * decoration.
 */

const accounts: Account[] = [
  { id: "sales", name: "Sales", statementType: "profit_loss", accountType: "income" },
  { id: "materials", name: "Materials", statementType: "profit_loss", accountType: "cogs" },
  { id: "rent", name: "Rent", statementType: "profit_loss", accountType: "expense" },
  { id: "cash", name: "Cash", statementType: "balance_sheet", accountType: "asset" },
];

const engagement: EngagementData = {
  companyId: "co-1",
  companyName: "Acme",
  profitMetric: "adjusted_ebitda",
  marketRateReplacementSalary: null,
  fiscalYears: [2023, 2024],
  accounts,
  entries: [] as GlEntry[],
  anchors: [],
};

let nextId = 0;
const tx = (over: Partial<LedgerTransaction>): LedgerTransaction => ({
  id: String(++nextId),
  accountId: "sales",
  fiscalYear: 2024,
  month: 1,
  date: "2024-01-15",
  vendorName: null,
  description: null,
  reference: null,
  journalType: null,
  amount: 100,
  debit: null,
  credit: null,
  ...over,
});

const ledger: LedgerTransaction[] = [
  tx({ accountId: "sales", month: 1, amount: 600, date: "2024-01-10", vendorName: "Northwind" }),
  tx({ accountId: "sales", month: 1, amount: 400, date: "2024-01-20" }),
  tx({ accountId: "sales", month: 2, amount: 900, date: "2024-02-05" }),
  tx({ accountId: "materials", month: 1, amount: 250, date: "2024-01-12" }),
  tx({ accountId: "rent", month: 2, amount: 300, date: "2024-02-01" }),
  // Another year, and a balance-sheet account: neither belongs on this page.
  tx({ accountId: "sales", fiscalYear: 2023, month: 1, amount: 5000, date: "2023-01-01" }),
  tx({ accountId: "cash", month: 1, amount: 750, date: "2024-01-10" }),
];

const sectionOf = (payload: ReturnType<typeof buildMonthlyDetail>, key: string) =>
  payload.sections.find((s) => s.key === key)!;

describe("choosing the months", () => {
  it("shows all twelve when none is asked for", () => {
    expect(resolveMonths(undefined)).toHaveLength(12);
    expect(resolveMonths([])).toHaveLength(12);
  });

  it("shows only the months asked for, in order and without repeats", () => {
    expect(resolveMonths([6, 2, 6])).toEqual([2, 6]);
  });

  it("discards a month that is not a month", () => {
    expect(resolveMonths([0, 13, -1, 7])).toEqual([7]);
  });
});

describe("the monthly detail", () => {
  const payload = buildMonthlyDetail(engagement, ledger, { fiscalYear: 2024 });

  it("reports the requested year and no other", () => {
    expect(payload.year).toBe(2024);
    const income = sectionOf(payload, "income");
    // FY2023's 5,000 would double the income if the filter leaked.
    expect(income.total).toBe(1900);
  });

  it("keeps a balance-sheet account off the statement", () => {
    const names = payload.sections
      .flatMap((s) => s.accounts ?? [])
      .map((a) => a.accountName);
    expect(names).not.toContain("Cash");
  });

  it("adds each account's months to its own total", () => {
    for (const section of payload.sections) {
      for (const account of section.accounts ?? []) {
        const summed = Object.values(account.monthly).reduce((a, b) => a + b, 0);
        expect(summed).toBeCloseTo(account.total, 2);
      }
    }
  });

  it("adds the transactions under a line to the month they belong to", () => {
    // The drill-down's whole claim.
    const sales = sectionOf(payload, "income").accounts!.find((a) => a.accountName === "Sales")!;
    for (const month of payload.months) {
      const fromRows = sales.transactions
        .filter((t) => (t.date ?? "").slice(5, 7) === String(month).padStart(2, "0"))
        .reduce((total, t) => total + t.amount, 0);
      expect(sales.monthly[month]).toBeCloseTo(fromRows, 2);
    }
  });

  it("adds each section to the accounts inside it", () => {
    for (const section of payload.sections) {
      if (!section.accounts) continue;
      for (const month of payload.months) {
        const summed = section.accounts.reduce((total, a) => total + (a.monthly[month] ?? 0), 0);
        expect(section.monthlyTotals[month]).toBeCloseTo(summed, 2);
      }
    }
  });

  it("derives the calculated rows from the sections above them", () => {
    const income = sectionOf(payload, "income");
    const cogs = sectionOf(payload, "cogs");
    const expenses = sectionOf(payload, "expenses");
    const gross = sectionOf(payload, "gross_profit");
    const netOperating = sectionOf(payload, "net_operating_income");
    const netIncome = sectionOf(payload, "net_income");

    expect(gross.total).toBeCloseTo(income.total - cogs.total, 2);
    expect(netOperating.total).toBeCloseTo(gross.total - expenses.total, 2);
    // Nothing sits below the line, so these agree.
    expect(netIncome.total).toBeCloseTo(netOperating.total, 2);
    expect(netIncome.total).toBeCloseTo(1900 - 250 - 300, 2);
  });

  it("derives them month by month too, not just on the total", () => {
    const gross = sectionOf(payload, "gross_profit");
    const income = sectionOf(payload, "income");
    const cogs = sectionOf(payload, "cogs");
    for (const month of payload.months) {
      expect(gross.monthlyTotals[month]).toBeCloseTo(
        income.monthlyTotals[month]! - cogs.monthlyTotals[month]!,
        2,
      );
    }
  });

  it("orders the drill-down oldest first", () => {
    const sales = sectionOf(payload, "income").accounts!.find((a) => a.accountName === "Sales")!;
    const dates = sales.transactions.map((t) => t.date);
    expect(dates).toEqual([...dates].sort());
  });

  it("carries what the ledger has and nulls what it does not", () => {
    // The extractor populates a date and sometimes a vendor, and nothing else.
    // A zero debit would state a fact the ledger does not contain.
    const sales = sectionOf(payload, "income").accounts!.find((a) => a.accountName === "Sales")!;
    const first = sales.transactions[0]!;
    expect(first.vendorName).toBe("Northwind");
    expect(first.description).toBeNull();
    expect(first.debit).toBeNull();
    expect(first.credit).toBeNull();
  });

  it("names every month it shows, so an empty column is still a column", () => {
    expect(payload.months).toHaveLength(12);
    expect(payload.monthNames).toHaveLength(12);
    const income = sectionOf(payload, "income");
    expect(income.monthlyTotals[12]).toBe(0);
  });

  it("omits the below-the-line section rather than showing it empty", () => {
    expect(payload.sections.map((s) => s.key)).not.toContain("other_income_expense");
  });
});

describe("filtering to some months", () => {
  const payload = buildMonthlyDetail(engagement, ledger, { fiscalYear: 2024, months: [1] });

  it("shows one column and counts only what falls in it", () => {
    expect(payload.months).toEqual([1]);
    expect(sectionOf(payload, "income").total).toBe(1000);
    expect(sectionOf(payload, "expenses").total).toBe(0);
  });

  it("drops the transactions outside the window from the drill-down too", () => {
    // Otherwise the rows under a line add to more than the line.
    const sales = sectionOf(payload, "income").accounts!.find((a) => a.accountName === "Sales")!;
    expect(sales.transactions).toHaveLength(2);
    expect(sales.transactions.reduce((t, x) => t + x.amount, 0)).toBeCloseTo(sales.total, 2);
  });
});

describe("choosing the year", () => {
  it("defaults to the latest year the engagement has", () => {
    expect(buildMonthlyDetail(engagement, ledger).year).toBe(2024);
  });

  it("falls back to the latest rather than reporting a year with no data", () => {
    const payload = buildMonthlyDetail(engagement, ledger, { fiscalYear: 2099 });
    expect(payload.year).toBe(2024);
  });

  it("answers a statement of zeroes for an engagement with no years at all", () => {
    const empty = buildMonthlyDetail({ ...engagement, fiscalYears: [] }, ledger);
    expect(empty.year).toBeNull();
    expect(sectionOf(empty, "income").total).toBe(0);
    expect(sectionOf(empty, "income").accounts).toEqual([]);
  });
});

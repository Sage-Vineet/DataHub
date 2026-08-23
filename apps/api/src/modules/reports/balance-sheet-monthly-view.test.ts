import { describe, expect, it } from "vitest";
import type { Account, BalanceSheetAnchor, GlEntry } from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";
import { buildBalanceSheetMonthlyDetail } from "./balance-sheet-monthly-view.js";
import { NoBalanceSheetError } from "./balance-sheet-view.js";
import type { LedgerTransaction } from "./ports.js";

/**
 * The month-by-month Balance Sheet.
 *
 * The failure this view invites is treating a balance like a movement: adding
 * the twelve columns, or letting a section's total be a sum rather than the
 * closing position. Both are pinned below, along with the identity a balance
 * sheet has to satisfy in EVERY month rather than only at the year end.
 */

const accounts: Account[] = [
  { id: "cash", name: "Operating Cash", statementType: "balance_sheet", accountType: "asset", group: "Bank Accounts" },
  { id: "loan", name: "Bank Loan", statementType: "balance_sheet", accountType: "liability", group: "Long-term Liabilities" },
  { id: "capital", name: "Owner Capital", statementType: "balance_sheet", accountType: "equity", group: "Equity" },
  { id: "sales", name: "Sales", statementType: "profit_loss", accountType: "income" },
  { id: "rent", name: "Rent", statementType: "profit_loss", accountType: "expense" },
];

const entries: GlEntry[] = [
  { accountId: "sales", fiscalYear: 2024, month: 1, amount: 1000 },
  { accountId: "cash", fiscalYear: 2024, month: 1, amount: 1000 },
  { accountId: "rent", fiscalYear: 2024, month: 2, amount: 400 },
  { accountId: "cash", fiscalYear: 2024, month: 2, amount: -400 },
  { accountId: "loan", fiscalYear: 2024, month: 3, amount: -300 },
  { accountId: "cash", fiscalYear: 2024, month: 3, amount: -300 },
];

const opening: BalanceSheetAnchor = {
  kind: "starting",
  fiscalYear: 2023,
  month: 12,
  rows: [
    { accountId: "cash", accountName: "Operating Cash", section: "asset", group: "Bank Accounts", amount: 2000 },
    { accountId: "loan", accountName: "Bank Loan", section: "liability", group: "Long-term Liabilities", amount: 1500 },
    { accountId: "capital", accountName: "Owner Capital", section: "equity", group: "Equity", amount: 500 },
  ],
};

const engagement: EngagementData = {
  companyId: "co-1",
  companyName: "Acme",
  profitMetric: "adjusted_ebitda",
  marketRateReplacementSalary: null,
  fiscalYears: [2024],
  accounts,
  entries,
  anchors: [opening],
};

const ledger: LedgerTransaction[] = [
  {
    id: "t1",
    accountId: "cash",
    fiscalYear: 2024,
    month: 1,
    date: "2024-01-15",
    vendorName: "Northwind",
    description: null,
    reference: null,
    journalType: null,
    amount: 1000,
    debit: null,
    credit: null,
  },
  {
    id: "t2",
    accountId: "cash",
    fiscalYear: 2024,
    month: 2,
    date: "2024-02-10",
    vendorName: null,
    description: null,
    reference: null,
    journalType: null,
    amount: -400,
    debit: null,
    credit: null,
  },
];

const cashAccount = (payload: ReturnType<typeof buildBalanceSheetMonthlyDetail>) =>
  payload.sections.Assets.categories
    .find((c) => c.label === "Bank Accounts")!
    .accounts.find((a) => a.name === "Operating Cash")!;

describe("without a stated position", () => {
  it("refuses rather than rolling from zero", () => {
    expect(() =>
      buildBalanceSheetMonthlyDetail({ ...engagement, anchors: [] }, ledger),
    ).toThrow(NoBalanceSheetError);
  });
});

describe("the monthly balance sheet", () => {
  const payload = buildBalanceSheetMonthlyDetail(engagement, ledger, { fiscalYear: 2024 });

  it("balances in every month, not only at the year end", () => {
    for (const month of payload.months) {
      const assets = payload.sections.Assets.monthlyTotals[month]!;
      const liabilities = payload.sections.Liabilities.monthlyTotals[month]!;
      const equity = payload.sections.Equity.monthlyTotals[month]!;
      expect(assets).toBeCloseTo(liabilities + equity, 2);
    }
  });

  it("carries a running position, not a monthly movement", () => {
    // Cash opens at 2,000; +1,000 in Jan, −400 in Feb, −300 in Mar, then flat.
    const cash = cashAccount(payload);
    expect(cash.monthly[1]).toBeCloseTo(3000, 2);
    expect(cash.monthly[2]).toBeCloseTo(2600, 2);
    expect(cash.monthly[3]).toBeCloseTo(2300, 2);
    expect(cash.monthly[12]).toBeCloseTo(2300, 2);
  });

  it("holds the position through a month with no activity", () => {
    // The ledger stops in March. April through December are quiet months, and
    // a balance sheet still has a position in a quiet month — the one it
    // closed March with. Showing zero would claim the bank account emptied.
    const cash = cashAccount(payload);
    for (const month of [4, 7, 12]) {
      expect(cash.monthly[month]).toBeCloseTo(2300, 2);
    }
  });

  it("balances in the quiet months too, which is the real check on carrying", () => {
    // Carrying the assets forward but not the equity would balance in March
    // and fail in April.
    for (const month of [4, 7, 12]) {
      expect(payload.sections.Assets.monthlyTotals[month]).toBeCloseTo(
        payload.sections.Liabilities.monthlyTotals[month]! +
          payload.sections.Equity.monthlyTotals[month]!,
        2,
      );
    }
  });

  it("totals to the closing month, never to the sum of the months", () => {
    // Adding the twelve columns would report 27,900-odd for an account that
    // holds 2,300.
    const cash = cashAccount(payload);
    const summed = Object.values(cash.monthly).reduce((a, b) => a + b, 0);
    expect(cash.total).toBeCloseTo(2300, 2);
    // Twelve carried columns add to well over 27,000 for an account holding 2,300.
    expect(summed).toBeGreaterThan(25000);
    expect(cash.total).not.toBeCloseTo(summed, 2);
    expect(payload.sections.Assets.total).toBeCloseTo(
      payload.sections.Assets.monthlyTotals[12]!,
      2,
    );
  });

  it("carries the derived equity rows, without which no month balances", () => {
    const labels = payload.sections.Equity.categories.map((c) => c.label);
    expect(labels).toEqual(["Owner Equity", "Retained Earnings", "Net Income"]);
    const netIncome = payload.sections.Equity.categories.find((c) => c.label === "Net Income")!;
    // FY2024 income to March: 1,000 − 400 = 600.
    expect(netIncome.monthlyTotals[3]).toBeCloseTo(600, 2);
  });

  it("attaches the movements that made the position", () => {
    const cash = cashAccount(payload);
    expect(cash.transactions.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(cash.transactions[0]!.vendorName).toBe("Northwind");
  });

  it("gives a derived row no drill-down, because no posting made it", () => {
    const retained = payload.sections.Equity.categories.find(
      (c) => c.label === "Retained Earnings",
    )!;
    expect(retained.accounts[0]!.transactions).toEqual([]);
  });

  it("keeps a P&L account off the balance sheet", () => {
    const names = Object.values(payload.sections)
      .flatMap((s) => s.categories)
      .flatMap((c) => c.accounts)
      .map((a) => a.name);
    expect(names).not.toContain("Sales");
    expect(names).not.toContain("Rent");
  });
});

describe("narrowing to some months", () => {
  const payload = buildBalanceSheetMonthlyDetail(engagement, ledger, {
    fiscalYear: 2024,
    months: [1, 2],
  });

  it("shows only those columns and totals to the last of them", () => {
    expect(payload.months).toEqual([1, 2]);
    expect(cashAccount(payload).total).toBeCloseTo(2600, 2);
  });

  it("still balances across the narrowed window", () => {
    for (const month of payload.months) {
      expect(payload.sections.Assets.monthlyTotals[month]).toBeCloseTo(
        payload.sections.Liabilities.monthlyTotals[month]! +
          payload.sections.Equity.monthlyTotals[month]!,
        2,
      );
    }
  });

  it("drops the drill-down rows outside the window", () => {
    const narrow = buildBalanceSheetMonthlyDetail(engagement, ledger, {
      fiscalYear: 2024,
      months: [1],
    });
    expect(cashAccount(narrow).transactions.map((t) => t.id)).toEqual(["t1"]);
  });
});

describe("choosing the year", () => {
  it("defaults to the latest the engagement has", () => {
    expect(buildBalanceSheetMonthlyDetail(engagement, ledger).year).toBe(2024);
  });

  it("falls back rather than reporting a year with no position", () => {
    expect(buildBalanceSheetMonthlyDetail(engagement, ledger, { fiscalYear: 2099 }).year).toBe(
      2024,
    );
  });

  it("answers an empty sheet for an engagement with no years", () => {
    const payload = buildBalanceSheetMonthlyDetail(
      { ...engagement, fiscalYears: [] },
      ledger,
    );
    expect(payload.year).toBeNull();
    expect(payload.sections.Assets.categories).toEqual([]);
    expect(payload.sections.Assets.total).toBe(0);
  });
});

describe("months the ledger never reached", () => {
  it("carries the last known position forward rather than showing zero", () => {
    // The roll only produces months with activity. Showing zero in a quiet
    // month claims the company's bank account emptied and refilled.
    const payload = buildBalanceSheetMonthlyDetail(engagement, ledger);
    const cash = cashAccount(payload);
    expect(cash.monthly[3]).toBe(cash.monthly[12]);
    expect(cash.monthly[12]).not.toBe(0);
  });

  it("shows the opening position for months before the first rolled one", () => {
    // A January before any activity holds what the engagement opened with, not
    // nothing.
    const later: EngagementData = {
      ...engagement,
      entries: entries.map((e) => ({ ...e, month: 6 })),
    };
    const cash = cashAccount(buildBalanceSheetMonthlyDetail(later, ledger));
    expect(cash.monthly[1]).toBe(2000);
    expect(cash.monthly[5]).toBe(2000);
  });

  it("shows no current-year income before the year's first rolled month", () => {
    // Income resets at each fiscal year start, so carrying it backwards would
    // show last year's result in this year's January.
    const later: EngagementData = {
      ...engagement,
      entries: entries.map((e) => ({ ...e, month: 6 })),
    };
    const netIncome = buildBalanceSheetMonthlyDetail(later, ledger)
      .sections.Equity.categories.find((c) => c.label === "Net Income")!
      .accounts[0]!;
    expect(netIncome.monthly[1]).toBe(0);
    expect(netIncome.monthly[6]).not.toBe(0);
  });
});

describe("rows the ledger cannot drill into", () => {
  it("gives the derived equity rows an empty drill-down rather than a wrong one", () => {
    // Retained earnings and net income are derived by the roll rather than
    // posted, so there are no transactions behind them. Borrowing another
    // account's would be worse than none.
    const equity = buildBalanceSheetMonthlyDetail(engagement, ledger).sections.Equity;
    const retained = equity.categories.find((c) => c.label === "Retained Earnings")!;
    expect(retained.accounts[0]!.transactions).toEqual([]);
  });

  it("orders a drill-down by date, and puts an undated row first", () => {
    const undated: LedgerTransaction[] = [
      { ...ledger[1]!, id: "t3", date: null },
      ...ledger,
    ];
    const cash = cashAccount(buildBalanceSheetMonthlyDetail(engagement, undated));
    expect(cash.transactions.map((t) => t.id)).toEqual(["t3", "t1", "t2"]);
  });
});

describe("an account the chart barely describes", () => {
  it("files an account the chart never classified under other current assets", () => {
    // No account type and no stated heading, so nothing can derive a group.
    // Dropped for want of one it would be a line missing from a sheet that
    // still balances — the amount reaches the total and the row does not
    // appear.
    const unclassified: EngagementData = {
      ...engagement,
      accounts: [
        ...accounts,
        {
          id: "mystery",
          name: "Suspense",
          statementType: "balance_sheet",
        } as (typeof accounts)[number],
      ],
      entries: [...entries, { accountId: "mystery", fiscalYear: 2024, month: 1, amount: 50 }],
    };
    const assets = buildBalanceSheetMonthlyDetail(unclassified, ledger).sections.Assets;
    const named = assets.categories.flatMap((c) => c.accounts.map((a) => `${c.label}/${a.name}`));
    expect(named).toContain("Other Current Assets/Suspense");
  });

  it("puts a category the order does not name last rather than dropping it", () => {
    const odd: EngagementData = {
      ...engagement,
      accounts: accounts.map((a) => (a.id === "cash" ? { ...a, group: "Crypto Wallets" } : a)),
      anchors: [
        {
          ...opening,
          rows: opening.rows.map((r) =>
            r.accountId === "cash" ? { ...r, group: "Crypto Wallets" } : r,
          ),
        },
      ],
    };
    const labels = buildBalanceSheetMonthlyDetail(odd, ledger).sections.Assets.categories.map(
      (c) => c.label,
    );
    expect(labels).toContain("Crypto Wallets");
    expect(labels[labels.length - 1]).toBe("Crypto Wallets");
  });
});

import { describe, expect, it } from "vitest";
import {
  bucketsMatching,
  buildStatementCashFlow,
  classifyStatementLine,
  leavesOf,
  type StatementNode,
} from "./statement-cash-flow.js";

/**
 * Cash flow from two uploaded balance sheets and a P&L.
 *
 * All this knows about an account is what the line is called, so the tests are
 * mostly about classification: a line put in the wrong bucket moves cash in
 * the wrong direction, and the statement can still reconcile while being
 * wrong about which activity produced the money.
 */

const node = (name: string, amount: number): StatementNode => ({ name, amount, type: "data" });

const section = (name: string, children: StatementNode[]): StatementNode => ({
  name,
  amount: children.reduce((t, c) => t + (c.amount ?? 0), 0),
  type: "section",
  children,
});

describe("what a balance-sheet line is taken to be", () => {
  it("recognises the names statements actually use", () => {
    expect(classifyStatementLine("Cash and Cash Equivalents")).toBe("cash");
    expect(classifyStatementLine("Accounts Receivable (A/R)")).toBe("accounts_receivable");
    expect(classifyStatementLine("Merchandise Inventory")).toBe("inventory");
    expect(classifyStatementLine("Accounts Payable")).toBe("accounts_payable");
    expect(classifyStatementLine("Accrued Payroll")).toBe("accrued_expenses");
    expect(classifyStatementLine("Prepaid Insurance")).toBe("other_current_assets");
    expect(classifyStatementLine("Deferred Revenue")).toBe("other_current_liabilities");
    expect(classifyStatementLine("Property and Equipment")).toBe("fixed_assets");
    expect(classifyStatementLine("Security Deposits")).toBe("deposits");
    expect(classifyStatementLine("Marketable Securities")).toBe("investments");
    expect(classifyStatementLine("Notes Payable")).toBe("debt");
    expect(classifyStatementLine("Additional Paid-in Capital")).toBe("paid_in_capital");
  });

  it("puts a customer deposit in working capital, not in investing", () => {
    // The defect this classification exists to prevent. "Customer Deposits"
    // matches both an other-current-liabilities pattern and the loose
    // `\bdeposits?\b` one. Legacy tested every bucket independently and summed
    // the matches, so the same money moved operating cash AND investing cash,
    // in opposite directions, and the two partially cancelled — leaving a
    // statement that reconciled while attributing the money to the wrong
    // activity.
    expect(bucketsMatching("Customer Deposits")).toContain("deposits");
    expect(bucketsMatching("Customer Deposits")).toContain("other_current_liabilities");
    expect(classifyStatementLine("Customer Deposits")).toBe("other_current_liabilities");
  });

  it("assigns exactly one bucket, whatever else matches", () => {
    for (const name of ["Customer Deposits", "Total Cash", "Long-term Investments", "Bank Loan"]) {
      const assigned = classifyStatementLine(name);
      expect(assigned).not.toBeNull();
      expect(bucketsMatching(name)).toContain(assigned!);
    }
  });

  it("prefers an exact name to another bucket's catch-all", () => {
    // "Investments" is exactly what it says; a loose deposits or cash pattern
    // must not claim it first.
    expect(classifyStatementLine("Investments")).toBe("investments");
    expect(classifyStatementLine("Bank Accounts")).toBe("cash");
  });

  it("says nothing rather than guessing", () => {
    expect(classifyStatementLine("Goodwill")).toBeNull();
    expect(classifyStatementLine("")).toBeNull();
    expect(classifyStatementLine("   ")).toBeNull();
    expect(bucketsMatching("")).toEqual([]);
  });
});

describe("reading a statement tree", () => {
  it("takes the leaves and never their parents", () => {
    // A parent's amount is the sum of its children; counting both doubles
    // every figure underneath it.
    const tree = [section("Current Assets", [node("Cash", 100), node("Inventory", 50)])];
    expect(leavesOf(tree).map((l) => l.name)).toEqual(["Cash", "Inventory"]);
  });

  it("treats a node with an empty children array as a leaf", () => {
    // Extraction emits `children: []` for a line it found no detail under,
    // and dropping those would silently lose real accounts.
    expect(leavesOf([{ name: "Cash", amount: 10, children: [] }])).toHaveLength(1);
  });

  it("handles nothing at all", () => {
    expect(leavesOf(null)).toEqual([]);
    expect(leavesOf(undefined)).toEqual([]);
    expect(leavesOf([])).toEqual([]);
  });
});

/**
 * A small company, two years.
 *
 * Cash 100 → 180. Everything below is arranged so the indirect statement lands
 * exactly on that 180, which is the only real test of a cash flow.
 */
const PRIOR: StatementNode[] = [
  section("Assets", [
    node("Cash", 100),
    node("Accounts Receivable", 200),
    node("Inventory", 50),
    node("Property and Equipment", 400),
  ]),
  section("Liabilities", [node("Accounts Payable", 120), node("Notes Payable", 300)]),
  section("Equity", [node("Common Stock", 10)]),
];

const CURRENT: StatementNode[] = [
  section("Assets", [
    node("Cash", 180),
    node("Accounts Receivable", 230),
    node("Inventory", 40),
    node("Property and Equipment", 380),
  ]),
  section("Liabilities", [node("Accounts Payable", 150), node("Notes Payable", 260)]),
  section("Equity", [node("Common Stock", 10)]),
];

const INCOME: StatementNode[] = [
  section("Income", [node("Sales", 1000)]),
  section("Expenses", [node("Depreciation", 60)]),
  node("Net Income", 90),
];

describe("the indirect statement", () => {
  const cf = buildStatementCashFlow({
    priorBalanceSheet: PRIOR,
    currentBalanceSheet: CURRENT,
    incomeStatement: INCOME,
    fiscalYear: 2024,
  });

  it("reconciles to the balance sheet's own cash line", () => {
    // The whole point. Everything else can be individually plausible and the
    // statement still be wrong; this is the check that says it is not.
    expect(cf.endingCash).toBe(180);
    expect(cf.reconciliation.balanceSheetCash).toBe(180);
    expect(cf.cashValidated).toBe(true);
    expect(cf.reconciliation.status).toBe("reconciled");
  });

  it("consumes cash when an asset grows and provides it when a liability does", () => {
    // Backwards, and the working-capital section is exactly twice wrong.
    const byLabel = new Map(cf.operatingActivities.map((a) => [a.label, a.value]));
    // Receivables 200 → 230: thirty pounds of sales not yet collected.
    expect(byLabel.get("Change in Accounts Receivable")).toBe(-30);
    // Inventory 50 → 40: ten pounds of stock turned into cash.
    expect(byLabel.get("Change in Inventory")).toBe(10);
    // Payables 120 → 150: thirty pounds of bills not yet paid.
    expect(byLabel.get("Change in Accounts Payable")).toBe(30);
  });

  it("adds depreciation back, because no cash left the business for it", () => {
    const byLabel = new Map(cf.operatingActivities.map((a) => [a.label, a.value]));
    expect(byLabel.get("Depreciation")).toBe(60);
    expect(cf.totalOperating).toBe(160);
  });

  it("infers capex from the movement plus the depreciation", () => {
    // Net PP&E falls by depreciation every year even when nothing was bought.
    // 400 → 380 with 60 of depreciation means 40 was actually spent; the raw
    // movement alone would report a 20 DISPOSAL, which is the opposite.
    const byLabel = new Map(cf.investingActivities.map((a) => [a.label, a.value]));
    expect(byLabel.get("Purchase of Fixed Assets")).toBe(-40);
    expect(byLabel.get("Sale of Fixed Assets")).toBe(0);
  });

  it("reports a repayment on the loan's own line", () => {
    // Notes payable 300 → 260.
    expect(cf.financingActivities).toContainEqual({ label: "Loans - Notes Payable", value: -40 });
    expect(cf.totalFinancing).toBe(-40);
  });

  it("classifies every line it was given", () => {
    expect(cf.reconciliation.unclassifiedLines).toEqual([]);
    expect(cf.reconciliation.ambiguousLines).toEqual([]);
  });

  it("says how it reached each figure", () => {
    // A cash flow that will not reconcile is the commonest thing to go wrong,
    // and the answer is a line somebody has to be able to see.
    const ar = cf.reconciliation.trace.find((t) => t.line === "Accounts Receivable");
    expect(ar).toMatchObject({ current: 230, prior: 200, delta: -30, section: "operating" });
  });
});

describe("when the statement will not reconcile", () => {
  it("names the lines nothing recognised", () => {
    // The first thing to look at: an unclassified line is a movement the cash
    // flow simply did not account for.
    const withGoodwill = [
      section("Assets", [node("Cash", 180), node("Goodwill", 500)]),
    ];
    const cf = buildStatementCashFlow({
      priorBalanceSheet: [section("Assets", [node("Cash", 100)])],
      currentBalanceSheet: withGoodwill,
      incomeStatement: [node("Net Income", 0)],
      fiscalYear: 2024,
    });
    expect(cf.cashValidated).toBe(false);
    expect(cf.reconciliation.status).toBe("mismatch");
    expect(cf.reconciliation.unclassifiedLines).toEqual([{ name: "Goodwill", amount: 500 }]);
    expect(cf.reconciliation.difference).toBe(-80);
  });

  it("reports a line more than one pattern claims", () => {
    // Not double counted — first match wins — but a pattern set that overlaps
    // is one about to classify something wrongly.
    const cf = buildStatementCashFlow({
      priorBalanceSheet: [section("L", [node("Customer Deposits", 10)])],
      currentBalanceSheet: [section("L", [node("Customer Deposits", 20)])],
      incomeStatement: [node("Net Income", 0)],
      fiscalYear: 2024,
    });
    expect(cf.reconciliation.ambiguousLines).toEqual([
      {
        name: "Customer Deposits",
        buckets: expect.arrayContaining(["other_current_liabilities", "deposits"]),
        assigned: "other_current_liabilities",
      },
    ]);
  });

  it("counts a customer deposit once, in one section", () => {
    // 10 → 20 is ten pounds of cash received in advance: operating +10, and
    // investing untouched.
    const cf = buildStatementCashFlow({
      priorBalanceSheet: [section("L", [node("Cash", 0), node("Customer Deposits", 10)])],
      currentBalanceSheet: [section("L", [node("Cash", 10), node("Customer Deposits", 20)])],
      incomeStatement: [node("Net Income", 0)],
      fiscalYear: 2024,
    });
    const operating = new Map(cf.operatingActivities.map((a) => [a.label, a.value]));
    expect(operating.get("Change in Other Current Liabilities")).toBe(10);
    expect(cf.totalInvesting).toBe(0);
    expect(cf.cashValidated).toBe(true);
  });

  it("reconciles a company that genuinely holds no cash", () => {
    // Legacy gated validation on the balance sheet's cash being non-zero, so
    // a company with nothing in the bank could never reconcile however correct
    // the statement was — it reported a permanent NO_CASH_BALANCE.
    const cf = buildStatementCashFlow({
      priorBalanceSheet: [section("A", [node("Cash", 0)])],
      currentBalanceSheet: [section("A", [node("Cash", 0)])],
      incomeStatement: [node("Net Income", 0)],
      fiscalYear: 2024,
    });
    expect(cf.reconciliation.balanceSheetCash).toBe(0);
    expect(cf.cashValidated).toBe(true);
  });

  it("allows a tolerance, because statements round to the dollar", () => {
    const near = buildStatementCashFlow({
      priorBalanceSheet: [section("A", [node("Cash", 100)])],
      currentBalanceSheet: [section("A", [node("Cash", 100.5)])],
      incomeStatement: [node("Net Income", 0)],
      fiscalYear: 2024,
    });
    expect(near.cashValidated).toBe(true);

    const strict = buildStatementCashFlow({
      priorBalanceSheet: [section("A", [node("Cash", 100)])],
      currentBalanceSheet: [section("A", [node("Cash", 100.5)])],
      incomeStatement: [node("Net Income", 0)],
      fiscalYear: 2024,
      tolerance: 0.01,
    });
    expect(strict.cashValidated).toBe(false);
  });
});

describe("the first year on file", () => {
  const cf = buildStatementCashFlow({
    currentBalanceSheet: CURRENT,
    incomeStatement: INCOME,
    fiscalYear: 2024,
  });

  it("produces a statement rather than refusing", () => {
    // There are no movements to measure without a prior balance sheet, but the
    // P&L is still worth showing, and a blank page explains nothing.
    expect(cf.totalOperating).toBe(150);
    expect(cf.beginningCash).toBe(0);
  });

  it("reports no movement anywhere, rather than mistaking a balance for one", () => {
    // A closing balance is not a change. Treating 230 of receivables as a
    // 230 movement would consume a year's cash that never moved.
    for (const label of ["Change in Accounts Receivable", "Change in Accounts Payable"]) {
      expect(cf.operatingActivities.find((a) => a.label === label)!.value).toBe(0);
    }
    expect(cf.totalInvesting).toBe(0);
    expect(cf.financingActivities).toEqual([
      { label: "Equity Contribution", value: 0 },
      { label: "Distributions", value: 0 },
    ]);
  });

  it("measures against a beginning of zero, and says so in the difference", () => {
    // There is no prior balance sheet to take an opening cash position from,
    // so the whole closing balance shows up as unexplained. That is the
    // honest report: it is not that the statement is wrong, it is that a
    // single year cannot be reconciled against a year nobody uploaded.
    expect(cf.beginningCash).toBe(0);
    expect(cf.reconciliation.computedEndingCash).toBe(150);
    expect(cf.reconciliation.balanceSheetCash).toBe(180);
    expect(cf.reconciliation.difference).toBe(-30);
  });
});

describe("the awkward income-statement lines", () => {
  it("does not count amortization twice when one line carries both", () => {
    const cf = buildStatementCashFlow({
      currentBalanceSheet: [node("Cash", 0)],
      incomeStatement: [node("Depreciation and Amortization", 90)],
      fiscalYear: 2024,
    });
    const byLabel = new Map(cf.operatingActivities.map((a) => [a.label, a.value]));
    expect(byLabel.get("Depreciation")).toBe(90);
    expect(byLabel.get("Amortization")).toBe(0);
    expect(cf.totalOperating).toBe(90);
  });

  it("counts amortization when it stands on its own line", () => {
    const cf = buildStatementCashFlow({
      currentBalanceSheet: [node("Cash", 0)],
      incomeStatement: [node("Depreciation", 60), node("Amortization of Goodwill", 30)],
      fiscalYear: 2024,
    });
    expect(cf.totalOperating).toBe(90);
  });

  it("takes owner draws from the P&L, never from retained earnings", () => {
    // Retained earnings moves by profit AND by draws together, so reading
    // draws off it double counts the year's profit.
    const cf = buildStatementCashFlow({
      priorBalanceSheet: [section("A", [node("Cash", 100)])],
      currentBalanceSheet: [section("A", [node("Cash", 40)])],
      incomeStatement: [node("Net Income", 0), node("Owner's Draws", 60)],
      fiscalYear: 2024,
    });
    expect(cf.financingActivities).toContainEqual({ label: "Distributions", value: -60 });
    expect(cf.cashValidated).toBe(true);
  });

  it("records an equity contribution as cash in", () => {
    const cf = buildStatementCashFlow({
      priorBalanceSheet: [section("E", [node("Cash", 0), node("Common Stock", 10)])],
      currentBalanceSheet: [section("E", [node("Cash", 90), node("Common Stock", 100)])],
      incomeStatement: [node("Net Income", 0)],
      fiscalYear: 2024,
    });
    expect(cf.financingActivities).toContainEqual({ label: "Equity Contribution", value: 90 });
    expect(cf.cashValidated).toBe(true);
  });

  it("keeps two loans apart rather than netting them to nothing", () => {
    // £200k drawn and £200k repaid is £400k of movement. Netting hides both,
    // and which loans grew is the question a buyer actually asks.
    const cf = buildStatementCashFlow({
      priorBalanceSheet: [
        section("L", [node("Cash", 0), node("Line of Credit", 0), node("Term Loan", 200)]),
      ],
      currentBalanceSheet: [
        section("L", [node("Cash", 0), node("Line of Credit", 200), node("Term Loan", 0)]),
      ],
      incomeStatement: [node("Net Income", 0)],
      fiscalYear: 2024,
    });
    expect(cf.financingActivities).toContainEqual({ label: "Loans - Line of Credit", value: 200 });
    expect(cf.financingActivities).toContainEqual({ label: "Loans - Term Loan", value: -200 });
    expect(cf.totalFinancing).toBe(0);
  });

  it("leaves an unchanged loan off the statement entirely", () => {
    // A line reading zero is noise on a statement whose purpose is to show
    // what moved.
    const cf = buildStatementCashFlow({
      priorBalanceSheet: [section("L", [node("Cash", 0), node("Term Loan", 200)])],
      currentBalanceSheet: [section("L", [node("Cash", 0), node("Term Loan", 200)])],
      incomeStatement: [node("Net Income", 0)],
      fiscalYear: 2024,
    });
    expect(cf.financingActivities.map((a) => a.label)).toEqual([
      "Equity Contribution",
      "Distributions",
    ]);
  });

  it("reports a disposal when net fixed assets fell by more than depreciation", () => {
    const cf = buildStatementCashFlow({
      priorBalanceSheet: [section("A", [node("Cash", 0), node("Fixed Assets", 400)])],
      currentBalanceSheet: [section("A", [node("Cash", 90), node("Fixed Assets", 300)])],
      incomeStatement: [node("Net Income", 0), node("Depreciation", 10)],
      fiscalYear: 2024,
    });
    const byLabel = new Map(cf.investingActivities.map((a) => [a.label, a.value]));
    expect(byLabel.get("Sale of Fixed Assets")).toBe(90);
    expect(byLabel.get("Purchase of Fixed Assets")).toBe(0);
  });

  it("uses the raw movement when there is no depreciation to add back", () => {
    const cf = buildStatementCashFlow({
      priorBalanceSheet: [section("A", [node("Cash", 100), node("Fixed Assets", 0)])],
      currentBalanceSheet: [section("A", [node("Cash", 60), node("Fixed Assets", 40)])],
      incomeStatement: [node("Net Income", 0)],
      fiscalYear: 2024,
    });
    expect(cf.investingActivities.find((a) => a.label === "Purchase of Fixed Assets")!.value).toBe(
      -40,
    );
    expect(cf.cashValidated).toBe(true);
  });

  it("reports nothing for fixed assets that did not move", () => {
    const cf = buildStatementCashFlow({
      priorBalanceSheet: [section("A", [node("Cash", 0), node("Fixed Assets", 400)])],
      currentBalanceSheet: [section("A", [node("Cash", 0), node("Fixed Assets", 400)])],
      incomeStatement: [node("Net Income", 0)],
      fiscalYear: 2024,
    });
    expect(cf.totalInvesting).toBe(0);
    expect(cf.reconciliation.trace.some((t) => t.section === "investing" && t.delta !== 0)).toBe(
      false,
    );
  });
});

describe("figures it was handed badly", () => {
  it("treats a missing or unreadable amount as zero", () => {
    const cf = buildStatementCashFlow({
      currentBalanceSheet: [
        { name: "Cash", amount: null },
        { name: "Inventory" },
        { name: "Accounts Receivable", amount: Number.NaN },
      ],
      incomeStatement: [node("Net Income", 100)],
      fiscalYear: 2024,
    });
    expect(cf.totalOperating).toBe(100);
    expect(cf.reconciliation.balanceSheetCash).toBe(0);
  });

  it("rounds to the cent rather than carrying float noise into a total", () => {
    const cf = buildStatementCashFlow({
      currentBalanceSheet: [node("Cash", 0)],
      incomeStatement: [node("Net Income", 0.1), node("Depreciation", 0.2)],
      fiscalYear: 2024,
    });
    expect(cf.totalOperating).toBe(0.3);
  });

  it("carries the fiscal year it was told", () => {
    const cf = buildStatementCashFlow({
      currentBalanceSheet: [node("Cash", 0)],
      incomeStatement: [],
      fiscalYear: 2019,
    });
    expect(cf.fiscalYear).toBe(2019);
    expect(cf.method).toBe("indirect");
  });
});

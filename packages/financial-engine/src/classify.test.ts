import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/engagement.json" with { type: "json" };
import { classifyAccount, classifyAccounts } from "./classify.js";
import type { Account } from "./types.js";

const accounts = fixture.accounts as Account[];

const account = (name: string, accountType: "income" | "expense" = "expense"): Account => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  name,
  statementType: "profit_loss",
  accountType,
});

const roleOf = (name: string, type: "income" | "expense" = "expense") =>
  classifyAccount(account(name, type)).role;

describe("operating taxes are never income tax", () => {
  /**
   * The regression this module exists for. On the real engagement these four
   * accounts total $83,981.56 in FY2024 against a net income of $47,568.23 —
   * the previous bridge added all of them back as income tax.
   */
  const operatingTaxes = [
    "Meals Tax",
    "Real estate taxes",
    "Taxes & Licenses",
    "Payroll taxes",
    "Sales Tax",
    "Use Tax",
    "Property Tax",
    "Personal Property Tax",
    "Excise Tax",
    "Franchise Tax",
    "Occupancy Tax",
    "Lodging Tax",
    "Fuel Tax",
    "Unemployment Taxes",
    "Employer Payroll Taxes",
    "Gross Receipts Tax",
    "Tax Preparation Fees",
    "Liquor Tax",
  ];

  for (const name of operatingTaxes) {
    it(`"${name}" is not classified`, () => {
      const result = classifyAccount(account(name));
      expect(result.role).toBeNull();
      expect(result.rule).toBe("exclude.operating-tax");
      expect(result.reason).toMatch(/operating tax/);
    });
  }

  it("a genuine income tax still classifies", () => {
    for (const name of [
      "Income Tax Expense",
      "Federal Income Taxes",
      "State Income Tax",
      "Provision for Income Taxes",
      "Deferred Income Tax",
    ]) {
      const result = classifyAccount(account(name));
      expect(result.role, name).toBe("income_tax");
      expect(result.confidence, name).toBe("high");
    }
  });

  it("does not match a bare 'tax' anywhere", () => {
    // The exact failure mode of the previous implementation.
    expect(roleOf("Tax")).toBeNull();
    expect(roleOf("Taxes")).toBeNull();
    expect(roleOf("Restaurant Tax")).toBeNull();
  });
});

describe("interest is split by side of the P&L", () => {
  it("classifies interest income and interest expense apart", () => {
    expect(roleOf("Interest Income", "income")).toBe("interest_income");
    expect(roleOf("Interest Paid")).toBe("interest_expense");
    expect(roleOf("Mortgage Interest")).toBe("interest_expense");
    expect(roleOf("Loan Interest")).toBe("interest_expense");
  });

  it("will not book interest income as an expense add-back", () => {
    // Same words, wrong side of the statement.
    expect(roleOf("Interest Income", "expense")).not.toBe("interest_income");
  });

  it("flags a bare 'Interest' account for review rather than applying it", () => {
    const result = classifyAccount(account("Interest"));
    expect(result.role).toBe("interest_expense");
    expect(result.confidence).toBe("low");
  });

  it("does not treat bank or card fees as interest", () => {
    expect(roleOf("Bank Charges & Fees")).toBeNull();
    expect(roleOf("Credit Card Charges/Fees")).toBeNull();
  });
});

describe("depreciation and amortization", () => {
  it("classifies each, and a combined line", () => {
    expect(roleOf("Depreciation")).toBe("depreciation");
    expect(roleOf("Amortization Expense")).toBe("amortization");
    expect(classifyAccount(account("Depreciation and Amortization")).rule).toBe(
      "depreciation.combined",
    );
  });

  it("refuses accumulated depreciation, which is a contra-asset", () => {
    const result = classifyAccount(account("Accumulated Depreciation- F&F"));
    expect(result.role).toBeNull();
    expect(result.rule).toBe("exclude.contra-asset");
  });
});

describe("owner compensation", () => {
  it("classifies the usual namings", () => {
    expect(roleOf("Officer Compensation")).toBe("owner_compensation");
    expect(roleOf("Owners Salary")).toBe("owner_compensation");
    expect(roleOf("Guaranteed Payments")).toBe("owner_compensation");
  });

  it("does not claim general payroll", () => {
    expect(roleOf("Payroll Expenses")).toBeNull();
    expect(roleOf("Employee Benefits")).toBeNull();
  });
});

describe("classifying the real engagement's chart of accounts", () => {
  const report = classifyAccounts(accounts);

  it("finds exactly the three roles this company actually has", () => {
    const applied = report.applied
      .map((c) => `${c.accountName} → ${c.role}`)
      .sort();
    expect(applied).toEqual([
      "Depreciation → depreciation",
      "Interest Income → interest_income",
      "Interest Paid → interest_expense",
    ]);
  });

  it("reproduces the roles the fixture was built with", () => {
    for (const expected of accounts.filter((a) => a.ebitdaRole)) {
      const result = classifyAccount(expected);
      expect(result.role, expected.name).toBe(expected.ebitdaRole);
    }
  });

  it("classifies no income tax, because this company has none", () => {
    expect(report.applied.some((c) => c.role === "income_tax")).toBe(false);
  });

  it("leaves every operating tax account unclassified, with a reason", () => {
    const names = ["Meals Tax", "Real estate taxes", "Taxes & Licenses", "Payroll taxes"];
    for (const name of names) {
      const entry = report.unclassified.find((c) => c.accountName === name);
      expect(entry, name).toBeDefined();
      expect(entry!.rule).toBe("exclude.operating-tax");
    }
  });

  it("suggests nothing it is not sure about", () => {
    expect(report.suggested).toEqual([]);
  });

  it("covers every P&L account exactly once", () => {
    const plCount = accounts.filter((a) => a.statementType === "profit_loss").length;
    const total =
      report.applied.length + report.suggested.length + report.unclassified.length;
    expect(total).toBe(plCount);
  });
});

describe("what the report does with an account it is unsure about", () => {
  /**
   * Three registers, and the difference between them is what a person has to
   * do next: applied is acted on, suggested is reviewed, unclassified is
   * ignored. Collapsing any two of them either moves EBITDA without a decision
   * or buries a real add-back in a list nobody reads.
   */
  const account = (over: Partial<Account>): Account => ({
    id: "a-1",
    name: "Interest",
    statementType: "profit_loss",
    accountType: "expense",
    ...over,
  });

  it("suggests rather than applies a name it is only half sure of", () => {
    // A bare "Interest" account is real, and broad enough to be a bank fee.
    // Applied, it moves EBITDA on a guess; unclassified, a genuine interest
    // cost is silently left out of the bridge.
    const report = classifyAccounts([account({ name: "Interest" })]);
    expect(report.applied).toEqual([]);
    expect(report.unclassified).toEqual([]);
    expect(report.suggested).toHaveLength(1);
    expect(report.suggested[0]).toMatchObject({
      role: "interest_expense",
      confidence: "low",
    });
    expect(report.suggested[0]!.reason).toMatch(/confirm/i);
  });

  it("says plainly why it skipped a balance-sheet account", () => {
    // Asked about one directly — which the review screen does, by id — the
    // answer has to be a reason rather than a null nobody can interpret.
    const result = classifyAccount(
      account({ name: "Accounts Receivable", statementType: "balance_sheet", accountType: "asset" }),
    );
    expect(result).toMatchObject({
      role: null,
      confidence: "high",
      rule: "skip.not-profit-loss",
    });
    expect(result.reason).toMatch(/balance-sheet/i);
  });

  it("leaves balance-sheet accounts out of the report altogether", () => {
    // The bridge classifies P&L accounts. A balance-sheet account in the
    // unclassified list reads as work outstanding, and there is none.
    const report = classifyAccounts([
      account({ id: "bs", name: "Cash", statementType: "balance_sheet", accountType: "asset" }),
      account({ id: "pl", name: "Depreciation" }),
    ]);
    const seen = [...report.applied, ...report.suggested, ...report.unclassified];
    expect(seen.map((c) => c.accountId)).toEqual(["pl"]);
  });

  it("reports an account carrying no type at all rather than dropping it", () => {
    const report = classifyAccounts([account({ name: "Sundry", accountType: null })]);
    expect(report.unclassified).toHaveLength(1);
    expect(report.unclassified[0]!.accountType).toBeNull();
  });
});

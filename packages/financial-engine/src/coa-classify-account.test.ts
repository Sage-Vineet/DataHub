import { describe, expect, it } from "vitest";
import {
  classifyAccountType,
  normaliseAccountType,
  typeFromAccountName,
  typeFromAccountNumber,
} from "./coa-classify-account.js";

/**
 * Working out what kind of account something is.
 *
 * Only a fallback — a stated type always wins. The tests are mostly about the
 * order of the fallbacks, because getting that wrong puts real money under the
 * wrong statement, which no report can detect.
 */

describe("what the statement said", () => {
  it("wins over everything else", () => {
    expect(
      classifyAccountType({
        accountName: "Bank Charges",
        accountNumber: "6100",
        statedType: "expense",
      }),
    ).toEqual({ accountType: "expense", basis: "stated" });
  });

  it("reads the spellings statements actually use", () => {
    expect(normaliseAccountType("Cost of Goods Sold")).toBe("cogs");
    expect(normaliseAccountType("cost of sales")).toBe("cogs");
    expect(normaliseAccountType("Revenue")).toBe("income");
    expect(normaliseAccountType("Expenses")).toBe("expense");
    expect(normaliseAccountType("ASSET")).toBe("asset");
  });

  it("says nothing rather than guessing at a type it does not know", () => {
    for (const value of ["", "  ", "suspense", "memo", null, undefined]) {
      expect(normaliseAccountType(value)).toBeNull();
    }
  });
});

describe("the account number", () => {
  it("reads the conventional ranges", () => {
    expect(typeFromAccountNumber("1000")).toBe("asset");
    expect(typeFromAccountNumber("2100")).toBe("liability");
    expect(typeFromAccountNumber("3000")).toBe("equity");
    expect(typeFromAccountNumber("4000")).toBe("income");
    expect(typeFromAccountNumber("5000")).toBe("cogs");
    for (const number of ["6100", "7000", "8500"]) {
      expect(typeFromAccountNumber(number)).toBe("expense");
    }
  });

  it("says nothing for a 9, which means nothing consistent", () => {
    // Used for "other" and for statistical accounts, differently everywhere.
    expect(typeFromAccountNumber("9000")).toBeNull();
  });

  it("says nothing for a scheme that is not numbered", () => {
    for (const number of ["A-100", "GL/Cash", "", "   ", null, undefined]) {
      expect(typeFromAccountNumber(number)).toBeNull();
    }
  });
});

describe("the number beats the name", () => {
  it("classifies 'Bank Charges & Fees' as the expense it is", () => {
    // The defect this ordering exists to fix. The old code tested the name
    // first, so `\bbank\b` made this an ASSET and the 6 was never looked at.
    expect(classifyAccountType({ accountName: "Bank Charges & Fees", accountNumber: "6100" })).toEqual({
      accountType: "expense",
      basis: "account_number",
    });
  });

  it("classifies 'Car & Truck Expense' as an expense", () => {
    // `\btruck\b` made this an asset too.
    expect(classifyAccountType({ accountName: "Car & Truck Expense", accountNumber: "6200" })).toEqual({
      accountType: "expense",
      basis: "account_number",
    });
  });

  it("classifies 'Credit Card Fees' as an expense", () => {
    // `\bcredit card\b` made this a LIABILITY — a cost recorded as debt.
    expect(classifyAccountType({ accountName: "Credit Card Fees", accountNumber: "6300" })).toEqual({
      accountType: "expense",
      basis: "account_number",
    });
  });

  it("still reads a real bank account as an asset when numbered as one", () => {
    expect(classifyAccountType({ accountName: "Bank of America Checking", accountNumber: "1010" })).toEqual({
      accountType: "asset",
      basis: "account_number",
    });
  });

  it("says which of the two decided", () => {
    // A person reviewing a chart needs to know whether they are looking at
    // something read off a statement, something a number determined, or a
    // guess about English.
    expect(classifyAccountType({ accountName: "Rent", accountNumber: "6000" }).basis).toBe(
      "account_number",
    );
    expect(classifyAccountType({ accountName: "Rent" }).basis).toBe("keyword");
    expect(classifyAccountType({ accountName: "Zxcv" }).basis).toBe("default");
  });
});

describe("falling back to the name", () => {
  it("reads the obvious ones", () => {
    expect(typeFromAccountName("Petty Cash")).toBe("asset");
    expect(typeFromAccountName("Accounts Payable")).toBe("liability");
    expect(typeFromAccountName("Retained Earnings")).toBe("equity");
    expect(typeFromAccountName("Product Sales")).toBe("income");
    expect(typeFromAccountName("Cost of Goods")).toBe("cogs");
    expect(typeFromAccountName("Office Rent")).toBe("expense");
  });

  it("says nothing when nothing matches", () => {
    expect(typeFromAccountName("Zxcv")).toBeNull();
    expect(typeFromAccountName("")).toBeNull();
    expect(typeFromAccountName(null)).toBeNull();
  });
});

describe("an unnumbered account found on a P&L", () => {
  it("does not become a balance-sheet type on a weak keyword", () => {
    // A P&L's rows are income and costs. With no number and no stated type, a
    // broad keyword is more likely wrong than right — and an expense recorded
    // as an asset overstates profit, which is the error that costs money.
    expect(
      classifyAccountType({ accountName: "Bank Charges", source: "profit_loss" }),
    ).toEqual({ accountType: "expense", basis: "default" });
    expect(classifyAccountType({ accountName: "Truck Repairs", source: "profit_loss" }).accountType).toBe(
      "expense",
    );
  });

  it("does become one on a term that could not be an expense", () => {
    expect(
      classifyAccountType({ accountName: "Accounts Receivable", source: "profit_loss" }),
    ).toEqual({ accountType: "asset", basis: "keyword" });
    expect(
      classifyAccountType({ accountName: "Note Payable", source: "profit_loss" }).accountType,
    ).toBe("liability");
    expect(
      classifyAccountType({ accountName: "Retained Earnings", source: "profit_loss" }).accountType,
    ).toBe("equity");
  });

  it("keeps 'Credit Card Fees' an expense but 'Credit Card Payable' a liability", () => {
    // "credit card" is deliberately not a strong term: charges and fees are
    // costs. Only `payable` moves it.
    expect(
      classifyAccountType({ accountName: "Credit Card Fees", source: "profit_loss" }).accountType,
    ).toBe("expense");
    expect(
      classifyAccountType({ accountName: "Credit Card Payable", source: "profit_loss" }).accountType,
    ).toBe("liability");
  });

  it("leaves a balance-sheet row's keyword alone", () => {
    // The guard is about where the row was FOUND. A bank account on a balance
    // sheet is a bank account.
    expect(
      classifyAccountType({ accountName: "Bank Charges", source: "balance_sheet" }).accountType,
    ).toBe("asset");
  });

  it("does not demote an income or cost keyword, which are P&L types anyway", () => {
    expect(classifyAccountType({ accountName: "Product Sales", source: "profit_loss" }).accountType).toBe(
      "income",
    );
    expect(classifyAccountType({ accountName: "Cost of Goods", source: "profit_loss" }).accountType).toBe(
      "cogs",
    );
  });
});

describe("when nothing says anything", () => {
  it("defaults to expense rather than leaving it unclassified", () => {
    // An unclassified account still has to go somewhere. An expense that turns
    // out to be an asset overstates costs; the reverse overstates profit, and
    // overstating profit is the error that costs somebody money.
    expect(classifyAccountType({ accountName: "Zxcv Reserve" })).toEqual({
      accountType: "expense",
      basis: "default",
    });
    expect(classifyAccountType({ accountName: null }).accountType).toBe("expense");
    expect(classifyAccountType({ accountName: "", accountNumber: "" }).accountType).toBe("expense");
  });
});

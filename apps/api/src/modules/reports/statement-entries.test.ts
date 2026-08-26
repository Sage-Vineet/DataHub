import { describe, expect, it } from "vitest";
import type { StatementNode } from "@datahub/financial-engine";
import { flattenStatement, splitAccountName } from "./statement-entries.js";

/**
 * A model-read statement, flattened into entry rows.
 *
 * These rows are what the financial engine reads: the balance sheet is rolled
 * forward from them and the chart of accounts is regenerated from them. A row
 * that should not be here is counted; a row that should be here and is not
 * leaves the sheet short by exactly its amount, and it still balances.
 */

const BALANCE_SHEET: StatementNode[] = [
  {
    name: "Assets",
    amount: 26000,
    children: [
      {
        name: "Bank Accounts",
        amount: 5000,
        children: [
          { name: "1000 Operating Cash", amount: 4000, type: "asset" },
          { name: "1010 Savings", amount: 1000, type: "asset" },
        ],
      },
      { name: "Fixed Assets", amount: 21000, children: [{ name: "Delivery Van", amount: 21000 }] },
    ],
  },
  {
    name: "Liabilities",
    amount: -52000,
    children: [{ name: "Long-term Liabilities", amount: -52000, children: [] }],
  },
];

describe("splitting an account number out of a name", () => {
  it("reads the shapes a chart exports", () => {
    // "4000 Sales" and "Sales" are two accounts to anything comparing names,
    // and the classifier keys on the number when there is one.
    expect(splitAccountName("4000 Sales")).toEqual({ name: "Sales", number: "4000" });
    expect(splitAccountName("4000 · Sales")).toEqual({ name: "Sales", number: "4000" });
    expect(splitAccountName("4000 - Sales")).toEqual({ name: "Sales", number: "4000" });
    expect(splitAccountName("4000.10 Sales")).toEqual({ name: "Sales", number: "4000.10" });
  });

  it("leaves a name with no number alone", () => {
    expect(splitAccountName("Operating Cash")).toEqual({ name: "Operating Cash", number: null });
  });

  it("does not read a bare number as an account number", () => {
    // A row called "2024" is a year heading, not account 2024.
    expect(splitAccountName("2024")).toEqual({ name: "2024", number: null });
    expect(splitAccountName("2024 ")).toEqual({ name: "2024", number: null });
  });
});

describe("flattening a balance sheet", () => {
  const entries = flattenStatement(BALANCE_SHEET, { kind: "balance_sheet" });

  it("keeps the statement's own order", () => {
    // A row's position IS information. Re-sorted by name or amount it becomes
    // something nobody recognises as their own accounts.
    expect(entries.map((e) => e.accountName)).toEqual([
      "Assets",
      "Bank Accounts",
      "Operating Cash",
      "Savings",
      "Fixed Assets",
      "Delivery Van",
      "Liabilities",
      "Long-term Liabilities",
    ]);
    expect(entries.map((e) => e.sortOrder)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("records how deep each row sits", () => {
    expect(entries.find((e) => e.accountName === "Assets")?.hierarchyLevel).toBe(0);
    expect(entries.find((e) => e.accountName === "Bank Accounts")?.hierarchyLevel).toBe(1);
    expect(entries.find((e) => e.accountName === "Operating Cash")?.hierarchyLevel).toBe(2);
  });

  it("marks anything with children as a total", () => {
    // Stored as an account it would be counted AGAINST the accounts beneath
    // it, and the sheet would still balance — it would just be wrong by the
    // size of every heading.
    expect(entries.find((e) => e.accountName === "Bank Accounts")?.isTotal).toBe(true);
    expect(entries.find((e) => e.accountName === "Operating Cash")?.isTotal).toBe(false);
  });

  it("marks a heading with an empty child list as an account, not a total", () => {
    // `children: []` is a heading nothing was found under, and calling it a
    // total would drop a real balance out of the roll.
    expect(entries.find((e) => e.accountName === "Long-term Liabilities")?.isTotal).toBe(false);
  });

  it("carries the section down from the statement's own top level", () => {
    for (const name of ["Bank Accounts", "Operating Cash", "Delivery Van"]) {
      expect(entries.find((e) => e.accountName === name)?.section).toBe("assets");
    }
    expect(entries.find((e) => e.accountName === "Long-term Liabilities")?.section).toBe(
      "liabilities",
    );
  });

  it("names the heading each row presents under", () => {
    expect(entries.find((e) => e.accountName === "Operating Cash")?.subSection).toBe(
      "Bank Accounts",
    );
    // A statement's own section presents under nothing.
    expect(entries.find((e) => e.accountName === "Assets")?.subSection).toBeNull();
  });

  it("splits the account number out where the chart wrote one into the name", () => {
    expect(entries.find((e) => e.accountName === "Operating Cash")?.accountNumber).toBe("1000");
    expect(entries.find((e) => e.accountName === "Delivery Van")?.accountNumber).toBeNull();
  });

  it("recognises equity however the statement words it", () => {
    for (const heading of ["Equity", "Owner's Capital", "Shareholders Funds"]) {
      const flat = flattenStatement([{ name: heading, children: [{ name: "Retained", amount: 1 }] }], {
        kind: "balance_sheet",
      });
      expect(flat[1]?.section).toBe("equity");
    }
  });

  it("leaves the section null for a heading it cannot place", () => {
    // Guessing would put a real amount on an arbitrary side of the sheet.
    const flat = flattenStatement([{ name: "Memoranda", children: [{ name: "Note", amount: 1 }] }], {
      kind: "balance_sheet",
    });
    expect(flat[0]?.section).toBeNull();
  });
});

describe("flattening a profit and loss", () => {
  const PL: StatementNode[] = [
    {
      name: "Income",
      amount: 1000,
      children: [{ name: "4000 Sales", amount: 1000, type: "income" }],
    },
  ];

  it("carries no section, because a P&L has none", () => {
    const entries = flattenStatement(PL, { kind: "profit_and_loss" });
    expect(entries.every((e) => e.section === null)).toBe(true);
  });

  it("still names the heading and the account type", () => {
    const entries = flattenStatement(PL, { kind: "profit_and_loss" });
    expect(entries[1]).toMatchObject({
      accountName: "Sales",
      accountNumber: "4000",
      accountType: "income",
      subSection: "Income",
    });
  });
});

describe("rows the statement should not have carried", () => {
  it("drops one with no name at all", () => {
    // A spacer the statement carries for layout. Stored, it becomes an account
    // called "" that every grouping downstream has to special-case.
    const entries = flattenStatement(
      [{ name: "Assets", children: [{ name: "  ", amount: 5 }, { name: "Cash", amount: 5 }] }],
      { kind: "balance_sheet" },
    );
    expect(entries.map((e) => e.accountName)).toEqual(["Assets", "Cash"]);
  });

  it("reads a row with no amount as nothing rather than dropping it", () => {
    // The account is real and on the statement; only its figure is missing,
    // and dropping it would take the account off the chart entirely.
    const entries = flattenStatement([{ name: "Cash" }], { kind: "balance_sheet" });
    expect(entries[0]).toMatchObject({ accountName: "Cash", amount: 0 });
  });

  it("never records minus zero", () => {
    // It serialises as `-0` and renders as "-0.00", which reads as a figure
    // somebody got wrong.
    const entries = flattenStatement([{ name: "Cash", amount: -0.001 }], {
      kind: "balance_sheet",
    });
    expect(Object.is(entries[0]!.amount, -0)).toBe(false);
    expect(entries[0]!.amount).toBe(0);
  });

  it("answers nothing for a statement with no rows", () => {
    expect(flattenStatement([], { kind: "balance_sheet" })).toEqual([]);
  });
});

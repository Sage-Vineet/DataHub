import { describe, expect, it } from "vitest";
import { toEngagementAccount, type CoaRowForEngagement } from "./engagement.drizzle.js";

/**
 * One stored chart-of-accounts row as the engine's account.
 *
 * Small, and two of its decisions are corrections rather than translation.
 * Both were silent when they were wrong: the statements still balanced, and
 * the figures were still plausible.
 */

const row = (over: Partial<CoaRowForEngagement> = {}): CoaRowForEngagement => ({
  id: "coa-1",
  accountName: "4000 Sales",
  statementType: "profit_loss",
  accountType: "revenue",
  ebitdaRole: null,
  ...over,
});

describe("which side of the statements an account sits on", () => {
  it("reads a profit-and-loss account as one", () => {
    expect(toEngagementAccount(row())).toMatchObject({
      statementType: "profit_loss",
      accountType: "income",
    });
  });

  it("treats anything that is not profit_loss as a balance-sheet account", () => {
    // Including a row whose statement type was never set: a balance sheet is
    // the safer default, because an unclassified account counted as income
    // moves net income and nothing on screen says why.
    expect(toEngagementAccount(row({ statementType: "balance_sheet" })).statementType).toBe(
      "balance_sheet",
    );
    expect(toEngagementAccount(row({ statementType: null })).statementType).toBe("balance_sheet");
  });
});

describe("a balance-sheet account's own type", () => {
  it("reads the section it presents under", () => {
    // Returning null here made every liability and equity account fall back to
    // "asset" in the roll-forward's balance check, and put the debit/credit
    // split in the trial balance on the wrong side of the ledger.
    for (const [section, expected] of [
      ["assets", "asset"],
      ["asset", "asset"],
      ["liabilities", "liability"],
      ["liability", "liability"],
      ["equity", "equity"],
    ] as const) {
      const account = toEngagementAccount(
        row({ statementType: "balance_sheet", accountType: section }),
      );
      expect(account.accountType).toBe(expected);
    }
  });

  it("reads the plural and the singular alike, and ignores case", () => {
    // The entry table uses plurals and the engine the singular, and exports
    // capitalise inconsistently.
    expect(
      toEngagementAccount(row({ statementType: "balance_sheet", accountType: "Liabilities" }))
        .accountType,
    ).toBe("liability");
  });

  it("answers null for a section it does not recognise", () => {
    // Rather than guessing at "asset", which is what the defect above did.
    for (const section of ["contra", "", null]) {
      expect(
        toEngagementAccount(row({ statementType: "balance_sheet", accountType: section }))
          .accountType,
      ).toBeNull();
    }
  });
});

describe("cost of sales", () => {
  it("is kept apart from expense", () => {
    // Folding it in kept net income right — cogs is subtracted either way —
    // but threw away the only thing gross profit can be derived from.
    for (const type of ["cogs", "COGS", "cost_of_goods_sold", "Cost_Of_Sales"]) {
      expect(toEngagementAccount(row({ accountType: type })).accountType).toBe("cogs");
    }
  });

  it("leaves an ordinary expense as an expense", () => {
    expect(toEngagementAccount(row({ accountType: "expense" })).accountType).toBe("expense");
    expect(toEngagementAccount(row({ accountType: "other_expense" })).accountType).toBe("expense");
  });

  it("treats an unclassified profit-and-loss account as an expense", () => {
    // The conservative reading: an unknown cost understates profit rather than
    // overstating it, which is the direction a buyer's diligence can survive.
    expect(toEngagementAccount(row({ accountType: null })).accountType).toBe("expense");
  });
});

describe("income, whatever case it was stored in", () => {
  it("reads every spelling of income the chart uses", () => {
    for (const type of ["income", "revenue", "other_income"]) {
      expect(toEngagementAccount(row({ accountType: type })).accountType).toBe("income");
    }
  });

  it("reads a capitalised one as income too", () => {
    // Matched case-sensitively, an account stored as "Revenue" missed the
    // income set and fell through to EXPENSE — which inverts its sign in every
    // statement derived from it, and still balances.
    for (const type of ["Revenue", "INCOME", "Other_Income"]) {
      expect(toEngagementAccount(row({ accountType: type })).accountType).toBe("income");
    }
  });
});

describe("the EBITDA role", () => {
  it("carries one the chart records", () => {
    expect(toEngagementAccount(row({ ebitdaRole: "depreciation" })).ebitdaRole).toBe(
      "depreciation",
    );
  });

  it("is null where the chart records none", () => {
    expect(toEngagementAccount(row()).ebitdaRole).toBeNull();
  });
});

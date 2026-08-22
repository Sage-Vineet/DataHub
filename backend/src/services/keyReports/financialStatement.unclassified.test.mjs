import { describe, expect, it, vi } from "vitest";
import financialStatementService from "./financialStatementService.js";

const { buildPlStatement, buildBsStatement } = financialStatementService;

/**
 * An account with no classification must never vanish from a statement.
 *
 * `isPlAccount` admits any account whose `statement_type` is "profit_loss",
 * whatever its `account_type` — and `account_type` is a nullable column. The
 * statement builders then filter that list into income / cogs / expense (or
 * asset / liability / equity) and compute every total from those three lists.
 * An account matching none of them was loaded, given an amount by the roll-up,
 * and then silently excluded from the output entirely.
 *
 * On the P&L that understates or overstates net income with no signal. On the
 * balance sheet it is worse: the sheet asserts A = L + E, so the omission shows
 * up as an imbalance of exactly the missing amount with nothing naming the
 * cause. The project has already paid for that once — a null `account_type` on
 * balance-sheet accounts put FY2022 out by $2,886,349.72, and only the
 * A = L + E assertion caught it.
 *
 * The fix reports rather than guesses. Which total an unclassified account
 * belongs in is precisely the unknown, and the amount's own sign cannot settle
 * it because this ledger exports revenue and expenses both positive.
 * `packages/financial-engine` refuses outright with UnclassifiedAccountError;
 * legacy still has to render a screen, so it renders the gap.
 */

/** A leaf in the shape `buildTree`/`rollupNode` hand to the builders. */
function leaf(name, accountType, amount, extra = {}) {
  return {
    id: name.toLowerCase().replace(/\s+/g, "-"),
    system_id: null,
    account_number: null,
    account_name: name,
    account_type: accountType,
    displayAmount: amount,
    ...extra,
  };
}

describe("buildPlStatement with unclassified accounts", () => {
  const classified = [
    leaf("Product Revenue", "income", 1_000_000),
    leaf("Materials", "cogs", 400_000),
    leaf("Salaries", "expense", 300_000),
  ];

  it("reports an unclassified account instead of dropping it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const leaves = [...classified, leaf("Suspense Account", null, 250_000)];

    const stmt = buildPlStatement(leaves, new Map());

    expect(stmt.unclassified.accounts).toHaveLength(1);
    expect(stmt.unclassified.accounts[0].name).toBe("Suspense Account");
    expect(stmt.unclassified.total).toBe(250_000);
    warn.mockRestore();
  });

  it("names the offending accounts in a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const leaves = [...classified, leaf("Suspense Account", null, 250_000)];

    buildPlStatement(leaves, new Map());

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0];
    expect(message).toContain("Suspense Account");
    expect(message).toContain("no income/cogs/expense classification");
    warn.mockRestore();
  });

  it("leaves the classified totals exactly as they were", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const leaves = [...classified, leaf("Suspense Account", null, 250_000)];

    const stmt = buildPlStatement(leaves, new Map());

    // The unclassified amount is deliberately NOT folded into any total: its
    // sign is unknowable. Reporting it must not silently restate net income.
    expect(stmt.revenue.total).toBe(1_000_000);
    expect(stmt.costOfSales.total).toBe(400_000);
    expect(stmt.grossProfit).toBe(600_000);
    expect(stmt.operatingExpenses.total).toBe(300_000);
    expect(stmt.netIncome).toBe(300_000);
    warn.mockRestore();
  });

  it("treats an unrecognised account_type as unclassified, not as expense", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Neither null nor one of the three known values — a typo or a new type.
    const leaves = [...classified, leaf("Other Income", "revenue", 50_000)];

    const stmt = buildPlStatement(leaves, new Map());

    expect(stmt.unclassified.accounts.map((a) => a.name)).toEqual(["Other Income"]);
    expect(stmt.netIncome).toBe(300_000);
    warn.mockRestore();
  });

  it("stays quiet and empty when everything is classified", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const stmt = buildPlStatement(classified, new Map());

    expect(stmt.unclassified.accounts).toEqual([]);
    expect(stmt.unclassified.total).toBe(0);
    // The field is always present, so a consumer never has to probe for it.
    expect(stmt.unclassified.label).toBe("Unclassified");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("buildBsStatement with unclassified accounts", () => {
  const balanced = [
    leaf("Cash", "asset", 500_000),
    leaf("Accounts Payable", "liability", 200_000),
    leaf("Common Stock", "equity", 300_000),
  ];

  it("surfaces the account that would otherwise unbalance the sheet", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const leaves = [...balanced, leaf("Retained Earnings", null, 120_000)];

    const stmt = buildBsStatement(leaves, new Map());

    expect(stmt.unclassified.accounts.map((a) => a.name)).toEqual(["Retained Earnings"]);
    expect(stmt.unclassified.total).toBe(120_000);
    warn.mockRestore();
  });

  it("quantifies the resulting imbalance in the warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const leaves = [...balanced, leaf("Retained Earnings", null, 120_000)];

    buildBsStatement(leaves, new Map());

    const message = warn.mock.calls[0][0];
    expect(message).toContain("Retained Earnings");
    expect(message).toContain("120000");
    warn.mockRestore();
  });

  it("keeps A = L + E for the accounts that are classified", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const leaves = [...balanced, leaf("Retained Earnings", null, 120_000)];

    const stmt = buildBsStatement(leaves, new Map());

    // The classified sheet still balances; the unclassified total is exactly
    // the amount a naive A = L + E check would report as missing, which is what
    // makes the new field diagnostic rather than decorative.
    expect(stmt.assets.total).toBe(500_000);
    expect(stmt.liabilities.total + stmt.equity.total).toBe(500_000);
    expect(stmt.unclassified.total).toBe(120_000);
    warn.mockRestore();
  });

  it("stays quiet and empty when everything is classified", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const stmt = buildBsStatement(balanced, new Map());

    expect(stmt.unclassified.accounts).toEqual([]);
    expect(stmt.unclassified.total).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

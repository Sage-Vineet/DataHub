import { describe, expect, it } from "vitest";
import {
  AddbackValidationError,
  detectDuplicates,
  forDataSource,
  resolveAddback,
  validateAddback,
} from "./addbacks.js";
import { buildIncomeStatement } from "./income-statement.js";
import { periodKey } from "./periods.js";
import type { Account, Addback, GlEntry, Period } from "./types.js";

/**
 * Add-backs, on their own.
 *
 * This file had no test of its own — it was exercised only through the bridge,
 * which is the one place its output is added up. That is the wrong level for
 * two of the things in here: the validation refuses a shape before any
 * arithmetic happens, and the duplicate detector produces a warning the bridge
 * never reads.
 *
 * What is at stake is not a rounding error. An add-back counted twice, or one
 * accepted with nothing behind it, moves EBITDA — and EBITDA times a multiple
 * is the number on the offer.
 */

const base: Addback = {
  id: "ab-1",
  kind: "manual_adjustment",
  dataSource: "company_financials",
  typeKey: "personal_expense",
  name: "Owner's vehicle",
  granularity: "detail",
};

const addback = (over: Partial<Addback>): Addback => ({ ...base, ...over });

describe("what an add-back must carry before it counts", () => {
  it("refuses a GL-sourced add-back with no account", () => {
    // The amount comes FROM the account. Without one there is nothing to read
    // and the add-back contributes zero — silently, on a bridge that shows a
    // row for it.
    expect(() => validateAddback(addback({ kind: "pnl_account_vendor" }))).toThrow(
      AddbackValidationError,
    );
    expect(() =>
      validateAddback(addback({ kind: "pnl_account_vendor", linkedAccountId: "meals" })),
    ).not.toThrow();
  });

  it("refuses a manual adjustment nobody explained", () => {
    // A manual adjustment is a number somebody typed. The explanation is the
    // only thing that distinguishes it from an unexplained one, and a buyer's
    // diligence will ask.
    for (const explanation of [undefined, null, "", "   "]) {
      expect(() => validateAddback(addback({ kind: "manual_adjustment", explanation }))).toThrow(
        /written explanation/,
      );
    }
    expect(() =>
      validateAddback(addback({ kind: "manual_adjustment", explanation: "Personal travel." })),
    ).not.toThrow();
  });

  it("refuses a recast missing either half of what it restates", () => {
    // A recast is the DELTA between a normalized post-close figure and what
    // the books actually show. Missing the account there is nothing to
    // compare, and missing the value there is nothing to compare it to.
    expect(() =>
      validateAddback(addback({ kind: "recast", recastNormalizedValue: 90_000 })),
    ).toThrow(/linked P&L account/);

    expect(() => validateAddback(addback({ kind: "recast", linkedAccountId: "rent" }))).toThrow(
      /normalized post-close value/,
    );

    expect(() =>
      validateAddback(
        addback({ kind: "recast", linkedAccountId: "rent", recastNormalizedValue: null }),
      ),
    ).toThrow(/normalized post-close value/);

    expect(() =>
      validateAddback(
        addback({ kind: "recast", linkedAccountId: "rent", recastNormalizedValue: 0 }),
      ),
    ).not.toThrow();
  });

  it("names the add-back on the error, not just the rule", () => {
    // The wizard shows several at once; a message with no id names none of
    // them.
    try {
      validateAddback(addback({ id: "ab-7", kind: "pnl_account_vendor" }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AddbackValidationError);
      expect((err as AddbackValidationError).addbackId).toBe("ab-7");
    }
  });

  it("asks nothing extra of a balance-sheet change", () => {
    // Balance-sheet deltas are supplied amounts by definition — they are not
    // P&L rows and there is no account to read them from.
    expect(() => validateAddback(addback({ kind: "balance_sheet_change" }))).not.toThrow();
  });
});

describe("add-backs that may be the same thing twice", () => {
  /**
   * Surfaced as a warning and never auto-removed: two add-backs on one account
   * are sometimes correct — the same account split by vendor across two
   * reviewers — and sometimes the same adjustment entered twice. Only a person
   * can tell, and the cost of guessing wrong in either direction is a wrong
   * EBITDA.
   */
  const on = (id: string, accountId: string | null, vendorScope?: string[]): Addback =>
    addback({ id, kind: "pnl_account_vendor", linkedAccountId: accountId, ...(vendorScope ? { vendorScope } : {}) });

  it("finds nothing to warn about in an empty or single list", () => {
    expect(detectDuplicates([])).toEqual([]);
    expect(detectDuplicates([on("a", "meals")])).toEqual([]);
  });

  it("pairs two that cover the whole of the same account", () => {
    expect(detectDuplicates([on("a", "meals"), on("b", "meals")])).toEqual([["a", "b"]]);
  });

  it("pairs a whole-account add-back with a vendor-scoped one on that account", () => {
    // The unscoped one already includes the scoped one's vendor, so the two
    // together count it twice.
    expect(detectDuplicates([on("a", "meals"), on("b", "meals", ["Bistro"])])).toEqual([
      ["a", "b"],
    ]);
    expect(detectDuplicates([on("a", "meals", ["Bistro"]), on("b", "meals")])).toEqual([
      ["a", "b"],
    ]);
  });

  it("pairs two scoped add-backs that share a vendor", () => {
    expect(
      detectDuplicates([on("a", "meals", ["Bistro", "Cafe"]), on("b", "meals", ["Cafe"])]),
    ).toEqual([["a", "b"]]);
  });

  it("leaves two scoped add-backs alone when their vendors do not overlap", () => {
    // The ordinary correct case: one account, split by vendor. Warning here
    // would train people to ignore the warning.
    expect(
      detectDuplicates([on("a", "meals", ["Bistro"]), on("b", "meals", ["Cafe"])]),
    ).toEqual([]);
  });

  it("leaves add-backs on different accounts alone", () => {
    expect(detectDuplicates([on("a", "meals"), on("b", "travel")])).toEqual([]);
  });

  it("says nothing about add-backs with no account at all", () => {
    // Manual adjustments have none. Treating "both have no account" as a match
    // would pair every manual adjustment with every other one.
    expect(detectDuplicates([on("a", null), on("b", null)])).toEqual([]);
    expect(detectDuplicates([addback({ id: "a" }), addback({ id: "b" })])).toEqual([]);
  });

  it("reports every colliding pair, not just the first", () => {
    // Three on one account is three pairs, and a reviewer clearing one should
    // still see the others.
    const pairs = detectDuplicates([on("a", "meals"), on("b", "meals"), on("c", "meals")]);
    expect(pairs).toEqual([
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
  });
});

describe("which add-backs belong to a data source", () => {
  it("keeps only the ones raised against that source", () => {
    // The bridge is built per source: company financials and tax return are
    // different sets of books, and mixing them adds an adjustment to a
    // statement it was never measured against.
    const list = [
      addback({ id: "a", dataSource: "company_financials" }),
      addback({ id: "b", dataSource: "tax_return" }),
      addback({ id: "c", dataSource: "company_financials" }),
    ];
    expect(forDataSource(list, "company_financials").map((a) => a.id)).toEqual(["a", "c"]);
    expect(forDataSource(list, "tax_return").map((a) => a.id)).toEqual(["b"]);
  });
});

describe("what an add-back is worth, per period", () => {
  const ACCOUNTS: Account[] = [
    { id: "meals", name: "Meals", statementType: "profit_loss", accountType: "expense" },
    { id: "rent", name: "Rent", statementType: "profit_loss", accountType: "expense" },
  ];

  const ENTRIES: GlEntry[] = [
    { accountId: "meals", fiscalYear: 2024, month: 1, amount: 300, vendor: "Bistro" },
    { accountId: "meals", fiscalYear: 2024, month: 2, amount: 200, vendor: "Cafe" },
    { accountId: "meals", fiscalYear: 2024, month: 3, amount: 100, vendor: null },
    { accountId: "rent", fiscalYear: 2024, month: 1, amount: 120_000 },
  ];

  const ANNUAL: Period[] = [{ fiscalYear: 2024, month: null }];
  const MONTHLY: Period[] = [1, 2, 3].map((month) => ({ fiscalYear: 2024, month }));

  const annualKey = (entry: GlEntry) => periodKey(entry.fiscalYear, null);
  const monthlyKey = (entry: GlEntry) => periodKey(entry.fiscalYear, entry.month);

  const statementFor = (periods: Period[]) =>
    buildIncomeStatement(ACCOUNTS, ENTRIES, periods, periods[0]?.month === null ? "annual" : "monthly");

  const resolve = (over: Partial<Addback>, periods = ANNUAL) =>
    resolveAddback(
      addback(over),
      ENTRIES,
      statementFor(periods),
      periods,
      periods === ANNUAL ? annualKey : monthlyKey,
    ).amounts;

  it("reads the whole account when no vendor is named", () => {
    expect(
      resolve({ kind: "pnl_account_vendor", linkedAccountId: "meals" })["2024"],
    ).toBe(600);
  });

  it("reads only the named vendors when scope is given", () => {
    // Scoping is how one account carries two add-backs without double-counting
    // — the reason `detectDuplicates` exists at all.
    expect(
      resolve({ kind: "pnl_account_vendor", linkedAccountId: "meals", vendorScope: ["Bistro"] })[
        "2024"
      ],
    ).toBe(300);
  });

  it("leaves a vendorless posting out of a scoped add-back", () => {
    // `vendor` is nullable, and a scoped add-back is a statement about NAMED
    // vendors. Counting the unattributed row would inflate it by whatever the
    // ledger failed to attribute.
    expect(
      resolve({
        kind: "pnl_account_vendor",
        linkedAccountId: "meals",
        vendorScope: ["Bistro", "Cafe"],
      })["2024"],
    ).toBe(500);
  });

  it("treats an empty scope as the whole account, not as no vendors", () => {
    // An empty list is what the form sends when nobody picked one, and reading
    // it as "no vendors match" would zero the add-back silently.
    expect(
      resolve({ kind: "pnl_account_vendor", linkedAccountId: "meals", vendorScope: [] })["2024"],
    ).toBe(600);
  });

  it("measures a recast as the gap between the books and the post-close figure", () => {
    // The add-back is what the business would NOT have spent after close.
    expect(
      resolve({ kind: "recast", linkedAccountId: "rent", recastNormalizedValue: 90_000 })["2024"],
    ).toBe(30_000);
  });

  it("measures a recast on an account with nothing posted as the negative of the figure", () => {
    // Not a shrug: an account with no ledger movement against a post-close
    // rent of 90k is a 90k cost the buyer takes on, and the bridge should show
    // it rather than nothing.
    expect(
      resolve({ kind: "recast", linkedAccountId: "unposted", recastNormalizedValue: 90_000 })[
        "2024"
      ],
    ).toBe(-90_000);
  });

  it("spreads an annual figure across the months it is viewed in", () => {
    // A manual adjustment is entered once, per year, and the monthly view has
    // to show something in each column rather than the whole figure in January.
    const monthly = resolve(
      { kind: "manual_adjustment", explanation: "Owner travel.", values: { "2024": 300 } },
      MONTHLY,
    );
    expect(monthly["2024-01"]).toBe(100);
    expect(monthly["2024-02"]).toBe(100);
    expect(monthly["2024-03"]).toBe(100);
  });

  it("prefers an exact monthly figure over the annual one", () => {
    const monthly = resolve(
      {
        kind: "manual_adjustment",
        explanation: "Owner travel.",
        values: { "2024": 300, "2024-02": 250 },
      },
      MONTHLY,
    );
    expect(monthly["2024-01"]).toBe(100);
    expect(monthly["2024-02"]).toBe(250);
  });

  it("reads an add-back with no amounts at all as zero, not as absent", () => {
    const amounts = resolve({ kind: "manual_adjustment", explanation: "Pending." });
    expect(amounts["2024"]).toBe(0);
  });

  it("smooths a smoothed add-back evenly, whatever period it was posted in", () => {
    // "Smoothed" says the cost is not really a January cost — a annual licence
    // paid up front, say — so showing it all in January makes that month look
    // worse and every other month better.
    const monthly = resolve(
      { kind: "pnl_account_vendor", linkedAccountId: "rent", granularity: "smoothed" },
      MONTHLY,
    );
    expect(monthly["2024-01"]).toBe(40_000);
    expect(monthly["2024-02"]).toBe(40_000);
    expect(monthly["2024-03"]).toBe(40_000);
  });
});

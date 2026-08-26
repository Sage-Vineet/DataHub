import { describe, expect, it } from "vitest";
import {
  MAX_LEVELS,
  STANDARD_PREFIX,
  STATEMENT_BY_TYPE,
  assetSubAndGroup,
  buildLevelsFromPath,
  classifyStandardised,
  expenseGroupFor,
  liabilitySubAndGroup,
} from "./coa-hierarchy.js";

/**
 * Placing an account into the standardised hierarchy.
 *
 * The anchors are the same for every company, which is the whole point: a
 * standardised chart is one where "Total Expenses" means the same place in
 * every client's statements. So the tests are about the anchors holding, and
 * about the account itself never losing the deepest slot.
 */

describe("the fixed anchors", () => {
  it("puts every P&L type under the same rollup chain", () => {
    for (const type of ["income", "expense", "cogs"] as const) {
      expect(STANDARD_PREFIX[type].slice(0, 5)).toEqual([
        "Income Statement",
        "Net Income",
        "Pretax Income",
        "Operating Income",
        "Gross Profit",
      ]);
    }
  });

  it("sends revenue and cost to opposite totals", () => {
    expect(STANDARD_PREFIX.income[5]).toBe("Total Revenue");
    expect(STANDARD_PREFIX.expense[5]).toBe("Total Expenses");
    // Cost of sales is a cost, not revenue — filed under expenses so gross
    // profit is revenue minus it rather than revenue plus it.
    expect(STANDARD_PREFIX.cogs[5]).toBe("Total Expenses");
  });

  it("knows which statement each type belongs to", () => {
    expect(STATEMENT_BY_TYPE.asset).toBe("balance_sheet");
    expect(STATEMENT_BY_TYPE.cogs).toBe("profit_loss");
  });
});

describe("which group an expense belongs to", () => {
  it("recognises the common ones", () => {
    expect(expenseGroupFor("Salaries and Wages")).toBe("Payroll and Labor");
    expect(expenseGroupFor("Rent Expense")).toBe("Occupancy");
    expect(expenseGroupFor("General Liability Insurance")).toBe("Insurance");
    expect(expenseGroupFor("Depreciation")).toBe("Non-Cash and Below-Line");
    expect(expenseGroupFor("Truck Fuel")).toBe("Vehicle and Travel");
  });

  it("puts an officer's benefit in payroll, not in insurance", () => {
    // Order is load-bearing: the payroll rule tests `\bofficer\b` before the
    // insurance rule runs. That is the intended reading for an owner-benefit
    // add-back, which is what somebody is looking for when they open the group.
    expect(expenseGroupFor("Officer Life Insurance")).toBe("Payroll and Labor");
  });

  it("falls back rather than leaving an expense unplaced", () => {
    // An unplaced account is one that appears under no heading and in no
    // total, which is worse than one filed under a vague heading.
    expect(expenseGroupFor("Sundry")).toBe("General and Administrative");
    expect(expenseGroupFor("")).toBe("General and Administrative");
    expect(expenseGroupFor(null)).toBe("General and Administrative");
  });
});

describe("where an asset sits", () => {
  it("separates the three sub-categories", () => {
    expect(assetSubAndGroup("Checking Account")[0]).toBe("Current Assets");
    expect(assetSubAndGroup("Leasehold Improvements")[0]).toBe("Fixed Assets");
    expect(assetSubAndGroup("Goodwill")[0]).toBe("Other Assets");
  });

  it("names the group a person would look under", () => {
    expect(assetSubAndGroup("Business Checking")[1]).toBe("Bank Accounts");
    expect(assetSubAndGroup("Accounts Receivable")[1]).toBe("Accounts Receivable");
    expect(assetSubAndGroup("Prepaid Insurance")[1]).toBe("Prepaid Expenses");
    expect(assetSubAndGroup("Accumulated Depreciation")[1]).toBe("Accumulated Depreciation");
  });

  it("puts each kind of asset under the heading a reader expects", () => {
    /**
     * Every rule in the chain, in the order it is applied. The order is the
     * substance: "Loan Receivable" matches both the receivable rule and the
     * loans-to rule, and "Accumulated Depreciation — Vehicles" matches both
     * depreciation and vehicles. Whichever runs first wins, and a reader
     * scanning the balance sheet sees the difference.
     *
     * The tail matters as much: an asset nothing recognises still has to land
     * somewhere, and where it lands depends on the sub-category the FIRST
     * chain chose. A fixed asset falling through must not become an "Other
     * Current Asset" — that moves it above the working-capital line.
     */
    const cases: Array<[string, string, string]> = [
      ["Money Market Account", "Current Assets", "Bank Accounts"],
      ["Petty Cash", "Current Assets", "Bank Accounts"],
      ["Accounts Receivable", "Current Assets", "Accounts Receivable"],
      ["Trade A/R", "Current Assets", "Accounts Receivable"],
      ["Inventory", "Current Assets", "Inventory"],
      ["Stock on Hand", "Current Assets", "Inventory"],
      ["Prepaid Insurance", "Current Assets", "Prepaid Expenses"],
      ["Loans to Shareholder", "Current Assets", "Other Current Assets"],
      ["Due from Affiliate", "Current Assets", "Other Current Assets"],
      ["Accumulated Depreciation", "Fixed Assets", "Accumulated Depreciation"],
      ["Machinery", "Fixed Assets", "Machinery & Equipment"],
      ["Shop Equipment", "Fixed Assets", "Machinery & Equipment"],
      ["Furniture", "Fixed Assets", "Furniture & Fixtures"],
      ["Fixtures", "Fixed Assets", "Furniture & Fixtures"],
      ["Leasehold Improvements", "Fixed Assets", "Leasehold Improvements"],
      ["Vehicle", "Fixed Assets", "Vehicles"],
      ["Delivery Truck", "Fixed Assets", "Vehicles"],
      ["Land", "Fixed Assets", "Land Improvements"],
      ["Construction in Progress", "Fixed Assets", "Construction in Progress"],
      ["Goodwill", "Other Assets", "Other Long-Term Assets"],
      ["Intangible Assets", "Other Assets", "Other Long-Term Assets"],
      ["Financing Costs", "Other Assets", "Other Long-Term Assets"],
      // Nothing matches the group chain, so the sub-category decides.
      ["Widget Reserve", "Current Assets", "Other Current Assets"],
      ["Building", "Fixed Assets", "Other Fixed Assets"],
      ["Security Deposit", "Other Assets", "Other Long-Term Assets"],
    ];

    for (const [name, sub, group] of cases) {
      expect([name, ...assetSubAndGroup(name)]).toEqual([name, sub, group]);
    }
  });

  it("reads the name whatever case it is written in", () => {
    // Charts of accounts are typed by people, and "PREPAID INSURANCE" is as
    // common as "Prepaid Insurance".
    expect(assetSubAndGroup("PREPAID INSURANCE")[1]).toBe("Prepaid Expenses");
    expect(assetSubAndGroup("business CHECKING")[1]).toBe("Bank Accounts");
  });

  it("takes an absent name as an unrecognised current asset", () => {
    expect(assetSubAndGroup(null)).toEqual(["Current Assets", "Other Current Assets"]);
    expect(assetSubAndGroup(undefined)).toEqual(["Current Assets", "Other Current Assets"]);
  });

  it("always gives a group, so nothing sits directly under a sub-category", () => {
    for (const name of ["Something Odd", "", "Widget Reserve"]) {
      const [, group] = assetSubAndGroup(name);
      expect(group).toBeTruthy();
    }
  });
});

describe("where a liability sits", () => {
  it("believes the statement's own section over the name", () => {
    // Keyword inference cannot tell a current loan from a long-term one — a
    // "Bank Loan" is either — and guessing puts debt in the wrong half of the
    // balance sheet, moving working capital and every ratio built on it.
    expect(liabilitySubAndGroup("Bank Loan", "Long-Term Liabilities")).toEqual([
      "Long-Term Liabilities",
      "Long-Term Loans",
    ]);
    expect(liabilitySubAndGroup("Bank Loan", "Current Liabilities")).toEqual([
      "Current Liabilities",
      "Other Current Liabilities",
    ]);
  });

  it("defaults a loan to current when nothing says otherwise", () => {
    // The conservative direction. Treating a term loan as current overstates
    // short-term obligations; the reverse understates them, and a buyer
    // reading understated obligations is the failure that matters.
    expect(liabilitySubAndGroup("PPP Loan")).toEqual([
      "Current Liabilities",
      "Other Current Liabilities",
    ]);
    expect(liabilitySubAndGroup("EIDL Loan")).toEqual([
      "Current Liabilities",
      "Other Current Liabilities",
    ]);
  });

  it("routes to long-term only on an explicit signal", () => {
    expect(liabilitySubAndGroup("Long-Term Note Payable")[0]).toBe("Long-Term Liabilities");
    expect(liabilitySubAndGroup("SBA Loan")[0]).toBe("Long-Term Liabilities");
  });

  it("puts a credit card in its own group whatever the section says", () => {
    expect(liabilitySubAndGroup("Amex Credit Card", "Long-Term Liabilities")).toEqual([
      "Current Liabilities",
      "Credit Cards",
    ]);
  });
});

describe("the standardised levels for an account", () => {
  it("gives an expense its whole chain, ending in its group", () => {
    const { levels, depth } = classifyStandardised({
      accountName: "Office Rent",
      accountType: "expense",
    });
    expect(depth).toBe(8);
    expect(levels.slice(0, 8)).toEqual([
      "Income Statement",
      "Net Income",
      "Pretax Income",
      "Operating Income",
      "Gross Profit",
      "Total Expenses",
      "Expenses",
      "Occupancy",
    ]);
  });

  it("gives an asset a sub-category and a group", () => {
    const { levels, depth } = classifyStandardised({
      accountName: "Business Checking",
      accountType: "asset",
    });
    expect(depth).toBe(4);
    expect(levels.slice(0, 4)).toEqual([
      "Balance Sheet",
      "Total Assets",
      "Current Assets",
      "Bank Accounts",
    ]);
  });

  it("gives equity the prefix and nothing more", () => {
    const { depth } = classifyStandardised({ accountName: "Retained Earnings", accountType: "equity" });
    expect(depth).toBe(2);
  });

  it("does NOT append the account's own name", () => {
    // One place decides where the account itself sits, and it is
    // `buildLevelsFromPath`. Appending here too would put it in twice.
    const { levels } = classifyStandardised({ accountName: "Office Rent", accountType: "expense" });
    expect(levels).not.toContain("Office Rent");
  });

  it("places an account of an unknown type nowhere rather than guessing", () => {
    // A guessed type puts real money under the wrong statement, which no
    // report can detect. Empty levels are visible; a wrong one is not.
    const { levels, depth } = classifyStandardised({
      accountName: "Mystery",
      accountType: "suspense",
    });
    expect(depth).toBe(0);
    expect(levels.every((l) => l === null)).toBe(true);
  });

  it("handles a null type and a null name", () => {
    expect(classifyStandardised({ accountName: null, accountType: null }).depth).toBe(0);
  });

  it("returns a fixed-width array whatever the depth", () => {
    // The stored row has fifteen columns; a shorter array leaves the tail
    // undefined rather than null, which the driver writes as a missing column.
    for (const type of ["expense", "asset", "equity", "nonsense"]) {
      expect(classifyStandardised({ accountName: "X", accountType: type }).levels).toHaveLength(
        MAX_LEVELS,
      );
    }
  });
});

describe("assembling the whole path", () => {
  const standard = classifyStandardised({ accountName: "Office Rent", accountType: "expense" });

  it("puts the account last, after the deeper levels", () => {
    const { levels, hierarchyPath } = buildLevelsFromPath(
      standard.levels,
      standard.depth,
      ["Premises"],
      "Office Rent",
    );
    expect(levels[8]).toBe("Premises");
    expect(levels[9]).toBe("Office Rent");
    expect(hierarchyPath.endsWith("Premises > Office Rent")).toBe(true);
  });

  it("drops a deeper level that echoes the one above it", () => {
    // A refiner asked for deeper levels commonly echoes the label directly
    // above. The result is a node that is its own child, which renders as an
    // expandable row that never ends.
    const { levels } = buildLevelsFromPath(standard.levels, standard.depth, ["Occupancy"], "Rent");
    expect(levels[8]).toBe("Rent");
  });

  it("drops a deeper level that repeats the account name", () => {
    // The other common echo: the refiner ends its list with the account, which
    // would otherwise appear twice in a row.
    const { levels } = buildLevelsFromPath(standard.levels, standard.depth, ["Office Rent"], "Office Rent");
    expect(levels[8]).toBe("Office Rent");
    expect(levels[9]).toBeNull();
  });

  it("compares case-insensitively when deduping", () => {
    const { levels } = buildLevelsFromPath(standard.levels, standard.depth, ["OCCUPANCY"], "Rent");
    expect(levels[8]).toBe("Rent");
  });

  it("keeps the account in the last slot when the path runs long", () => {
    // Truncating from the end would drop the account itself, and every report
    // groups by that slot — the figures would stop appearing under any line.
    const deep = Array.from({ length: 20 }, (_, i) => `Level ${i}`);
    const { levels } = buildLevelsFromPath(standard.levels, standard.depth, deep, "Office Rent");
    expect(levels).toHaveLength(MAX_LEVELS);
    expect(levels[MAX_LEVELS - 1]).toBe("Office Rent");
    expect(levels.filter((l) => l === "Office Rent")).toHaveLength(1);
  });

  it("truncates without an account when there is none to keep", () => {
    const deep = Array.from({ length: 20 }, (_, i) => `Level ${i}`);
    const { levels } = buildLevelsFromPath([], 0, deep, "");
    expect(levels[MAX_LEVELS - 1]).toBe("Level 14");
  });

  it("ignores blank and null labels rather than leaving holes", () => {
    // A null in the middle of a path is a level with no name, which renders as
    // an unnamed row that cannot be expanded or collapsed.
    const { hierarchyPath } = buildLevelsFromPath(
      ["Balance Sheet", null, "Total Assets"],
      3,
      ["  ", null],
      "Cash",
    );
    expect(hierarchyPath).toBe("Balance Sheet > Total Assets > Cash");
  });

  it("makes a path of just the account when there is nothing above it", () => {
    const { levels, hierarchyPath } = buildLevelsFromPath([], 0, [], "Orphan");
    expect(levels[0]).toBe("Orphan");
    expect(hierarchyPath).toBe("Orphan");
  });

  it("makes nothing out of nothing", () => {
    const { levels, hierarchyPath } = buildLevelsFromPath([], 0, null, null);
    expect(hierarchyPath).toBe("");
    expect(levels.every((l) => l === null)).toBe(true);
  });
});

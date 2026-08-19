import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/engagement.json" with { type: "json" };
import { assignGroup, deriveGroup, groupBalanceSheet, GROUP_ORDER } from "./balance-sheet-hierarchy.js";
import type { Account } from "./types.js";

const accounts = fixture.accounts as Account[];

interface Row { name: string; section: string; group: string | null; amount: number }
const sheets = fixture.balanceSheets as Array<{ anchor: string; rows: Row[] }>;

/** Every account the statements group, with the grouping they state. */
const stated = new Map<string, { section: string; group: string | null }>();
for (const sheet of sheets) {
  for (const row of sheet.rows) stated.set(row.name, { section: row.section, group: row.group });
}

describe("the statement's own sub-heading wins", () => {
  it("returns what the document said, without re-deriving it", () => {
    const account = {
      name: "Something Unguessable",
      accountType: "asset" as const,
      group: "Fixed Assets",
    };
    expect(deriveGroup(account)).toBe("Fixed Assets");
  });
});

describe("derivation reproduces the workbook's groupings", () => {
  /**
   * The real test of the rules: strip the sub-heading the statement supplied,
   * derive one from the account alone, and compare against what the workbook
   * actually printed.
   */
  const confident: string[] = [];
  const uncertain: string[] = [];
  for (const [name, { section, group }] of stated) {
    if (!group) continue; // equity rows carry no sub-heading on this statement
    const assigned = assignGroup({
      name,
      accountType: section as Account["accountType"],
      group: null,
    })!;
    if (assigned.group === group) continue;
    (assigned.certain ? confident : uncertain).push(
      `${name}: derived "${assigned.group}", statement says "${group}"`,
    );
  }

  it("never contradicts the statement on an assignment it claims to be sure of", () => {
    expect(confident).toEqual([]);
  });

  it("covers a meaningful number of accounts, so the above is not vacuous", () => {
    const grouped = [...stated.values()].filter((v) => v.group).length;
    expect(grouped).toBeGreaterThan(30);
  });

  it("marks debt's term as uncertain, because a name cannot settle it", () => {
    /**
     * This engagement files six "Loan Payable" accounts as current and four as
     * long-term. Nothing in the names distinguishes them — only the statement
     * does. Any rule claiming certainty here would mis-file a real balance
     * sheet, so the module declines to.
     */
    const loans = [...stated].filter(
      ([name, v]) => v.section === "liability" && /loan payable/i.test(name),
    );
    const terms = new Set(loans.map(([, v]) => v.group));
    expect(terms.size, "the same naming appears under both terms").toBeGreaterThan(1);

    for (const [name] of loans) {
      const assigned = assignGroup({ name, accountType: "liability", group: null })!;
      expect(assigned.certain, `${name} must not claim certainty`).toBe(false);
    }
  });

  it("uses the statement's answer whenever there is one", () => {
    for (const [name, { section, group }] of stated) {
      if (!group) continue;
      const assigned = assignGroup({
        name,
        accountType: section as Account["accountType"],
        group,
      })!;
      expect(assigned.group, name).toBe(group);
      expect(assigned.fromStatement, name).toBe(true);
    }
  });
});

describe("specific classifications", () => {
  const asset = (name: string) => deriveGroup({ name, accountType: "asset", group: null });
  const liability = (name: string) => deriveGroup({ name, accountType: "liability", group: null });

  it("separates bank accounts from other current assets", () => {
    expect(asset("Community Bank Operating")).toBe("Bank Accounts");
    expect(asset("Reserve Money Market")).toBe("Bank Accounts");
    expect(asset("Facility Savings")).toBe("Bank Accounts");
    expect(asset("Inventory")).toBe("Other Current Assets");
  });

  it("files accumulated depreciation as a fixed asset, not a bank account", () => {
    // "Accumulated Depreciation- M&E" contains no bank word, but the ordering
    // of the rules is what keeps contra-asset accounts out of the wrong bucket.
    expect(asset("Accumulated Depreciation- M&E")).toBe("Fixed Assets");
    expect(asset("Accumulated Depreciation- Vehicle")).toBe("Fixed Assets");
  });

  it("recognises accounts receivable", () => {
    expect(asset("Accounts Receivable")).toBe("Accounts Receivable");
    expect(asset("Trade Receivables")).toBe("Accounts Receivable");
  });

  it("separates credit cards from other debt", () => {
    expect(liability("Corporate Credit Card")).toBe("Credit Cards");
    expect(liability("Credit Card Payable - Warehouse Club")).toBe("Credit Cards");
    expect(liability("Accrued Meals Tax")).toBe("Other Current Liabilities");
  });

  it("only calls debt long-term when the name says so", () => {
    expect(liability("Long-term Note Payable")).toBe("Long-term Liabilities");
    expect(liability("Mortgage Payable")).toBe("Long-term Liabilities");
    // No term stated: presented as current, and flagged uncertain.
    const bare = assignGroup({ name: "Loan Payable - Community Bank", accountType: "liability", group: null })!;
    expect(bare.group).toBe("Other Current Liabilities");
    expect(bare.certain).toBe(false);
  });

  it("does not mistake an asset named 'loan' for a liability", () => {
    // "Loans to Affiliate" is money owed TO the company.
    expect(asset("Loans to Affiliate")).toBe("Other Current Assets");
  });

  it("returns nothing for a profit-and-loss account", () => {
    expect(deriveGroup({ name: "Sales", accountType: "income", group: null })).toBeNull();
  });
});

describe("presentation", () => {
  const sections = groupBalanceSheet(
    accounts.map((a) => ({
      id: a.id,
      name: a.name,
      accountType: a.accountType,
      group: stated.get(a.name)?.group ?? null,
    })),
  );

  it("returns assets, liabilities and equity in that order", () => {
    expect(sections.map((s) => s.section)).toEqual(["asset", "liability", "equity"]);
  });

  it("orders sub-headings the way a balance sheet presents them", () => {
    for (const section of sections) {
      const positions = section.groups.map((g) => GROUP_ORDER.indexOf(g.group));
      expect([...positions].sort((a, b) => a - b), section.section).toEqual(positions);
    }
  });

  it("places every balance-sheet account in exactly one group", () => {
    const placed = sections.flatMap((s) => s.groups.flatMap((g) => g.accountIds));
    const expected = accounts.filter(
      (a) => a.statementType === "balance_sheet" && a.accountType,
    );
    expect(new Set(placed).size).toBe(placed.length); // no account placed twice
    expect(placed.length).toBe(expected.length);
  });

  it("gives assets real depth — several groups, not one bucket", () => {
    const assets = sections.find((s) => s.section === "asset")!;
    expect(assets.groups.length).toBeGreaterThanOrEqual(3);
  });
});

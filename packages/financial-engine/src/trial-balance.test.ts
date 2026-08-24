import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/engagement.json" with { type: "json" };
import type { BalanceSheetAnchor } from "./balance-sheet.js";
import { balanceDelta, buildTrialBalance } from "./trial-balance.js";
import type { Account, GlEntry } from "./types.js";

const accounts = fixture.accounts as Account[];
const entries = fixture.glEntries as GlEntry[];
const years = fixture.fiscalYears;
const idByName = new Map(accounts.map((a) => [a.name, a.id]));

interface FixtureSheet {
  anchor: string;
  rows: Array<{ name: string; section: string; group: string | null; amount: number }>;
}
const sheets = fixture.balanceSheets as FixtureSheet[];

function anchor(which: "starting" | "ending"): BalanceSheetAnchor {
  const sheet = sheets.find((s) => s.anchor === which)!;
  return {
    kind: which,
    fiscalYear: which === "starting" ? 2021 : 2025,
    month: 12,
    rows: sheet.rows.map((row) => ({
      accountId: idByName.get(row.name) ?? row.name,
      accountName: row.name,
      section: row.section,
      group: row.group,
      amount: row.amount,
    })),
  };
}

const result = buildTrialBalance({
  accounts,
  entries,
  anchors: [anchor("starting"), anchor("ending")],
  fiscalYears: years,
});

const rowFor = (period: string, name: string) =>
  result.entries.find((e) => e.period === period)!.rows.find((r) => r.accountName === name);

describe("openings are real, not zero", () => {
  it("carries a balance-sheet account's prior closing into its opening", () => {
    for (const period of ["2023", "2024", "2025"]) {
      const rows = result.entries
        .find((e) => e.period === period)!
        .rows.filter((r) => r.statementType === "balance_sheet");
      expect(rows.length, `${period} must report balance-sheet accounts`).toBeGreaterThan(0);
      expect(
        rows.some((r) => r.openingBalance !== 0),
        `${period}: balance-sheet openings must not all be zero`,
      ).toBe(true);
    }
  });

  it("opens profit-and-loss accounts at zero every fiscal year", () => {
    for (const entry of result.entries) {
      const nonZero = entry.rows.filter(
        (r) => r.statementType === "profit_loss" && r.openingBalance !== 0,
      );
      expect(nonZero.map((r) => r.accountName), entry.period).toEqual([]);
    }
  });

  it("satisfies closing = opening + movement for every row", () => {
    for (const entry of result.entries) {
      for (const row of entry.rows) {
        expect(
          row.closingBalance,
          `${entry.period} ${row.accountName}`,
        ).toBeCloseTo(row.openingBalance + row.movement, 2);
      }
    }
  });

  it("chains each year's closing into the next year's opening", () => {
    const depreciationId = idByName.get("Accumulated Depreciation- M&E");
    expect(depreciationId, "fixture must carry this account").toBeDefined();

    for (const [earlier, later] of [["2022", "2023"], ["2023", "2024"], ["2024", "2025"]]) {
      const before = rowFor(earlier!, "Accumulated Depreciation- M&E");
      const after = rowFor(later!, "Accumulated Depreciation- M&E");
      if (!before || !after) continue;
      expect(after.openingBalance, `${earlier} → ${later}`).toBeCloseTo(
        before.closingBalance,
        2,
      );
    }
  });
});

describe("the trial balance balances", () => {
  it("has equal debits and credits in every period", () => {
    const broken = result.entries
      .filter((e) => !e.balances)
      .map((e) => `${e.period}: out by ${e.outOfBalance}`);
    expect(broken).toEqual([]);
    expect(result.balances).toBe(true);
  });
});

describe("balance deltas for QE-0001 basis adjustments", () => {
  /**
   * QE-0001 requires basis adjustments computed as "the exact
   * beginning-to-ending balance delta from the Trial Balance — never an
   * AI-estimated value". That is only possible once openings are real.
   */
  it("returns an exact delta, equal to the period's movement", () => {
    const inventoryId = idByName.get("Inventory");
    expect(inventoryId, "fixture must carry Inventory").toBeDefined();

    const delta = balanceDelta(result, inventoryId!, "2024");
    const row = rowFor("2024", "Inventory");
    expect(delta).not.toBeNull();
    expect(delta).toBeCloseTo(row!.movement, 2);
    expect(delta).toBeCloseTo(row!.closingBalance - row!.openingBalance, 2);
  });

  it("is null for an account with no activity in the period", () => {
    expect(balanceDelta(result, "no-such-account", "2024")).toBeNull();
  });
});

describe("agreement with the balance sheet", () => {
  it("reports the same closing balance the roll-forward does", () => {
    // Both read the same roll-forward, so they cannot drift apart. Inventory at
    // Dec 2025 per the ending statement is 19,265.
    const row = rowFor("2025", "Inventory");
    expect(row!.closingBalance).toBeCloseTo(19265, 2);
  });
});

describe("cost of sales sits on the debit side", () => {
  // `DEBIT_NATURED` listed only asset and expense. The omission was invisible
  // for as long as the loader folded cogs into expense before the engine saw
  // it; the moment the classification was preserved, every cost-of-sales
  // account would have been posted to the credit column and thrown the trial
  // balance out by twice its movement.
  const cogsAccounts: Account[] = [
    { id: "sales", name: "Sales", statementType: "profit_loss", accountType: "income" },
    { id: "materials", name: "Materials", statementType: "profit_loss", accountType: "cogs" },
    { id: "cash", name: "Cash", statementType: "balance_sheet", accountType: "asset" },
  ];
  const rows: GlEntry[] = [
    { accountId: "sales", fiscalYear: 2024, month: 1, amount: 1000 },
    { accountId: "materials", fiscalYear: 2024, month: 1, amount: 400 },
    // The cash side, so the fixture is an actual double entry and the balance
    // assertion below means something.
    { accountId: "cash", fiscalYear: 2024, month: 1, amount: 600 },
  ];
  // The roll-forward underneath refuses to run without a stated position, so
  // the smallest legitimate one stands in.
  const opening: BalanceSheetAnchor = {
    kind: "starting",
    fiscalYear: 2023,
    month: 12,
    rows: [
      { accountId: "cash", accountName: "Cash", section: "asset", group: "Bank Accounts", amount: 0 },
    ],
  };

  const rowFor = (accounts: Account[], id: string) => {
    const built = buildTrialBalance({ accounts, entries: rows, anchors: [opening], fiscalYears: [2024] });
    return built.entries[0]!.rows.find((r) => r.accountId === id)!;
  };

  it("debits a cost-of-sales account and credits revenue", () => {
    expect(rowFor(cogsAccounts, "materials").debits).toBeCloseTo(400, 2);
    expect(rowFor(cogsAccounts, "materials").credits).toBeCloseTo(0, 2);
    expect(rowFor(cogsAccounts, "sales").credits).toBeCloseTo(1000, 2);
    expect(rowFor(cogsAccounts, "sales").debits).toBeCloseTo(0, 2);
  });

  it("puts it on the same side an expense account would take", () => {
    const asExpense = cogsAccounts.map((a) =>
      a.id === "materials" ? { ...a, accountType: "expense" as const } : a,
    );
    expect(rowFor(cogsAccounts, "materials").debits).toBeCloseTo(
      rowFor(asExpense, "materials").debits,
      2,
    );
    expect(rowFor(cogsAccounts, "materials").movement).toBeCloseTo(
      rowFor(asExpense, "materials").movement,
      2,
    );
  });

  it("still balances with a cost-of-sales account in the ledger", () => {
    // The whole point of the column: credit the 400 instead of debiting it and
    // the trial balance is out by 800 on a 1,000 ledger.
    const built = buildTrialBalance({
      accounts: cogsAccounts,
      entries: rows,
      anchors: [opening],
      fiscalYears: [2024],
    });
    expect(built.entries[0]!.outOfBalance).toBeCloseTo(0, 2);
    expect(built.entries[0]!.balances).toBe(true);
  });
});

describe("which periods a trial balance covers", () => {
  it("derives the years from the ledger when none are named", () => {
    // The screen that opens on "everything" names none. Deriving them is what
    // stops it answering an empty trial balance for a company with a ledger.
    const derived = buildTrialBalance({
      accounts,
      entries,
      anchors: [anchor("starting"), anchor("ending")],
    });
    expect(derived.entries.map((e) => e.period)).toEqual(
      result.entries.map((e) => e.period),
    );
  });

  it("derives them in order, whatever order the ledger is in", () => {
    // Periods out of order put 2023 after 2025 on the page, and every opening
    // balance is then the wrong period's closing.
    const shuffled = [...entries].reverse();
    const derived = buildTrialBalance({
      accounts,
      entries: shuffled,
      anchors: [anchor("starting"), anchor("ending")],
    });
    const periods = derived.entries.map((e) => e.period);
    expect(periods).toEqual([...periods].sort());
  });

  it("takes an empty year list as naming none at all", () => {
    // `fiscalYears: []` is what a cleared filter sends. Read as a selection it
    // would answer nothing; read as "unset" it answers everything, which is
    // what the cleared filter means.
    const cleared = buildTrialBalance({
      accounts,
      entries,
      anchors: [anchor("starting"), anchor("ending")],
      fiscalYears: [],
    });
    expect(cleared.entries.length).toBe(result.entries.length);
  });
});

describe("a trial balance month by month", () => {
  it("carries each month's closing into the next month's opening", () => {
    /**
     * The same rule the annual view has, applied within a year. The prior
     * period is the PREVIOUS MONTH rather than the previous December — reading
     * the year's opening into every month would show twelve months all opening
     * where January did, and the ledger movement on top would then double-count.
     */
    const monthly = buildTrialBalance({
      accounts,
      entries,
      anchors: [anchor("starting"), anchor("ending")],
      fiscalYears: [2024],
      aggregation: "monthly",
    });

    expect(monthly.entries.length).toBeGreaterThan(1);

    const bsAccount = accounts.find((a) => a.statementType === "balance_sheet")!;
    for (let i = 1; i < monthly.entries.length; i += 1) {
      const previous = monthly.entries[i - 1]!.rows.find((r) => r.accountId === bsAccount.id);
      const current = monthly.entries[i]!.rows.find((r) => r.accountId === bsAccount.id);
      if (!previous || !current) continue;
      expect(current.openingBalance).toBeCloseTo(previous.closingBalance, 2);
    }
  });

  it("opens the first month on the engagement's own opening balance", () => {
    // There is no previous month to carry from, and zero would report the
    // company as starting the year with nothing.
    const monthly = buildTrialBalance({
      accounts,
      entries,
      anchors: [anchor("starting"), anchor("ending")],
      fiscalYears: [2023],
      aggregation: "monthly",
    });
    const first = monthly.entries[0]!;
    expect(first.rows.some((r) => r.openingBalance !== 0)).toBe(true);
  });
});

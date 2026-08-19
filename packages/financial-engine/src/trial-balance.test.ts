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

import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/engagement.json" with { type: "json" };
import {
  MissingAnchorError,
  NET_INCOME,
  RETAINED_EARNINGS,
  rollForwardBalanceSheet,
  type BalanceSheetAnchor,
} from "./balance-sheet.js";
import { periodKey } from "./periods.js";
import type { Account, GlEntry } from "./types.js";

const accounts = fixture.accounts as Account[];
const entries = fixture.glEntries as GlEntry[];
const years = fixture.fiscalYears;

interface FixtureSheet {
  anchor: string;
  asOf: string;
  rows: Array<{ name: string; section: string; group: string | null; amount: number }>;
}
const sheets = fixture.balanceSheets as FixtureSheet[];

const idByName = new Map(accounts.map((a) => [a.name, a.id]));

/** Build an anchor from a fixture statement, keyed by account id. */
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

/** Statement totals straight off the workbook, for cross-checking. */
function statedTotals(which: "starting" | "ending") {
  const sheet = sheets.find((s) => s.anchor === which)!;
  const by = (section: string) =>
    sheet.rows.filter((r) => r.section === section).reduce((a, r) => a + r.amount, 0);
  return { assets: by("asset"), liabilities: by("liability"), equity: by("equity") };
}

describe("the workbook's own anchors", () => {
  it("both balance as stated", () => {
    for (const which of ["starting", "ending"] as const) {
      const t = statedTotals(which);
      expect(t.assets, which).toBeCloseTo(t.liabilities + t.equity, 2);
    }
    expect(statedTotals("starting").assets).toBeCloseTo(1362752.12, 2);
    expect(statedTotals("ending").assets).toBeCloseTo(771373.56, 2);
  });

  it("carries retained earnings and net income as separate lines", () => {
    const start = sheets.find((s) => s.anchor === "starting")!;
    expect(start.rows.find((r) => r.name === RETAINED_EARNINGS)!.amount).toBeCloseTo(-347512.36, 2);
    expect(start.rows.find((r) => r.name === NET_INCOME)!.amount).toBeCloseTo(223131.66, 2);
  });
});

describe("roll forward from the starting balance sheet", () => {
  const result = rollForwardBalanceSheet({
    accounts,
    entries,
    anchors: [anchor("starting"), anchor("ending")],
    fiscalYears: years,
  });

  it("balances in every period", () => {
    const broken = result.checks.filter((c) => !c.balances);
    expect(
      broken.map((c) => `${c.period}: out by ${c.outOfBalance}`),
      "every period must satisfy A = L + E",
    ).toEqual([]);
    expect(result.balances).toBe(true);
  });

  it("produces a balance for every month of every fiscal year", () => {
    expect(result.periods).toHaveLength(48); // 4 years x 12 months
    expect(result.periods[0]!.fiscalYear).toBe(2022);
    expect(result.periods.at(-1)!.fiscalYear).toBe(2025);
  });

  it("closes net income into retained earnings at each year end", () => {
    // Dec 2025 retained earnings, per the workbook's ending sheet.
    expect(result.retainedEarnings[periodKey(2025, 12)]).toBeCloseTo(112021.03, 2);
  });

  it("reports current-year net income separately, reset each year", () => {
    expect(result.netIncome[periodKey(2022, 12)]).toBeCloseTo(115896.38, 2);
    expect(result.netIncome[periodKey(2023, 12)]).toBeCloseTo(104079.12, 2);
    expect(result.netIncome[periodKey(2024, 12)]).toBeCloseTo(47568.23, 2);
    // The ending statement's own Net Income line.
    expect(result.netIncome[periodKey(2025, 12)]).toBeCloseTo(169495.9, 2);
  });

  it("ties to the ending balance sheet it was not rolled from", () => {
    expect(result.tieOut).not.toBeNull();
    expect(result.tieOut!.period).toBe(periodKey(2025, 12));
    expect(
      result.tieOut!.differences,
      "rolled balances must equal the stated ending sheet",
    ).toEqual({});
    expect(result.tieOut!.ties).toBe(true);
  });

  it("reaches the stated ending totals", () => {
    const last = result.checks.at(-1)!;
    const stated = statedTotals("ending");
    expect(last.assets).toBeCloseTo(stated.assets, 2);
    expect(last.liabilities + last.equity).toBeCloseTo(stated.liabilities + stated.equity, 2);
  });
});

describe("roll backward from the ending balance sheet (UAT #6)", () => {
  /**
   * Josh: "I uploaded the 2022 GL, but it is not populating the Dec 2021
   * balance sheet. I did not upload the Dec 2021 balance sheet, but it should
   * be able to populate that based on the GL data."
   */
  // Only the ending sheet is given as the anchor; the starting sheet is
  // supplied purely as the thing to check the derived opening against.
  const result = rollForwardBalanceSheet({
    accounts,
    entries,
    anchors: [anchor("ending"), anchor("starting")],
    fiscalYears: years,
  });

  it("balances in every period without rolling from a starting sheet", () => {
    expect(result.checks.filter((c) => !c.balances).map((c) => c.period)).toEqual([]);
  });

  it("still states the ending sheet it was anchored on", () => {
    const bankId = idByName.get("Community Bank Operating")!;
    const stated = anchor("ending").rows
      .filter((r) => r.accountId === bankId)
      .reduce((a, r) => a + r.amount, 0);
    const line = result.lines.find((l) => l.accountId === bankId)!;
    expect(line.balances[periodKey(2025, 12)]).toBeCloseTo(stated, 2);
  });

  it("reproduces the Dec-2021 opening it was never given", () => {
    // The whole of UAT #6: derive the prior-year balance sheet from the GL.
    expect(result.tieOut).not.toBeNull();
    expect(result.tieOut!.period).toBe(periodKey(2021, 12));
    expect(
      result.tieOut!.differences,
      "the derived opening must equal the starting statement",
    ).toEqual({});
    expect(result.tieOut!.ties).toBe(true);
  });
});

describe("guards", () => {
  it("refuses to roll with no anchor at all", () => {
    expect(() =>
      rollForwardBalanceSheet({ accounts, entries, anchors: [], fiscalYears: years }),
    ).toThrow(MissingAnchorError);
  });
});

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

describe("hierarchy on the rolled sheet (UAT #7)", () => {
  const result = rollForwardBalanceSheet({
    accounts,
    entries,
    anchors: [anchor("starting"), anchor("ending")],
    fiscalYears: years,
  });

  it("gives every line a sub-heading", () => {
    const ungrouped = result.lines.filter((l) => !l.group).map((l) => l.accountName);
    expect(ungrouped).toEqual([]);
  });

  it("produces the depth the statement has, not a single bucket", () => {
    const assetGroups = new Set(
      result.lines.filter((l) => l.section === "asset").map((l) => l.group),
    );
    expect(assetGroups.size).toBeGreaterThanOrEqual(3);
    expect(assetGroups).toContain("Bank Accounts");
    expect(assetGroups).toContain("Fixed Assets");

    const liabilityGroups = new Set(
      result.lines.filter((l) => l.section === "liability").map((l) => l.group),
    );
    expect(liabilityGroups).toContain("Credit Cards");
  });

  it("marks a grouping taken from the statement as certain", () => {
    const bank = result.lines.find((l) => l.accountName === "Community Bank Operating")!;
    expect(bank.group).toBe("Bank Accounts");
    expect(bank.groupCertain).toBe(true);
  });
});

describe("guards", () => {
  it("refuses to roll with no anchor at all", () => {
    expect(() =>
      rollForwardBalanceSheet({ accounts, entries, anchors: [], fiscalYears: years }),
    ).toThrow(MissingAnchorError);
  });
});

describe("an anchor dated outside the rolled range", () => {
  /**
   * The rolled range is only the months the ledger posts in. A closing balance
   * sheet is routinely dated after the last posting — the year end, when the
   * last entry was in February — and the tie-out has to know that means "the
   * position has not moved since", not "this is where the roll began".
   *
   * It did not. `keys.indexOf(key) === -1` made EVERY anchor outside the range
   * an opening anchor, so a year-end sheet was compared against the position
   * the roll started from and reported a difference for every account that had
   * moved, each one exactly that account's activity.
   */
  const accounts: Account[] = [
    { id: "cash", name: "Cash", statementType: "balance_sheet", accountType: "asset", group: "Bank Accounts" },
    { id: "loan", name: "Loan", statementType: "balance_sheet", accountType: "liability", group: "Long-term Liabilities" },
    { id: "capital", name: "Capital", statementType: "balance_sheet", accountType: "equity", group: "Equity" },
    { id: "sales", name: "Sales", statementType: "profit_loss", accountType: "income" },
  ];
  const rows: GlEntry[] = [
    { accountId: "sales", fiscalYear: 2024, month: 1, amount: 500 },
    { accountId: "cash", fiscalYear: 2024, month: 1, amount: 500 },
  ];
  const line = (id: string, name: string, section: string, amount: number) => ({
    accountId: id, accountName: name, section, group: null, amount,
  });
  const opening: BalanceSheetAnchor = {
    kind: "starting", fiscalYear: 2023, month: 12,
    rows: [
      line("cash", "Cash", "asset", 1000),
      line("loan", "Loan", "liability", 400),
      line("capital", "Capital", "equity", 600),
    ],
  };

  const roll = (closing: BalanceSheetAnchor) =>
    rollForwardBalanceSheet({
      accounts, entries: rows, anchors: [opening, closing], fiscalYears: [2024],
    });

  it("ties out against a year-end sheet, though the ledger stops in January", () => {
    const yearEnd: BalanceSheetAnchor = {
      kind: "ending", fiscalYear: 2024, month: 12,
      rows: [
        line("cash", "Cash", "asset", 1500),
        line("loan", "Loan", "liability", 400),
        line("capital", "Capital", "equity", 600),
      ],
    };
    // Cash rolls to 1,500 in January and stays there. Compared against the
    // opening it would report a 500 difference on an account that agrees.
    expect(roll(yearEnd).tieOut!.differences["cash"]).toBeUndefined();
  });

  it("still reports a year-end sheet that genuinely disagrees", () => {
    const wrong: BalanceSheetAnchor = {
      kind: "ending", fiscalYear: 2024, month: 12,
      rows: [
        line("cash", "Cash", "asset", 1800),
        line("loan", "Loan", "liability", 400),
        line("capital", "Capital", "equity", 600),
      ],
    };
    // Carrying the position forward must not turn the check off.
    expect(roll(wrong).tieOut!.differences["cash"]).toBeCloseTo(-300, 2);
    expect(roll(wrong).tieOut!.ties).toBe(false);
  });

  it("still reads a sheet dated before the range as the opening position", () => {
    // The behaviour that was right all along, and must survive the fix.
    const backward = rollForwardBalanceSheet({
      accounts,
      entries: rows,
      anchors: [
        opening,
        {
          kind: "ending", fiscalYear: 2024, month: 1,
          rows: [
            line("cash", "Cash", "asset", 1500),
            line("loan", "Loan", "liability", 400),
            line("capital", "Capital", "equity", 600),
          ],
        },
      ],
      fiscalYears: [2024],
    });
    expect(backward.tieOut!.differences["cash"]).toBeUndefined();
  });
});

describe("which years a balance sheet rolls through", () => {
  const roll = (over: Record<string, unknown> = {}) =>
    rollForwardBalanceSheet({
      accounts,
      entries,
      anchors: [anchor("starting"), anchor("ending")],
      ...over,
    });

  it("derives them from the ledger when none are named", () => {
    // The roll is what the trial balance and the cash flow both read their
    // openings from, so an empty roll is three statements empty at once.
    const derived = roll();
    const named = roll({ fiscalYears: years });
    expect(derived.periods.length).toBe(named.periods.length);
  });

  it("sorts them, whatever order the ledger arrives in", () => {
    // The roll carries each period's closing into the next opening. Out of
    // order, every opening is the wrong period's closing and the sheet still
    // balances — which is what makes it dangerous.
    const shuffled = roll({ entries: [...entries].reverse() });
    const keys = shuffled.periods.map((p) => `${p.fiscalYear}-${String(p.month).padStart(2, "0")}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("takes an empty year list as naming none", () => {
    expect(roll({ fiscalYears: [] }).periods.length).toBe(roll().periods.length);
  });
});

describe("an account the statement barely describes", () => {
  it("keeps a statement row that names no sub-heading", () => {
    /**
     * The statement is the source for which sub-heading an account presents
     * under, and a row that names none still has a balance. Dropping it loses
     * that balance and the sheet stops balancing by exactly its amount — the
     * kind of break that looks like an arithmetic fault and is really a
     * missing row.
     */
    const rolled = rollForwardBalanceSheet({
      accounts: [],
      entries: [],
      anchors: [
        {
          kind: "starting",
          fiscalYear: 2023,
          month: 12,
          rows: [
            { accountId: "unheaded", accountName: "Suspense", section: "asset", group: null, amount: 1_000 },
            { accountId: "eq", accountName: "Owner Capital", section: "equity", group: "Equity", amount: 1_000 },
          ],
        },
      ],
      fiscalYears: [2024],
    });

    const line = rolled.lines.find((l) => l.accountId === "unheaded");
    expect(line).toBeDefined();
    // A heading is DERIVED for it rather than left blank, and marked
    // uncertain — a line with no heading has nowhere to render, and one
    // presented under a derived heading without the flag looks as settled as
    // the ones the statement named.
    expect(line!.group).toBe("Other Current Assets");
    expect(line!.groupCertain).toBe(false);
  });

  it("files an account carrying no type at all under assets", () => {
    // Every line has to sit in one of the three sections — there is no fourth
    // place to put it, and a line with no section renders nowhere while its
    // balance still counts towards the check that the sheet balances.
    const rolled = rollForwardBalanceSheet({
      accounts: [
        {
          id: "untyped",
          name: "Sundry",
          statementType: "balance_sheet",
          accountType: null,
        },
      ],
      entries: [{ accountId: "untyped", fiscalYear: 2024, month: 1, amount: 50 }],
      anchors: [
        {
          kind: "starting",
          fiscalYear: 2023,
          month: 12,
          rows: [
            { accountId: "untyped", accountName: "Sundry", section: "asset", group: null, amount: 0 },
          ],
        },
      ],
      fiscalYears: [2024],
    });

    expect(rolled.lines.find((l) => l.accountId === "untyped")?.section).toBe("asset");
  });
});

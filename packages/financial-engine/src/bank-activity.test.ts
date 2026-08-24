import { describe, expect, it } from "vitest";
import {
  accumulate,
  buildLadder,
  emptyActivity,
  monthOf,
  monthsInRange,
  type BankAccountRef,
  type BankMovement,
  type MonthActivity,
} from "./bank-activity.js";

const ACCOUNT: BankAccountRef = {
  id: "35",
  name: "Wells Fargo Business Checking",
  accountNumber: "0067",
  currentBalance: 9_999,
};

const movement = (over: Partial<BankMovement> = {}): BankMovement => ({
  accountId: "35",
  month: "2026-01",
  deposits: 0,
  withdrawals: 0,
  intercompany: false,
  ...over,
});

const activityMap = (entries: Record<string, Partial<MonthActivity>>) =>
  new Map(Object.entries(entries).map(([month, a]) => [month, { ...emptyActivity(), ...a }]));

describe("the months a range covers", () => {
  it("counts them inclusively, across a year boundary", () => {
    expect(monthsInRange("2025-11-01", "2026-02-28")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  it("covers a single month", () => {
    expect(monthsInRange("2026-01-01", "2026-01-31")).toEqual(["2026-01"]);
  });

  it("answers nothing for a range it cannot read", () => {
    expect(monthsInRange("", "2026-01-31")).toEqual([]);
    expect(monthsInRange("last tuesday", "2026-01-31")).toEqual([]);
  });
});

describe("which month a transaction falls in", () => {
  it("reads the date QuickBooks writes", () => {
    expect(monthOf("2026-03-04")).toBe("2026-03");
  });

  it("does not go through a Date, so the server's zone cannot move it", () => {
    // `new Date("2026-03-01")` is UTC midnight and `new Date("03/01/2026")` is
    // LOCAL midnight. Round-tripping through a Date puts the first of the
    // month in the previous one, west of Greenwich.
    expect(monthOf("2026-03-01")).toBe("2026-03");
    expect(monthOf("2026-01-01")).toBe("2026-01");
  });

  it("reports a date it cannot read as absent", () => {
    expect(monthOf("03/04/2026")).toBeNull();
    expect(monthOf("")).toBeNull();
    expect(monthOf(null)).toBeNull();
  });
});

describe("gathering movements", () => {
  it("adds up a month's deposits and withdrawals per account", () => {
    const gathered = accumulate([
      movement({ deposits: 100 }),
      movement({ deposits: 50 }),
      movement({ withdrawals: 30 }),
      movement({ accountId: "36", deposits: 7 }),
    ]);

    expect(gathered.get("35")!.get("2026-01")).toEqual({
      deposits: 150,
      withdrawals: 30,
      intercompanyDeposits: 0,
      intercompanyWithdraws: 0,
    });
    expect(gathered.get("36")!.get("2026-01")!.deposits).toBe(7);
  });

  it("counts an intercompany move in both the total and the intercompany figure", () => {
    // It IS a deposit into this account. The intercompany figure says how much
    // of the month's total was the company moving its own money, which is what
    // stops it being read as trading income.
    const gathered = accumulate([movement({ deposits: 500, intercompany: true })]);
    expect(gathered.get("35")!.get("2026-01")).toEqual({
      deposits: 500,
      withdrawals: 0,
      intercompanyDeposits: 500,
      intercompanyWithdraws: 0,
    });
  });

  it("keeps the months apart", () => {
    const gathered = accumulate([
      movement({ month: "2026-01", deposits: 10 }),
      movement({ month: "2026-02", deposits: 20 }),
    ]);
    expect(gathered.get("35")!.get("2026-01")!.deposits).toBe(10);
    expect(gathered.get("35")!.get("2026-02")!.deposits).toBe(20);
  });

  it("drops a movement naming no account or no month", () => {
    expect(accumulate([movement({ accountId: "" }), movement({ month: "" })]).size).toBe(0);
  });
});

describe("the ladder", () => {
  const months = ["2026-01", "2026-02", "2026-03"];

  it("anchors the opening balance to the books rather than to today", () => {
    // Back-calculated from the first month's stated closing balance: a company
    // whose account has moved since is otherwise offset by that much in every
    // row.
    const ladder = buildLadder(
      ACCOUNT,
      months,
      activityMap({ "2026-01": { deposits: 500, withdrawals: 200 } }),
      new Map([["2026-01", 1_300]]),
    );

    expect(ladder.openingBalanceSource).toBe("balance_sheet");
    expect(ladder.monthlyData[0]!.startingBalance).toBe(1_000);
    expect(ladder.monthlyData[0]!.endingBalance).toBe(1_300);
    expect(ladder.monthlyData[0]!.variance).toBe(0);
  });

  it("says so when it had to fall back to today's balance", () => {
    // Legacy did this silently. The account's balance AS OF TODAY is a
    // different point in time from the first month's opening, so the whole
    // ladder is offset by however much has happened since.
    const ladder = buildLadder(ACCOUNT, months, undefined, undefined);
    expect(ladder.openingBalanceSource).toBe("current_balance");
    expect(ladder.monthlyData[0]!.startingBalance).toBe(9_999);
  });

  it("carries each month's close into the next month's open", () => {
    const ladder = buildLadder(
      ACCOUNT,
      months,
      activityMap({
        "2026-01": { deposits: 500, withdrawals: 200 },
        "2026-02": { deposits: 100, withdrawals: 400 },
      }),
      new Map([["2026-01", 1_300]]),
    );

    expect(ladder.monthlyData.map((r) => [r.startingBalance, r.endingBalance])).toEqual([
      [1_000, 1_300],
      [1_300, 1_000],
      [1_000, 1_000],
    ]);
  });

  it("reports a month with no activity rather than leaving it out", () => {
    // A month missing from the grid looks like a month that has not loaded.
    const ladder = buildLadder(ACCOUNT, months, activityMap({}), new Map([["2026-01", 0]]));
    expect(ladder.monthlyData).toHaveLength(3);
    expect(ladder.monthlyData[2]).toMatchObject({ deposits: 0, withdrawals: 0 });
  });

  it("reports the gap against the balance sheet, and its absence", () => {
    const ladder = buildLadder(
      ACCOUNT,
      months,
      activityMap({ "2026-01": { deposits: 500 } }),
      new Map([
        ["2026-01", 1_300],
        ["2026-02", 1_500],
      ]),
    );

    expect(ladder.monthlyData[1]!.perBalanceSheet).toBe(1_500);
    expect(ladder.monthlyData[1]!.variance).toBe(-200);
    // No stated balance for March, so there is nothing to compare against.
    expect(ladder.monthlyData[2]!.perBalanceSheet).toBeNull();
    expect(ladder.monthlyData[2]!.variance).toBeNull();
  });

  it("catches a month whose transactions do not explain its movement", () => {
    // This is the check that can actually fail. The balance sheet says the
    // account went from 1,300 to 1,500 — up 200 — while the transactions
    // account for 50. The other 150 is missing, which is what a truncated
    // query looks like from the outside.
    const ladder = buildLadder(
      ACCOUNT,
      months,
      activityMap({ "2026-02": { deposits: 50 } }),
      new Map([
        ["2026-01", 1_300],
        ["2026-02", 1_500],
      ]),
    );
    expect(ladder.monthlyData[1]!.unexplainedMovement).toBe(150);
  });

  it("reports nothing unexplained when the transactions account for the movement", () => {
    const ladder = buildLadder(
      ACCOUNT,
      months,
      activityMap({ "2026-02": { deposits: 300, withdrawals: 100 } }),
      new Map([
        ["2026-01", 1_300],
        ["2026-02", 1_500],
      ]),
    );
    expect(ladder.monthlyData[1]!.unexplainedMovement).toBe(0);
  });

  it("cannot check the first month, and says so rather than reporting zero", () => {
    // The first month's opening was back-calculated FROM its own closing, so
    // checking one against the other returns zero by construction — which is
    // exactly the sort of check this field exists to replace.
    const ladder = buildLadder(
      ACCOUNT,
      months,
      activityMap({ "2026-01": { deposits: 500 } }),
      new Map([["2026-01", 1_300]]),
    );
    expect(ladder.monthlyData[0]!.unexplainedMovement).toBeNull();
  });

  it("cannot check a month whose neighbour has no stated balance", () => {
    const ladder = buildLadder(
      ACCOUNT,
      months,
      activityMap({}),
      new Map([["2026-03", 1_000]]),
    );
    expect(ladder.monthlyData[2]!.unexplainedMovement).toBeNull();
  });

  it("still emits the two checks the page reads, both zero", () => {
    // They are `ending - (starting + deposits - withdrawals)` and the previous
    // month's ending less this month's starting. Both are identities, so both
    // are zero however wrong the underlying data is. The page recomputes them
    // the same way; they are kept so it does not show blank columns.
    const ladder = buildLadder(
      ACCOUNT,
      months,
      activityMap({ "2026-01": { deposits: 500, withdrawals: 200 } }),
      new Map([["2026-01", 1_300]]),
    );
    expect(ladder.monthlyData.every((r) => r.footingCheck === 0 && r.priorMonthCheck === 0)).toBe(
      true,
    );
  });

  it("rounds to the cent, and never reports minus zero", () => {
    const ladder = buildLadder(
      { ...ACCOUNT, currentBalance: 0 },
      ["2026-01"],
      activityMap({ "2026-01": { deposits: 0.1, withdrawals: 0.3 } }),
      undefined,
    );
    expect(ladder.monthlyData[0]!.endingBalance).toBe(-0.2);
    expect(Object.is(ladder.monthlyData[0]!.deposits, -0)).toBe(false);
  });

  it("copes with an empty range", () => {
    const ladder = buildLadder(ACCOUNT, [], undefined, undefined);
    expect(ladder.monthlyData).toEqual([]);
    expect(ladder.openingBalanceSource).toBe("current_balance");
  });

  it("carries the account's own details through", () => {
    const ladder = buildLadder(ACCOUNT, ["2026-01"], undefined, undefined);
    expect(ladder).toMatchObject({
      accountId: "35",
      accountName: "Wells Fargo Business Checking",
      accountNumber: "0067",
      currentBalance: 9_999,
    });
  });
});

describe("the months a date range covers", () => {
  it("takes the months out of two ISO dates", () => {
    expect(monthsInRange("2024-01-01", "2024-03-31")).toEqual(["2024-01", "2024-02", "2024-03"]);
  });

  it("answers nothing for a range it cannot read", () => {
    // A ladder built over an unreadable range would have no columns, and every
    // balance would land nowhere — a grid that renders empty for an account
    // with a year of statements.
    for (const [start, end] of [
      ["", "2024-03-31"],
      ["2024-01-01", ""],
      ["not a date", "also not"],
      [null as unknown as string, null as unknown as string],
      ["2024", "2024-03"],
    ]) {
      expect(monthsInRange(start, end)).toEqual([]);
    }
  });
});

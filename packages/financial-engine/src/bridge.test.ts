import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/engagement.json" with { type: "json" };
import { AddbackValidationError } from "./addbacks.js";
import { buildBridge } from "./bridge.js";
import type { Account, Addback, GlEntry } from "./types.js";

const accounts = fixture.accounts as Account[];
const entries = fixture.glEntries as GlEntry[];
const years = fixture.fiscalYears;

const bridge = (over: Partial<Parameters<typeof buildBridge>[0]> = {}) =>
  buildBridge({ accounts, entries, selectedYears: years, ...over });

describe("reported EBITDA", () => {
  const result = bridge();
  const line = (key: string) => result.ebitLines.find((l) => l.key === key);

  it("equals net income plus the itemized EBIT lines for FY2024", () => {
    // 47,568.23 + 87,176.03 - 5,115.91 + 217,775.00 + 0 + 0
    expect(result.netIncome.amounts["2024"]).toBeCloseTo(47568.23, 2);
    expect(line("interest_expense")!.amounts["2024"]).toBeCloseTo(87176.03, 2);
    expect(line("interest_income")!.amounts["2024"]).toBeCloseTo(-5115.91, 2);
    expect(line("depreciation")!.amounts["2024"]).toBeCloseTo(217775, 2);
    expect(result.reportedEbitda["2024"]!).toBeCloseTo(347403.35, 2);
  });

  it("itemizes each EBIT add-back rather than pre-aggregating", () => {
    const keys = result.ebitLines.map((l) => l.key);
    expect(keys).toContain("interest_expense");
    expect(keys).toContain("interest_income");
    expect(keys).toContain("depreciation");
    // This engagement genuinely has no income tax expense and no amortization,
    // so those lines are absent rather than fabricated.
    expect(keys).not.toContain("income_tax");
    expect(keys).not.toContain("amortization");
  });

  /**
   * The regression this engine exists to prevent. The legacy browser bridge
   * matched the whole word "tax", sweeping three operating-expense accounts
   * into income tax expense.
   */
  it("excludes operating taxes from the income tax line", () => {
    expect(line("income_tax")).toBeUndefined();

    const spurious = ["meals-tax", "real-estate-taxes", "taxes-licenses"];
    for (const id of spurious) {
      const account = accounts.find((a) => a.id === id);
      expect(account, `${id} should exist in the fixture`).toBeDefined();
      expect(account!.ebitdaRole, `${id} must not be flagged as income tax`).toBeFalsy();
    }

    // Had they been added back they would have contributed $83,981.56 —
    // nearly doubling FY2024 reported EBITDA.
    expect(result.reportedEbitda["2024"]!).toBeCloseTo(347403.35, 2);
    expect(result.reportedEbitda["2024"]!).not.toBeCloseTo(347403.35 + 83981.56, 2);
  });

  it("reports every unflagged P&L account so nothing is silently skipped", () => {
    expect(result.unflaggedAccounts).toContain("Meals Tax");
    expect(result.unflaggedAccounts).toContain("Taxes & Licenses");
    expect(result.unflaggedAccounts).not.toContain("Depreciation");
  });

  it("computes margin against revenue", () => {
    expect(result.revenue["2024"]).toBeCloseTo(2511740.83, 2);
    expect(result.margin["2024"]).toBeCloseTo((347403.35 / 2511740.83) * 100, 2);
  });
});

describe("Adjusted EBITDA vs SDE", () => {
  const ownerComp: Addback = {
    id: "oc-1",
    kind: "manual_adjustment",
    dataSource: "company_financials",
    typeKey: "officer_compensation",
    name: "Owner compensation",
    granularity: "detail",
    values: { "2024": 250000 },
    explanation: "Owner salary per payroll register.",
  };

  it("differs only in the market-rate replacement salary", () => {
    const sde = bridge({ addbacks: [ownerComp], metric: "sde", marketRateReplacementSalary: 90000 });
    const adj = bridge({
      addbacks: [ownerComp],
      metric: "adjusted_ebitda",
      marketRateReplacementSalary: 90000,
    });

    expect(sde.ownerCompensation!.amounts["2024"]).toBeCloseTo(250000, 2);
    expect(adj.ownerCompensation!.amounts["2024"]).toBeCloseTo(160000, 2);
    expect(sde.adjusted["2024"]! - adj.adjusted["2024"]!).toBeCloseTo(90000, 2);

    // Everything above the owner-comp line is identical.
    expect(sde.reportedEbitda["2024"]!).toBeCloseTo(adj.reportedEbitda["2024"]!, 2);
    expect(sde.metricLabel).toBe("Seller's Discretionary Earnings");
    expect(adj.metricLabel).toBe("Adjusted EBITDA");
  });

  it("adds back full owner compensation when no replacement salary is set", () => {
    const adj = bridge({ addbacks: [ownerComp], metric: "adjusted_ebitda" });
    expect(adj.ownerCompensation!.amounts["2024"]).toBeCloseTo(250000, 2);
  });
});

describe("add-back sourcing kinds", () => {
  it("pulls a P&L account/vendor amount from the GL", () => {
    const result = bridge({
      selectedYears: [2024],
      addbacks: [
        {
          id: "ab-1",
          kind: "pnl_account_vendor",
          dataSource: "company_financials",
          typeKey: "personal_expense",
          name: "Meals & entertainment",
          linkedAccountId: "meals-entertainment",
          granularity: "detail",
        },
      ],
    });
    expect(result.addbackGroups[0]!.items[0]!.amounts["2024"]!).toBeCloseTo(1163.86, 2);
  });

  it("computes a recast as the delta from the normalized value", () => {
    const result = bridge({
      selectedYears: [2024],
      addbacks: [
        {
          id: "ab-2",
          kind: "recast",
          dataSource: "company_financials",
          typeKey: "related_party_rent",
          name: "Rent recast to market",
          linkedAccountId: "rent-lease",
          recastNormalizedValue: 180000,
          granularity: "detail",
        },
      ],
    });
    // Actual FY2024 rent 240,741.20 less normalized 180,000.
    expect(result.addbackGroups[0]!.items[0]!.amounts["2024"]!).toBeCloseTo(60741.2, 2);
  });

  it("refuses a manual adjustment with no written explanation", () => {
    expect(() =>
      bridge({
        addbacks: [
          {
            id: "ab-3",
            kind: "manual_adjustment",
            dataSource: "company_financials",
            typeKey: "other_addback",
            name: "Unexplained",
            granularity: "detail",
            values: { "2024": 5000 },
          },
        ],
      }),
    ).toThrow(AddbackValidationError);
  });

  it("spreads a smoothed add-back evenly across displayed periods", () => {
    const result = bridge({
      selectedYears: [2024],
      aggregation: "monthly",
      addbacks: [
        {
          id: "ab-4",
          kind: "manual_adjustment",
          dataSource: "company_financials",
          typeKey: "other_addback",
          name: "Smoothed",
          granularity: "smoothed",
          values: { "2024": 12000 },
          explanation: "Spread evenly.",
        },
      ],
    });
    const amounts = Object.values(result.addbackGroups[0]!.items[0]!.amounts);
    expect(amounts).toHaveLength(12);
    for (const amount of amounts) expect(amount).toBeCloseTo(1000, 2);
  });
});

describe("data source toggle", () => {
  const taxOnly: Addback = {
    id: "ab-tax",
    kind: "manual_adjustment",
    dataSource: "tax_return",
    typeKey: "other_addback",
    name: "Return-only adjustment",
    granularity: "detail",
    values: { "2024": 10000 },
    explanation: "From the return.",
  };

  it("never mixes sources in one view", () => {
    const financials = bridge({ selectedYears: [2024], addbacks: [taxOnly] });
    expect(financials.addbackGroups).toHaveLength(0);

    const fromReturn = bridge({
      selectedYears: [2024],
      addbacks: [taxOnly],
      dataSource: "tax_return",
    });
    expect(fromReturn.addbackGroups[0]!.items[0]!.amounts["2024"]!).toBeCloseTo(10000, 2);
  });

  it("moves the net income note with the toggle", () => {
    expect(bridge().netIncome.commentary).toBe("Sourced from Company Financials");
    expect(bridge({ dataSource: "tax_return" }).netIncome.commentary).toBe("Sourced from Tax Return");
  });
});

describe("period selection", () => {
  it("selects years discretely rather than as a range", () => {
    const result = bridge({ selectedYears: [2022, 2025] });
    expect(result.periods.map((p) => p.label)).toEqual(["FY2022", "FY2025"]);
  });

  it("expands to the months that carry data", () => {
    const result = bridge({ selectedYears: [2024], aggregation: "monthly" });
    expect(result.periods).toHaveLength(12);
    const total = Object.values(result.reportedEbitda).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(347403.35, 1);
  });
});

describe("add-backs a broker has grouped together", () => {
  /**
   * Grouping is presentational — several add-backs shown under one heading
   * with a subtotal — but the subtotal is what a reader checks, so it has to
   * be the sum of what is under it and nothing else.
   */
  const manual = (id: string, name: string, amount: number, over: Partial<Addback> = {}): Addback => ({
    id,
    kind: "manual_adjustment",
    dataSource: "company_financials",
    typeKey: "personal_expense",
    name,
    granularity: "detail",
    explanation: "Owner's personal spending.",
    values: { "2024": amount },
    ...over,
  });

  it("subtotals a group to the items inside it, under the label it was given", () => {
    const result = bridge({
      selectedYears: [2024],
      addbacks: [
        manual("ab-1", "Country club", 5_000, { groupId: "g-1", groupLabel: "Owner perks" }),
        manual("ab-2", "Season tickets", 3_000, { groupId: "g-1", groupLabel: "Owner perks" }),
      ],
    });

    const group = result.addbackGroups.find((g) => g.id === "g-1")!;
    expect(group.label).toBe("Owner perks");
    expect(group.items.map((i) => i.label).sort()).toEqual(["Country club", "Season tickets"]);
    expect(group.subtotals["2024"]).toBeCloseTo(8_000, 2);
  });

  it("keeps ungrouped add-backs out of any group, and gives them no label", () => {
    // The ungrouped bucket is not a group somebody made; labelling it would
    // put a heading on the page that nobody chose.
    const result = bridge({
      selectedYears: [2024],
      addbacks: [
        manual("ab-1", "Country club", 5_000, { groupId: "g-1", groupLabel: "Owner perks" }),
        manual("ab-2", "One-off legal fee", 2_000),
      ],
    });

    const ungrouped = result.addbackGroups.find((g) => g.id === null)!;
    expect(ungrouped.label).toBeNull();
    expect(ungrouped.items.map((i) => i.label)).toEqual(["One-off legal fee"]);
  });
});

describe("the market-rate salary, month by month", () => {
  const ownerComp: Addback = {
    id: "oc-1",
    kind: "manual_adjustment",
    dataSource: "company_financials",
    typeKey: "officer_compensation",
    name: "Owner compensation",
    granularity: "detail",
    values: { "2024": 250_000 },
    explanation: "Owner salary per payroll register.",
  };

  it("spreads the replacement salary across the months in view", () => {
    /**
     * SDE adds the owner's whole compensation back; Adjusted EBITDA subtracts
     * what a hired replacement would cost. Annually that is one figure.
     * Monthly it has to be divided, or every month carries the full year's
     * salary and the metric collapses.
     *
     * Divided by the months ACTUALLY in view rather than by twelve, so the two
     * aggregations of the same year agree — which is the assertion, because a
     * reader switching the toggle is entitled to the same answer.
     */
    const annual = bridge({
      selectedYears: [2024],
      addbacks: [ownerComp],
      metric: "adjusted_ebitda",
      marketRateReplacementSalary: 120_000,
    });
    const monthly = bridge({
      selectedYears: [2024],
      aggregation: "monthly",
      addbacks: [ownerComp],
      metric: "adjusted_ebitda",
      marketRateReplacementSalary: 120_000,
    });

    expect(annual.ownerCompensation!.amounts["2024"]).toBeCloseTo(130_000, 2);

    const monthlyOwnerComp = Object.values(monthly.ownerCompensation!.amounts).reduce(
      (a, b) => a + b,
      0,
    );
    expect(monthlyOwnerComp).toBeCloseTo(130_000, 1);
  });
});

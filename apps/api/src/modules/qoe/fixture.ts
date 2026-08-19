import { engagementFixture, type BalanceSheetAnchor } from "@datahub/financial-engine";
import type { EngagementData } from "./ports.js";

/** Fixture statements, resolved to account ids. */
function fixtureAnchors(): BalanceSheetAnchor[] {
  const idByName = new Map(engagementFixture.accounts.map((a) => [a.name, a.id]));
  return engagementFixture.balanceSheets.map((sheet) => ({
    kind: sheet.anchor,
    fiscalYear: sheet.anchor === "starting" ? 2021 : 2025,
    month: 12,
    rows: sheet.rows.map((row) => ({
      accountId: idByName.get(row.name) ?? row.name,
      accountName: row.name,
      section: row.section,
      group: row.group,
      amount: row.amount,
    })),
  }));
}

/**
 * The anonymized walkthrough engagement, shaped for the repository.
 *
 * Used by the demo seed so the UI renders the same figures the golden suite
 * asserts — FY2024 net income $47,568.23, Reported EBITDA $347,403.35.
 */
export function fixtureEngagement(companyId: string): EngagementData {
  return {
    companyId,
    companyName: engagementFixture.company.name,
    profitMetric: engagementFixture.company.profitMetric,
    marketRateReplacementSalary: engagementFixture.company.marketRateReplacementSalary,
    fiscalYears: engagementFixture.fiscalYears,
    accounts: engagementFixture.accounts,
    entries: engagementFixture.glEntries,
    anchors: fixtureAnchors(),
  };
}

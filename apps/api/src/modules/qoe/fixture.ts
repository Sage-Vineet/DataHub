import { engagementFixture } from "@datahub/financial-engine";
import type { EngagementData } from "./ports.js";

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
  };
}

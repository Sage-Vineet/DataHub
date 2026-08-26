import raw from "./__fixtures__/engagement.json" with { type: "json" };
import type { Account, GlEntry } from "./types.js";

/**
 * The anonymized walkthrough engagement.
 *
 * Derived from "Data walkthrough 05.05.2026.xlsx" by `scripts/build-fixture.py`,
 * which asserts every fiscal year's revenue, expenses and net income before
 * writing — so this data cannot drift from the workbook it is measured against.
 *
 * Exported because it is the demo seed as well as the test fixture: the numbers
 * a reviewer sees on screen are the numbers the golden suite asserts.
 */
export interface EngagementFixture {
  company: {
    id: string;
    name: string;
    profitMetric: "adjusted_ebitda" | "sde";
    marketRateReplacementSalary: number | null;
  };
  fiscalYears: number[];
  accounts: Account[];
  glEntries: GlEntry[];
  /** The two anchor statements, as parsed from the workbook. */
  balanceSheets: Array<{
    anchor: "starting" | "ending";
    asOf: string;
    rows: Array<{
      name: string;
      section: string;
      group: string | null;
      amount: number;
    }>;
  }>;
}

export const engagementFixture = raw as unknown as EngagementFixture;

import { amountAt } from "./amounts.js";
import { buildPeriods, buildVendorBreakdown } from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";
import { categoryOf } from "./profit-loss-view.js";

/**
 * Spend by vendor, then by account.
 *
 * The arithmetic is `buildVendorBreakdown`'s; this arranges it into the payload
 * the vendor view reads, and does one thing the engine deliberately will not:
 * it names the vendor-less bucket. The engine reports `vendorName: null`,
 * because a row with no vendor has no vendor — inventing a name for it inside
 * the calculator would make "No Vendor" indistinguishable from a supplier
 * actually called that. On the wire it becomes the label the page prints.
 */

export interface VendorAccountRow {
  accountName: string;
  accountNumber: string;
  accountType: string;
  category: string;
  subCategory: string;
  totalAmount: number;
  yearlyTotals: Record<number, number>;
}

export interface VendorRow {
  vendorName: string;
  totalAmount: number;
  yearlyTotals: Record<number, number>;
  accounts: VendorAccountRow[];
}

export interface VendorDetailPayload {
  source: string;
  reportType: "vendor_analysis";
  filters: VendorDetailFilters;
  years: number[];
  vendors: VendorRow[];
}

export interface VendorDetailFilters {
  fiscalYears?: number[];
}

/** What the page prints for a ledger row that named nobody. */
export const NO_VENDOR_LABEL = "No Vendor";

const toYearly = (amounts: Record<string, number>, years: number[]): Record<number, number> =>
  Object.fromEntries(years.map((y) => [y, amountAt(amounts, String(y))]));

export function buildVendorDetail(
  engagement: EngagementData,
  filters: VendorDetailFilters = {},
): VendorDetailPayload {
  const explicit = (filters.fiscalYears ?? [])
    .map(Number)
    .filter((y) => Number.isInteger(y) && y > 0)
    .sort((a, b) => a - b);
  const available = engagement.fiscalYears;
  const years = explicit.length > 0 ? explicit.filter((y) => available.includes(y)) : available;

  const breakdown = buildVendorBreakdown(
    engagement.accounts,
    engagement.entries,
    buildPeriods(engagement.entries, years, "annual"),
    "annual",
  );

  const byId = new Map(engagement.accounts.map((a) => [a.id, a]));

  return {
    source: "general_ledger_entries",
    reportType: "vendor_analysis",
    filters,
    years,
    vendors: breakdown.map((vendor) => ({
      vendorName: vendor.vendorName ?? NO_VENDOR_LABEL,
      totalAmount: vendor.total,
      yearlyTotals: toYearly(vendor.amounts, years),
      accounts: vendor.accounts.map((line) => {
        const account = byId.get(line.accountId);
        return {
          accountName: line.accountName,
          // Account numbers are not modelled on the engagement's accounts, and
          // an invented one would be worse than an absent one.
          accountNumber: "",
          accountType: line.accountType ?? "",
          // The bucket the P&L puts it in, from its type — the same source the
          // statement uses, so the two views cannot disagree about an account.
          category: account ? (categoryOf(account) ?? "") : "",
          subCategory: "",
          totalAmount: line.total,
          yearlyTotals: toYearly(line.amounts, years),
        };
      }),
    })),
  };
}

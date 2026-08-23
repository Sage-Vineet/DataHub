import type { EngagementData } from "../../shared/engagement.drizzle.js";

/**
 * What the report filters can actually offer.
 *
 * Legacy read the distinct values of fourteen columns off the staging table.
 * Eight of those columns exist in `general_ledger_entries` and the current
 * extractor populates none of them: across 3,723 posted rows, `category`,
 * `sub_category`, `department`, `class`, `location`, `transaction_type` and
 * `journal_type` are empty, and so is every `account_number` on the 71-row
 * chart of accounts.
 *
 * The keys are all still emitted, each with the values the ledger has and an
 * empty list where it has none. Dropping a key would break the filter panel,
 * which indexes into this object by name; inventing values would offer a filter
 * that matches nothing. An empty list is the true answer: that dimension has
 * nothing to filter on yet, and will the moment extraction fills it in.
 */

export interface FilterOptions {
  fiscalYear: number[];
  fiscalMonth: number[];
  accountName: string[];
  accountNumber: string[];
  accountType: string[];
  category: string[];
  subCategory: string[];
  department: string[];
  class: string[];
  location: string[];
  sourceFile: string[];
  transactionType: string[];
  journalType: string[];
  reportType: string[];
}

export interface FilterOptionsPayload {
  source: string;
  rowCount: number;
  options: FilterOptions;
}

/** The two statements a report can be about. Fixed, not derived. */
const REPORT_TYPES = ["profit_loss", "balance_sheet"];

export function buildFilterOptions(engagement: EngagementData): FilterOptionsPayload {
  const years = new Set<number>();
  const months = new Set<number>();
  const accountIds = new Set<string>();

  for (const entry of engagement.entries) {
    years.add(entry.fiscalYear);
    // `0` means the row carried no usable date, and is not a month anyone can
    // pick from a list.
    if (entry.month >= 1 && entry.month <= 12) months.add(entry.month);
    accountIds.add(entry.accountId);
  }

  // Only accounts the ledger actually posts to. Offering a filter that returns
  // nothing is worse than not offering it.
  const accounts = engagement.accounts.filter((a) => accountIds.has(a.id));
  const accountNames = [...new Set(accounts.map((a) => a.name))].sort((a, b) =>
    a.localeCompare(b),
  );
  const accountTypes = [
    ...new Set(accounts.map((a) => a.accountType).filter((t): t is NonNullable<typeof t> => t !== null)),
  ].sort();

  return {
    source: "general_ledger_entries",
    rowCount: engagement.entries.length,
    options: {
      fiscalYear: [...years].sort((a, b) => a - b),
      fiscalMonth: [...months].sort((a, b) => a - b),
      accountName: accountNames,
      accountNumber: [],
      accountType: accountTypes,
      category: [],
      subCategory: [],
      department: [],
      class: [],
      location: [],
      sourceFile: [],
      transactionType: [],
      journalType: [],
      reportType: [...REPORT_TYPES],
    },
  };
}

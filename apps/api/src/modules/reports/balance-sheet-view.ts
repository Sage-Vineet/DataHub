import {
  periodKey,
  rollForwardBalanceSheet,
  type BalanceSheetResult,
} from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";
import type { PlRow } from "./profit-loss-view.js";

/**
 * The Balance Sheet payload the Reports page reads.
 *
 * Same story as `profit-loss-view.ts`: the legacy builder read a staging table
 * that is empty, so this honours its payload shape while taking every figure
 * from `rollForwardBalanceSheet`. That matters more here than on the P&L,
 * because a balance sheet is the one statement that can be checked against
 * itself — assets must equal liabilities plus equity in every period, and the
 * roll-forward already computes that check rather than asserting it.
 *
 * A balance sheet is a POSITION, not a sum. Each year's column is the closing
 * position at that year's last rolled month, never the year's movements added
 * up. Legacy got this right; it is restated because it is the single easiest
 * thing to get wrong when assembling yearly columns from monthly ones.
 */

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** The sub-headings each section presents, in the order the statement prints them. */
const ASSET_GROUPS = [
  "Bank Accounts",
  "Accounts Receivable",
  "Other Current Assets",
  "Fixed Assets",
  "Other Assets",
] as const;
const LIABILITY_GROUPS = ["Credit Cards", "Other Current Liabilities", "Long-term Liabilities"] as const;

/** Which sub-headings roll up into "Current Assets" / "Current Liabilities". */
const CURRENT_ASSET_GROUPS = ["Bank Accounts", "Accounts Receivable", "Other Current Assets"];
const CURRENT_LIABILITY_GROUPS = ["Credit Cards", "Other Current Liabilities"];

export interface BsAccount {
  name: string;
  balancesByYear: Record<number, number>;
}

export interface BsCategory {
  label: string;
  totalByYear: Record<number, number>;
  accounts: BsAccount[];
}

export interface BsSection {
  totalByYear: Record<number, number>;
  categories: BsCategory[];
}

export interface BsAuditEntry {
  year: number;
  assets: number;
  liabilities: number;
  equity: number;
  /** assets − (liabilities + equity). */
  difference: number;
  isBalanced: boolean;
}

export interface BalanceSheetPayload {
  source: string;
  reportType: "balance_sheet";
  filters: BalanceSheetFilters;
  years: number[];
  displayYear: number | null;
  sections: { Assets: BsSection; Liabilities: BsSection; Equity: BsSection };
  hierarchicalRows: PlRow[];
  audit: BsAuditEntry[];
  yearCols?: Array<{ key: string; label: string }>;
}

export interface BalanceSheetFilters {
  fiscalYears?: number[];
}

export class NoBalanceSheetError extends Error {
  constructor() {
    super(
      "No balance sheet has been ingested, so no position can be derived. " +
        "A roll-forward needs a stated starting or ending balance sheet to roll from.",
    );
    this.name = "NoBalanceSheetError";
  }
}

const amountsFromByYear = (
  byYear: Record<number, number>,
  years: readonly number[],
): Record<string, number> =>
  Object.fromEntries(years.map((y) => [`y${y}`, round2(byYear[y] ?? 0)]));

/**
 * The closing period key for each year — the last month the roll-forward
 * actually produced, not December by assumption. A part-year at the end of the
 * engagement closes at whatever month the ledger stops.
 */
function closingKeys(balanceSheet: BalanceSheetResult, years: number[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const year of years) {
    const inYear = balanceSheet.periods.filter((p) => p.fiscalYear === year);
    const last = inYear[inYear.length - 1];
    if (last) out.set(year, periodKey(last.fiscalYear, last.month));
  }
  return out;
}

/** Group accounts into the three sections and their sub-headings. */
export function buildSections(
  balanceSheet: BalanceSheetResult,
  years: number[],
  keys: Map<number, string>,
): BalanceSheetPayload["sections"] {
  const make = (): BsSection => ({ totalByYear: {}, categories: [] });
  const sections = { Assets: make(), Liabilities: make(), Equity: make() };

  const categoryFor = (section: BsSection, label: string): BsCategory => {
    let category = section.categories.find((c) => c.label === label);
    if (!category) {
      category = { label, totalByYear: {}, accounts: [] };
      section.categories.push(category);
    }
    return category;
  };

  for (const line of balanceSheet.lines) {
    const sectionKey =
      line.section === "liability" ? "Liabilities" : line.section === "equity" ? "Equity" : "Assets";
    const section = sections[sectionKey];
    const label =
      sectionKey === "Equity" ? "Owner Equity" : (line.group ?? "Other Current Assets");
    const category = categoryFor(section, label);

    const balancesByYear: Record<number, number> = {};
    for (const year of years) {
      const key = keys.get(year);
      const balance = round2(key === undefined ? 0 : (line.balances[key] ?? 0));
      balancesByYear[year] = balance;
      category.totalByYear[year] = round2((category.totalByYear[year] ?? 0) + balance);
      section.totalByYear[year] = round2((section.totalByYear[year] ?? 0) + balance);
    }
    category.accounts.push({ name: line.accountName, balancesByYear });
  }

  // Retained earnings and current-year income are derived by the roll-forward
  // rather than rolled as lines. Omitting them does not merely lose two rows —
  // the sheet stops balancing by exactly their sum.
  const derived: Array<[string, Record<string, number>]> = [
    ["Retained Earnings", balanceSheet.retainedEarnings],
    ["Net Income", balanceSheet.netIncome],
  ];
  for (const [label, source] of derived) {
    const category = categoryFor(sections.Equity, label);
    const balancesByYear: Record<number, number> = {};
    for (const year of years) {
      const key = keys.get(year);
      const balance = round2(key === undefined ? 0 : (source[key] ?? 0));
      balancesByYear[year] = balance;
      category.totalByYear[year] = round2((category.totalByYear[year] ?? 0) + balance);
      sections.Equity.totalByYear[year] = round2((sections.Equity.totalByYear[year] ?? 0) + balance);
    }
    category.accounts.push({ name: label, balancesByYear });
  }

  // Print order is the statement's, not insertion order.
  const order = (section: BsSection, labels: readonly string[]) => {
    const rank = new Map(labels.map((l, i) => [l, i]));
    section.categories.sort(
      (a, b) => (rank.get(a.label) ?? labels.length) - (rank.get(b.label) ?? labels.length),
    );
    for (const category of section.categories) {
      category.accounts.sort((a, b) => a.name.localeCompare(b.name));
    }
  };
  order(sections.Assets, ASSET_GROUPS);
  order(sections.Liabilities, LIABILITY_GROUPS);
  order(sections.Equity, ["Owner Equity", "Retained Earnings", "Net Income"]);

  return sections;
}

/** The nested rows the statement table walks. */
export function buildBalanceSheetRows(
  sections: BalanceSheetPayload["sections"],
  years: number[],
  displayYear: number | null,
): PlRow[] {
  const byCategory = (sectionKey: keyof BalanceSheetPayload["sections"], label: string) =>
    sections[sectionKey].categories.find((c) => c.label === label) ?? null;

  const scalar = (byYear: Record<number, number>): number =>
    displayYear === null ? 0 : round2(byYear[displayYear] ?? 0);

  const sumByYear = (...maps: Array<Record<number, number>>): Record<number, number> =>
    Object.fromEntries(
      years.map((y) => [y, round2(maps.reduce((total, m) => total + (m[y] ?? 0), 0))]),
    );

  const node = (
    id: string,
    name: string,
    type: PlRow["type"],
    byYear: Record<number, number>,
    children?: PlRow[],
  ): PlRow => ({
    id,
    name,
    type,
    amount: scalar(byYear),
    amounts: amountsFromByYear(byYear, years),
    ...(children ? { children } : {}),
  });

  const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const categoryNode = (
    sectionKey: keyof BalanceSheetPayload["sections"],
    label: string,
    prefix: string,
  ): PlRow | null => {
    const category = byCategory(sectionKey, label);
    if (!category) return null;
    const accountRows = category.accounts.map((account, index) =>
      node(`${prefix}-acc-${index}`, account.name, "data", account.balancesByYear),
    );
    return node(`${prefix}-${slug(label)}`, label, "header", category.totalByYear, [
      ...accountRows,
      node(`${prefix}-total-${slug(label)}`, `Total for ${label}`, "total", category.totalByYear),
    ]);
  };

  const totalOf = (
    sectionKey: keyof BalanceSheetPayload["sections"],
    labels: readonly string[],
  ): Record<number, number> =>
    sumByYear(...labels.map((l) => byCategory(sectionKey, l)?.totalByYear ?? {}));

  const present = (rows: Array<PlRow | null>): PlRow[] => rows.filter((r): r is PlRow => r !== null);

  const currentAssets = totalOf("Assets", CURRENT_ASSET_GROUPS);
  const currentAssetsNode = node("current-assets", "Current Assets", "header", currentAssets, [
    ...present([
      categoryNode("Assets", "Bank Accounts", "assets-bank"),
      categoryNode("Assets", "Accounts Receivable", "assets-ar"),
      categoryNode("Assets", "Other Current Assets", "assets-oca"),
    ]),
    node("current-assets-total", "Total for Current Assets", "total", currentAssets),
  ]);

  const assetsNode = node("assets", "Assets", "header", sections.Assets.totalByYear, [
    currentAssetsNode,
    ...present([
      categoryNode("Assets", "Fixed Assets", "assets-fixed"),
      categoryNode("Assets", "Other Assets", "assets-other"),
    ]),
    node("assets-total", "Total for Assets", "total", sections.Assets.totalByYear),
  ]);

  const currentLiabilities = totalOf("Liabilities", CURRENT_LIABILITY_GROUPS);
  const currentLiabilitiesNode = node(
    "current-liabilities",
    "Current Liabilities",
    "header",
    currentLiabilities,
    [
      ...present([
        categoryNode("Liabilities", "Credit Cards", "liab-cc"),
        categoryNode("Liabilities", "Other Current Liabilities", "liab-ocl"),
      ]),
      node("current-liabilities-total", "Total for Current Liabilities", "total", currentLiabilities),
    ],
  );

  const liabilitiesNode = node(
    "liabilities",
    "Liabilities",
    "header",
    sections.Liabilities.totalByYear,
    [
      currentLiabilitiesNode,
      ...present([categoryNode("Liabilities", "Long-term Liabilities", "liab-ltl")]),
      node("liabilities-total", "Total for Liabilities", "total", sections.Liabilities.totalByYear),
    ],
  );

  const equityNode = node("equity", "Equity", "header", sections.Equity.totalByYear, [
    ...present([
      categoryNode("Equity", "Owner Equity", "eq-owner"),
      categoryNode("Equity", "Retained Earnings", "eq-retained"),
      categoryNode("Equity", "Net Income", "eq-net-income"),
    ]),
    node("equity-total", "Total for Equity", "total", sections.Equity.totalByYear),
  ]);

  const liabilitiesAndEquity = sumByYear(
    sections.Liabilities.totalByYear,
    sections.Equity.totalByYear,
  );

  return [
    assetsNode,
    node(
      "liabilities-and-equity",
      "Liabilities and Equity",
      "header",
      liabilitiesAndEquity,
      [
        liabilitiesNode,
        equityNode,
        node(
          "liabilities-and-equity-total",
          "Total for Liabilities and Equity",
          "total",
          liabilitiesAndEquity,
        ),
      ],
    ),
  ];
}

/** Does the sheet balance, per year? Reported rather than assumed. */
export function buildAudit(
  sections: BalanceSheetPayload["sections"],
  years: number[],
): BsAuditEntry[] {
  // A cent of rounding across a hundred accounts is not an unbalanced sheet.
  const EPSILON = 0.01;
  return years.map((year) => {
    const assets = round2(sections.Assets.totalByYear[year] ?? 0);
    const liabilities = round2(sections.Liabilities.totalByYear[year] ?? 0);
    const equity = round2(sections.Equity.totalByYear[year] ?? 0);
    const difference = round2(assets - (liabilities + equity));
    return {
      year,
      assets,
      liabilities,
      equity,
      difference,
      isBalanced: Math.abs(difference) <= EPSILON,
    };
  });
}

export function buildBalanceSheet(
  engagement: EngagementData,
  filters: BalanceSheetFilters = {},
): BalanceSheetPayload {
  if (engagement.anchors.length === 0) throw new NoBalanceSheetError();

  const explicit = (filters.fiscalYears ?? [])
    .map(Number)
    .filter((y) => Number.isInteger(y) && y > 0)
    .sort((a, b) => a - b);
  const available = engagement.fiscalYears;
  const inScope = explicit.length > 0 ? explicit.filter((y) => available.includes(y)) : available;

  // The roll-forward runs over every year the engagement has, always: a
  // position at the end of FY2024 is the sum of everything before it, so
  // rolling from FY2024 alone would start from nothing and report a sheet that
  // balances and is wrong.
  const balanceSheet = rollForwardBalanceSheet({
    accounts: engagement.accounts,
    entries: engagement.entries,
    anchors: engagement.anchors,
    fiscalYears: available,
  });

  const keys = closingKeys(balanceSheet, inScope);
  const years = inScope.filter((y) => keys.has(y));
  const sections = buildSections(balanceSheet, years, keys);
  const displayYear = years.length > 0 ? (years[years.length - 1] ?? null) : null;

  return {
    source: "general_ledger_entries",
    reportType: "balance_sheet",
    filters,
    years,
    displayYear,
    sections,
    hierarchicalRows: buildBalanceSheetRows(sections, years, displayYear),
    audit: buildAudit(sections, years),
    ...(explicit.length > 0
      ? { yearCols: years.map((y) => ({ key: `y${y}`, label: String(y) })) }
      : {}),
  };
}

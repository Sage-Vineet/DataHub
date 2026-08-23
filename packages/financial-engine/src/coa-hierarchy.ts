/**
 * Placing an account into the standardised statement hierarchy.
 *
 * Levels 1 to N are fixed anchors, identical for every company, so two
 * companies' charts can be compared line for line. Deeper levels are
 * company-specific and come from elsewhere; this file never calls anything, so
 * it is reproducible and is the answer when nothing else is available.
 *
 *   P&L (income / cogs / expense)
 *     1 Income Statement · 2 Net Income · 3 Pretax Income · 4 Operating Income
 *     5 Gross Profit · 6 Total Revenue | Total Expenses · 7 Income | Expenses
 *     8 expense group (rule-derived) · 9+ company-specific · last: the account
 *
 *   Balance sheet (asset / liability / equity)
 *     1 Balance Sheet · 2 Total Assets | Total Liabilities | Total Equity
 *     3 sub-category · 4 group · 5+ company-specific · last: the account
 *
 * WHY THE ACCOUNT IS ALWAYS LAST
 * ------------------------------
 * The deepest slot is what every report groups and totals by. An account
 * pushed out of it by a path that ran long stops being a line on the statement
 * and starts being a heading, and its figures vanish from the total that
 * should contain them.
 */

import { MAX_LEVELS } from "./coa-recommendation.js";

/**
 * How deep a path may go — the width of the stored row.
 *
 * Re-exported rather than redeclared: `coa-recommendation.ts` already defines
 * it, and two constants that must agree are one that eventually will not.
 */
export { MAX_LEVELS };

/** The six account types this hierarchy knows. */
export type CoaAccountType =
  | "asset"
  | "liability"
  | "equity"
  | "income"
  | "cogs"
  | "expense";

/** Which statement an account belongs to. */
export const STATEMENT_BY_TYPE: Readonly<Record<CoaAccountType, "balance_sheet" | "profit_loss">> =
  Object.freeze({
    asset: "balance_sheet",
    liability: "balance_sheet",
    equity: "balance_sheet",
    income: "profit_loss",
    cogs: "profit_loss",
    expense: "profit_loss",
  });

/**
 * The fixed anchor levels per type.
 *
 * The same for EVERY company, which is the whole point: a standardised chart is
 * one where "Total Expenses" means the same place in every client's statements.
 */
export const STANDARD_PREFIX: Readonly<Record<CoaAccountType, readonly string[]>> = Object.freeze({
  income: [
    "Income Statement",
    "Net Income",
    "Pretax Income",
    "Operating Income",
    "Gross Profit",
    "Total Revenue",
    "Income",
  ],
  expense: [
    "Income Statement",
    "Net Income",
    "Pretax Income",
    "Operating Income",
    "Gross Profit",
    "Total Expenses",
    "Expenses",
  ],
  cogs: [
    "Income Statement",
    "Net Income",
    "Pretax Income",
    "Operating Income",
    "Gross Profit",
    "Total Expenses",
    "Expenses",
  ],
  asset: ["Balance Sheet", "Total Assets"],
  liability: ["Balance Sheet", "Total Liabilities"],
  equity: ["Balance Sheet", "Total Equity"],
});

/**
 * The expense group that sits under "Expenses".
 *
 * First match wins and the order is load-bearing: specific before the
 * catch-all. "Officer's life insurance" is payroll before it is insurance,
 * because the payroll rule tests `\bofficer\b` first — which is the intended
 * reading for an owner-benefit add-back.
 */
const EXPENSE_GROUP_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /payroll|salar|wages|401\s*k|employee benefit|\bbenefits?\b|worker'?s? ?comp|\bofficer\b|\blabor\b/,
    "Payroll and Labor",
  ],
  [/food|beverage|job suppl|meals tax|cost of (goods|sales)|merchandise|raw material/, "Cost of Sales"],
  [
    /\brent\b|lease|real estate tax|propert(?:y|ies) tax|utilit|water|sewer|alarm|electric|natural gas/,
    "Occupancy",
  ],
  [/car (?:and|&) truck|\btruck\b|\btravel\b|mileage|\bauto\b|\bvehicle\b|\bfuel\b|gasoline/, "Vehicle and Travel"],
  [/repair|maintenance|rubbish|\btrash\b|removal|janitor|cleaning/, "Repairs and Maintenance"],
  [/advertis|marketing|promotion|charitable|contribution|entertainment/, "Sales and Marketing"],
  [/insurance/, "Insurance"],
  [
    /depreciation|amortization|interest (?:paid|expense)|\binterest\b|education|bad debt|below.line|non.?cash/,
    "Non-Cash and Below-Line",
  ],
];

export function expenseGroupFor(name: string | null | undefined): string {
  const text = String(name ?? "").toLowerCase();
  for (const [pattern, label] of EXPENSE_GROUP_RULES) {
    if (pattern.test(text)) return label;
  }
  return "General and Administrative";
}

/** An asset's sub-category and group — levels 3 and 4. */
export function assetSubAndGroup(name: string | null | undefined): [string, string] {
  const text = String(name ?? "").toLowerCase();

  let sub: string;
  if (
    /equipment|furniture|fixture|machinery|building|\bland\b|leasehold|accumulated depreciation|construction in progress|\bvehicle\b/.test(
      text,
    )
  ) {
    sub = "Fixed Assets";
  } else if (
    /amortization|goodwill|intangible|other long.?term|\bdeposit\b|financing cost|note receivable/.test(text)
  ) {
    sub = "Other Assets";
  } else {
    sub = "Current Assets";
  }

  let group: string;
  if (/money market|checking|savings|\bbank\b|petty cash|\bcash\b/.test(text)) group = "Bank Accounts";
  else if (/receivable|\ba\/r\b/.test(text)) group = "Accounts Receivable";
  else if (/inventory|stock on hand/.test(text)) group = "Inventory";
  else if (/prepaid/.test(text)) group = "Prepaid Expenses";
  else if (/loans? to|due from|loan receivable/.test(text)) group = "Other Current Assets";
  else if (/accumulated depreciation/.test(text)) group = "Accumulated Depreciation";
  else if (/machinery|equipment/.test(text)) group = "Machinery & Equipment";
  else if (/furniture|fixture/.test(text)) group = "Furniture & Fixtures";
  else if (/leasehold/.test(text)) group = "Leasehold Improvements";
  else if (/\bvehicle\b|\btruck\b/.test(text)) group = "Vehicles";
  else if (/\bland\b/.test(text)) group = "Land Improvements";
  else if (/construction in progress/.test(text)) group = "Construction in Progress";
  else if (/amortization|financing cost|goodwill|intangible/.test(text)) group = "Other Long-Term Assets";
  else if (sub === "Current Assets") group = "Other Current Assets";
  else if (sub === "Fixed Assets") group = "Other Fixed Assets";
  else group = "Other Long-Term Assets";

  return [sub, group];
}

/**
 * A liability's sub-category and group.
 *
 * The statement's OWN section wins over the name, when it is known. Keyword
 * inference cannot reliably tell a current loan from a long-term one — a
 * "Bank Loan" is either — and guessing puts debt in the wrong half of the
 * balance sheet, which moves working capital and every ratio built on it.
 *
 * Without a section, a loan defaults to CURRENT unless something says
 * otherwise. That is the conservative direction: an SBA, PPP or EIDL loan
 * treated as current overstates short-term obligations, where the reverse
 * understates them, and a buyer reading understated obligations is the failure
 * that matters.
 */
export function liabilitySubAndGroup(
  name: string | null | undefined,
  bsSection?: string | null,
): [string, string] {
  const text = String(name ?? "").toLowerCase();
  if (/credit card/.test(text)) return ["Current Liabilities", "Credit Cards"];

  if (bsSection) {
    const section = String(bsSection).toLowerCase();
    if (/long.?term/.test(section)) return ["Long-Term Liabilities", "Long-Term Loans"];
    if (/current/.test(section)) return ["Current Liabilities", "Other Current Liabilities"];
  }

  if (/\blong.?term\b/.test(text)) return ["Long-Term Liabilities", "Long-Term Loans"];
  if (/\bsba\b/.test(text)) return ["Long-Term Liabilities", "Long-Term Loans"];
  return ["Current Liabilities", "Other Current Liabilities"];
}

export interface StandardisedAccount {
  accountName: string | null;
  accountNumber?: string | null;
  accountType: string | null;
  statementType?: string | null;
  /** The section the uploaded balance sheet filed it under, when known. */
  bsSection?: string | null;
}

export interface StandardisedLevels {
  /** A fixed-width array; slots past `depth` are null. */
  levels: Array<string | null>;
  depth: number;
}

const isCoaAccountType = (value: string): value is CoaAccountType =>
  value in STATEMENT_BY_TYPE;

/**
 * The standardised rollup labels for an account.
 *
 * The account's own name is deliberately NOT appended — `buildLevelsFromPath`
 * adds it last, after any company-specific levels, so there is one place that
 * decides where the account itself sits.
 */
export function classifyStandardised(account: StandardisedAccount): StandardisedLevels {
  const type = String(account.accountType ?? "");
  const labels: Array<string | null> = isCoaAccountType(type) ? [...STANDARD_PREFIX[type]] : [];

  if (type === "expense" || type === "cogs") {
    labels.push(expenseGroupFor(account.accountName));
  } else if (type === "asset") {
    const [sub, group] = assetSubAndGroup(account.accountName);
    labels.push(sub, group);
  } else if (type === "liability") {
    const [sub, group] = liabilitySubAndGroup(account.accountName, account.bsSection);
    labels.push(sub, group);
  }
  // Income and equity get the prefix only; the account follows directly.

  return toLevels(dedupeConsecutive(labels));
}

/**
 * Drop a label that merely repeats the one above it.
 *
 * Case-insensitively, because "Total Assets" under "TOTAL ASSETS" is one level
 * spelled twice, and a tree with a node as its own child renders as an
 * expandable row that never ends.
 */
function dedupeConsecutive(labels: ReadonlyArray<string | null>): string[] {
  const out: string[] = [];
  for (const raw of labels) {
    const label = String(raw ?? "").trim();
    if (!label) continue;
    if (out.length > 0 && out[out.length - 1]!.toLowerCase() === label.toLowerCase()) continue;
    out.push(label);
  }
  return out;
}

function toLevels(path: readonly string[]): StandardisedLevels {
  const levels: Array<string | null> = new Array<string | null>(MAX_LEVELS).fill(null);
  for (let i = 0; i < path.length && i < MAX_LEVELS; i += 1) levels[i] = path[i]!;
  return { levels, depth: Math.min(path.length, MAX_LEVELS) };
}

export interface HierarchyPath {
  levels: Array<string | null>;
  /** The path as one readable string, for a heading or a log line. */
  hierarchyPath: string;
}

/**
 * Assemble the full path: standardised levels, then company-specific ones,
 * then the account itself.
 *
 * Consecutive duplicates are removed across the whole path, not just within
 * each part. A refiner asked for deeper levels commonly echoes the label
 * directly above it, or ends its list with the account name — both produce a
 * node that is its own child, and both are silent.
 *
 * When the path runs past `MAX_LEVELS` the intermediate levels are truncated
 * and the account KEEPS the last slot. Truncating from the end instead would
 * drop the account itself, and every report groups by that slot: the figures
 * would stop appearing under any line at all.
 */
export function buildLevelsFromPath(
  standardisedLevels: ReadonlyArray<string | null>,
  standardisedDepth: number,
  deeperLabels: ReadonlyArray<string | null> | null | undefined,
  baseAccount: string | null | undefined,
): HierarchyPath {
  const raw: Array<string | null> = [];
  for (let i = 0; i < standardisedDepth; i += 1) raw.push(standardisedLevels[i] ?? null);
  for (const label of deeperLabels ?? []) raw.push(label);

  const base = String(baseAccount ?? "").trim();
  if (base) raw.push(base);

  const deduped = dedupeConsecutive(raw);

  let path = deduped;
  if (path.length > MAX_LEVELS) {
    path = base ? [...deduped.slice(0, MAX_LEVELS - 1), base] : deduped.slice(0, MAX_LEVELS);
  }

  return { ...toLevels(path), hierarchyPath: path.join(" > ") };
}

import type { StatementNode } from "./statement-cash-flow.js";

/**
 * The headline figures a dashboard shows for a year.
 *
 * Read off an uploaded balance sheet and profit-and-loss by matching line
 * names, because that is all an extracted statement gives: a tree of labels
 * and figures.
 *
 * ALL NODES, NOT JUST THE LEAVES
 * ------------------------------
 * Unlike the cash flow, which sums detail, this wants the TOTALS — and a total
 * is a parent. So the whole tree is flattened rather than only its leaves.
 * That makes the matching order load-bearing in the other direction: "Total
 * Assets" must be preferred to "Assets", or a section header's own figure is
 * read as the total.
 */

/** What a dashboard puts on a card. */
export interface StatementKpis {
  totalRevenue: number;
  totalExpenses: number;
  netProfit: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  workingCapital: number;
  cashAndBankBalance: number;
  accountsReceivable: number;
  inventoryValue: number;
  accountsPayable: number;
  longTermDebt: number;
}

/** Every node in a statement tree, parents included. */
export function allNodes(nodes: readonly StatementNode[] | null | undefined): StatementNode[] {
  const out: StatementNode[] = [];
  const walk = (list: readonly StatementNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.children && node.children.length > 0) walk(node.children);
    }
  };
  walk(nodes ?? []);
  return out;
}

/** A label, as the matchers compare it. */
function normalise(name: unknown): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const amountOf = (node: StatementNode): number =>
  typeof node.amount === "number" && Number.isFinite(node.amount) ? node.amount : 0;

/**
 * The first line matching any of these names, in the order given.
 *
 * Order is the whole design: the list runs from most specific to least, so
 * "Total Assets" is found before a bare "Assets" section header. Reversed, a
 * section's own figure — often zero, often the first child's — is read as the
 * total for the section.
 *
 * Returns 0 rather than null when nothing matches, because every caller here
 * puts the figure on a card and a card cannot render an absence differently
 * from a zero. That is a real limitation and it is why `found` is reported
 * separately.
 */
export function findAmount(
  nodes: readonly StatementNode[],
  names: readonly string[],
): { amount: number; found: boolean } {
  const byName = new Map<string, StatementNode>();
  for (const node of nodes) {
    const key = normalise(node.name);
    // First wins, so an outer total is preferred to a repeat further down.
    if (key !== "" && !byName.has(key)) byName.set(key, node);
  }

  for (const name of names) {
    const node = byName.get(normalise(name));
    if (node) return { amount: amountOf(node), found: true };
  }
  return { amount: 0, found: false };
}

const REVENUE = [
  "total income",
  "total revenue",
  "total sales",
  "total ordinary income",
  "income",
  "revenue",
];
const EXPENSES = [
  "total expenses",
  "total expense",
  "total operating expenses",
  "expenses",
  "operating expenses",
];
const NET_PROFIT = ["net income", "net profit", "net loss", "net earnings", "net income loss"];
const ASSETS = ["total assets", "assets"];
const LIABILITIES = ["total liabilities", "liabilities"];
const EQUITY = [
  "total equity",
  "total stockholders equity",
  "total shareholders equity",
  "total owners equity",
  "equity",
  "stockholders equity",
  "shareholders equity",
  "owners equity",
];
const CURRENT_ASSETS = ["total current assets", "current assets"];
const CURRENT_LIABILITIES = ["total current liabilities", "current liabilities"];
const CASH = [
  "total bank accounts",
  "total cash and cash equivalents",
  "total cash and bank",
  "total cash",
  "bank accounts",
  "cash and cash equivalents",
];
const RECEIVABLE = [
  "total accounts receivable",
  "total accounts receivable a r",
  "accounts receivable a r",
  "accounts receivable",
];
const INVENTORY = ["total inventory", "inventory asset", "inventory"];
const PAYABLE = [
  "total accounts payable",
  "total accounts payable a p",
  "accounts payable a p",
  "accounts payable",
];
const LONG_TERM_DEBT = [
  "total long term liabilities",
  "long term liabilities",
  "notes payable",
  "long term debt",
];

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Read the headline figures off a balance sheet and a P&L.
 *
 * Two fixes over the version this replaces, both of the same shape — treating
 * a genuine ZERO as an absence:
 *
 * Net profit fell back to revenue-minus-expenses whenever the statement's own
 * figure was `0`. A company that broke even exactly showed a FABRICATED number
 * in place of its real one. The fallback now runs when the line is ABSENT,
 * which is what it was for.
 *
 * Working capital used `currentAssets && currentLiabilities ? a - b : …`. A
 * company with no current liabilities — which is a real and good position —
 * took the fallback path and had its working capital computed from a different
 * set of accounts. Again: absence, not zero.
 */
export function readStatementKpis(
  balanceSheetRows: readonly StatementNode[] | null | undefined,
  profitLossRows: readonly StatementNode[] | null | undefined,
): StatementKpis {
  const bs = allNodes(balanceSheetRows);
  const pl = allNodes(profitLossRows);

  const totalRevenue = findAmount(pl, REVENUE).amount;
  // Forced positive: statements disagree about the sign of a cost total, and a
  // dashboard card reading "-450,000 expenses" is read as a credit.
  const totalExpenses = Math.abs(findAmount(pl, EXPENSES).amount);

  const netProfitLine = findAmount(pl, NET_PROFIT);
  const netProfit = netProfitLine.found
    ? netProfitLine.amount
    : round2(totalRevenue - totalExpenses);

  const totalAssets = findAmount(bs, ASSETS).amount;
  const totalLiabilities = findAmount(bs, LIABILITIES).amount;
  const totalEquity = findAmount(bs, EQUITY).amount;

  const currentAssets = findAmount(bs, CURRENT_ASSETS);
  const currentLiabilities = findAmount(bs, CURRENT_LIABILITIES);
  const cashAndBankBalance = findAmount(bs, CASH).amount;
  const accountsReceivable = findAmount(bs, RECEIVABLE).amount;
  const inventoryValue = findAmount(bs, INVENTORY).amount;
  const accountsPayable = findAmount(bs, PAYABLE).amount;
  const longTermDebt = findAmount(bs, LONG_TERM_DEBT).amount;

  // The statement's own subtotals when it has them; the components otherwise.
  // A statement that states both is believed over anything derived from parts
  // of it, because the parts may not be all of them.
  const workingCapital =
    currentAssets.found && currentLiabilities.found
      ? round2(currentAssets.amount - currentLiabilities.amount)
      : round2(cashAndBankBalance + accountsReceivable + inventoryValue - accountsPayable);

  return {
    totalRevenue,
    totalExpenses,
    netProfit,
    totalAssets,
    totalLiabilities,
    totalEquity,
    workingCapital,
    cashAndBankBalance,
    accountsReceivable,
    inventoryValue,
    accountsPayable,
    longTermDebt,
  };
}

/** One year's trend point, for the dashboard's chart. */
export interface KpiTrendPoint {
  year: string;
  revenue: number;
  expenses: number;
  netProfit: number;
}

/** The trend line, oldest first — the order a chart draws it in. */
export function toKpiTrend(
  byYear: ReadonlyArray<{ year: number; kpis: StatementKpis }>,
): KpiTrendPoint[] {
  return [...byYear]
    .sort((a, b) => a.year - b.year)
    .map(({ year, kpis }) => ({
      year: String(year),
      revenue: kpis.totalRevenue,
      expenses: kpis.totalExpenses,
      netProfit: kpis.netProfit,
    }));
}

/**
 * The nine figures a tax reconciliation compares, from an UPLOADED statement.
 *
 * The same nine `quickbooks-pl-summary.ts` reads out of a QuickBooks report,
 * read instead out of an extracted statement tree — so a company whose P&L
 * arrives as a PDF gets the same comparison as one connected to QuickBooks.
 *
 * WHY NOT THE MATCHER IT REPLACES
 * -------------------------------
 * That one matched in BOTH directions:
 *
 *   patterns.some((p) => label.includes(p) || p.includes(label))
 *
 * The second half means a SHORT label matches a LONG pattern. A row called
 * "Interest" matched the pattern "total interest expense"; a row called
 * "Income" matched "total income". Combined with last-match-wins, a statement
 * with a section header and a total both matching took whichever came last in
 * the tree, which is an ordering nobody chose.
 *
 * `findAmount` matches whole names, most specific first — so "Total Interest
 * Expense" is found as itself, and a bare "Interest" only where the list says
 * so.
 */
export interface TaxComparisonFigures {
  year: number;
  totalRevenue: number;
  totalCostOfGoodsSold: number;
  grossProfit: number;
  officerWages: number;
  depreciation: number;
  amortization: number;
  interestExpense: number;
  allOtherIncome: number;
  netIncome: number;
  /**
   * Total expenses less the named costs.
   *
   * NOT clamped to zero. The version this replaces did
   * `Math.max(0, total - named)`, so a statement whose named costs exceeded
   * its total expenses — which happens when one cost is matched twice —
   * reported 0 and hid the inconsistency. A negative here is a real signal
   * that the statement or the matching is wrong, and it belongs on screen.
   */
  allOtherExpenses: number;
}

const OFFICER_WAGES = [
  "officer compensation",
  "officer wages",
  "officer salary",
  "officers compensation",
  "compensation of officers",
];
const DEPRECIATION = ["depreciation expense", "total depreciation", "depreciation"];
const AMORTIZATION = ["amortization expense", "total amortization", "amortization"];
const INTEREST_EXPENSE = ["total interest expense", "interest expense", "loan interest"];
const OTHER_INCOME = ["total other income", "other income", "other revenue"];
const COGS = [
  "total cost of goods sold",
  "cost of goods sold",
  "total cost of sales",
  "cost of sales",
];
const GROSS_PROFIT = ["gross profit", "gross margin"];

/** Read the tax-comparison figures off an uploaded profit-and-loss. */
export function readTaxComparisonFigures(
  profitLossRows: readonly StatementNode[] | null | undefined,
  year: number,
): TaxComparisonFigures {
  const nodes = allNodes(profitLossRows);

  const totalRevenue = findAmount(nodes, REVENUE).amount;
  const totalExpenses = Math.abs(findAmount(nodes, EXPENSES).amount);
  const officerWages = findAmount(nodes, OFFICER_WAGES).amount;
  const depreciation = findAmount(nodes, DEPRECIATION).amount;
  const amortization = findAmount(nodes, AMORTIZATION).amount;
  const interestExpense = findAmount(nodes, INTEREST_EXPENSE).amount;

  const netIncomeLine = findAmount(nodes, NET_PROFIT);

  return {
    year,
    totalRevenue,
    totalCostOfGoodsSold: findAmount(nodes, COGS).amount,
    grossProfit: findAmount(nodes, GROSS_PROFIT).amount,
    officerWages,
    depreciation,
    amortization,
    interestExpense,
    allOtherIncome: findAmount(nodes, OTHER_INCOME).amount,
    netIncome: netIncomeLine.found
      ? netIncomeLine.amount
      : round2(totalRevenue - totalExpenses),
    allOtherExpenses: round2(
      totalExpenses - (officerWages + depreciation + amortization + interestExpense),
    ),
  };
}

/**
 * The year a statement covers.
 *
 * Its own dates first, because they are what the statement says; the filename
 * only when it says nothing. A filename year is a guess about how somebody
 * named a file, and preferring it over the statement's own period is how a
 * file called "2023 Accounts" holding 2024 figures ends up filed under 2023.
 */
export function statementYear(
  statement: { asOfDate?: string | null; periodEnd?: string | null; periodStart?: string | null },
  fileName: string | null | undefined,
  fallbackYear: number,
): number {
  for (const value of [statement.asOfDate, statement.periodEnd, statement.periodStart]) {
    const year = Number.parseInt(String(value ?? "").slice(0, 4), 10);
    if (Number.isInteger(year) && year >= 2000 && year <= fallbackYear + 1) return year;
  }
  const fromName = String(fileName ?? "").match(/\b(20\d{2})\b/);
  if (fromName) {
    const year = Number.parseInt(fromName[1]!, 10);
    if (year >= 2000 && year <= fallbackYear + 1) return year;
  }
  return fallbackYear;
}

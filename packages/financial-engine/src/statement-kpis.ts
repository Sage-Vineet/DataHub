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

import { addTo, amountAt, emptyAmounts, periodKeyFor, roundAmounts } from "./periods.js";
import type { Account, Aggregation, GlEntry, Period } from "./types.js";

/**
 * Derive the income statement from general-ledger rows.
 *
 * WHY THIS EXISTS RATHER THAN READING `profit_loss_entries`
 * --------------------------------------------------------
 * QuickBooks exports revenue AND expenses as positive ledger amounts. Summing
 * a P&L without consulting each account's type therefore yields revenue plus
 * expenses — which is exactly what the extracted `profit_loss_entries` table
 * contains today (FY2024 reports $4,975,913 against a true net income of
 * $47,568, and the same inversion holds for every other year).
 *
 * The sign convention is applied here, once, from `Account.accountType`. It
 * cannot be inferred from the amount, so an unclassified P&L account is a hard
 * error rather than a silent zero.
 */

export interface IncomeStatement {
  periods: Period[];
  revenue: Record<string, number>;
  /**
   * EVERY non-income account, cost of sales included.
   *
   * Kept whole so `netIncome` is `revenue - expenses` however the accounts are
   * classified — a company with no `cogs` accounts must not report a different
   * bottom line from one that separates them.
   */
  expenses: Record<string, number>;
  /** The `cogs` subset of `expenses`. Zero when nothing is classified as such. */
  costOfSales: Record<string, number>;
  /**
   * `revenue - costOfSales`.
   *
   * Equal to `netIncome` plus operating expense, not a second bottom line.
   * Where no account is classified `cogs` this equals revenue, which is the
   * honest answer: gross profit is undefined without a cost of sales, and
   * guessing one from account labels is what this engine exists to stop.
   */
  grossProfit: Record<string, number>;
  netIncome: Record<string, number>;
  /** Signed contribution per account: revenue positive, expenses negative. */
  byAccount: Map<string, Record<string, number>>;
  /** Raw unsigned ledger total per account — what the add-back wizard quotes. */
  ledgerByAccount: Map<string, Record<string, number>>;
}

export class UnclassifiedAccountError extends Error {
  constructor(readonly accountIds: string[]) {
    super(
      `P&L accounts carry no income/expense classification: ${accountIds.join(", ")}. ` +
        "Classify them on the chart of accounts before building a statement.",
    );
    this.name = "UnclassifiedAccountError";
  }
}

export function buildIncomeStatement(
  accounts: Account[],
  entries: GlEntry[],
  periods: Period[],
  aggregation: Aggregation,
): IncomeStatement {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const revenue = emptyAmounts(periods);
  const expenses = emptyAmounts(periods);
  const costOfSales = emptyAmounts(periods);
  const byAccount = new Map<string, Record<string, number>>();
  const ledgerByAccount = new Map<string, Record<string, number>>();
  const unclassified = new Set<string>();

  for (const entry of entries) {
    const account = byId.get(entry.accountId);
    if (!account || account.statementType !== "profit_loss") continue;

    const key = periodKeyFor(entry, aggregation);
    if (revenue[key] === undefined) continue;

    if (account.accountType === null || account.accountType === undefined) {
      unclassified.add(entry.accountId);
      continue;
    }

    // The one place a sign is applied.
    const signed = account.accountType === "income" ? entry.amount : -entry.amount;

    if (account.accountType === "income") addTo(revenue, key, entry.amount);
    else addTo(expenses, key, entry.amount);

    if (account.accountType === "cogs") addTo(costOfSales, key, entry.amount);

    let signedTotals = byAccount.get(entry.accountId);
    if (!signedTotals) byAccount.set(entry.accountId, (signedTotals = emptyAmounts(periods)));
    addTo(signedTotals, key, signed);

    let ledgerTotals = ledgerByAccount.get(entry.accountId);
    if (!ledgerTotals) ledgerByAccount.set(entry.accountId, (ledgerTotals = emptyAmounts(periods)));
    addTo(ledgerTotals, key, entry.amount);
  }

  if (unclassified.size > 0) throw new UnclassifiedAccountError([...unclassified].sort());

  const netIncome = Object.fromEntries(
    Object.keys(revenue).map((key) => [key, amountAt(revenue, key) - amountAt(expenses, key)]),
  );
  const grossProfit = Object.fromEntries(
    Object.keys(revenue).map((key) => [key, amountAt(revenue, key) - amountAt(costOfSales, key)]),
  );

  return {
    periods,
    revenue: roundAmounts(revenue),
    expenses: roundAmounts(expenses),
    costOfSales: roundAmounts(costOfSales),
    grossProfit: roundAmounts(grossProfit),
    netIncome: roundAmounts(netIncome),
    byAccount: new Map([...byAccount].map(([id, a]) => [id, roundAmounts(a)])),
    ledgerByAccount: new Map([...ledgerByAccount].map(([id, a]) => [id, roundAmounts(a)])),
  };
}

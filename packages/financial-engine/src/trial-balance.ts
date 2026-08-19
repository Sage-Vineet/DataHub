import { rollForwardBalanceSheet, type BalanceSheetAnchor } from "./balance-sheet.js";
import { buildPeriods, periodKey, round2 } from "./periods.js";
import type { Account, Aggregation, GlEntry, Period } from "./types.js";

/**
 * Build a trial balance with real opening balances.
 *
 * `trial_balance_entries.opening_balance` is always 0 in the extracted data, so
 * `closing_balance` holds period movement rather than a balance. That is right
 * for profit-and-loss accounts, which genuinely open at zero each fiscal year,
 * and wrong for every balance-sheet account — which is why the balance sheet
 * could not be reconstructed from the TB table (UAT #8).
 *
 * It also blocks `QE - 0001`: basis adjustments are specified as "the exact
 * beginning-to-ending balance delta from the Trial Balance — never an
 * AI-estimated value". With openings at zero there is no delta to take.
 *
 * The rule:
 *   balance-sheet account → opening = prior period's closing
 *   profit-and-loss account → opening = 0 at the start of each fiscal year
 *   closing = opening + movement, always
 */

export interface TrialBalanceRow {
  accountId: string;
  accountName: string;
  /** asset | liability | equity | income | expense */
  accountType: string;
  statementType: "profit_loss" | "balance_sheet";
  openingBalance: number;
  debits: number;
  credits: number;
  /** debits − credits for the period. */
  movement: number;
  closingBalance: number;
}

export interface TrialBalancePeriod {
  period: string;
  label: string;
  rows: TrialBalanceRow[];
  totalDebits: number;
  totalCredits: number;
  /** Total debits − total credits. Zero when the trial balance balances. */
  outOfBalance: number;
  balances: boolean;
}

export interface TrialBalanceResult {
  periods: Period[];
  entries: TrialBalancePeriod[];
  balances: boolean;
}

export interface TrialBalanceInput {
  accounts: Account[];
  entries: GlEntry[];
  /** Needed to seed balance-sheet openings; same contract as the roll-forward. */
  anchors: BalanceSheetAnchor[];
  fiscalYears?: number[];
  /** Defaults to annual. */
  aggregation?: Aggregation;
}

/**
 * Gross positive and negative movement per account per period.
 *
 * Kept as raw signed amounts here; which column they belong in depends on the
 * account, and is decided in `splitDebitCredit`.
 */
function movementByPeriod(
  entries: GlEntry[],
  periods: Period[],
  aggregation: Aggregation,
): Map<string, Map<string, { positive: number; negative: number }>> {
  const keys = new Set(periods.map((p) => periodKey(p.fiscalYear, p.month)));
  const out = new Map<string, Map<string, { positive: number; negative: number }>>();

  for (const entry of entries) {
    const key =
      aggregation === "annual"
        ? periodKey(entry.fiscalYear, null)
        : periodKey(entry.fiscalYear, entry.month);
    if (!keys.has(key)) continue;

    let perAccount = out.get(entry.accountId);
    if (!perAccount) out.set(entry.accountId, (perAccount = new Map()));
    const bucket = perAccount.get(key) ?? { positive: 0, negative: 0 };
    if (entry.amount >= 0) bucket.positive += entry.amount;
    else bucket.negative += -entry.amount;
    perAccount.set(key, bucket);
  }
  return out;
}

/** Accounts whose natural balance is a debit. */
const DEBIT_NATURED = new Set(["asset", "expense"]);

/**
 * Assign movement to the debit or credit column.
 *
 * The ledger exports revenue AND expenses as positive amounts, so a raw sign
 * says nothing about which column a figure belongs in — the account's type
 * does. An asset or expense increases on the debit side; a liability, equity
 * or income account increases on the credit side. Get this wrong and the trial
 * balance is out by the whole of revenue plus expenses.
 */
function splitDebitCredit(
  accountType: string,
  bucket: { positive: number; negative: number },
): { debits: number; credits: number } {
  return DEBIT_NATURED.has(accountType)
    ? { debits: bucket.positive, credits: bucket.negative }
    : { debits: bucket.negative, credits: bucket.positive };
}

export function buildTrialBalance(input: TrialBalanceInput): TrialBalanceResult {
  const { accounts, entries, anchors } = input;
  const aggregation = input.aggregation ?? "annual";
  const years =
    input.fiscalYears && input.fiscalYears.length > 0
      ? [...input.fiscalYears].sort((a, b) => a - b)
      : [...new Set(entries.map((e) => e.fiscalYear))].sort((a, b) => a - b);

  const periods = buildPeriods(entries, years, aggregation);
  const keys = periods.map((p) => periodKey(p.fiscalYear, p.month));
  const movement = movementByPeriod(entries, periods, aggregation);

  // Balance-sheet openings come from the roll-forward — the single place the
  // opening position is derived, so the TB and the balance sheet cannot
  // disagree with one another.
  const sheet = rollForwardBalanceSheet({ accounts, entries, anchors, fiscalYears: years });
  const bsClosing = new Map<string, Record<string, number>>();
  for (const line of sheet.lines) bsClosing.set(line.accountId, line.balances);

  // Monthly roll-forward periods, so an annual trial balance can read the
  // December closing of the preceding year as its opening.
  const monthlyKeys = sheet.periods.map((p) => periodKey(p.fiscalYear, p.month));

  const byId = new Map(accounts.map((a) => [a.id, a]));
  const universe = new Map<string, Account>(byId);
  for (const line of sheet.lines) {
    if (universe.has(line.accountId)) continue;
    universe.set(line.accountId, {
      id: line.accountId,
      name: line.accountName,
      statementType: "balance_sheet",
      accountType: line.section as Account["accountType"],
    });
  }

  /**
   * Closing balance of the period immediately before `key`.
   *
   * Annual periods open at the prior December, monthly at the prior month. The
   * earliest period has no predecessor in the rolled range, so it reads the
   * roll-forward's own opening position — otherwise the first year would open
   * at zero and every subsequent year would inherit the error.
   */
  const priorClosing = (accountId: string, key: string): number => {
    const series = bsClosing.get(accountId);
    if (!series) return 0;
    const [yearPart, monthPart] = key.split("-");
    const year = Number(yearPart);
    const target =
      monthPart === undefined
        ? periodKey(year - 1, 12)
        : monthlyKeys[monthlyKeys.indexOf(key) - 1];
    if (target === undefined) return sheet.openingBalances[accountId] ?? 0;
    const prior = series[target];
    if (prior === undefined) return sheet.openingBalances[accountId] ?? 0;
    return prior;
  };

  const entriesOut: TrialBalancePeriod[] = periods.map((period, index) => {
    const key = keys[index]!;
    const rows: TrialBalanceRow[] = [];

    for (const account of universe.values()) {
      const bucket = movement.get(account.id)?.get(key) ?? { positive: 0, negative: 0 };
      const isBalanceSheet = account.statementType === "balance_sheet";
      const accountType = account.accountType ?? (isBalanceSheet ? "asset" : "expense");
      const { debits, credits } = splitDebitCredit(accountType, bucket);

      // The whole point: balance-sheet accounts carry their prior closing;
      // profit-and-loss accounts genuinely open at zero each fiscal year.
      const openingBalance = isBalanceSheet ? round2(priorClosing(account.id, key)) : 0;
      // Raw signed movement drives the closing BALANCE; the debit/credit split
      // above is a presentation of the same figure.
      const periodMovement = round2(bucket.positive - bucket.negative);

      if (openingBalance === 0 && bucket.positive === 0 && bucket.negative === 0) {
        continue; // nothing to report for this account in this period
      }

      rows.push({
        accountId: account.id,
        accountName: account.name,
        accountType,
        statementType: isBalanceSheet ? "balance_sheet" : "profit_loss",
        openingBalance,
        debits: round2(debits),
        credits: round2(credits),
        movement: periodMovement,
        closingBalance: round2(openingBalance + periodMovement),
      });
    }

    const totalDebits = round2(rows.reduce((a, r) => a + r.debits, 0));
    const totalCredits = round2(rows.reduce((a, r) => a + r.credits, 0));
    const outOfBalance = round2(totalDebits - totalCredits);

    return {
      period: key,
      label: period.label,
      rows,
      totalDebits,
      totalCredits,
      outOfBalance,
      balances: Math.abs(outOfBalance) < 0.01,
    };
  });

  return {
    periods,
    entries: entriesOut,
    balances: entriesOut.every((e) => e.balances),
  };
}

/**
 * Beginning-to-ending balance delta for one account across a fiscal year.
 *
 * This is the primitive `QE - 0001` needs for basis adjustments — change in
 * accounts receivable, customer deposits, inventory, accounts payable — and it
 * is exact by construction rather than estimated.
 */
export function balanceDelta(
  result: TrialBalanceResult,
  accountId: string,
  period: string,
): number | null {
  const entry = result.entries.find((e) => e.period === period);
  const row = entry?.rows.find((r) => r.accountId === accountId);
  if (!row) return null;
  return round2(row.closingBalance - row.openingBalance);
}

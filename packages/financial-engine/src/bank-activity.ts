import { monthsBetween } from "./quickbooks-monthly-items.js";

/**
 * A bank account's month-by-month activity, and whether it ties to the books.
 *
 * The reconciliation page's "Balance Review": for each bank account, what came
 * in and what went out each month, the balance that implies, and the balance
 * the balance sheet states. Where those two disagree, something is missing.
 *
 * Pure arithmetic. Fetching the transactions is the module's job.
 *
 * WHAT THE TWO "CHECKS" ACTUALLY CHECK
 * ------------------------------------
 * The version this replaces reported `footingCheck` and `priorMonthCheck`
 * alongside each month:
 *
 *   footingCheck    = ending - (starting + deposits - withdrawals)
 *   priorMonthCheck = previous month's ending - this month's starting
 *
 * Both are identically zero. `ending` is DEFINED as `starting + deposits -
 * withdrawals` a few lines earlier, and `starting` is DEFINED as the previous
 * month's ending. They are two tie-out controls that cannot fail — they check
 * that addition works, not that the data is right. The page recomputes them
 * from the same identities, so it agrees with itself for the same reason.
 *
 * They are still emitted, because the page reads them and a reconciliation
 * that suddenly showed blank columns would look broken rather than fixed. What
 * is ADDED is a check that can fail: `unexplainedMovement`, the gap between
 * what the balance sheet says the account moved and what the transactions
 * account for. That is non-zero exactly when transactions are missing — which
 * is the failure the old checks were presumably meant to catch, and which
 * happens for real whenever a query comes back truncated.
 */

/** What an account did in one month. */
export interface MonthActivity {
  deposits: number;
  withdrawals: number;
  /** Of those, the part that moved between two of the company's own accounts. */
  intercompanyDeposits: number;
  intercompanyWithdraws: number;
}

export function emptyActivity(): MonthActivity {
  return { deposits: 0, withdrawals: 0, intercompanyDeposits: 0, intercompanyWithdraws: 0 };
}

/** One row of the ladder. */
export interface BankActivityRow extends MonthActivity {
  month: string;
  startingBalance: number;
  endingBalance: number;
  /** What the balance sheet says the account held at month end, if known. */
  perBalanceSheet: number | null;
  /** Ledger ending less the balance sheet's, where both are known. */
  variance: number | null;
  /**
   * The balance sheet's own movement, less the movement the transactions
   * explain. Non-zero means transactions are missing — see the note above.
   */
  unexplainedMovement: number | null;
  /** Always zero. Kept because the page reads it. See the note above. */
  footingCheck: number;
  /** Always zero, for the same reason. */
  priorMonthCheck: number;
}

export interface BankAccountActivity {
  accountId: string;
  accountName: string;
  accountNumber: string;
  currentBalance: number;
  /**
   * Where the first month's opening balance came from.
   *
   * `balance_sheet` means it was back-calculated from a stated month-end
   * balance and the ladder is anchored to the books. `current_balance` means
   * no balance sheet was available and the account's balance AS OF TODAY was
   * used instead — a different point in time, so every figure in the ladder is
   * offset by however much the account has moved since. Legacy did this
   * silently; naming it lets the page say the ladder is not anchored.
   */
  openingBalanceSource: "balance_sheet" | "current_balance";
  monthlyData: BankActivityRow[];
}

/** A bank account as QuickBooks describes it. */
export interface BankAccountRef {
  id: string;
  name: string;
  accountNumber: string;
  currentBalance: number;
}

/** One movement against a bank account. */
export interface BankMovement {
  accountId: string;
  month: string;
  deposits: number;
  withdrawals: number;
  /** True when this moved between two of the company's own bank accounts. */
  intercompany: boolean;
}

/** Every month a range covers, as `YYYY-MM`. */
export function monthsInRange(startDate: string, endDate: string): string[] {
  const start = String(startDate ?? "").slice(0, 7);
  const end = String(endDate ?? "").slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(start) || !/^\d{4}-\d{2}$/.test(end)) return [];
  return monthsBetween(start, end);
}

/** The month a transaction date falls in, or null if it is not a date. */
export function monthOf(date: string | null | undefined): string | null {
  const text = String(date ?? "").trim();
  // Matched rather than parsed. `new Date("2026-03-04")` is UTC midnight and
  // `new Date("03/04/2026")` is local midnight, so a Date round-trip moves
  // some transactions into the previous month depending on the server's zone.
  const match = text.match(/^(\d{4})-(\d{2})-\d{2}/);
  return match ? `${match[1]}-${match[2]}` : null;
}

/** Gather movements into per-account, per-month totals. */
export function accumulate(
  movements: readonly BankMovement[],
): Map<string, Map<string, MonthActivity>> {
  const byAccount = new Map<string, Map<string, MonthActivity>>();

  for (const movement of movements) {
    if (!movement.accountId || !movement.month) continue;
    let byMonth = byAccount.get(movement.accountId);
    if (!byMonth) {
      byMonth = new Map();
      byAccount.set(movement.accountId, byMonth);
    }
    let slot = byMonth.get(movement.month);
    if (!slot) {
      slot = emptyActivity();
      byMonth.set(movement.month, slot);
    }
    slot.deposits += movement.deposits;
    slot.withdrawals += movement.withdrawals;
    if (movement.intercompany) {
      slot.intercompanyDeposits += movement.deposits;
      slot.intercompanyWithdraws += movement.withdrawals;
    }
  }

  return byAccount;
}

/** Two decimal places, and never `-0`. */
function round2(value: number): number {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Build one account's ladder.
 *
 * The opening balance is back-calculated from the first month's stated
 * month-end balance, so the ladder is anchored to the books rather than
 * floating from an arbitrary starting point.
 */
export function buildLadder(
  account: BankAccountRef,
  months: readonly string[],
  activity: ReadonlyMap<string, MonthActivity> | undefined,
  balanceSheet: ReadonlyMap<string, number> | undefined,
): BankAccountActivity {
  const activityFor = (month: string): MonthActivity => activity?.get(month) ?? emptyActivity();
  const statedFor = (month: string): number | null => {
    const stated = balanceSheet?.get(month);
    return stated === undefined ? null : stated;
  };

  const firstMonth = months[0];
  const firstStated = firstMonth === undefined ? null : statedFor(firstMonth);

  let running = account.currentBalance;
  let openingBalanceSource: BankAccountActivity["openingBalanceSource"] = "current_balance";
  if (firstMonth !== undefined && firstStated !== null) {
    const first = activityFor(firstMonth);
    running = firstStated - first.deposits + first.withdrawals;
    openingBalanceSource = "balance_sheet";
  }

  let priorStated: number | null = null;
  const monthlyData: BankActivityRow[] = months.map((month, index) => {
    const act = activityFor(month);
    const startingBalance = round2(running);
    const endingBalance = round2(startingBalance + act.deposits - act.withdrawals);
    running = endingBalance;

    const perBalanceSheet = statedFor(month);
    const variance = perBalanceSheet === null ? null : round2(endingBalance - perBalanceSheet);

    // The first month has no stated balance to move FROM — its opening was
    // back-calculated FROM its own closing, so checking one against the other
    // would return zero by construction, which is exactly the sort of check
    // this field exists to replace. Reported as unknown rather than as zero,
    // which would read as "checked and fine".
    const unexplainedMovement =
      index === 0 || perBalanceSheet === null || priorStated === null
        ? null
        : round2(perBalanceSheet - priorStated - (act.deposits - act.withdrawals));

    priorStated = perBalanceSheet;

    return {
      month,
      startingBalance,
      deposits: round2(act.deposits),
      withdrawals: round2(act.withdrawals),
      endingBalance,
      intercompanyDeposits: round2(act.intercompanyDeposits),
      intercompanyWithdraws: round2(act.intercompanyWithdraws),
      perBalanceSheet,
      variance,
      unexplainedMovement,
      footingCheck: 0,
      priorMonthCheck: 0,
    };
  });

  return {
    accountId: account.id,
    accountName: account.name,
    accountNumber: account.accountNumber,
    currentBalance: round2(account.currentBalance),
    openingBalanceSource,
    monthlyData,
  };
}

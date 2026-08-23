import { assignGroup } from "./balance-sheet-hierarchy.js";
import { buildIncomeStatement } from "./income-statement.js";
import { buildPeriods, periodKey, round2 } from "./periods.js";
import type { Account, GlEntry, Period } from "./types.js";

/**
 * Roll a balance sheet forward (or backward) from an anchor statement.
 *
 * WHY THIS EXISTS
 * ---------------
 * The extracted balance sheet is out by exactly the unclassified Retained
 * Earnings / Net Income account, to the cent, every year — 2022 alone is
 * $5,863,315.58. Retained earnings never roll forward, so the sheet does not
 * balance and neither the trial balance nor the balance-sheet report can be
 * reconstructed from it (UAT #8).
 *
 * The model, from the Data-walkthrough Step 3:
 *
 *   closing balance = opening balance + GL activity, per account, per month
 *   retained earnings and net income are tracked SEPARATELY
 *   at each year end, that year's net income closes into retained earnings
 *
 * Equity movement is not only the close: distributions and contributions post
 * to equity accounts in the GL and must be picked up too. On the reference
 * engagement those total -$31,142.00 across 2022-2025, and including them is
 * what makes the ending retained earnings tie to the statement exactly.
 *
 * DIRECTION
 * ---------
 * Either anchor works. UAT #6 asks for the Dec-2021 sheet to be derived from
 * the 2022 GL without a starting sheet, so an `ending` anchor rolls backward:
 * opening = closing - activity.
 */

export type AnchorKind = "starting" | "ending";

/**
 * One line of an anchor statement.
 *
 * The statement is a source of ACCOUNTS, not merely of balances. A chart of
 * accounts derived from the general ledger contains only accounts that moved,
 * so static ones — leasehold improvements, land, fully-depreciated fixtures —
 * are absent from it while sitting on the balance sheet with real balances. On
 * the reference engagement those total $390,470.80, and dropping them puts
 * every period out by exactly that amount.
 *
 * `section` and `group` also carry the hierarchy the uploaded statement already
 * has, which extraction currently flattens (UAT #7).
 */
export interface AnchorRow {
  accountId: string;
  accountName: string;
  /** asset | liability | equity */
  section: string;
  group?: string | null;
  amount: number;
}

export interface BalanceSheetAnchor {
  kind: AnchorKind;
  /** Period the anchor states, e.g. `{ fiscalYear: 2021, month: 12 }`. */
  fiscalYear: number;
  month: number;
  rows: AnchorRow[];
}

/** Balance stated for an account on an anchor, or zero. */
function statedBalance(anchor: BalanceSheetAnchor, accountId: string): number {
  let total = 0;
  for (const row of anchor.rows) {
    if (row.accountId === accountId) total += row.amount;
  }
  return total;
}

export interface BalanceSheetLine {
  accountId: string;
  accountName: string;
  /** asset | liability | equity */
  section: string;
  /**
   * The sub-heading the account presents under — "Bank Accounts", "Fixed
   * Assets", "Credit Cards". Taken from the uploaded statement where it
   * survived ingestion, derived from the account otherwise (UAT #7).
   */
  group: string | null;
  /** False where the grouping was a convention the statement could contradict. */
  groupCertain: boolean;
  /** Closing balance per period key. */
  balances: Record<string, number>;
}

export interface PeriodCheck {
  period: string;
  assets: number;
  liabilities: number;
  equity: number;
  /** assets − (liabilities + equity). Zero when the sheet balances. */
  outOfBalance: number;
  balances: boolean;
}

export interface TieOut {
  /** The anchor the roll-forward was checked against, when one was supplied. */
  period: string;
  /** Account id → (rolled − stated). Only accounts that disagree. */
  differences: Record<string, number>;
  ties: boolean;
}

export interface BalanceSheetResult {
  periods: Period[];
  lines: BalanceSheetLine[];
  /**
   * Position immediately BEFORE the first rolled period, per account. The
   * trial balance reads this as the opening for the earliest fiscal year,
   * which has no prior December to chain from.
   */
  openingBalances: Record<string, number>;
  /** Retained earnings, carried separately from net income per the model. */
  retainedEarnings: Record<string, number>;
  /**
   * Retained earnings immediately BEFORE the first rolled period, with no
   * current-year income yet.
   *
   * Exposed for the same reason as `openingBalances`: the first period has no
   * predecessor inside the statement, and a period-over-period reading of
   * equity would otherwise measure it from zero. The cash flow statement needs
   * it to tell this year's profit apart from money posted straight to the
   * account.
   */
  openingRetainedEarnings: number;
  /** Current-year net income to date, reset at each fiscal year start. */
  netIncome: Record<string, number>;
  checks: PeriodCheck[];
  /** Null when no opposite anchor was supplied to check against. */
  tieOut: TieOut | null;
  balances: boolean;
}

/** Conventional account names the close writes to. */
export const RETAINED_EARNINGS = "Retained Earnings";
export const NET_INCOME = "Net Income";

export class MissingAnchorError extends Error {
  constructor() {
    super(
      "A balance sheet roll-forward needs at least one anchor statement — a " +
        "starting or an ending balance sheet.",
    );
    this.name = "MissingAnchorError";
  }
}

function isDerivedEquity(name: string): boolean {
  // Retained earnings and net income are derived, never rolled as ordinary lines.
  return name === RETAINED_EARNINGS || name === NET_INCOME;
}

/**
 * Every account that belongs on the sheet: balance-sheet accounts from the
 * chart of accounts, UNION accounts that appear only on an anchor statement.
 */
function rollForwardAccounts(accounts: Account[], anchors: BalanceSheetAnchor[]): Account[] {
  const universe = new Map<string, Account>();

  for (const account of accounts) {
    if (account.statementType !== "balance_sheet") continue;
    if (isDerivedEquity(account.name)) continue;
    universe.set(account.id, account);
  }

  for (const anchor of anchors) {
    for (const row of anchor.rows) {
      if (isDerivedEquity(row.accountName)) continue;
      const existing = universe.get(row.accountId);
      if (!existing) {
        universe.set(row.accountId, {
          id: row.accountId,
          name: row.accountName,
          statementType: "balance_sheet",
          accountType: row.section as Account["accountType"],
          group: row.group ?? null,
        });
        continue;
      }
      // The chart of accounts knows the account exists; only the statement
      // knows which sub-heading it presents under, and whether debt is current
      // or long-term. Carry that across rather than losing it to derivation.
      if (!existing.group && row.group) {
        universe.set(row.accountId, { ...existing, group: row.group });
      }
    }
  }
  return [...universe.values()];
}

/** Month-by-month periods spanning every fiscal year present in the ledger. */
function monthlyPeriods(entries: GlEntry[], years: number[]): Period[] {
  return buildPeriods(entries, years, "monthly");
}

/** GL movement per account for each monthly period. */
function activityByPeriod(
  entries: GlEntry[],
  accounts: Map<string, Account>,
  periods: Period[],
): Map<string, Map<string, number>> {
  const keys = new Set(periods.map((p) => periodKey(p.fiscalYear, p.month)));
  const activity = new Map<string, Map<string, number>>();

  for (const entry of entries) {
    const account = accounts.get(entry.accountId);
    if (!account || account.statementType !== "balance_sheet") continue;
    const key = periodKey(entry.fiscalYear, entry.month);
    if (!keys.has(key)) continue;

    let perAccount = activity.get(entry.accountId);
    if (!perAccount) activity.set(entry.accountId, (perAccount = new Map()));
    perAccount.set(key, (perAccount.get(key) ?? 0) + entry.amount);
  }
  return activity;
}

export interface BalanceSheetInput {
  accounts: Account[];
  entries: GlEntry[];
  /**
   * At least one. The first is rolled from; a second is used only as a tie-out
   * and never as a source of balances.
   */
  anchors: BalanceSheetAnchor[];
  /** Defaults to every fiscal year present in the ledger. */
  fiscalYears?: number[];
}

export function rollForwardBalanceSheet(input: BalanceSheetInput): BalanceSheetResult {
  const { accounts, entries, anchors } = input;
  if (anchors.length === 0) throw new MissingAnchorError();

  const byId = new Map(accounts.map((a) => [a.id, a]));
  const years =
    input.fiscalYears && input.fiscalYears.length > 0
      ? [...input.fiscalYears].sort((a, b) => a - b)
      : [...new Set(entries.map((e) => e.fiscalYear))].sort((a, b) => a - b);

  const periods = monthlyPeriods(entries, years);
  const keys = periods.map((p) => periodKey(p.fiscalYear, p.month));
  const activity = activityByPeriod(entries, byId, periods);

  // Net income per month, from the one place the sign convention is applied.
  const income = buildIncomeStatement(accounts, entries, periods, "monthly");

  // ── choose the anchor to roll from ────────────────────────────────────────
  // The FIRST anchor is rolled from; any second is only checked against. Caller
  // order decides, so "anchor on the ending sheet and verify the opening I
  // derived" is expressible — which is what UAT #6 asks for.
  const primary = anchors[0] as BalanceSheetAnchor;
  const opposite = anchors[1] ?? null;
  const rollAccounts = rollForwardAccounts(accounts, anchors);

  /**
   * Where the anchor sits relative to the rolled periods.
   *
   * A starting sheet states the position BEFORE the first period; an ending
   * sheet states the closing position OF one of them. Rather than branch on
   * direction, roll cumulative activity from zero and then shift the whole
   * series so it passes through the anchor. One code path, and an anchor at any
   * period works — not just the two ends.
   */
  const anchorKey = periodKey(primary.fiscalYear, primary.month);
  const anchorIndex = keys.indexOf(anchorKey);

  const shiftToAnchor = (cumulative: Record<string, number>, stated: number): number =>
    anchorIndex === -1 ? stated : stated - (cumulative[anchorKey] ?? 0);

  // ── roll each account across the periods ──────────────────────────────────
  const lines: BalanceSheetLine[] = [];
  for (const account of rollAccounts) {
    const perAccount = activity.get(account.id);

    const cumulative: Record<string, number> = {};
    let running = 0;
    for (const key of keys) {
      running += perAccount?.get(key) ?? 0;
      cumulative[key] = running;
    }

    const opening = shiftToAnchor(cumulative, statedBalance(primary, account.id));
    const balances: Record<string, number> = {};
    for (const key of keys) balances[key] = round2(opening + (cumulative[key] ?? 0));

    const grouping = assignGroup(account);
    lines.push({
      accountId: account.id,
      accountName: account.name,
      section: account.accountType ?? "asset",
      group: grouping?.group ?? null,
      groupCertain: grouping?.certain ?? false,
      balances,
    });
  }

  // ── retained earnings and net income, tracked separately ──────────────────
  const retainedEarnings: Record<string, number> = {};
  const netIncome: Record<string, number> = {};

  const reId = retainedEarningsId(accounts);

  // Movement in retained earnings, from zero: each completed year's net income
  // closes in, plus anything posted directly to the account. On the reference
  // engagement that direct activity is -$31,142.00 across 2022-2025, and
  // including it is what makes the ending retained earnings tie exactly.
  const reCumulative: Record<string, number> = {};
  let movement = 0;
  let currentYear: number | null = null;
  let yearToDate = 0;

  for (const period of periods) {
    const key = periodKey(period.fiscalYear, period.month);
    if (currentYear !== null && period.fiscalYear !== currentYear) {
      movement += yearToDate;    // year-end close
      yearToDate = 0;
    }
    currentYear = period.fiscalYear;
    yearToDate += income.netIncome[key] ?? 0;
    movement += activity.get(reId)?.get(key) ?? 0;

    reCumulative[key] = movement;
    netIncome[key] = round2(yearToDate);
  }

  // A starting sheet states retained earnings BEFORE the roll, so its own net
  // income line closes in first. An ending sheet already includes every close,
  // so the series is shifted to pass through it instead.
  const statedRe =
    anchorIndex === -1
      ? statedBalance(primary, reId) + statedBalance(primary, netIncomeId(accounts))
      : statedBalance(primary, reId);
  const openingRe = shiftToAnchor(reCumulative, statedRe);
  for (const key of keys) retainedEarnings[key] = round2(openingRe + (reCumulative[key] ?? 0));

  // ── balance check per period ──────────────────────────────────────────────
  const checks: PeriodCheck[] = keys.map((key) => {
    let assets = 0;
    let liabilities = 0;
    let equity = 0;
    for (const line of lines) {
      const value = line.balances[key] ?? 0;
      if (line.section === "asset") assets += value;
      else if (line.section === "liability") liabilities += value;
      else equity += value;
    }
    equity += (retainedEarnings[key] ?? 0) + (netIncome[key] ?? 0);
    const outOfBalance = round2(assets - (liabilities + equity));
    return {
      period: key,
      assets: round2(assets),
      liabilities: round2(liabilities),
      equity: round2(equity),
      outOfBalance,
      balances: Math.abs(outOfBalance) < 0.01,
    };
  });

  // ── tie-out against the opposite anchor ───────────────────────────────────
  let tieOut: TieOut | null = null;
  if (opposite) {
    const key = periodKey(opposite.fiscalYear, opposite.month);
    const firstKey = keys[0];
    const lastKey = keys[keys.length - 1];

    // WHERE the anchor sits relative to the rolled range, not merely whether
    // it is inside it.
    //
    // This used to be `keys.indexOf(key) === -1`, which made every anchor
    // outside the range an OPENING anchor — so a closing sheet dated after the
    // ledger's last posting was compared against the position the roll STARTED
    // from. It reported a difference for every account that moved, each one
    // exactly the account's activity, and reported them as tie-out failures.
    const outside = keys.indexOf(key) === -1;
    const isOpening = outside && firstKey !== undefined && key < firstKey;
    // An anchor dated after the last rolled period states the position at a
    // moment nothing has happened since, so the last rolled close IS that
    // position — the same carrying a balance sheet does for a quiet month.
    const isAfter = outside && lastKey !== undefined && key > lastKey;

    const rolledFor = (accountId: string, series: Record<string, number>): number | undefined => {
      if (isOpening) {
        const first = series[firstKey!];
        if (first === undefined) return undefined;
        return round2(first - (activity.get(accountId)?.get(firstKey!) ?? 0));
      }
      if (isAfter) return series[lastKey!];
      return series[key];
    };

    const differences: Record<string, number> = {};
    for (const line of lines) {
      const rolled = rolledFor(line.accountId, line.balances);
      if (rolled === undefined) continue;
      const diff = round2(rolled - statedBalance(opposite, line.accountId));
      if (Math.abs(diff) >= 0.01) differences[line.accountId] = diff;
    }

    // Retained earnings on a prior-period anchor is stated before that year's
    // net income closes in, so compare against RE + net income together.
    const rolledRe = rolledFor(reId, retainedEarnings);
    const statedRe = isOpening
      ? statedBalance(opposite, reId) + statedBalance(opposite, netIncomeId(accounts))
      : statedBalance(opposite, reId);
    if (rolledRe !== undefined) {
      const reDiff = round2(rolledRe - statedRe);
      if (Math.abs(reDiff) >= 0.01) differences[RETAINED_EARNINGS] = reDiff;
    }

    tieOut = { period: key, differences, ties: Object.keys(differences).length === 0 };
  }

  const firstKey = keys[0];
  const openingBalances: Record<string, number> = {};
  if (firstKey !== undefined) {
    for (const line of lines) {
      openingBalances[line.accountId] = round2(
        (line.balances[firstKey] ?? 0) - (activity.get(line.accountId)?.get(firstKey) ?? 0),
      );
    }
  }

  return {
    periods,
    lines,
    openingBalances,
    retainedEarnings,
    openingRetainedEarnings: round2(openingRe),
    netIncome,
    checks,
    tieOut,
    balances: checks.every((c) => c.balances),
  };
}

function findByName(accounts: Account[], name: string): string {
  return accounts.find((a) => a.name === name)?.id ?? name;
}
function retainedEarningsId(accounts: Account[]): string {
  return findByName(accounts, RETAINED_EARNINGS);
}
function netIncomeId(accounts: Account[]): string {
  return findByName(accounts, NET_INCOME);
}

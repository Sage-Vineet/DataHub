import type { BalanceSheetGroup } from "./balance-sheet-hierarchy.js";
import type { BalanceSheetResult } from "./balance-sheet.js";
import type { IncomeStatement } from "./income-statement.js";
import { emptyAmounts, periodKey } from "./periods.js";
import type { Period } from "./types.js";

/**
 * The cash flow statement, by the indirect method.
 *
 * A pure function of the two statements that already exist: net income comes
 * from the income statement, and every other line is the period-over-period
 * movement of a balance-sheet account. Nothing here reads the ledger again —
 * which is the point. Legacy's `manualCashFlowService.js` is 1,489 lines that
 * re-derive balances from GL entries, and it can therefore disagree with the
 * balance sheet shown beside it. This cannot: if the balance sheet is wrong the
 * cash flow is wrong in exactly the same way, and the reconciliation check below
 * fails loudly rather than quietly presenting two different truths.
 *
 * The reconciliation is the whole value of the statement. Operating plus
 * investing plus financing must equal the actual movement in the bank accounts.
 * When it does not, the sheet does not articulate, and saying so is more useful
 * than a plausible-looking number.
 */

export type CashFlowSection = "operating" | "investing" | "financing";

/**
 * Which section a balance-sheet group belongs to.
 *
 * Derived from the group rather than from the account name, so the mapping is
 * one table instead of a second set of regexes that can disagree with the
 * balance sheet's own grouping. "Bank Accounts" is absent deliberately: those
 * accounts ARE the cash being explained, so they are the reconciliation target
 * rather than a line in the statement.
 */
const SECTION_BY_GROUP: Readonly<Record<Exclude<BalanceSheetGroup, "Bank Accounts">, CashFlowSection>> =
  {
    "Accounts Receivable": "operating",
    "Other Current Assets": "operating",
    "Credit Cards": "operating",
    "Other Current Liabilities": "operating",
    "Fixed Assets": "investing",
    "Other Assets": "investing",
    "Long-term Liabilities": "financing",
    Equity: "financing",
  };

export interface CashFlowLine {
  accountId: string;
  accountName: string;
  section: CashFlowSection;
  group: BalanceSheetGroup;
  /**
   * The cash effect per period, already signed.
   *
   * An asset going up consumes cash and reads negative; a liability going up
   * provides it and reads positive. That inversion is applied exactly once,
   * here, so no caller has to remember which way round a receivable goes.
   */
  amounts: Record<string, number>;
  /** False where the account's grouping was a guess the statement could contradict. */
  groupCertain: boolean;
}

export interface CashFlowPeriodCheck {
  period: string;
  /** operating + investing + financing. */
  netChange: number;
  /** The actual movement in the bank accounts over the same period. */
  cashMovement: number;
  /** netChange − cashMovement. Zero when the statement articulates. */
  difference: number;
  reconciles: boolean;
}

export interface CashFlowStatement {
  periods: Period[];
  lines: CashFlowLine[];
  netIncome: Record<string, number>;
  operating: Record<string, number>;
  investing: Record<string, number>;
  financing: Record<string, number>;
  netChange: Record<string, number>;
  openingCash: Record<string, number>;
  closingCash: Record<string, number>;
  checks: CashFlowPeriodCheck[];
  /** True only when every period reconciles. */
  reconciles: boolean;
}

/**
 * The income statement does not describe the same periods as the balance sheet.
 *
 * Thrown rather than tolerated: a missing period reads as zero net income, and
 * the statement then differs from the truth by exactly the profit of that
 * period — a plausible-looking number that is wrong. This is easy to cause
 * (`rollForwardBalanceSheet` always rolls monthly, so an annual income
 * statement never lines up) and impossible to spot in the output.
 */
export class PeriodMismatchError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `The income statement does not cover ${missing.length} of the balance sheet's periods ` +
        `(${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}). ` +
        "Build both with the same aggregation — the balance sheet rolls monthly.",
    );
    this.name = "PeriodMismatchError";
  }
}

export interface CashFlowInput {
  income: IncomeStatement;
  balanceSheet: BalanceSheetResult;
  /**
   * Tolerance for the reconciliation check, in currency units. Rounding to the
   * cent happens at several steps, so an exact-zero test would fail on
   * arithmetic rather than on a real break.
   */
  toleranceMinorUnits?: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Build the cash flow statement.
 *
 * The first period has no prior period inside the statement, so its movement is
 * measured against the balance sheet's opening balances — the position
 * immediately before the first rolled period. Without that, the opening period
 * would show every balance as if it had appeared from nothing.
 */
export function buildCashFlow(input: CashFlowInput): CashFlowStatement {
  const { income, balanceSheet } = input;
  const tolerance = input.toleranceMinorUnits ?? 0.01;
  const periods = balanceSheet.periods;
  const keys = periods.map((p) => periodKey(p.fiscalYear, p.month));

  const opening = balanceSheet.openingBalances;
  /** The balance immediately before `index`, falling back to the opening position. */
  const priorBalance = (line: { balances: Record<string, number> }, accountId: string, index: number): number =>
    index === 0 ? (opening[accountId] ?? 0) : (line.balances[keys[index - 1]!] ?? 0);

  const missing = keys.filter((k) => income.netIncome[k] === undefined);
  if (missing.length > 0 && keys.length > 0) throw new PeriodMismatchError(missing);

  const lines: CashFlowLine[] = [];
  const operating = emptyAmounts(periods);
  const investing = emptyAmounts(periods);
  const financing = emptyAmounts(periods);
  const openingCash = emptyAmounts(periods);
  const closingCash = emptyAmounts(periods);

  for (const line of balanceSheet.lines) {
    if (line.group === "Bank Accounts") {
      // Cash is what the statement explains, not a line within it.
      keys.forEach((key, i) => {
        openingCash[key]! += priorBalance(line, line.accountId, i);
        closingCash[key]! += line.balances[key] ?? 0;
      });
      continue;
    }

    const group = (line.group ?? "Other Current Assets") as Exclude<BalanceSheetGroup, "Bank Accounts">;
    const section = SECTION_BY_GROUP[group] ?? "operating";
    // Assets consume cash as they grow; liabilities and equity provide it.
    const sign = line.section === "asset" ? -1 : 1;

    const amounts: Record<string, number> = {};
    keys.forEach((key, i) => {
      const movement = (line.balances[key] ?? 0) - priorBalance(line, line.accountId, i);
      const effect = round2(sign * movement);
      amounts[key] = effect;
      const bucket = section === "operating" ? operating : section === "investing" ? investing : financing;
      bucket[key]! += effect;
    });

    lines.push({
      accountId: line.accountId,
      accountName: line.accountName,
      section,
      group,
      amounts,
      groupCertain: line.groupCertain,
    });
  }

  // Net income is the starting line, and it is already the reason retained
  // earnings moved — which is why the balance sheet never rolls those as lines.
  const netIncome: Record<string, number> = {};
  // Non-null: the mismatch guard above proved every key is present.
  for (const key of keys) netIncome[key] = round2(income.netIncome[key]!);

  /**
   * Equity that moved for a reason other than trading — owner distributions and
   * contributions, posted straight to retained earnings.
   *
   * Real cash, and financing by nature, but invisible to the income statement:
   * the balance sheet records it as retained-earnings activity, so the only way
   * to see it is to compare the movement in derived equity against the profit
   * that should explain it. On the reference engagement it is three months out
   * of forty-eight, and leaving it out puts the statement out by six figures in
   * each of them.
   */
  const distributions: Record<string, number> = {};
  // Only when the balance sheet actually tracks derived equity. A sheet that
  // does not would read as "equity never moved", and the comparison below would
  // then subtract net income back out of the statement — turning a missing
  // input into a wrong number rather than an absent line.
  const tracksDerivedEquity = keys.some(
    (k) => balanceSheet.netIncome[k] !== undefined || balanceSheet.retainedEarnings[k] !== undefined,
  );
  if (tracksDerivedEquity) keys.forEach((key, i) => {
    const derivedNow = (balanceSheet.retainedEarnings[key] ?? 0) + (balanceSheet.netIncome[key] ?? 0);
    const priorKey = i === 0 ? null : keys[i - 1]!;
    const derivedPrior =
      priorKey === null
        ? // Before the first period there is no current-year income yet.
          balanceSheet.openingRetainedEarnings
        : (balanceSheet.retainedEarnings[priorKey] ?? 0) + (balanceSheet.netIncome[priorKey] ?? 0);

    const amount = round2(derivedNow - derivedPrior - netIncome[key]!);
    distributions[key] = amount;
    financing[key] = round2(financing[key]! + amount);
  });

  if (keys.some((k) => Math.abs(distributions[k] ?? 0) > 0.005)) {
    lines.push({
      accountId: "__retained_earnings_activity__",
      accountName: "Distributions and other equity movements",
      section: "financing",
      group: "Equity",
      amounts: distributions,
      groupCertain: true,
    });
  }

  const netChange: Record<string, number> = {};
  const checks: CashFlowPeriodCheck[] = [];
  // Non-null throughout: `emptyAmounts` seeds every period key, so a fallback
  // here would be a branch no input can reach — and an untestable one.
  for (const key of keys) {
    operating[key] = round2(operating[key]! + netIncome[key]!);
    investing[key] = round2(investing[key]!);
    financing[key] = round2(financing[key]!);
    openingCash[key] = round2(openingCash[key]!);
    closingCash[key] = round2(closingCash[key]!);

    const change = round2(operating[key]! + investing[key]! + financing[key]!);
    netChange[key] = change;

    const cashMovement = round2(closingCash[key]! - openingCash[key]!);
    const difference = round2(change - cashMovement);
    checks.push({
      period: key,
      netChange: change,
      cashMovement,
      difference,
      reconciles: Math.abs(difference) <= tolerance,
    });
  }

  return {
    periods,
    lines,
    netIncome,
    operating,
    investing,
    financing,
    netChange,
    openingCash,
    closingCash,
    checks,
    reconciles: checks.every((c) => c.reconciles),
  };
}

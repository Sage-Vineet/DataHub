import {
  buildIncomeStatement,
  buildPeriods,
  rollForwardBalanceSheet,
  type BalanceSheetAnchor,
} from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";

/**
 * Does the ledger get you from the opening balance sheet to the closing one?
 *
 * The question the whole engagement rests on, and the one legacy answered with
 * a hand-rolled second implementation of the roll-forward — a loop over staged
 * transactions applying its own sign rules, its own contra-account detection
 * and its own account matching by normalized label. Two roll-forwards that must
 * agree forever is one more than there should be, and the validator's copy is
 * the one nobody reconciles against the statements.
 *
 * So this asks `rollForwardBalanceSheet` instead. Its `tieOut` already reports
 * exactly what the validator was computing: per account, the difference between
 * where the ledger says the position ended and where the closing sheet says it
 * did.
 *
 * A cent of rounding across a hundred accounts is not a mismatch, hence
 * `EPSILON`; anything larger is reported rather than smoothed away.
 */

const EPSILON = 0.01;
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface SheetTotals {
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  isBalanced: boolean;
}

export interface AccountMismatch {
  account: string;
  opening: number;
  activity: number;
  expectedClosing: number;
  actualClosing: number;
  variance: number;
}

export interface BalanceSheetValidation {
  openingBalance: number;
  closingBalance: number;
  netIncome: number;
  adjustments: number;
  equationVariance: number;
  missingSheets: string[];
  hasStartingSheet: boolean;
  hasEndingSheet: boolean;
  isComplete: boolean;
  startTotals: SheetTotals;
  endTotals: SheetTotals;
  mismatches: AccountMismatch[];
  missingInEnding: Array<{ account: string; opening: number; activity: number; expectedClosing: number }>;
  missingInStarting: Array<{ account: string; actualClosing: number }>;
  isBalanced: boolean;
  isEquationValid: boolean;
  isValid: boolean;
}

export interface ValidationPayload {
  source: string;
  validation: BalanceSheetValidation;
}

const EMPTY_TOTALS: SheetTotals = {
  totalAssets: 0,
  totalLiabilities: 0,
  totalEquity: 0,
  isBalanced: false,
};

/** Assets, liabilities and equity as a stated sheet reports them. */
export function totalsOf(anchor: BalanceSheetAnchor | undefined): SheetTotals {
  if (!anchor) return { ...EMPTY_TOTALS };
  let totalAssets = 0;
  let totalLiabilities = 0;
  let totalEquity = 0;
  for (const row of anchor.rows) {
    if (row.section === "asset") totalAssets += row.amount;
    else if (row.section === "liability") totalLiabilities += row.amount;
    else if (row.section === "equity") totalEquity += row.amount;
  }
  totalAssets = round2(totalAssets);
  totalLiabilities = round2(totalLiabilities);
  totalEquity = round2(totalEquity);
  return {
    totalAssets,
    totalLiabilities,
    totalEquity,
    isBalanced: Math.abs(round2(totalAssets - (totalLiabilities + totalEquity))) <= EPSILON,
  };
}

export function validateBalanceSheet(engagement: EngagementData): ValidationPayload {
  const starting = engagement.anchors.find((a) => a.kind === "starting");
  const ending = engagement.anchors.find((a) => a.kind === "ending");
  const hasStartingSheet = starting !== undefined;
  const hasEndingSheet = ending !== undefined;
  const missingSheets = [
    ...(hasStartingSheet ? [] : ["starting"]),
    ...(hasEndingSheet ? [] : ["ending"]),
  ];

  const startTotals = totalsOf(starting);
  const endTotals = totalsOf(ending);

  const openingBalance = round2(startTotals.totalAssets - startTotals.totalLiabilities);
  const closingBalance = round2(endTotals.totalAssets - endTotals.totalLiabilities);

  const mismatches: AccountMismatch[] = [];
  const missingInEnding: ValidationPayload["validation"]["missingInEnding"] = [];
  const missingInStarting: ValidationPayload["validation"]["missingInStarting"] = [];
  let netIncome = 0;

  // Without both sheets there is nothing to roll between, and a mismatch list
  // built against a sheet that was never uploaded would be a list of every
  // account.
  if (hasStartingSheet && hasEndingSheet) {
    const balanceSheet = rollForwardBalanceSheet({
      accounts: engagement.accounts,
      entries: engagement.entries,
      anchors: engagement.anchors,
      fiscalYears: engagement.fiscalYears,
    });
    const income = buildIncomeStatement(
      engagement.accounts,
      engagement.entries,
      buildPeriods(engagement.entries, engagement.fiscalYears, "annual"),
      "annual",
    );
    netIncome = round2(
      Object.values(income.netIncome).reduce((total, value) => total + value, 0),
    );

    const nameOf = new Map(engagement.accounts.map((a) => [a.id, a.name]));
    const openingOf = balanceSheet.openingBalances;
    const statedEnding = new Map(ending.rows.map((r) => [r.accountId, r.amount]));
    const statedStarting = new Map(starting.rows.map((r) => [r.accountId, r.amount]));

    for (const [accountId, difference] of Object.entries(balanceSheet.tieOut?.differences ?? {})) {
      if (Math.abs(difference) <= EPSILON) continue;
      const opening = round2(openingOf[accountId] ?? 0);
      const actualClosing = round2(statedEnding.get(accountId) ?? 0);
      // The rolled position is what the ledger says; `difference` is
      // rolled − stated, so the expected closing is the stated plus it.
      const expectedClosing = round2(actualClosing + difference);
      mismatches.push({
        account: nameOf.get(accountId) ?? accountId,
        opening,
        activity: round2(expectedClosing - opening),
        expectedClosing,
        actualClosing,
        variance: round2(actualClosing - expectedClosing),
      });
    }
    mismatches.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));

    for (const row of starting.rows) {
      if (statedEnding.has(row.accountId)) continue;
      const opening = round2(row.amount);
      const expectedClosing = round2(openingOf[row.accountId] ?? opening);
      missingInEnding.push({
        account: nameOf.get(row.accountId) ?? row.accountName,
        opening,
        activity: round2(expectedClosing - opening),
        expectedClosing,
      });
    }
    for (const row of ending.rows) {
      if (statedStarting.has(row.accountId)) continue;
      missingInStarting.push({
        account: nameOf.get(row.accountId) ?? row.accountName,
        actualClosing: round2(row.amount),
      });
    }
  }

  // What is left over once the year's profit is accounted for: distributions,
  // capital in or out, anything posted straight to equity.
  const adjustments = round2(closingBalance - openingBalance - netIncome);
  const equationVariance = round2(openingBalance + netIncome + adjustments - closingBalance);
  const isEquationValid =
    hasStartingSheet && hasEndingSheet && Math.abs(equationVariance) <= EPSILON;

  return {
    source: "general_ledger_entries",
    validation: {
      openingBalance,
      closingBalance,
      netIncome,
      adjustments,
      equationVariance,
      missingSheets,
      hasStartingSheet,
      hasEndingSheet,
      isComplete: hasStartingSheet && hasEndingSheet,
      startTotals,
      endTotals,
      mismatches,
      missingInEnding,
      missingInStarting,
      isBalanced: startTotals.isBalanced && endTotals.isBalanced,
      isEquationValid,
      isValid:
        hasStartingSheet &&
        hasEndingSheet &&
        startTotals.isBalanced &&
        endTotals.isBalanced &&
        isEquationValid &&
        mismatches.length === 0,
    },
  };
}

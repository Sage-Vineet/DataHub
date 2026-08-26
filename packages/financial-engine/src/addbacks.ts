import type { IncomeStatement } from "./income-statement.js";
import { amountAt, emptyAmounts, periodKey, round2, roundAmounts } from "./periods.js";
import type { Addback, DataSource, GlEntry, Period } from "./types.js";

/**
 * Resolve each add-back to an amount per displayed period.
 *
 * The four `QE - 0004` sourcing kinds behave differently and deliberately so:
 *
 *   pnl_account_vendor  amount comes from the GL and is NEVER overridable
 *   recast              amount is the delta between a normalized post-close
 *                       value and the actual GL value
 *   manual_adjustment   free-form amount, requires a written explanation
 *   balance_sheet_change  supplied amounts (BS deltas are not P&L rows)
 */

export class AddbackValidationError extends Error {
  constructor(readonly addbackId: string, message: string) {
    super(message);
    this.name = "AddbackValidationError";
  }
}

/** Validation the wizard enforces up front and the engine refuses to skip. */
export function validateAddback(addback: Addback): void {
  const fail = (message: string) => {
    throw new AddbackValidationError(addback.id, message);
  };

  if (addback.kind === "pnl_account_vendor" && !addback.linkedAccountId) {
    fail("A P&L account/vendor add-back requires a linked GL account.");
  }
  if (addback.kind === "manual_adjustment" && !addback.explanation?.trim()) {
    fail("A manual adjustment requires a written explanation before it can be saved.");
  }
  if (addback.kind === "recast") {
    if (!addback.linkedAccountId) fail("A recast add-back requires a linked P&L account.");
    if (addback.recastNormalizedValue === null || addback.recastNormalizedValue === undefined) {
      fail("A recast add-back requires a normalized post-close value.");
    }
  }
}

/** Sum GL rows for one account across the periods, honouring vendor scope. */
function ledgerAmounts(
  entries: GlEntry[],
  accountId: string,
  vendorScope: string[] | undefined,
  periods: Period[],
  keyFor: (entry: GlEntry) => string,
): Record<string, number> {
  const amounts = emptyAmounts(periods);
  const scoped = vendorScope && vendorScope.length > 0 ? new Set(vendorScope) : null;
  for (const entry of entries) {
    if (entry.accountId !== accountId) continue;
    if (scoped && !(entry.vendor && scoped.has(entry.vendor))) continue;
    const key = keyFor(entry);
    const current = amounts[key];
    if (current !== undefined) amounts[key] = current + entry.amount;
  }
  return amounts;
}

/** Spread a single figure evenly across every displayed period. */
function smooth(total: number, periods: Period[]): Record<string, number> {
  const amounts = emptyAmounts(periods);
  const keys = Object.keys(amounts);
  if (keys.length === 0) return amounts;
  const each = total / keys.length;
  for (const key of keys) amounts[key] = each;
  return amounts;
}

/** Read supplied values, tolerating annual keys against monthly columns. */
function suppliedAmounts(
  values: Record<string, number> | undefined,
  periods: Period[],
): Record<string, number> {
  const amounts = emptyAmounts(periods);
  if (!values) return amounts;
  for (const period of periods) {
    const exact = periodKey(period.fiscalYear, period.month);
    const supplied = values[exact];
    if (supplied !== undefined) {
      amounts[exact] = supplied;
      continue;
    }
    // An annual figure viewed monthly spreads evenly across that year's months.
    const annual = values[String(period.fiscalYear)];
    if (annual !== undefined && period.month !== null) {
      const monthsInYear = periods.filter((p) => p.fiscalYear === period.fiscalYear).length;
      amounts[exact] = annual / monthsInYear;
    }
  }
  return amounts;
}

export interface ResolvedAddback {
  addback: Addback;
  amounts: Record<string, number>;
}

export function resolveAddback(
  addback: Addback,
  entries: GlEntry[],
  statement: IncomeStatement,
  periods: Period[],
  keyFor: (entry: GlEntry) => string,
): ResolvedAddback {
  validateAddback(addback);

  let amounts: Record<string, number>;

  switch (addback.kind) {
    case "pnl_account_vendor": {
      amounts = ledgerAmounts(entries, addback.linkedAccountId!, addback.vendorScope, periods, keyFor);
      break;
    }
    case "recast": {
      // Add-back is what the business would NOT have spent post-close.
      const actual = statement.ledgerByAccount.get(addback.linkedAccountId!) ?? emptyAmounts(periods);
      amounts = emptyAmounts(periods);
      for (const key of Object.keys(amounts)) {
        amounts[key] = amountAt(actual, key) - (addback.recastNormalizedValue ?? 0);
      }
      break;
    }
    case "manual_adjustment":
    case "balance_sheet_change": {
      amounts = suppliedAmounts(addback.values, periods);
      break;
    }
  }

  if (addback.granularity === "smoothed") {
    const total = Object.values(amounts).reduce((a, b) => a + b, 0);
    amounts = smooth(total, periods);
  }

  return { addback, amounts: roundAmounts(amounts) };
}

/**
 * Add-backs applicable to the active data source.
 *
 * `QE - 0004` requires every record to be retained independently of the toggle,
 * so nothing is deleted when the source changes — it simply stops contributing.
 */
export function forDataSource(addbacks: Addback[], dataSource: DataSource): Addback[] {
  return addbacks.filter((a) => a.dataSource === dataSource);
}

/**
 * Flag add-backs that look like duplicates of one another — same account and
 * overlapping vendor scope. Surfaced as a warning; never auto-removed.
 */
export function detectDuplicates(addbacks: Addback[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < addbacks.length; i += 1) {
    for (let j = i + 1; j < addbacks.length; j += 1) {
      const a = addbacks[i];
      const b = addbacks[j];
      if (!a || !b) continue;
      if (!a.linkedAccountId || a.linkedAccountId !== b.linkedAccountId) continue;
      const scopeA = a.vendorScope ?? [];
      const scopeB = b.vendorScope ?? [];
      const entireAccount = scopeA.length === 0 || scopeB.length === 0;
      const overlaps = scopeA.some((v) => scopeB.includes(v));
      if (entireAccount || overlaps) pairs.push([a.id, b.id]);
    }
  }
  return pairs;
}

export { round2 };

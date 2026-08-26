/** Money and percentage formatting for the bridge. */

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const MONEY_EXACT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Accounting presentation: negatives in parentheses, zero as an em dash. */
export function money(value, { exact = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) < 0.005) return "—";
  const fmt = exact ? MONEY_EXACT : MONEY;
  return n < 0 ? `(${fmt.format(Math.abs(n))})` : fmt.format(n);
}

export function percent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}%`;
}

export function periodKey(period) {
  return period.month === null
    ? String(period.fiscalYear)
    : `${period.fiscalYear}-${String(period.month).padStart(2, "0")}`;
}

/**
 * Make a displayed column add up.
 *
 * The engine is exact — its subtotals equal the sum of its components to the
 * cent. Presentation rounds to whole dollars, and rounding each figure
 * independently can leave the column not footing: FY2023's components round to
 * 715,930 while its true subtotal, 715,929.37, rounds to 715,929. A reader who
 * adds the column up finds a dollar missing, and in a quality-of-earnings
 * deliverable a bridge that does not foot is a credibility problem well out of
 * proportion to a dollar.
 *
 * So the subtotal shown is the sum of the ROUNDED components rather than the
 * rounded exact subtotal. The underlying value is untouched — this is a
 * presentation rule, applied where the numbers are read.
 *
 * `components` are the exact values that make up the subtotal, in any order.
 * Returns the whole-dollar figure to display for the subtotal.
 */
export function footedSubtotal(components) {
  return (components || [])
    .map((v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n) : 0;
    })
    .reduce((a, b) => a + b, 0);
}

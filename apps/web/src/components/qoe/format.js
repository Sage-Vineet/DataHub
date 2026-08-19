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

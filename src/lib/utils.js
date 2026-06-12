export function cn(...values) {
  return values.flat(Infinity).filter(Boolean).join(" ");
}

/**
 * Formats a number to US locale (en-US).
 * - Thousand separator: comma (,)
 * - Decimal separator: period (.)
 * - Handles null, undefined, NaN as '-'
 * - Zero as '0.00' (or as specified by decimals)
 */
export const formatNumber = (value, decimals = 2) => {
  if (value === null || value === undefined || value === "") return "-";

  const numericValue = Number(value);
  if (isNaN(numericValue)) return "-";

  return numericValue.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
};

/**
 * Standardized Financial Number Formatter
 * 0 -> "0.00"
 * null, undefined -> "-"
 * Positive -> "1,234.56"
 * Negative -> "-1,234.56"
 */
export function formatCurrency(amount) {
  return formatNumber(amount, 2);
}

export function formatDate(dateStr) {
  return new Date(dateStr || Date.now()).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

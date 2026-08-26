export function cn(...values) {
  return values.flat(Infinity).filter(Boolean).join(" ");
}

/**
 * Standardized Financial Number Formatter
 * 0, null, undefined -> "-"
 * Positive -> "1,234.56"
 * Negative -> "(1,234.56)"
 */
export function formatNumber(amount, decimals = 2) {
  if (amount === null || amount === undefined || amount === "" || Number(amount) === 0) {
    return "-";
  }

  const numeric = typeof amount === "string"
    ? Number(amount.replace(/,/g, "").replace(/[^\d.-]/g, ""))
    : Number(amount);

  if (isNaN(numeric) || numeric === 0) {
    return "-";
  }

  const formatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  const absValue = Math.abs(numeric);
  const formatted = formatter.format(absValue);

  return numeric < 0 ? `(${formatted})` : formatted;
}

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

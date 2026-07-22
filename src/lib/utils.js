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

/**
 * A row is a structural container (folder) rather than a leaf value when it has
 * children or is explicitly typed as a grouping row. Its own amount cells must
 * stay blank — the aggregate already lives on its "Total …" child/sibling row,
 * so showing a number here would duplicate that total. Total rows are exempt
 * even if they happen to carry children.
 */
export function isReportGroupRow(line, hasChildren, isTotal) {
  const type = line?.type;
  return Boolean(!isTotal && (hasChildren || type === "header" || type === "group" || type === "section"));
}

export function formatDate(dateStr) {
  return new Date(dateStr || Date.now()).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

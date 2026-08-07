export const PROFIT_METRIC_VALUES = Object.freeze({
  ADJUSTED_EBITDA: "adjusted_ebitda",
  SDE: "sde",
});

export const PROFIT_METRIC_OPTIONS = Object.freeze([
  {
    value: PROFIT_METRIC_VALUES.ADJUSTED_EBITDA,
    label: "Adjusted EBITDA",
    description: "Use EBITDA as the primary profit metric.",
  },
  {
    value: PROFIT_METRIC_VALUES.SDE,
    label: "SDE",
    description: "Use Seller's Discretionary Earnings as the primary profit metric.",
  },
]);

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeProfitMetric(value, fallback = PROFIT_METRIC_VALUES.ADJUSTED_EBITDA) {
  const normalized = normalizeText(value).replace(/[\s-]+/g, "_");
  if (!normalized) return fallback;

  if (
    normalized === PROFIT_METRIC_VALUES.SDE ||
    normalized === "seller_discretionary_earnings" ||
    normalized === "sellers_discretionary_earnings" ||
    normalized === "seller's_discretionary_earnings"
  ) {
    return PROFIT_METRIC_VALUES.SDE;
  }

  if (
    normalized === PROFIT_METRIC_VALUES.ADJUSTED_EBITDA ||
    normalized === "adj_ebitda" ||
    normalized === "adjusted_ebitda" ||
    normalized === "ebitda"
  ) {
    return PROFIT_METRIC_VALUES.ADJUSTED_EBITDA;
  }

  return fallback;
}

export function getProfitMetricConfig(source) {
  const metric = normalizeProfitMetric(
    typeof source === "object" && source !== null
      ? source.profit_metric ?? source.profitMetric ?? source.metric
      : source,
  );

  const isSde = metric === PROFIT_METRIC_VALUES.SDE;
  const shortLabel = isSde ? "SDE" : "EBITDA";
  const longLabel = isSde ? "Seller's Discretionary Earnings" : "Adjusted EBITDA";
  const itemSingularLabel = isSde ? "Addback" : "Adjustment";
  const itemPluralLabel = isSde ? "Addbacks" : "Adjustments";

  return {
    metric,
    shortLabel,
    longLabel,
    analysisLabel: `${shortLabel} Analysis`,
    navLabel: `${shortLabel} Calculation`,
    sectionLabel: itemPluralLabel,
    sectionButtonLabel: `ADD ${itemSingularLabel.toUpperCase()}`,
    sectionIntro: `Add, edit, and audit ${itemPluralLabel.toLowerCase()} that flow into ${longLabel}.`,
    loadingLabel: `Loading saved ${itemPluralLabel.toLowerCase()}...`,
    emptyLabel: `No ${itemPluralLabel.toLowerCase()} have been created yet. Click Add Row to normalize earnings.`,
    totalRowLabel: `Total ${itemPluralLabel}`,
    finalRowLabel: longLabel,
    finalRowSubtitle: `EBITDA plus approved ${itemPluralLabel.toLowerCase()}`,
    percentRowLabel: `${shortLabel} % of Sales`,
    headerLead: `Recalculated ${longLabel}`,
    itemSingularLabel,
    itemPluralLabel,
    tableHeaderLabel: itemPluralLabel,
    modalTitleAdd: `Add ${itemSingularLabel}`,
    modalTitleEdit: `Edit ${itemSingularLabel}`,
    modalNameLabel: `${itemSingularLabel} Name`,
    modalTypeLabel: `${itemSingularLabel} Type`,
    modalSaveLabel: `Save ${itemSingularLabel}`,
    modalPlaceholderLabel: itemSingularLabel,
  };
}

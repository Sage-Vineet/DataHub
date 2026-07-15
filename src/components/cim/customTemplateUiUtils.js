export function normalizeText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export const CUSTOM_FIELD_STATUS_STYLES = {
  auto_filled: "border-emerald-300 bg-emerald-50 text-emerald-700",
  needs_review: "border-amber-300 bg-amber-50 text-amber-700",
  manual: "border-[#8BC53D]/50 bg-[#EEF6E0] text-[#476E2C]",
  ignored: "border-border bg-bg-page text-[#6D6E71]",
};

export function fieldStatusClass(mapping) {
  if (mapping?.ignored) return CUSTOM_FIELD_STATUS_STYLES.ignored;
  return CUSTOM_FIELD_STATUS_STYLES[mapping?.status] || CUSTOM_FIELD_STATUS_STYLES.needs_review;
}

export function validateMappingValue(mapping) {
  const value = mapping?.value;
  if (!value) return "";
  const rules = mapping.validationRules || [];
  if (!rules.some((rule) => rule.kind === "numeric")) return "";
  const numeric = Number(String(value).replace(/[$,%()]/g, ""));
  if (!Number.isFinite(numeric)) return "Expected a numeric value.";
  const range = rules.find((rule) => rule.kind === "numeric" && (rule.min !== undefined || rule.max !== undefined));
  if (range && ((range.min !== undefined && numeric < range.min) || (range.max !== undefined && numeric > range.max))) {
    return `Value should be between ${range.min ?? "-∞"} and ${range.max ?? "∞"}.`;
  }
  return "";
}

export function countMappingsWithData(placeholders = [], mappings = {}) {
  return placeholders.filter((placeholder) => {
    const mapping = mappings?.[placeholder.id];
    return mapping && !mapping.ignored && normalizeText(mapping.value);
  }).length;
}

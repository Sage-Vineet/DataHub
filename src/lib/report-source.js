export const REPORT_SOURCE_KEYS = {
  QUICKBOOKS: "quickbooks_online",
  MANUAL_GL: "manual_gl_upload",
};

export const REPORT_SOURCE_OPTIONS = [
  {
    key: REPORT_SOURCE_KEYS.QUICKBOOKS,
    label: "QuickBooks Online",
    sourceMode: "quickbooks",
  },
  {
    key: REPORT_SOURCE_KEYS.MANUAL_GL,
    label: "Manual GL Upload",
    sourceMode: "manual",
  },
];

export function normalizeReportSourceKey(value) {
  return value === REPORT_SOURCE_KEYS.MANUAL_GL
    ? REPORT_SOURCE_KEYS.MANUAL_GL
    : REPORT_SOURCE_KEYS.QUICKBOOKS;
}

export function getReportSourceMode(sourceKey) {
  return normalizeReportSourceKey(sourceKey) === REPORT_SOURCE_KEYS.MANUAL_GL
    ? "manual"
    : "quickbooks";
}

export function getReportSourceLabel(sourceKey) {
  return (
    REPORT_SOURCE_OPTIONS.find((option) => option.key === normalizeReportSourceKey(sourceKey))
      ?.label || "QuickBooks Online"
  );
}

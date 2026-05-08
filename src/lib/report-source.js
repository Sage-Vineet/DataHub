export const REPORT_SOURCE_KEYS = {
  QUICKBOOKS: "quickbooks_online",
  MANUAL_GL: "manual_gl_upload",
  MANUAL_UPLOAD: "manual_upload_excel_pdf",
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
  {
    key: REPORT_SOURCE_KEYS.MANUAL_UPLOAD,
    label: "Manual Upload (Excel or PDF)",
    sourceMode: "manual_upload",
  },
];

export function normalizeReportSourceKey(value) {
  if (value === REPORT_SOURCE_KEYS.MANUAL_GL) return REPORT_SOURCE_KEYS.MANUAL_GL;
  if (value === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) return REPORT_SOURCE_KEYS.MANUAL_UPLOAD;
  return REPORT_SOURCE_KEYS.QUICKBOOKS;
}

export function getReportSourceMode(sourceKey) {
  const normalized = normalizeReportSourceKey(sourceKey);
  if (normalized === REPORT_SOURCE_KEYS.MANUAL_GL) return "manual";
  if (normalized === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) return "manual_upload";
  return "quickbooks";
}

export function getReportSourceLabel(sourceKey) {
  return (
    REPORT_SOURCE_OPTIONS.find((option) => option.key === normalizeReportSourceKey(sourceKey))
      ?.label || "QuickBooks Online"
  );
}

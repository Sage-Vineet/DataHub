export const REPORT_SOURCE_KEYS = {
  QUICKBOOKS: "quickbooks_online",
  MANUAL_GL: "manual_gl_upload",
  MANUAL_UPLOAD: "manual_upload_excel_pdf",
  QUICKBOOKS_MANUAL: "quickbooks_manual",
  // 5th data source. NOT a Connections-page card — it is activated from the
  // Key Reports page (by setting a version as the official source). When this is
  // the active source, the consumer pages (Reports / EBITDA / Bank & Tax Recon)
  // read from the selected Key Report Version instead of one of the 4 connections.
  KEY_REPORTS: "key_reports",
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
  {
    key: REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL,
    label: "QuickBooks Manual",
    sourceMode: "quickbooks_manual",
  },
];

export function normalizeReportSourceKey(value) {
  if (!value) return null;
  if (value === REPORT_SOURCE_KEYS.MANUAL_GL) return REPORT_SOURCE_KEYS.MANUAL_GL;
  if (value === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) return REPORT_SOURCE_KEYS.MANUAL_UPLOAD;
  if (value === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) return REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL;
  if (value === REPORT_SOURCE_KEYS.QUICKBOOKS) return REPORT_SOURCE_KEYS.QUICKBOOKS;
  if (value === REPORT_SOURCE_KEYS.KEY_REPORTS) return REPORT_SOURCE_KEYS.KEY_REPORTS;
  // Legacy aliases
  const lower = String(value).trim().toLowerCase();
  if (lower === "quickbooks" || lower === "quickbooks_online") return REPORT_SOURCE_KEYS.QUICKBOOKS;
  if (lower === "manual_gl" || lower === "manual" || lower === "manual_gl_upload") return REPORT_SOURCE_KEYS.MANUAL_GL;
  if (lower === "manual_upload" || lower === "manual_report_upload" || lower === "manual_upload_excel_pdf") return REPORT_SOURCE_KEYS.MANUAL_UPLOAD;
  if (lower === "quickbooks_manual" || lower === "qb_manual") return REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL;
  if (lower === "key_reports" || lower === "keyreports" || lower === "key_report") return REPORT_SOURCE_KEYS.KEY_REPORTS;
  return null;
}

export function getReportSourceMode(sourceKey) {
  const normalized = normalizeReportSourceKey(sourceKey);
  if (normalized === REPORT_SOURCE_KEYS.MANUAL_GL) return "manual";
  if (normalized === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) return "manual_upload";
  if (normalized === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) return "quickbooks_manual";
  if (normalized === REPORT_SOURCE_KEYS.KEY_REPORTS) return "key_reports";
  return "quickbooks";
}

export function getReportSourceLabel(sourceKey) {
  const normalized = normalizeReportSourceKey(sourceKey);
  if (normalized === REPORT_SOURCE_KEYS.KEY_REPORTS) return "Key Reports";
  return (
    REPORT_SOURCE_OPTIONS.find((option) => option.key === normalized)
      ?.label || "QuickBooks Online"
  );
}

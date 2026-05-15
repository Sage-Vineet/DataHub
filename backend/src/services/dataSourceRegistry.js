const DATA_SOURCE_KEYS = Object.freeze({
  QUICKBOOKS: "quickbooks_online",
  MANUAL_GL: "manual_gl_upload",
  MANUAL_UPLOAD: "manual_upload_excel_pdf",
});

const DATA_SOURCE_DEFINITIONS = Object.freeze({
  [DATA_SOURCE_KEYS.QUICKBOOKS]: Object.freeze({
    key: DATA_SOURCE_KEYS.QUICKBOOKS,
    label: "QuickBooks Online",
    mode: "quickbooks",
    supportsConnection: true,
  }),
  [DATA_SOURCE_KEYS.MANUAL_GL]: Object.freeze({
    key: DATA_SOURCE_KEYS.MANUAL_GL,
    label: "Manual GL Upload",
    mode: "manual",
    supportsConnection: false,
  }),
  [DATA_SOURCE_KEYS.MANUAL_UPLOAD]: Object.freeze({
    key: DATA_SOURCE_KEYS.MANUAL_UPLOAD,
    label: "Manual Upload (Excel or PDF)",
    mode: "manual_upload",
    supportsConnection: false,
  }),
});

const VALID_DATA_SOURCE_KEYS = Object.freeze(
  Object.keys(DATA_SOURCE_DEFINITIONS),
);

const DATA_SOURCE_ALIASES = new Map(
  [
    [DATA_SOURCE_KEYS.QUICKBOOKS, DATA_SOURCE_KEYS.QUICKBOOKS],
    ["quickbooks", DATA_SOURCE_KEYS.QUICKBOOKS],
    ["quickbooks_online", DATA_SOURCE_KEYS.QUICKBOOKS],
    [DATA_SOURCE_KEYS.MANUAL_GL, DATA_SOURCE_KEYS.MANUAL_GL],
    ["manual_gl", DATA_SOURCE_KEYS.MANUAL_GL],
    ["manual_gl_upload", DATA_SOURCE_KEYS.MANUAL_GL],
    [DATA_SOURCE_KEYS.MANUAL_UPLOAD, DATA_SOURCE_KEYS.MANUAL_UPLOAD],
    ["manual_upload", DATA_SOURCE_KEYS.MANUAL_UPLOAD],
    ["manual_report_upload", DATA_SOURCE_KEYS.MANUAL_UPLOAD],
  ].map(([alias, key]) => [String(alias).toLowerCase(), key]),
);

function normalizeDataSourceKey(value, fallback = null) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  return DATA_SOURCE_ALIASES.get(normalized) || fallback;
}

function isSupportedDataSourceKey(value) {
  return VALID_DATA_SOURCE_KEYS.includes(String(value || "").trim());
}

function getDataSourceDefinition(value) {
  const key = normalizeDataSourceKey(value);
  if (!key) return null;
  return DATA_SOURCE_DEFINITIONS[key] || null;
}

function getDataSourceLabel(value) {
  return getDataSourceDefinition(value)?.label || null;
}

function listDataSourceDefinitions() {
  return VALID_DATA_SOURCE_KEYS.map((key) => DATA_SOURCE_DEFINITIONS[key]);
}

const DATA_SOURCE_LABELS = Object.freeze(
  VALID_DATA_SOURCE_KEYS.reduce((accumulator, key) => {
    accumulator[key] = DATA_SOURCE_DEFINITIONS[key].label;
    return accumulator;
  }, {}),
);

module.exports = {
  DATA_SOURCE_KEYS,
  DATA_SOURCE_LABELS,
  VALID_DATA_SOURCE_KEYS,
  normalizeDataSourceKey,
  isSupportedDataSourceKey,
  getDataSourceDefinition,
  getDataSourceLabel,
  listDataSourceDefinitions,
};

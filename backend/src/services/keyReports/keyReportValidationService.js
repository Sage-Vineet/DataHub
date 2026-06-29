const { supabase } = require("../../db");

const TABLE_VALIDATION_RESULTS = "key_report_validation_results";

const DATA_TYPES = Object.freeze([
  "tax_return",
  "bank_statement",
  "chart_of_accounts",
  "general_ledger",
  "balance_sheet",
  "profit_loss",
]);

const DATA_TYPE_LABELS = Object.freeze({
  tax_return: "Tax Return Data",
  bank_statement: "Bank Statement Data",
  chart_of_accounts: "Chart of Accounts Data",
  general_ledger: "General Ledger Data",
  balance_sheet: "Balance Sheet Data",
  profit_loss: "Profit & Loss Data",
});

function normalizeRow(row) {
  if (!row) return null;
  const year = Number(row.year);
  return {
    id: row.id,
    versionId: row.version_id,
    companyId: row.company_id,
    dataType: row.data_type,
    year: Number.isInteger(year) ? year : null,
    status: row.status || row.severity || "warning",
    severity: row.severity || row.status || "warning",
    message: row.message || "",
    metadata: row.metadata || {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function normalizeYearValue(value) {
  const year = Number(value);
  if (!Number.isFinite(year) || year < 0) return null;
  if (year >= 1000 && year <= 9999) return year;
  if (year > 0 && year <= 99) return year >= 70 ? 1900 + year : 2000 + year;
  return null;
}

function inferYearFromText(text) {
  const years = collectYearsFromText(text);
  return years.length ? years[years.length - 1] : null;
}

function collectYearsFromText(value) {
  const text = String(value || '').trim();
  if (!text) return [];

  const years = new Set();
  const fullYearMatches = text.match(/(?:19|20)\d{2}/g) || [];
  fullYearMatches.forEach((match) => years.add(Number(match)));

  const monthPattern = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const monthYearRegex = new RegExp(monthPattern + '[\s._-]*(\d{2,4})', 'ig');
  let monthMatch;
  while ((monthMatch = monthYearRegex.exec(text))) {
    const normalized = normalizeYearValue(monthMatch[1]);
    if (normalized) years.add(normalized);
  }

  return Array.from(years).sort((a, b) => a - b);
}

function normalizeYearList(values) {
  const years = new Set();
  const items = Array.isArray(values) ? values : values == null ? [] : [values];
  for (const value of items) {
    const normalized = normalizeYearValue(value);
    if (normalized) years.add(normalized);
  }
  return Array.from(years).sort((a, b) => a - b);
}

function resolveMappingYears(mapping = {}, syncSummary = {}) {
  const years = new Set();
  const addYears = (values) => {
    normalizeYearList(values).forEach((year) => years.add(year));
  };

  addYears(mapping?.year);
  addYears(mapping?.metadata?.detectedYears);
  addYears(syncSummary?.mappingYearsById?.[mapping?.id]);
  addYears(syncSummary?.mappingYearsByDocumentId?.[mapping?.documentId]);

  if (!years.size) {
    addYears(collectYearsFromText(mapping?.fileName || ''));
  }

  return Array.from(years).sort((a, b) => a - b);
}

function resolveMappingYear(mapping) {
  const years = resolveMappingYears(mapping);
  return years.length ? years[years.length - 1] : null;
}

function pickWorstStatus(current, next) {
  const rank = { success: 0, warning: 1, error: 2 };
  const left = rank[current?.status] ?? 3;
  const right = rank[next?.status] ?? 3;
  return right > left ? next : current;
}

function collectYears(mappingsByCategory = {}, syncSummary = {}) {
  const years = new Set();
  const addYear = (value) => {
    normalizeYearList(value).forEach((year) => years.add(year));
  };

  Object.values(mappingsByCategory || {}).forEach((items) => {
    (items || []).forEach((mapping) => {
      resolveMappingYears(mapping, syncSummary).forEach((year) => years.add(year));
    });
  });

  addYear(syncSummary.years || []);
  addYear(syncSummary.fiscalYears || []);
  addYear(syncSummary.snapshotYears || []);

  return Array.from(years).sort((a, b) => a - b);
}

function buildRowsForCategory({
  dataType,
  label,
  years,
  mappings = [],
  missingMappingIds = new Set(),
  syncSummary = {},
}) {
  const rows = [];
  const resolvedYears = years.length ? years : [null];
  const anyMappings = (mappings || []).length > 0;

  for (const year of resolvedYears) {
    const yearMappings = (mappings || []).filter((mapping) => {
      const mappingYears = resolveMappingYears(mapping, syncSummary);
      if (year == null) return mappingYears.length === 0;
      return mappingYears.includes(year);
    });

    let status = 'warning';
    let severity = 'warning';
    let message = year == null ? `No ${label} selected.` : `No ${label} Identified For ${year}`;
    const fileNames = yearMappings.map((mapping) => mapping.fileName).filter(Boolean);

    if (dataType === 'chart_of_accounts') {
      const chartCount = Number(syncSummary.chartOfAccounts?.accountCount || 0);
      if (chartCount > 0) {
        status = 'success';
        severity = 'success';
        message = 'Chart of Accounts generated successfully.';
      } else {
        message = 'Run Sync to generate the Chart of Accounts.';
      }
    } else if (dataType === 'general_ledger') {
      const glCount = Number(syncSummary.glFiles || 0);
      if (glCount > 0) {
        status = 'success';
        severity = 'success';
        message = `General Ledger processed successfully${year ? ` for ${year}` : ''}.`;
      } else if (!anyMappings) {
        message = 'No General Ledger files linked.';
      }
    } else if (yearMappings.length > 0) {
      const missing = yearMappings.find((mapping) => missingMappingIds.has(mapping.id));
      if (missing) {
        status = 'error';
        severity = 'error';
        message = `Unable To Read ${label}`;
      } else {
        status = 'success';
        severity = 'success';
        message = fileNames.length
          ? `${fileNames[0]} loaded successfully.`
          : `${label} loaded successfully.`;
      }
    } else if (!anyMappings) {
      message = `No ${label} files linked.`;
    }

    rows.push({
      dataType,
      year,
      status,
      severity,
      message,
      metadata: {
        fileNames,
        linkedCount: yearMappings.length,
      },
    });
  }

  return rows;
}

function buildValidationResults({
  version,
  mappingsByCategory = {},
  syncSummary = {},
  warnings = [],
  missingFiles = [],
}) {
  const years = collectYears(mappingsByCategory, syncSummary);
  const missingMappingIds = new Set((missingFiles || []).map((item) => item?.mappingId).filter(Boolean));
  const rows = [];

  const categoryOrder = [
    'tax_return',
    'bank_statement',
    'profit_loss',
    'balance_sheet',
    'general_ledger',
    'chart_of_accounts',
  ];

  for (const dataType of categoryOrder) {
    const label = DATA_TYPE_LABELS[dataType] || dataType;
    const categoryRows = buildRowsForCategory({
      dataType,
      label,
      years,
      mappings: mappingsByCategory[dataType] || [],
      missingMappingIds,
      syncSummary,
    });
    rows.push(...categoryRows);
  }

  // Bubble up any top-level validation warnings so the UI can show them in a
  // detail pane without losing the yearly grid.
  (warnings || []).forEach((warning) => {
    const dataType = warning?.category || warning?.type || 'general_ledger';
    const year = Number(warning?.year);
    rows.push({
      dataType,
      year: Number.isInteger(year) && year > 0 ? year : null,
      status: warning?.type === 'file_missing' ? 'error' : 'warning',
      severity: warning?.type === 'file_missing' ? 'error' : 'warning',
      message: warning?.fileName
        ? `${warning.fileName} could not be validated.`
        : warning?.category
          ? `Validation warning for ${warning.category}.`
          : 'Validation warning.',
      metadata: { warning },
    });
  });

  return rows;
}

async function replaceValidationResults(versionId, companyId, rows = []) {
  if (!versionId || !companyId) return [];

  const { error: deleteError } = await supabase
    .from(TABLE_VALIDATION_RESULTS)
    .delete()
    .eq("version_id", versionId)
    .eq("company_id", companyId);
  if (deleteError) throw deleteError;

  const insertRows = (rows || []).map((row) => ({
    version_id: versionId,
    company_id: companyId,
    data_type: row.dataType,
    year: Number.isInteger(Number(row.year)) ? Number(row.year) : null,
    status: row.status || row.severity || "warning",
    severity: row.severity || row.status || "warning",
    message: row.message || "",
    metadata: row.metadata || {},
  }));

  if (!insertRows.length) return [];

  const { data, error } = await supabase
    .from(TABLE_VALIDATION_RESULTS)
    .insert(insertRows)
    .select("*");
  if (error) throw error;
  return (data || []).map(normalizeRow);
}

async function listValidationResults(versionId) {
  if (!versionId) return [];
  const { data, error } = await supabase
    .from(TABLE_VALIDATION_RESULTS)
    .select("*")
    .eq("version_id", versionId)
    .order("year", { ascending: true, nullsFirst: false })
    .order("data_type", { ascending: true });
  if (error) throw error;
  return (data || []).map(normalizeRow);
}

module.exports = {
  DATA_TYPES,
  DATA_TYPE_LABELS,
  buildValidationResults,
  replaceValidationResults,
  listValidationResults,
  resolveMappingYear,
  inferYearFromText,
};

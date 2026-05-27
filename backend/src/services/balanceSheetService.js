const { supabase } = require("../db");

const MANUAL_BALANCE_SHEET_SNAPSHOT_REPORT_TYPE = "manual_balance_sheet_snapshot";
const MANUAL_BALANCE_SHEET_SOURCE = "MANUAL_UPLOAD";
const BALANCE_SHEET_VALIDATION_EPSILON = 0.01;

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function roundMoney(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseDateFlexible(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  if (typeof value === "number") {
    const excelEpoch = new Date(1899, 11, 30);
    return new Date(excelEpoch.getTime() + value * 86400000);
  }

  const raw = String(value).trim();
  if (!raw) return null;

  let parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  const parts = raw.split(/[/-]/);
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      parsed = new Date(`${parts[0]}-${parts[1]}-${parts[2]}`);
    } else {
      parsed = new Date(`${parts[2]}-${parts[0]}-${parts[1]}`);
      if (Number.isNaN(parsed.getTime())) {
        parsed = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
      }
    }
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

function toIsoDate(value) {
  const date = parseDateFlexible(value);
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function parseAmount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  let cleaned = raw
    .replace(/[$,\s]/g, "")
    .replace(/\((.*)\)/, "-$1")
    .replace(/^[=]/, "")
    .replace(/\.{2,}/g, "");

  if (!cleaned) return null;

  if (/^[-+]?[\d.]+$/.test(cleaned)) {
    const numeric = Number(cleaned);
    return Number.isFinite(numeric) ? numeric : null;
  }

  return null;
}

function firstTextCell(cells = []) {
  for (const cell of cells) {
    const text = String(cell || "").trim();
    if (/[a-z]/i.test(text)) return text;
  }
  return "";
}

function findAmountInRow(cells = []) {
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    const amount = parseAmount(cells[index]);
    if (amount !== null) return amount;
  }
  return null;
}

function isTotalLabel(labelKey = "") {
  return (
    labelKey === "total" ||
    labelKey.startsWith("total ") ||
    labelKey.includes("total assets") ||
    labelKey.includes("total liabilities") ||
    labelKey.includes("total equity") ||
    labelKey.includes("total liabilities and equity")
  );
}

function resolveSection(label) {
  const key = normalizeKey(label);
  if (!key) return null;

  if (key.includes("liabilities and equity")) return null;
  if (key === "assets" || key.startsWith("assets ")) return "assets";
  if (key.includes("liabilit")) return "liabilities";
  if (key.includes("equity") || key.includes("stockholder") || key.includes("shareholder")) return "equity";
  return null;
}

function extractAsOfDate(rawRows = []) {
  const rowLimit = Math.min(rawRows.length, 25);
  const asOfPattern = /as\s+of\s+([-a-z0-9,/ ]{4,50})/i;

  for (let index = 0; index < rowLimit; index += 1) {
    const row = Array.isArray(rawRows[index]) ? rawRows[index] : [];
    const joined = row.map((cell) => String(cell || "").trim()).join(" ");
    const match = joined.match(asOfPattern);
    if (match?.[1]) {
      const asOfDate = toIsoDate(match[1]);
      if (asOfDate) return asOfDate;
    }
  }

  for (let index = 0; index < rowLimit; index += 1) {
    const row = Array.isArray(rawRows[index]) ? rawRows[index] : [];
    for (const cell of row) {
      const asOfDate = toIsoDate(cell);
      if (asOfDate) return asOfDate;
    }
  }

  return null;
}

function processBalanceSheet(fileData = {}) {
  const rawRows = Array.isArray(fileData.rawRows) ? fileData.rawRows : [];
  if (!rawRows.length) {
    throw new Error("Balance Sheet parsing failed: file has no readable rows.");
  }

  const result = {
    asOfDate: extractAsOfDate(rawRows),
    assets: [],
    liabilities: [],
    equity: [],
  };

  let currentSection = null;
  rawRows.forEach((row) => {
    const cells = Array.isArray(row) ? row : [];
    if (!cells.length) return;

    const label = firstTextCell(cells);
    const labelKey = normalizeKey(label);
    if (!labelKey) return;

    const section = resolveSection(label);
    if (section) {
      currentSection = section;
      return;
    }

    if (!currentSection || labelKey.includes("as of")) return;

    const amount = findAmountInRow(cells);
    if (amount === null || !Number.isFinite(amount)) return;
    if (isTotalLabel(labelKey)) return;

    result[currentSection].push({
      name: label,
      amount: roundMoney(amount),
    });
  });

  const missingSections = ["assets", "liabilities", "equity"].filter(
    (sectionName) => !Array.isArray(result[sectionName]) || result[sectionName].length === 0
  );
  if (missingSections.length) {
    throw new Error(
      `Balance Sheet parsing failed: missing categories (${missingSections.join(", ")}).`
    );
  }

  return result;
}

function validateBalanceSheet(data = {}) {
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const liabilities = Array.isArray(data.liabilities) ? data.liabilities : [];
  const equity = Array.isArray(data.equity) ? data.equity : [];

  const totalAssets = roundMoney(assets.reduce((sum, item) => sum + Number(item?.amount || 0), 0));
  const totalLiabilities = roundMoney(liabilities.reduce((sum, item) => sum + Number(item?.amount || 0), 0));
  const totalEquity = roundMoney(equity.reduce((sum, item) => sum + Number(item?.amount || 0), 0));
  const expectedAssets = roundMoney(totalLiabilities + totalEquity);
  const difference = roundMoney(totalAssets - expectedAssets);
  const isValid = Math.abs(difference) <= BALANCE_SHEET_VALIDATION_EPSILON;

  return {
    isValid,
    totals: {
      totalAssets,
      totalLiabilities,
      totalEquity,
      expectedAssets,
    },
    difference,
    message: isValid
      ? "Balance Sheet is balanced."
      : `Unbalanced sheet: assets (${totalAssets}) do not equal liabilities + equity (${expectedAssets}).`,
  };
}

async function saveBalanceSheetSnapshot({
  companyId,
  stagedDataId,
  sourceUploadId,
  data,
  validation,
}) {
  if (!companyId) throw new Error("companyId is required");
  if (!stagedDataId) throw new Error("stagedDataId is required");
  if (!data || typeof data !== "object") throw new Error("Balance Sheet data is required");

  const now = new Date().toISOString();
  const normalizedAsOfDate = toIsoDate(data.asOfDate) || data.asOfDate || null;
  const payload = {
    manual_balance_sheet_snapshot: {
      companyId,
      stagedDataId,
      sourceUploadId: sourceUploadId || null,
      asOfDate: normalizedAsOfDate,
      assets: data.assets || [],
      liabilities: data.liabilities || [],
      equity: data.equity || [],
      source: MANUAL_BALANCE_SHEET_SOURCE,
      totals: validation?.totals || null,
      validation: validation || null,
      createdAt: now,
      savedAt: now,
    },
  };

  const { data: row, error } = await supabase
    .from("qb_synced_reports")
    .upsert(
      {
        company_id: companyId,
        report_type: MANUAL_BALANCE_SHEET_SNAPSHOT_REPORT_TYPE,
        report_params: {
          stagedDataId,
          asOfDate: normalizedAsOfDate,
          dataset_version_id: data.datasetVersionId || null,
        },
        data: payload,
        source: MANUAL_BALANCE_SHEET_SOURCE,
        status: validation?.isValid ? "validated" : "invalid",
        last_synced_at: now,
        updated_at: now,
      },
      { onConflict: "company_id,report_type,report_params" }
    )
    .select("id, report_type, report_params, data, status, updated_at")
    .single();

  if (error) {
    throw new Error(`Failed to save Balance Sheet snapshot: ${error.message}`);
  }

  return row;
}

module.exports = {
  MANUAL_BALANCE_SHEET_SNAPSHOT_REPORT_TYPE,
  MANUAL_BALANCE_SHEET_SOURCE,
  processBalanceSheet,
  validateBalanceSheet,
  saveBalanceSheetSnapshot,
};

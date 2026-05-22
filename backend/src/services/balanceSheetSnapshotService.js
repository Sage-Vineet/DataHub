const { supabase } = require("../db");
const {
  MANUAL_BALANCE_SHEET_SNAPSHOT_REPORT_TYPE,
  MANUAL_BALANCE_SHEET_SOURCE,
  validateBalanceSheet,
} = require("./balanceSheetService");

function roundMoney(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseAmount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const raw = String(value).trim();
  if (!raw) return null;

  const cleaned = raw
    .replace(/[$,\s]/g, "")
    .replace(/\((.*)\)/, "-$1")
    .replace(/^[=]/, "")
    .replace(/\.{2,}/g, "");

  if (!cleaned) return null;
  if (!/^[-+]?[\d.]+$/.test(cleaned)) return null;

  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : null;
}

function toIsoDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeLineItems(items = [], prefix = "line") {
  if (!Array.isArray(items)) return [];

  return items
    .map((item, index) => {
      const name = String(item?.name || item?.account || "").trim();
      const amount = parseAmount(item?.amount ?? item?.balance ?? item?.value);
      if (!name || amount === null) return null;

      return {
        id: String(item?.id || `${prefix}-${index + 1}`),
        name,
        amount: roundMoney(amount),
      };
    })
    .filter(Boolean);
}

function normalizeSnapshot(rowOrSnapshot = {}) {
  const fromRow = rowOrSnapshot?.data?.manual_balance_sheet_snapshot || rowOrSnapshot?.manual_balance_sheet_snapshot;
  const raw = fromRow && typeof fromRow === "object" ? fromRow : rowOrSnapshot;

  if (!raw || typeof raw !== "object") return null;

  const assets = normalizeLineItems(raw.assets, "asset");
  const liabilities = normalizeLineItems(raw.liabilities, "liability");
  const equity = normalizeLineItems(raw.equity, "equity");

  return {
    stagedDataId: raw.stagedDataId || rowOrSnapshot?.report_params?.stagedDataId || null,
    sourceUploadId: raw.sourceUploadId || null,
    asOfDate: toIsoDate(raw.asOfDate || raw.as_of_date) || null,
    assets,
    liabilities,
    equity,
    totals: raw.totals || null,
    source: raw.source || rowOrSnapshot?.source || MANUAL_BALANCE_SHEET_SOURCE,
  };
}

function isRenderableSnapshot(snapshot = {}, rowStatus = "") {
  if (!snapshot || typeof snapshot !== "object") return false;

  const status = String(rowStatus || "").toLowerCase();
  if (status === "invalid") return false;

  if (!snapshot.assets?.length || !snapshot.liabilities?.length || !snapshot.equity?.length) {
    return false;
  }

  const validation = validateBalanceSheet(snapshot);
  return Boolean(validation?.isValid);
}

function computeTotals(snapshot = {}) {
  const provided = snapshot?.totals || {};
  const totalAssets = roundMoney(
    Number.isFinite(Number(provided.totalAssets))
      ? Number(provided.totalAssets)
      : (snapshot.assets || []).reduce((sum, item) => sum + Number(item?.amount || 0), 0)
  );
  const totalLiabilities = roundMoney(
    Number.isFinite(Number(provided.totalLiabilities))
      ? Number(provided.totalLiabilities)
      : (snapshot.liabilities || []).reduce((sum, item) => sum + Number(item?.amount || 0), 0)
  );
  const totalEquity = roundMoney(
    Number.isFinite(Number(provided.totalEquity))
      ? Number(provided.totalEquity)
      : (snapshot.equity || []).reduce((sum, item) => sum + Number(item?.amount || 0), 0)
  );

  return {
    totalAssets,
    totalLiabilities,
    totalEquity,
    totalLiabilitiesAndEquity: roundMoney(totalLiabilities + totalEquity),
  };
}

async function getLatestBalanceSheetSnapshot(companyId, options = {}) {
  if (!companyId) throw new Error("companyId is required");

  const requestedAsOfDate = toIsoDate(
    options?.asOfDate || options?.as_of_date || options?.endDate || options?.end_date || null
  );

  const { data, error } = await supabase
    .from("qb_synced_reports")
    .select("id, company_id, report_params, data, source, status, created_at, updated_at, last_synced_at")
    .eq("company_id", companyId)
    .eq("report_type", MANUAL_BALANCE_SHEET_SNAPSHOT_REPORT_TYPE)
    .order("created_at", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(25);

  if (error) {
    throw new Error(`Failed to fetch Balance Sheet snapshots: ${error.message}`);
  }

  const rows = Array.isArray(data) ? data : [];
  if (!rows.length) return null;

  let selectedRow = rows[0];
  if (requestedAsOfDate) {
    selectedRow = rows.find((row) => {
      const snapshot = normalizeSnapshot(row);
      return snapshot?.asOfDate === requestedAsOfDate;
    });
    if (!selectedRow) return null;
  }

  const snapshot = normalizeSnapshot(selectedRow);
  if (!isRenderableSnapshot(snapshot, selectedRow?.status)) {
    return null;
  }

  return {
    id: selectedRow.id,
    companyId,
    stagedDataId: snapshot.stagedDataId || null,
    sourceUploadId: snapshot.sourceUploadId || null,
    snapshot,
    asOfDate: snapshot.asOfDate,
    source: snapshot.source || MANUAL_BALANCE_SHEET_SOURCE,
    status: selectedRow.status || null,
    createdAt: selectedRow.created_at || null,
    updatedAt: selectedRow.updated_at || null,
    lastSyncedAt: selectedRow.last_synced_at || null,
  };
}

async function getBalanceSheetSnapshot(companyId, asOfDate = null) {
  return getLatestBalanceSheetSnapshot(companyId, { asOfDate });
}

function formatMoney(value) {
  return roundMoney(Number(value || 0)).toFixed(2);
}

function buildDataRow(name, amount, id = "") {
  return {
    type: "Data",
    ColData: [
      id ? { id, value: String(name || "") } : { value: String(name || "") },
      { value: formatMoney(amount) },
    ],
  };
}

function buildSection({ name, rows = [], total = 0, totalLabel = "" }) {
  const section = {
    type: "Section",
    Header: { ColData: [{ value: String(name || "Section") }] },
    Summary: {
      ColData: [
        { value: totalLabel || `Total ${name}` },
        { value: formatMoney(total) },
      ],
    },
  };

  if (Array.isArray(rows) && rows.length > 0) {
    section.Rows = { Row: rows };
  }

  return section;
}

function buildQuickbooksBalanceSheetFromSnapshot({
  snapshot,
  accountingMethod = "Accrual",
  startDate = "",
  endDate = "",
} = {}) {
  const normalized = normalizeSnapshot(snapshot);
  if (!normalized || !isRenderableSnapshot(normalized)) return null;

  const totals = computeTotals(normalized);
  const asOfDate = normalized.asOfDate || toIsoDate(endDate) || new Date().toISOString().slice(0, 10);
  const resolvedStart = toIsoDate(startDate) || asOfDate;
  const resolvedEnd = toIsoDate(endDate) || asOfDate;

  const assetsRows = normalized.assets.map((item) =>
    buildDataRow(item.name, item.amount, item.id)
  );
  const liabilitiesRows = normalized.liabilities.map((item) =>
    buildDataRow(item.name, item.amount, item.id)
  );
  const equityRows = normalized.equity.map((item) =>
    buildDataRow(item.name, item.amount, item.id)
  );

  const liabilitiesSection = buildSection({
    name: "Liabilities",
    rows: liabilitiesRows,
    total: totals.totalLiabilities,
    totalLabel: "Total Liabilities",
  });
  const equitySection = buildSection({
    name: "Equity",
    rows: equityRows,
    total: totals.totalEquity,
    totalLabel: "Total Equity",
  });

  return {
    Header: {
      ReportName: "BalanceSheet",
      Time: new Date().toISOString(),
      StartPeriod: resolvedStart,
      EndPeriod: resolvedEnd,
      ReportBasis: accountingMethod || "Accrual",
      Currency: "USD",
    },
    Columns: {
      Column: [{ ColTitle: "Account" }, { ColTitle: "Total", ColType: "Money" }],
    },
    Rows: {
      Row: [
        buildSection({
          name: "Assets",
          rows: assetsRows,
          total: totals.totalAssets,
          totalLabel: "Total Assets",
        }),
        buildSection({
          name: "Liabilities and Equity",
          rows: [liabilitiesSection, equitySection],
          total: totals.totalLiabilitiesAndEquity,
          totalLabel: "Total Liabilities and Equity",
        }),
      ],
    },
  };
}

module.exports = {
  getLatestBalanceSheetSnapshot,
  getBalanceSheetSnapshot,
  buildQuickbooksBalanceSheetFromSnapshot,
};

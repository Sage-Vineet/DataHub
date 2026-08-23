const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { canAccessCompany } = require("../services/permissionService");
const keyReportService = require("../services/keyReports/keyReportService");
const fileReferenceService = require("../services/fileReferenceService");
const userPreferenceService = require("../services/userPreferenceService");
const chartOfAccountsService = require("../services/chartOfAccountsService");
const { normalizeError, isConnectionError } = require("../utils/dbErrorHandler");

const router = express.Router();
router.use(requireAuth);

const POPUP_PREF_KEY = "key_reports_popup_dismissed";

function resolveClientId(req) {
  let clientId =
    req.headers["x-client-id"] ||
    req.query.clientId ||
    req.body?.companyId ||
    req.body?.clientId;
  if (!clientId && req.headers.referer) {
    const match =
      req.headers.referer.match(/\/client\/([^/]+)/) ||
      req.headers.referer.match(/\/workspace\/([^/]+)/);
    if (match) clientId = match[1];
  }
  return clientId;
}

function requireCompanyAccess(req, res, companyId) {
  if (!companyId) {
    res.status(400).json({ success: false, error: "Missing companyId / clientId." });
    return false;
  }
  if (!canAccessCompany(req.user, companyId)) {
    res.status(403).json({ success: false, error: "You do not have permission for this company's Key Reports." });
    return false;
  }
  return true;
}

// Resolve a version and verify the caller can access its company.
async function loadVersionWithAccess(req, res) {
  const version = await keyReportService.getVersion(req.params.versionId);
  if (!version) {
    res.status(404).json({ success: false, error: "Key Report version not found." });
    return null;
  }
  if (!requireCompanyAccess(req, res, version.companyId)) return null;
  return version;
}

function handleError(res, error, label) {
  const normalizedError = normalizeError(error);
  const status =
    normalizedError.status ||
    (normalizedError.code === "FILE_LINKED"
      ? 409
      : isConnectionError(normalizedError)
        ? 503
        : 500);
  if (status >= 500) {
    console.error(`[KeyReports] ${label} failed`, {
      error: normalizedError.message,
      stack: normalizedError.stack,
    });
  }
  return res.status(status).json({
    success: false,
    code: normalizedError.code || undefined,
    error: normalizedError.message || "Key Reports request failed.",
  });
}

// ---- Versions --------------------------------------------------------------

// ---- Mappings --------------------------------------------------------------

router.get("/key-reports/versions/:versionId/mappings", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const mappingsByCategory = await keyReportService.getMappingsByCategory(version.id);
    return res.json({ success: true, mappingsByCategory });
  } catch (error) {
    return handleError(res, error, "GET mappings");
  }
});

router.post("/key-reports/versions/:versionId/mappings", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const { reportCategory, documentId, documentIds } = req.body || {};
    const ids = Array.isArray(documentIds) ? documentIds : documentId ? [documentId] : [];
    if (!ids.length) {
      return res.status(400).json({ success: false, error: "documentId(s) required." });
    }
    const created = [];
    for (const id of ids) {
      created.push(await keyReportService.addMapping(version.id, { reportCategory, documentId: id }, req.user?.id));
    }
    return res.status(201).json({ success: true, mappings: created });
  } catch (error) {
    return handleError(res, error, "POST mappings");
  }
});

router.delete("/key-reports/mappings/:mappingId", async (req, res) => {
  try {
    // Access is enforced via the parent version's company. Look it up first.
    const { supabase } = require("../db");
    const { data: row } = await supabase
      .from("key_report_file_mappings")
      .select("company_id")
      .eq("id", req.params.mappingId)
      .maybeSingle();
    if (!row) return res.status(404).json({ success: false, error: "Mapping not found." });
    if (!requireCompanyAccess(req, res, row.company_id)) return;
    await keyReportService.removeMapping(req.params.mappingId);
    return res.status(204).send();
  } catch (error) {
    return handleError(res, error, "DELETE mapping");
  }
});

// ---- Sync ------------------------------------------------------------------

router.post("/key-reports/versions/:versionId/sync", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const result = await keyReportService.syncVersion(version.id, req.user?.id);
    return res.json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "POST sync");
  }
});

router.get("/key-reports/versions/:versionId/extracted-data", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const { dataType, year, page, pageSize, search } = req.query;
    const result = await keyReportService.getExtractedData(version.id, {
      dataType,
      year,
      page,
      pageSize,
      search,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "GET extracted-data");
  }
});

router.get("/key-reports/versions/:versionId/sync-logs", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const logs = await keyReportService.listSyncLogs(version.id);
    return res.json({ success: true, syncLogs: logs });
  } catch (error) {
    return handleError(res, error, "GET sync-logs");
  }
});

// ---- Chart of Accounts -----------------------------------------------------

// Helper: verify the caller can access the company that owns a COA account.
async function loadAccountWithAccess(req, res) {
  const { supabase } = require("../db");
  const { data: row } = await supabase
    .from("chart_of_accounts")
    .select("company_id, version_id")
    .eq("id", req.params.accountId)
    .maybeSingle();
  if (!row) {
    res.status(404).json({ success: false, error: "Account not found." });
    return null;
  }
  if (!requireCompanyAccess(req, res, row.company_id)) return null;
  return row;
}

// The standardized hierarchy taxonomy (reference data for UI level filters).
// Fetch a version's COA as a deep tree + flat list (15-level hierarchy).
// Classification + adjustment audit history for a version.
// Rebuild a version's COA from its entry tables (general_ledger_entries +
// balance_sheet_entries). batchId=null → reads from Key Reports entry tables,
// which is correct for all new-style syncs (resolvedBatchId is always null).
router.post("/key-reports/versions/:versionId/chart-of-accounts/regenerate", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    console.log(`[KeyReports][Audit] COA regenerate versionId=${version.id} resolvedBatchId=${version.resolvedBatchId || 'null (entry-table path)'}`);
    const summary = await chartOfAccountsService.generateChartOfAccounts(
      version.companyId,
      version.id,
      version.resolvedBatchId || null,
    );
    // Re-run the COA spec checks so a manual rebuild reports its own health.
    // (Not persisted here — replaceValidationResults would wipe the other data
    //  types' rows; persistence happens during a full Sync.)
    let validation = null;
    try {
      validation = await chartOfAccountsService.validateChartOfAccounts(version.companyId, version.id);
    } catch (vErr) {
      console.warn(`[KeyReports][Audit] COA regenerate validation failed: ${vErr.message}`);
    }
    const coa = await chartOfAccountsService.getChartOfAccounts(version.id);
    return res.json({ success: true, summary, validation: validation ? validation.summary : null, ...coa });
  } catch (error) {
    return handleError(res, error, "POST chart-of-accounts/regenerate");
  }
});

// Update a single COA account: rename (adjustedName), move/reclassify (levels +
// accountType/statementType), activate/deactivate. Writes adjustment + history
// audit; never touches the original AI classification.
// Restore a single account to its original AI classification.
// Bulk-save an edited hierarchy for a version.
// Restore the entire version's hierarchy to the original AI classification.
// ---- File references (deletion guard / "linked" badges) --------------------

// ---- Educational popup preference (per user) -------------------------------

router.get("/key-reports/popup-preference", async (req, res) => {
  try {
    const value = await userPreferenceService.getPreference(req.user?.id, POPUP_PREF_KEY);
    return res.json({ success: true, dismissed: Boolean(value?.dismissed) });
  } catch (error) {
    return handleError(res, error, "GET popup-preference");
  }
});

router.put("/key-reports/popup-preference", async (req, res) => {
  try {
    const dismissed = req.body?.dismissed === true || req.body?.dismissed === "true";
    await userPreferenceService.setPreference(req.user?.id, POPUP_PREF_KEY, { dismissed });
    return res.json({ success: true, dismissed });
  } catch (error) {
    return handleError(res, error, "PUT popup-preference");
  }
});

// ---- Reports (read ONLY from Key Reports entry tables) ---------------------
// These endpoints are the single authoritative report source for Key Reports.
// They NEVER touch Manual GL staging, active batches, or snapshots.

function parseReportQuery(q = {}) {
  // `year` accepts a single fiscal year. A comma list (e.g. "2022,2023") is NOT a
  // single year — collapse it to a date range so spec #12/#13 still resolve the
  // full year set rather than silently using only the first value.
  const rawYear = q.year != null ? String(q.year).trim() : "";
  const isSingleYear = /^\d{4}$/.test(rawYear);
  return {
    year: isSingleYear ? parseInt(rawYear, 10) : null,
    startDate: q.startDate ? String(q.startDate) : null,
    endDate: q.endDate ? String(q.endDate) : null,
    // "month" → monthly columns (Jan…Dec); anything else → fiscal-year columns.
    period: String(q.period || "").toLowerCase() === "month" ? "month" : "year",
    page: parseInt(String(q.page || 1), 10) || 1,
    pageSize: parseInt(String(q.pageSize || 500), 10) || 500,
  };
}

// ── COA-mapped Financial Statements (P&L + Balance Sheet, monthly + yearly) ───
// GET /key-reports/versions/:versionId/reports/financial-statements?year=2024&currency=USD
module.exports = router;

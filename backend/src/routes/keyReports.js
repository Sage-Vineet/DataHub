const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { canAccessCompany } = require("../services/permissionService");
const keyReportService = require("../services/keyReportService");
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

router.get("/key-reports/versions", async (req, res) => {
  try {
    const companyId = resolveClientId(req);
    if (!requireCompanyAccess(req, res, companyId)) return;
    const versions = await keyReportService.listVersions(companyId);
    const active = versions.find((v) => v.isActive) || null;
    return res.json({ success: true, versions, activeVersionId: active?.id || null });
  } catch (error) {
    return handleError(res, error, "GET /key-reports/versions");
  }
});

router.post("/key-reports/versions", async (req, res) => {
  try {
    const companyId = resolveClientId(req);
    if (!requireCompanyAccess(req, res, companyId)) return;
    const version = await keyReportService.createVersion(
      companyId,
      { versionName: req.body?.versionName, copyFromVersionId: req.body?.copyFromVersionId },
      req.user?.id
    );
    return res.status(201).json({ success: true, version });
  } catch (error) {
    return handleError(res, error, "POST /key-reports/versions");
  }
});

router.get("/key-reports/versions/:versionId", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const [mappingsByCategory, syncLogs] = await Promise.all([
      keyReportService.getMappingsByCategory(version.id),
      keyReportService.listSyncLogs(version.id),
    ]);
    return res.json({ success: true, version, mappingsByCategory, syncLogs });
  } catch (error) {
    return handleError(res, error, "GET /key-reports/versions/:versionId");
  }
});

router.put("/key-reports/versions/:versionId", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const updated = await keyReportService.updateVersion(
      version.id,
      { versionName: req.body?.versionName, status: req.body?.status },
      req.user?.id
    );
    return res.json({ success: true, version: updated });
  } catch (error) {
    return handleError(res, error, "PUT /key-reports/versions/:versionId");
  }
});

router.post("/key-reports/versions/:versionId/duplicate", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const dup = await keyReportService.duplicateVersion(
      version.id,
      { versionName: req.body?.versionName },
      req.user?.id
    );
    return res.status(201).json({ success: true, version: dup });
  } catch (error) {
    return handleError(res, error, "POST /key-reports/versions/:versionId/duplicate");
  }
});

router.post("/key-reports/versions/:versionId/activate", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const activated = await keyReportService.switchActiveVersion(
      version.companyId,
      version.id,
      req.user?.id
    );
    return res.json({ success: true, version: activated });
  } catch (error) {
    return handleError(res, error, "POST /key-reports/versions/:versionId/activate");
  }
});

router.delete("/key-reports/versions/:versionId", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    await keyReportService.deleteVersion(version.id);
    return res.status(204).send();
  } catch (error) {
    return handleError(res, error, "DELETE /key-reports/versions/:versionId");
  }
});

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

// Fetch a version's COA hierarchy (groups with their child accounts).
router.get("/key-reports/versions/:versionId/chart-of-accounts", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const coa = await chartOfAccountsService.getChartOfAccounts(version.id);
    return res.json({ success: true, ...coa });
  } catch (error) {
    return handleError(res, error, "GET chart-of-accounts");
  }
});

// Rebuild a version's COA from its currently-resolved Manual GL batch (without a
// full re-sync). Useful after editing classifications or relinking files.
router.post("/key-reports/versions/:versionId/chart-of-accounts/regenerate", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    if (!version.resolvedBatchId) {
      return res.status(409).json({
        success: false,
        error: "This version has no synced General Ledger data yet. Run Sync first.",
      });
    }
    const summary = await chartOfAccountsService.generateChartOfAccounts(
      version.companyId,
      version.id,
      version.resolvedBatchId,
    );
    const coa = await chartOfAccountsService.getChartOfAccounts(version.id);
    return res.json({ success: true, summary, ...coa });
  } catch (error) {
    return handleError(res, error, "POST chart-of-accounts/regenerate");
  }
});

// Update a single COA account (rename, reclassify, reparent, activate/deactivate).
router.patch("/key-reports/chart-of-accounts/:accountId", async (req, res) => {
  try {
    const { supabase } = require("../db");
    const { data: row } = await supabase
      .from("chart_of_accounts")
      .select("company_id")
      .eq("id", req.params.accountId)
      .maybeSingle();
    if (!row) return res.status(404).json({ success: false, error: "Account not found." });
    if (!requireCompanyAccess(req, res, row.company_id)) return;
    const account = await chartOfAccountsService.updateAccount(req.params.accountId, req.body || {});
    return res.json({ success: true, account });
  } catch (error) {
    return handleError(res, error, "PATCH chart-of-accounts");
  }
});

// ---- File references (deletion guard / "linked" badges) --------------------

router.get("/key-reports/file-references", async (req, res) => {
  try {
    const companyId = resolveClientId(req);
    if (!requireCompanyAccess(req, res, companyId)) return;
    const idsParam = req.query.documentIds || req.query.documentId;
    const ids = String(idsParam || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const counts = await fileReferenceService.getReferenceCountsForDocuments(ids);
    return res.json({ success: true, counts });
  } catch (error) {
    return handleError(res, error, "GET file-references");
  }
});

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

module.exports = router;

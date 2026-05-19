const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  REPORT_SOURCE_KEYS,
} = require("../services/reportSourceStore");
const dataSourceService = require("../services/dataSourceService");
const { canAccessCompany } = require("../services/permissionService");

const router = express.Router();

router.use(requireAuth);

function resolveClientId(req) {
  let clientId = req.headers["x-client-id"] || req.query.clientId;

  if (!clientId && req.headers.referer) {
    const match =
      req.headers.referer.match(/\/client\/([^/]+)/) ||
      req.headers.referer.match(/\/workspace\/([^/]+)/);
    if (match) clientId = match[1];
  }

  return clientId;
}

function requireClientAccess(req, res, clientId) {
  if (!canAccessCompany(req.user, clientId)) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

router.get("/report-sources", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) {
      return res.status(400).json({ success: false, error: "Missing clientId." });
    }
    if (!requireClientAccess(req, res, clientId)) return;

    const state = await dataSourceService.getDataSourceState(clientId);
    const selectedSource = state.activeSource || REPORT_SOURCE_KEYS.QUICKBOOKS;
    const activeSource = state.activeSource || null;

    return res.json({
      success: true,
      sources: state.sources || [],
      selectedSource,
      activeSource,
      quickbooksConnected: Boolean(state.quickbooksConnected),
      manualUploadActive: Boolean(state.manualUploadActive),
      lastSourceSwitchAt: state.lastSourceSwitchAt || null,
    });
  } catch (error) {
    console.error("[ReportSources] GET /report-sources failed", {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to load report sources.",
    });
  }
});

router.put("/report-sources/selected", async (req, res) => {
  const requestStart = Date.now();
  const clientId = resolveClientId(req);

  try {
    const sourceKey = String(req.body?.sourceKey || "").trim();
    const confirmSwitch = req.body?.confirmSwitch === true || req.body?.confirmSwitch === "true";
    const forceDisconnectQuickbooks =
      req.body?.forceDisconnectQuickbooks === true ||
      req.body?.forceDisconnectQuickbooks === "true";

    console.info("[ReportSources] PUT /report-sources/selected — incoming", {
      clientId,
      sourceKey,
      confirmSwitch,
      forceDisconnectQuickbooks,
    });

    if (!clientId) {
      return res.status(400).json({ success: false, error: "Missing clientId." });
    }
    if (!requireClientAccess(req, res, clientId)) return;

    if (!sourceKey) {
      return res.status(400).json({ success: false, error: "sourceKey is required." });
    }

    const result = await dataSourceService.switchDataSource(clientId, sourceKey, {
      confirmSwitch,
      forceDisconnectQuickbooks,
    });

    const durationMs = Date.now() - requestStart;
    console.info("[ReportSources] PUT /report-sources/selected — success", {
      clientId,
      activeSource: result.activeSource,
      quickbooksConnected: result.quickbooksConnected,
      durationMs,
    });

    return res.json({
      success: true,
      sources: result.sources,
      selectedSource: result.activeSource,
      activeSource: result.activeSource,
      quickbooksConnected: Boolean(result.quickbooksConnected),
    });
  } catch (error) {
    const durationMs = Date.now() - requestStart;

    const conflictCodes = new Set([
      "SOURCE_SWITCH_CONFIRMATION_REQUIRED",
      "QB_DISCONNECT_REQUIRED",
      "QUICKBOOKS_SOURCE_ACTIVE",
      "MANUAL_SOURCE_ACTIVE",
    ]);
    const badRequestCodes = new Set(["INVALID_SOURCE_KEY"]);
    const status = conflictCodes.has(error.code)
      ? 409
      : badRequestCodes.has(error.code)
        ? 400
        : 500;

    if (status === 500) {
      console.error("[ReportSources] PUT /report-sources/selected — error", {
        clientId,
        code: error.code,
        error: error.message,
        stack: error.stack,
        durationMs,
      });
    } else {
      console.info("[ReportSources] PUT /report-sources/selected — confirmation required", {
        clientId,
        code: error.code,
        durationMs,
      });
    }

    return res.status(status).json({
      success: false,
      code: error.code || "SOURCE_SWITCH_FAILED",
      error: error.message || "Failed to save report source.",
      message: error.message || "Failed to save report source.",
      requiresConfirmation: Boolean(error.requiresConfirmation),
      nextAction: error.nextAction || null,
      requestedSource: error.requestedSource || null,
      currentSource: error.currentSource || null,
    });
  }
});

module.exports = router;

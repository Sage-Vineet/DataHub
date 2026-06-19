const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { canAccessCompany } = require("../services/permissionService");
const {
  listAdjustmentTypes,
  listEbitdaAdjustments,
  saveEbitdaAdjustmentsBatch,
  deleteEbitdaAdjustment,
  addEbitdaComment,
  normalizeScope,
} = require("../services/ebitdaAdjustmentStore");

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
  if (!clientId) {
    res.status(400).json({ success: false, error: "Missing clientId." });
    return false;
  }
  if (!canAccessCompany(req.user, clientId)) {
    res.status(403).json({ success: false, error: "You do not have permission to access this company." });
    return false;
  }
  return true;
}

function normalizeRequestScope(req) {
  return normalizeScope({
    companyId: resolveClientId(req),
    versionId: req.query.versionId || req.body?.versionId,
    sourceKey: req.query.sourceKey || req.body?.sourceKey || "manual_gl",
    datasetVersionId: req.query.datasetVersionId || req.body?.datasetVersionId,
    uploadBatchId: req.query.uploadBatchId || req.body?.uploadBatchId,
  });
}

router.get("/ebitda-adjustment-types", async (_req, res) => {
  try {
    const types = await listAdjustmentTypes();
    return res.json({ success: true, types });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to load EBITDA adjustment types.",
    });
  }
});

router.get("/ebitda-adjustments", async (req, res) => {
  try {
    const scope = normalizeRequestScope(req);
    if (!requireClientAccess(req, res, scope.companyId)) return;
    if (!scope.versionId) {
      return res.status(400).json({ success: false, error: "Missing versionId." });
    }

    const payload = await listEbitdaAdjustments(scope);
    return res.json({ success: true, ...payload });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to load EBITDA adjustments.",
    });
  }
});

router.post("/ebitda-adjustments/batch", async (req, res) => {
  try {
    const scope = normalizeRequestScope(req);
    if (!requireClientAccess(req, res, scope.companyId)) return;
    if (!scope.versionId) {
      return res.status(400).json({ success: false, error: "Missing versionId." });
    }

    const result = await saveEbitdaAdjustmentsBatch(
      {
        ...scope,
        adjustments: req.body?.adjustments || [],
      },
      req.user?.id || null,
    );

    const refreshed = await listEbitdaAdjustments(scope);
    return res.json({
      success: true,
      ...result,
      ...refreshed,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to save EBITDA adjustments.",
    });
  }
});

router.delete("/ebitda-adjustments/:id", async (req, res) => {
  try {
    const scope = normalizeRequestScope(req);
    if (!requireClientAccess(req, res, scope.companyId)) return;
    if (!scope.versionId) {
      return res.status(400).json({ success: false, error: "Missing versionId." });
    }

    const result = await deleteEbitdaAdjustment(req.params.id, scope, req.user?.id || null);
    const refreshed = await listEbitdaAdjustments(scope);
    return res.json({
      success: true,
      ...result,
      ...refreshed,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to delete EBITDA adjustment.",
    });
  }
});

router.post("/ebitda-adjustments/:id/comments", async (req, res) => {
  try {
    const scope = normalizeRequestScope(req);
    if (!requireClientAccess(req, res, scope.companyId)) return;
    if (!scope.versionId) {
      return res.status(400).json({ success: false, error: "Missing versionId." });
    }

    const comment = await addEbitdaComment(req.params.id, scope, req.body || {}, req.user?.id || null);
    return res.status(201).json({ success: true, comment });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to add EBITDA comment.",
    });
  }
});

module.exports = router;

const express = require("express");
const {
  getWorkspacePageState,
  replaceWorkspacePageState,
  deleteWorkspacePageState,
  getSharedWorkspacePageState,
  replaceSharedWorkspacePageState,
} = require("../services/workspacePageStateStore");
const { requireAuth } = require("../middleware/auth");
const { canAccessCompany } = require("../services/permissionService");

const router = express.Router();

router.use(requireAuth);

const CIM_QUESTIONNAIRE_PAGE_KEY = "cim-questionnaire";

function resolveClientId(req) {
  let clientId = req.headers["x-client-id"] || req.query.clientId;

  if (!clientId && req.headers.referer) {
    const match = req.headers.referer.match(/\/client\/([^/]+)/);
    if (match) clientId = match[1];
  }

  return clientId;
}

function getUserSummary(user) {
  return {
    id: user?.id || null,
    name: user?.name || user?.email || "User",
    email: user?.email || "",
    role: user?.role || user?.effective_role || "",
  };
}

function normalizeQuestionnaireState(input, user) {
  const now = new Date().toISOString();
  const items = input?.items && typeof input.items === "object" ? input.items : {};

  return {
    version: 1,
    items,
    currentBatchId: input?.currentBatchId || "",
    history: Array.isArray(input?.history) ? input.history : [],
    createdAt: input?.createdAt || now,
    sentAt: input?.sentAt || null,
    sentBy: input?.sentBy || null,
    clientSubmittedAt: input?.clientSubmittedAt || null,
    clientSubmittedBy: input?.clientSubmittedBy || null,
    updatedAt: now,
    updatedBy: getUserSummary(user),
  };
}

router.get("/cim-questionnaire", async (req, res) => {
  try {
    const clientId = resolveClientId(req);

    if (!clientId) {
      return res.status(400).json({
        success: false,
        error: "Missing clientId.",
      });
    }
    if (!canAccessCompany(req.user, clientId)) {
      return res.status(403).json({ error: "You do not have permission to access this workspace." });
    }

    const state = await getSharedWorkspacePageState(clientId, CIM_QUESTIONNAIRE_PAGE_KEY, req.user.id);

    return res.json({
      success: true,
      state: state?.payload || null,
      updatedAt: state?.updatedAt || null,
      userId: req.user.id,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Failed to load CIM questionnaire.",
      details: error.message,
    });
  }
});

router.put("/cim-questionnaire", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const payload = normalizeQuestionnaireState(req.body?.state || {}, req.user);

    if (!clientId) {
      return res.status(400).json({
        success: false,
        error: "Missing clientId.",
      });
    }
    if (!canAccessCompany(req.user, clientId)) {
      return res.status(403).json({ error: "You do not have permission to access this workspace." });
    }

    const saved = await replaceSharedWorkspacePageState(
      clientId,
      CIM_QUESTIONNAIRE_PAGE_KEY,
      payload,
      req.user.id,
    );

    return res.json({
      success: true,
      state: saved?.payload || null,
      updatedAt: saved?.updatedAt || payload.updatedAt,
      userId: req.user.id,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Failed to save CIM questionnaire.",
      details: error.message,
    });
  }
});

router.get("/workspace-page-state/:pageKey", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const { pageKey } = req.params;
    const scopedPageKey = `${pageKey}:${req.user.id}`;

    if (!clientId) {
      return res.status(400).json({
        success: false,
        error: "Missing clientId.",
      });
    }
    if (!canAccessCompany(req.user, clientId)) {
      return res.status(403).json({ error: "You do not have permission to access this workspace." });
    }

    const state = await getWorkspacePageState(clientId, scopedPageKey, req.user.id);

    return res.json({
      success: true,
      state: state?.payload || null,
      updatedAt: state?.updatedAt || null,
      userId: req.user.id,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Failed to load workspace page state.",
      details: error.message,
    });
  }
});

router.put("/workspace-page-state/:pageKey", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const { pageKey } = req.params;
    const scopedPageKey = `${pageKey}:${req.user.id}`;
    const payload = req.body?.state;

    if (!clientId) {
      return res.status(400).json({
        success: false,
        error: "Missing clientId.",
      });
    }
    if (!canAccessCompany(req.user, clientId)) {
      return res.status(403).json({ error: "You do not have permission to access this workspace." });
    }

    const saved = await replaceWorkspacePageState(
      clientId,
      scopedPageKey,
      payload,
      req.user.id,
    );

    return res.json({
      success: true,
      state: saved?.payload || null,
      updatedAt: saved?.updatedAt || null,
      userId: req.user.id,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Failed to save workspace page state.",
      details: error.message,
    });
  }
});

router.delete("/workspace-page-state/:pageKey", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const { pageKey } = req.params;
    const scopedPageKey = `${pageKey}:${req.user.id}`;

    if (!clientId) {
      return res.status(400).json({
        success: false,
        error: "Missing clientId.",
      });
    }
    if (!canAccessCompany(req.user, clientId)) {
      return res.status(403).json({ error: "You do not have permission to access this workspace." });
    }

    const deleted = await deleteWorkspacePageState(clientId, scopedPageKey, req.user.id);

    return res.json({
      success: true,
      deleted,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Failed to delete workspace page state.",
      details: error.message,
    });
  }
});

module.exports = router;

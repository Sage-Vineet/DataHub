const express = require("express");
const {
  getWorkspacePageState,
  replaceWorkspacePageState,
  deleteWorkspacePageState,
} = require("../services/workspacePageStateStore");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

function resolveClientId(req) {
  let clientId = req.headers["x-client-id"] || req.query.clientId;

  if (!clientId && req.headers.referer) {
    const match = req.headers.referer.match(/\/client\/([^/]+)/);
    if (match) clientId = match[1];
  }

  return clientId;
}

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

    const state = await getWorkspacePageState(clientId, scopedPageKey);

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

    const saved = await replaceWorkspacePageState(
      clientId,
      scopedPageKey,
      payload,
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

    const deleted = await deleteWorkspacePageState(clientId, scopedPageKey);

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

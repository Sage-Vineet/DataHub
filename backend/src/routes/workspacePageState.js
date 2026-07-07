const express = require("express");
const {
  getWorkspacePageState,
  replaceWorkspacePageState,
  deleteWorkspacePageState,
  getSharedWorkspacePageState,
  replaceSharedWorkspacePageState,
} = require("../services/workspacePageStateStore");
const { requireAuth } = require("../middleware/auth");
const { canAccessCompany, isBroker } = require("../services/permissionService");

const router = express.Router();

router.use(requireAuth);

const CIM_QUESTIONNAIRE_PAGE_KEY = "cim-questionnaire";
const CIM_REVIEW_PAGE_KEY = "cim-review";

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

function normalizeCimReviewNote(note, user) {
  return {
    id: note?.id || `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    author: note?.author || getUserSummary(user),
    body: String(note?.body || "").trim(),
    createdAt: note?.createdAt || new Date().toISOString(),
    kind: note?.kind === "resolution" ? "resolution" : "note",
  };
}

function normalizeCimReviewItem(item) {
  return {
    id: item?.id || item?.fieldId,
    fieldId: item?.fieldId || item?.id,
    slideNumber: item?.slideNumber ?? null,
    sectionId: item?.sectionId || "",
    sectionTitle: item?.sectionTitle || "",
    label: item?.label || "",
    fieldKind: item?.fieldKind || "text",
    status: item?.status === "resolved" ? "resolved" : "open",
    notes: Array.isArray(item?.notes) ? item.notes.map((note) => normalizeCimReviewNote(note)) : [],
    resolvedBy: item?.resolvedBy || null,
    resolvedAt: item?.resolvedAt || null,
    createdAt: item?.createdAt || new Date().toISOString(),
    updatedAt: item?.updatedAt || new Date().toISOString(),
  };
}

function normalizeCimReviewState(input, user) {
  const now = new Date().toISOString();
  const items = {};
  if (input?.items && typeof input.items === "object") {
    Object.entries(input.items).forEach(([fieldId, item]) => {
      items[fieldId] = normalizeCimReviewItem({ ...item, id: item?.id || fieldId, fieldId: item?.fieldId || fieldId });
    });
  }

  return {
    version: 1,
    ownerUserId: input?.ownerUserId || null,
    sharedAt: input?.sharedAt || null,
    sharedBy: input?.sharedBy || null,
    sharedWith: Array.isArray(input?.sharedWith) ? input.sharedWith : [],
    items,
    history: (Array.isArray(input?.history) ? input.history : []).slice(0, 25),
    updatedAt: now,
    updatedBy: getUserSummary(user),
  };
}

function isSharedWithUser(state, userId) {
  return (state?.sharedWith || []).some((member) => String(member.id) === String(userId));
}

// Clients may only append their own notes to existing (or brand-new) items — they can never
// touch sharedWith/ownerUserId or flip status/resolvedBy themselves, since the client is an
// untrusted caller against a whole-payload PUT endpoint.
function mergeClientNoteOnly(existingPayload, incoming, user) {
  const base = normalizeCimReviewState(existingPayload || {}, user);
  const incomingItems = incoming?.items && typeof incoming.items === "object" ? incoming.items : {};
  const now = new Date().toISOString();
  const history = [...base.history];

  Object.entries(incomingItems).forEach(([fieldId, incomingItem]) => {
    const existingItem = base.items[fieldId];
    const existingNoteIds = new Set((existingItem?.notes || []).map((note) => note.id));
    const newNotes = (Array.isArray(incomingItem?.notes) ? incomingItem.notes : [])
      .filter((note) => !existingNoteIds.has(note?.id))
      .filter((note) => String(note?.author?.id) === String(user.id))
      .map((note) => normalizeCimReviewNote(note, user));

    if (!newNotes.length) return;

    const wasResolved = existingItem?.status === "resolved";
    const mergedItem = normalizeCimReviewItem({
      id: fieldId,
      fieldId,
      slideNumber: incomingItem?.slideNumber ?? existingItem?.slideNumber ?? null,
      sectionId: incomingItem?.sectionId || existingItem?.sectionId || "",
      sectionTitle: incomingItem?.sectionTitle || existingItem?.sectionTitle || "",
      label: incomingItem?.label || existingItem?.label || "",
      fieldKind: incomingItem?.fieldKind || existingItem?.fieldKind || "text",
      status: "open",
      notes: [...(existingItem?.notes || []), ...newNotes],
      resolvedBy: null,
      resolvedAt: null,
      createdAt: existingItem?.createdAt || now,
      updatedAt: now,
    });

    base.items[fieldId] = mergedItem;

    newNotes.forEach((note) => {
      history.unshift({
        id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: "note_added",
        at: note.createdAt,
        by: note.author,
        fieldId,
        summary: `${note.author?.name || "Client"} raised a note on ${mergedItem.label || fieldId}`,
      });
    });

    if (wasResolved) {
      history.unshift({
        id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: "reopened",
        at: now,
        by: getUserSummary(user),
        fieldId,
        summary: `${user.name || "Client"} reopened ${mergedItem.label || fieldId}`,
      });
    }
  });

  return {
    ...base,
    history: history.slice(0, 25),
    updatedAt: now,
    updatedBy: getUserSummary(user),
  };
}

router.get("/cim-review", async (req, res) => {
  try {
    const clientId = resolveClientId(req);

    if (!clientId) {
      return res.status(400).json({ success: false, error: "Missing clientId." });
    }
    if (!canAccessCompany(req.user, clientId)) {
      return res.status(403).json({ error: "You do not have permission to access this workspace." });
    }

    const state = await getSharedWorkspacePageState(clientId, CIM_REVIEW_PAGE_KEY, req.user.id);

    return res.json({
      success: true,
      state: state?.payload || null,
      updatedAt: state?.updatedAt || null,
      userId: req.user.id,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Failed to load CIM review.",
      details: error.message,
    });
  }
});

router.put("/cim-review", async (req, res) => {
  try {
    const clientId = resolveClientId(req);

    if (!clientId) {
      return res.status(400).json({ success: false, error: "Missing clientId." });
    }
    if (!canAccessCompany(req.user, clientId)) {
      return res.status(403).json({ error: "You do not have permission to access this workspace." });
    }

    const existing = await getSharedWorkspacePageState(clientId, CIM_REVIEW_PAGE_KEY, req.user.id);
    const incoming = req.body?.state || {};

    let payload;
    if (isBroker(req.user)) {
      payload = normalizeCimReviewState(incoming, req.user);
    } else {
      if (!isSharedWithUser(existing?.payload, req.user.id)) {
        return res.status(403).json({ error: "This CIM has not been shared with you for review." });
      }
      payload = mergeClientNoteOnly(existing?.payload, incoming, req.user);
    }

    const saved = await replaceSharedWorkspacePageState(
      clientId,
      CIM_REVIEW_PAGE_KEY,
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
      error: "Failed to save CIM review.",
      details: error.message,
    });
  }
});

router.get("/cim-review/content", async (req, res) => {
  try {
    const clientId = resolveClientId(req);

    if (!clientId) {
      return res.status(400).json({ success: false, error: "Missing clientId." });
    }
    if (!canAccessCompany(req.user, clientId)) {
      return res.status(403).json({ error: "You do not have permission to access this workspace." });
    }

    const review = await getSharedWorkspacePageState(clientId, CIM_REVIEW_PAGE_KEY, req.user.id);
    const ownerUserId = review?.payload?.ownerUserId;

    if (!ownerUserId) {
      return res.json({ success: true, reviewState: review?.payload || null, cimContent: null });
    }
    if (!isBroker(req.user) && !isSharedWithUser(review.payload, req.user.id)) {
      return res.status(403).json({ error: "This CIM has not been shared with you for review." });
    }

    const cimContent = await getWorkspacePageState(clientId, `cim-prep:${ownerUserId}`, ownerUserId);

    return res.json({
      success: true,
      reviewState: review?.payload || null,
      cimContent: cimContent?.payload || null,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Failed to load CIM review content.",
      details: error.message,
    });
  }
});

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

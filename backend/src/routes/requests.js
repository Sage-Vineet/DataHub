const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  listRequests,
  createRequest,
  createRequestsBulk,
  getRequest,
  updateRequest,
  approveRequest,
  deleteRequest,
  addRequestReminder,
  listRequestDocuments,
  addRequestDocument,
  updateNarrative,
  getNarrativeFile,
} = require("../controllers/requests");

const router = express.Router();

router.get("/companies/:id/requests", requireAuth, listRequests);
router.post("/companies/:id/requests/bulk", requireAuth, createRequestsBulk);
router.post("/companies/:id/requests", requireAuth, createRequest);
router.get("/requests/:id", requireAuth, getRequest);
router.patch("/requests/:id", requireAuth, updateRequest);
router.post("/requests/:id/approve", requireAuth, approveRequest);
router.delete("/requests/:id", requireAuth, deleteRequest);
router.post("/requests/:id/reminders", requireAuth, addRequestReminder);
router.get("/requests/:id/documents", requireAuth, listRequestDocuments);
router.post("/requests/:id/documents", requireAuth, addRequestDocument);
router.patch("/requests/:id/narrative", requireAuth, updateNarrative);
router.get("/requests/:id/narrative/file", requireAuth, getNarrativeFile);

module.exports = router;

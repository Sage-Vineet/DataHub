const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  listRequests,
  createRequest,
  createRequestsBulk,
  getRequest,
  updateRequest,
  deleteRequest,
  addRequestReminder,
  listRequestDocuments,
  addRequestDocument,
  updateNarrative,
  getNarrativeFile,
} = require("../controllers/requests");

const router = express.Router();
router.use(requireAuth);

router.get("/companies/:id/requests", listRequests);
router.post("/companies/:id/requests/bulk", createRequestsBulk);
router.post("/companies/:id/requests", createRequest);
router.get("/requests/:id", getRequest);
router.patch("/requests/:id", updateRequest);
router.delete("/requests/:id", deleteRequest);
router.post("/requests/:id/reminders", addRequestReminder);
router.get("/requests/:id/documents", listRequestDocuments);
router.post("/requests/:id/documents", addRequestDocument);
router.patch("/requests/:id/narrative", updateNarrative);
router.get("/requests/:id/narrative/file", getNarrativeFile);

module.exports = router;

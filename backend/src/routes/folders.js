const express = require("express");
const {
  listFolders,
  listFolderTree,
  createFolder,
  updateFolder,
  deleteFolder,
  moveFolder,
  listFolderDocuments,
  addFolderDocument,
  deleteDocument,
  recordDocumentActivity,
  getDocumentActivity,
} = require("../controllers/folders");

const { requireAuth } = require("../middleware/auth");
const router = express.Router();

router.use(requireAuth);

router.get("/companies/:id/folders/tree", listFolderTree);
router.get("/companies/:id/folders", listFolders);
router.post("/companies/:id/folders", createFolder);
router.patch("/folders/:id", updateFolder);
router.delete("/folders/:id", deleteFolder);
router.post("/folders/:id/move", moveFolder);
router.get("/folders/:id/documents", listFolderDocuments);
router.post("/folders/:id/documents", addFolderDocument);
router.delete("/documents/:id", deleteDocument);

router.post("/documents/:id/activity", recordDocumentActivity);
router.get("/documents/:id/activity", getDocumentActivity);

module.exports = router;

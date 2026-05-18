const express = require("express");
const {
  listFolders,
  listFolderTree,
  createFolder,
  updateFolder,
  deleteFolder,
  moveFolder,
  archiveFolderController,
  unarchiveFolderController,
  listFolderDocuments,
  addFolderDocument,
  deleteDocument,
  archiveDocumentController,
  unarchiveDocumentController,
  recordDocumentActivity,
  getDocumentActivity,
  ensureDefaultFolders,
} = require("../controllers/folders");

const { requireAuth } = require("../middleware/auth");
const router = express.Router();

router.use(requireAuth);

router.get("/companies/:id/folders/tree", listFolderTree);
router.get("/companies/:id/folders", listFolders);
router.post("/companies/:id/folders", createFolder);
router.post("/companies/:id/folders/ensure-defaults", ensureDefaultFolders);
router.patch("/folders/:id", updateFolder);
router.delete("/folders/:id", deleteFolder);
router.post("/folders/:id/move", moveFolder);
router.post("/folders/:id/archive", archiveFolderController);
router.post("/folders/:id/unarchive", unarchiveFolderController);
router.get("/folders/:id/documents", listFolderDocuments);
router.post("/folders/:id/documents", addFolderDocument);
router.delete("/documents/:id", deleteDocument);
router.post("/documents/:id/archive", archiveDocumentController);
router.post("/documents/:id/unarchive", unarchiveDocumentController);

router.post("/documents/:id/activity", recordDocumentActivity);
router.get("/documents/:id/activity", getDocumentActivity);

module.exports = router;

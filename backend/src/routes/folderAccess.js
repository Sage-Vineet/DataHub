const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  listFolderAccess,
  createFolderAccess,
  updateFolderAccess,
  deleteFolderAccess,
} = require("../controllers/folderAccess");

const router = express.Router();
router.use(requireAuth);

router.get("/folders/:id/access", listFolderAccess);
router.post("/folders/:id/access", createFolderAccess);
router.patch("/folder-access/:id", updateFolderAccess);
router.delete("/folder-access/:id", deleteFolderAccess);
router.patch("/:id", updateFolderAccess);
router.delete("/:id", deleteFolderAccess);

module.exports = router;

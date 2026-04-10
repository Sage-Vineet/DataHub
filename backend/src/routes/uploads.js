const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { createUpload, getUploadContent, legacyPresignUpload } = require("../controllers/uploads");

const router = express.Router();

router.post(
  "/uploads",
  requireAuth,
  express.raw({ type: () => true, limit: process.env.UPLOAD_MAX_SIZE || "50mb" }),
  createUpload
);
router.get("/uploads/:id/content", requireAuth, getUploadContent);
router.post("/uploads/presign", requireAuth, legacyPresignUpload);

module.exports = router;

const express = require("express");
const { createUpload, getUploadContent } = require("../controllers/uploads");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.post(
  "/uploads",
  express.raw({ type: () => true, limit: process.env.UPLOAD_MAX_SIZE || "200mb" }),
  requireAuth,
  createUpload
);
router.get("/uploads/:id/content", requireAuth, getUploadContent);

module.exports = router;

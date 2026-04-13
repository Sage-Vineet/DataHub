const express = require("express");
const { createUpload, getUploadContent, legacyPresignUpload } = require("../controllers/uploads");

const router = express.Router();

router.post(
  "/uploads",
  express.raw({ type: () => true, limit: process.env.UPLOAD_MAX_SIZE || "50mb" }),
  createUpload
);
router.get("/uploads/:id/content", getUploadContent);
router.post("/uploads/presign", legacyPresignUpload);

module.exports = router;

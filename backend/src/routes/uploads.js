"use strict";

const express = require("express");
const { createUpload, getUploadContent, legacyPresignUpload } = require("../controllers/uploads");
const { requireAuth } = require("../middleware/auth");
const { requirePermission, PERMISSION } = require("../middleware/rbac");
const { uploadLimiter } = require("../middleware/rateLimit");
const { validate, schemas } = require("../middleware/validate");
const { config } = require("../config/env");

const router = express.Router();

router.post(
  "/uploads",
  // Authenticate BEFORE buffering the body. Previously `express.raw` ran first,
  // so an unauthenticated client could make the server allocate up to 200 MB of
  // memory per request — a trivial denial of service with no credentials at all.
  requireAuth,
  requirePermission(PERMISSION.DOCUMENT_UPLOAD),
  uploadLimiter,
  // 200 MB reduced to the configured cap (25 MB by default). The limit is
  // enforced by the parser, so an oversized body is rejected as it streams in
  // rather than after it has been fully buffered.
  express.raw({ type: () => true, limit: config.UPLOAD_MAX_BYTES }),
  createUpload
);

router.get(
  "/uploads/:id/content",
  requireAuth,
  requirePermission(PERMISSION.DOCUMENT_READ),
  validate({ params: schemas.strictObject({ id: schemas.uuid }) }),
  getUploadContent
);

// This legacy endpoint previously had NO authentication. Anything that issues
// or describes upload targets must be authenticated and authorised.
router.post(
  "/uploads/presign",
  requireAuth,
  requirePermission(PERMISSION.DOCUMENT_UPLOAD),
  uploadLimiter,
  legacyPresignUpload
);

module.exports = router;

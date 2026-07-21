const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const multer = require("multer");
const { requireAuth } = require("../middleware/auth");
const { isBroker, canAccessCompany } = require("../services/permissionService");
const { spliceNativeTablesAndCharts } = require("../services/asposeSlidesExportService");

const router = express.Router();
const upload = multer({ dest: path.join(os.tmpdir(), "cim-aspose-export-uploads") });

const cleanupFile = (filePath) => {
  if (!filePath) return;
  fs.promises.unlink(filePath).catch(() => {});
};

router.use(requireAuth);

router.post("/cim-prep/aspose-export", upload.single("file"), async (req, res) => {
  if (!isBroker(req.user)) {
    cleanupFile(req.file?.path);
    return res.status(403).json({ success: false, error: "Only brokers can export the CIM." });
  }

  const clientId = req.headers["x-client-id"] || req.query.clientId;
  if (!canAccessCompany(req.user, clientId)) {
    cleanupFile(req.file?.path);
    return res.status(403).json({ success: false, error: "You do not have permission to access this company." });
  }

  if (!req.file) {
    return res.status(400).json({ success: false, error: "Missing base PPTX file." });
  }

  let manifest;
  try {
    manifest = JSON.parse(req.body?.manifest || "{}");
  } catch {
    cleanupFile(req.file.path);
    return res.status(400).json({ success: false, error: "Malformed manifest JSON." });
  }

  try {
    const buffer = await spliceNativeTablesAndCharts({
      basePptxPath: req.file.path,
      slides: manifest.slides || [],
    });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", 'attachment; filename="cim-aspose-export.pptx"');
    return res.send(buffer);
  } catch (error) {
    console.error("[Aspose Export] failed", error);
    return res.status(500).json({
      success: false,
      error: "Failed to generate the native-table/chart export.",
      details: String(error?.message || error),
    });
  } finally {
    cleanupFile(req.file.path);
  }
});

module.exports = router;

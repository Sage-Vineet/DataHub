const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { isBroker, canAccessCompany } = require("../services/permissionService");
const { generatePocPptx } = require("../services/asposeSlidesPocService");

const router = express.Router();

router.use(requireAuth);

router.post("/cim-prep/aspose-poc-export", async (req, res) => {
  if (!isBroker(req.user)) {
    return res.status(403).json({ success: false, error: "Only brokers can export the CIM." });
  }

  const clientId = req.headers["x-client-id"] || req.query.clientId;
  if (!canAccessCompany(req.user, clientId)) {
    return res.status(403).json({ success: false, error: "You do not have permission to access this company." });
  }

  const { slide4, slide24, slide6 } = req.body || {};
  if (!slide4 || !slide24 || !slide6) {
    return res.status(400).json({ success: false, error: "Missing slide4, slide24, or slide6 payload." });
  }

  try {
    const buffer = await generatePocPptx({ slide4, slide24, slide6 });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", 'attachment; filename="cim-aspose-poc.pptx"');
    return res.send(buffer);
  } catch (error) {
    console.error("[Aspose POC Export] failed", error);
    return res.status(500).json({
      success: false,
      error: "Failed to generate the Aspose POC export.",
      details: String(error?.message || error),
    });
  }
});

module.exports = router;

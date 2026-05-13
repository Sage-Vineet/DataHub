const express = require("express");
const { requireAuth } = require("../../middleware/auth");
const { checkQBAuth } = require("../../middleware/quickbooksAuth");
const { syncAllReports, getSyncStatus } = require("../../services/quickbooksReportService");

const router = express.Router();

/**
 * @swagger
 * /api/quickbooks/sync:
 *   post:
 *     summary: Trigger a full sync of all QB reports
 *     description: Fetches all core financial reports from QuickBooks and caches them in the database.
 *     tags:
 *       - QuickBooks Sync
 *     responses:
 *       200:
 *         description: Sync completed
 *       401:
 *         description: Not connected to QuickBooks
 */
router.post("/api/quickbooks/sync", requireAuth, checkQBAuth, async (req, res) => {
  try {
    const clientId = req.clientId;

    console.log(`[Sync] Full sync triggered for company ${clientId}`);
    const result = await syncAllReports(clientId);

    return res.json({
      success: true,
      message: result.hasErrors
        ? "Sync completed with some errors"
        : "All reports synced successfully",
      ...result,
    });
  } catch (error) {
    console.error("[Sync] Full sync failed:", error.message);
    return res.status(500).json({
      success: false,
      error: "Sync failed",
      message: error.message,
    });
  }
});

/**
 * @swagger
 * /api/quickbooks/sync-status:
 *   get:
 *     summary: Get sync status for the current company
 *     description: Returns what reports are cached and when they were last synced.
 *     tags:
 *       - QuickBooks Sync
 *     responses:
 *       200:
 *         description: Sync status
 */
router.get("/api/quickbooks/sync-status", requireAuth, async (req, res) => {
  try {
    let clientId = req.headers["x-client-id"] || req.query.clientId;

    if (!clientId && req.user) {
      clientId = req.user.company_id || (req.user.company_ids && req.user.company_ids[0]);
    }

    if (!clientId) {
      return res.status(400).json({ success: false, message: "Missing Client ID" });
    }

    const status = await getSyncStatus(clientId);

    return res.json({
      success: true,
      ...status,
    });
  } catch (error) {
    console.error("[Sync] Status check failed:", error.message);
    return res.status(500).json({
      success: false,
      error: "Failed to check sync status",
      message: error.message,
    });
  }
});

module.exports = router;

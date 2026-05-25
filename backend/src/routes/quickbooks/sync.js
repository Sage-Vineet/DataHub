const express = require("express");
const { requireAuth } = require("../../middleware/auth");
const { checkQBAuth } = require("../../middleware/quickbooksAuth");
const { enforceDataSource, REPORT_SOURCE_KEYS } = require("../../middleware/dataSourceIsolation");
const { syncAllReports, getSyncStatus } = require("../../services/quickbooksReportService");

const router = express.Router();
const backgroundSyncByCompany = new Map();

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
router.post(
  "/api/quickbooks/sync",
  requireAuth,
  enforceDataSource(REPORT_SOURCE_KEYS.QUICKBOOKS),
  checkQBAuth,
  async (req, res) => {
  try {
    const clientId = req.clientId;
    const background =
      req.body?.background === true ||
      req.body?.background === "true" ||
      req.query?.background === "true";
    const yearsBack = Number(req.body?.yearsBack || req.query?.yearsBack || 4);
    const monthsBack = Number(req.body?.monthsBack || req.query?.monthsBack || 18);
    const incremental =
      req.body?.incremental === undefined && req.query?.incremental === undefined
        ? true
        : req.body?.incremental === true ||
          req.body?.incremental === "true" ||
          req.query?.incremental === "true";

    const syncOptions = {
      requestedBy: req.user?.id || null,
      yearsBack,
      monthsBack,
      accountingMethod: req.body?.accountingMethod || "Accrual",
      incremental,
    };

    console.log(
      `[Sync] Full sync triggered for company ${clientId}` +
      ` accountingMethod=${syncOptions.accountingMethod} yearsBack=${yearsBack} monthsBack=${monthsBack}` +
      ` incremental=${incremental} background=${background}`
    );
    if (background) {
      if (!backgroundSyncByCompany.has(clientId)) {
        const runningPromise = syncAllReports(clientId, syncOptions)
          .catch((error) => {
            console.error(`[Sync][Background] failed for company ${clientId}:`, error.message);
          })
          .finally(() => {
            backgroundSyncByCompany.delete(clientId);
          });
        backgroundSyncByCompany.set(clientId, runningPromise);
      }

      // Give the sync worker a brief moment to create the DB sync job row.
      await new Promise((resolve) => setTimeout(resolve, 60));
      const status = await getSyncStatus(clientId).catch(() => null);

      return res.status(202).json({
        success: true,
        source: "sync_job",
        disconnected: Boolean(req.qbDisconnected),
        message: "Background sync started.",
        syncStatus: status?.syncStatus || "running",
        syncProgress: status?.syncProgress || 0,
        syncJobId: status?.syncJobId || null,
        datasetVersion: status?.datasetVersion || null,
      });
    }

    const result = await syncAllReports(clientId, syncOptions);
    if (result?.alreadyRunning) {
      return res.status(202).json({
        success: true,
        source: "sync_job",
        disconnected: Boolean(req.qbDisconnected),
        message: result.message || "A sync job is already running.",
        syncStatus: result.status || "running",
        syncJobId: result.syncJobId || null,
      });
    }

    return res.json({
      success: true,
      source: "sync_job",
      disconnected: Boolean(req.qbDisconnected),
      message: result.hasErrors
        ? "Sync completed with some errors"
        : "All reports synced successfully",
      ...result,
    });
  } catch (error) {
    console.error("[Sync] Full sync failed:", error.message);
    const status = /missing or disconnected/i.test(String(error.message || ""))
      ? 400
      : 500;
    return res.status(status).json({
      success: false,
      source: "sync_job",
      disconnected: Boolean(req.qbDisconnected),
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
      source: "cached_snapshot",
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

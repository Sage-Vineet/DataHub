const express = require("express");
const {
  serveCachedReport,
  fetchOnDemandReport,
  REPORT_TYPES,
} = require("../../../services/quickbooksReportService");

const router = express.Router();

function normalizeDateQuery(query = {}) {
  return {
    start_date: String(query.start_date || "").trim(),
    end_date: String(query.end_date || "").trim(),
    accounting_method: String(query.accounting_method || "").trim(),
    as_of_date: String(query.as_of_date || query.end_date || "").trim(),
  };
}

function isExactPeriodMatch(requested, storedParams = {}) {
  const { start_date, end_date, as_of_date } = requested;
  return (
    (!start_date || storedParams.start_date === start_date) &&
    (!end_date || storedParams.end_date === end_date) &&
    (!as_of_date || storedParams.as_of_date === as_of_date)
  );
}

// ── /balance-sheet-detail ─────────────────────────────────────────────────────

// ── /all-reports ──────────────────────────────────────────────────────────────

router.get("/all-reports", async (req, res) => {
  const clientId = req.clientId;
  const disconnected = Boolean(req.qbDisconnected);

  try {
    const accountList = await serveCachedReport(
      clientId,
      REPORT_TYPES.ACCOUNT_LIST,
      {},
      { disconnected },
    );

    const lastSyncAt = accountList?.lastSyncedAt || null;
    const datasetVersion = accountList?.datasetVersion || null;

    const data = {
      accountList: accountList?.data || { error: "No snapshot available" },
    };

    if (!accountList?.data) {
      return res.status(404).json({
        success: false,
        source: "cached_snapshot",
        disconnected,
        message: "No finalized snapshot data is available. Run QuickBooks sync to generate snapshots.",
        data,
      });
    }

    console.log(
      `[All Reports] clientId=${clientId}` +
      ` accountListExists=${Boolean(accountList?.data)}` +
      ` lastSync=${lastSyncAt} datasetVersion=${datasetVersion}`
    );

    return res.json({
      success: true,
      source: "cached_snapshot",
      disconnected,
      lastSyncAt,
      datasetVersion,
      data,
    });
  } catch (error) {
    console.error("[All Reports] Snapshot read failed:", error.message);
    return res.status(500).json({
      success: false,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      message: "Failed to load all reports snapshot.",
      error: error.message,
    });
  }
});

module.exports = router;
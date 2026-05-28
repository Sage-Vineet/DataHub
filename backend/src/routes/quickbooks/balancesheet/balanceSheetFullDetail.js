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

router.get("/balance-sheet-detail", async (req, res) => {
  const clientId = req.clientId;
  const disconnected = Boolean(req.qbDisconnected);
  const { start_date, end_date, accounting_method, as_of_date } =
    normalizeDateQuery(req.query);
  const { summarize_column_by } = req.query;
  const hasDateFilter = Boolean(start_date || end_date);

  const params = { start_date, end_date, accounting_method, as_of_date, summarize_column_by };

  console.log(
    `[BS Detail] Request — clientId=${clientId}` +
    ` start_date=${start_date || "(none)"} end_date=${end_date || "(none)"}` +
    ` disconnected=${disconnected}`
  );

  try {
    // Try detail snapshot first, fall back to summary if detail not found.
    const cachedDetail = await serveCachedReport(
      clientId, REPORT_TYPES.BALANCE_SHEET_DETAIL, params, { disconnected }
    );
    const cachedSummary = cachedDetail ||
      await serveCachedReport(
        clientId, REPORT_TYPES.BALANCE_SHEET, params, { disconnected }
      );

    const best = cachedDetail || cachedSummary;
    const bestIsExact = best?.data &&
      isExactPeriodMatch({ start_date, end_date, as_of_date }, best.reportParams);

    if (bestIsExact) {
      console.log(`[BS Detail] Cache hit (exact) — datasetVersion=${best.datasetVersion}`);
      return res.json({
        success: true,
        source: "cached_snapshot",
        disconnected,
        lastSyncAt: best.lastSyncedAt,
        datasetVersion: best.datasetVersion || null,
        reportParams: best.reportParams,
        data: best.data,
      });
    }

    // Live fetch when connected and date filters are present.
    if (!disconnected && hasDateFilter) {
      console.log(`[BS Detail] Fetching live — start_date=${start_date} end_date=${end_date}`);
      try {
        const live = await fetchOnDemandReport(
          clientId, REPORT_TYPES.BALANCE_SHEET_DETAIL, "BalanceSheet",
          { start_date, end_date, accounting_method, as_of_date, summarize_column_by: summarize_column_by || "Total" }
        );
        console.log(`[BS Detail] Live fetch success — datasetVersion=${live.datasetVersion}`);
        return res.json({
          success: true,
          source: "live_fetch",
          disconnected,
          lastSyncAt: live.lastSyncedAt,
          datasetVersion: live.datasetVersion || null,
          reportParams: live.reportParams,
          data: live.data,
        });
      } catch (liveError) {
        console.error(`[BS Detail] Live fetch failed: ${liveError.message}`);
      }
    }

    // Coverage fallback for disconnected state.
    if (best?.data) {
      const storedParams = best.reportParams || {};
      const badCoverage =
        (start_date && storedParams.start_date && storedParams.start_date > start_date) ||
        (end_date && storedParams.end_date && storedParams.end_date < end_date);

      if (!badCoverage) {
        return res.json({
          success: true,
          source: "cached_snapshot",
          disconnected,
          lastSyncAt: best.lastSyncedAt,
          datasetVersion: best.datasetVersion || null,
          reportParams: storedParams,
          coverageFallback: true,
          note: `No exact snapshot for ${start_date}–${end_date}. Returning nearest available snapshot (${storedParams.start_date}–${storedParams.end_date}).`,
          data: best.data,
        });
      }
    }

    return res.status(404).json({
      success: false,
      source: "cached_snapshot",
      disconnected,
      message: disconnected
        ? "QuickBooks is disconnected and no cached Balance Sheet detail snapshot is available."
        : "No Balance Sheet detail snapshot is available for the requested period. Run QuickBooks sync to generate one.",
    });

  } catch (error) {
    console.error("[BS Detail] Request failed:", error.message);
    return res.status(500).json({
      success: false,
      source: "cached_snapshot",
      disconnected,
      message: "Failed to load Balance Sheet detail snapshot.",
    });
  }
});

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
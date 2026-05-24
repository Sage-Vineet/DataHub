const express = require("express");
const { fetchAndCacheReport, REPORT_TYPES } = require("../../../services/quickbooksReportService");

const router = express.Router();

router.get("/balance-sheet", async (req, res) => {
  const clientId = req.clientId;
  const disconnected = Boolean(req.qbDisconnected);
  const { clientId: _cid, minorversion, ...queryParams } = req.query;
  const { start_date, end_date } = queryParams;

  try {
    // ── 1. Always fetch cached snapshot first ─────────────────────────────────
    const result = await fetchAndCacheReport(
      clientId,
      REPORT_TYPES.BALANCE_SHEET,
      "BalanceSheet",
      queryParams
    );

    const cached = result;

    // ── 2. QB connected — attempt live fetch ──────────────────────────────────
    if (!disconnected) {
      try {
        const live = result;

        console.log(
          `[Balance Sheet] Live fetch success — datasetVersion=${live.datasetVersion}` +
          ` reportParams=${JSON.stringify(live.reportParams)}`
        );

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
        console.error(
          `[Balance Sheet] Live fetch failed — falling through to coverage cache: ${liveError.message}`
        );
        // fall through
      }
    }

    // ── 3. QB disconnected (or live failed) — serve coverage cache if valid ───
    if (cached?.data) {
      const storedParams = cached.reportParams || {};
      const storedStartAfter = start_date && storedParams.start_date && storedParams.start_date > start_date;
      const storedEndBefore = end_date && storedParams.end_date && storedParams.end_date < end_date;

      if (!storedStartAfter && !storedEndBefore) {
        console.log(
          `[Balance Sheet] Coverage cache hit — stored=${storedParams.start_date}–${storedParams.end_date}` +
          ` requested=${start_date}–${end_date}`
        );
        return res.json({
          success: true,
          source: "cached_snapshot",
          disconnected,
          lastSyncAt: cached.lastSyncedAt,
          datasetVersion: cached.datasetVersion || null,
          reportParams: storedParams,
          coverageFallback: true,
          note:
            `No exact snapshot for ${start_date}–${end_date}. ` +
            `Returning nearest available snapshot (${storedParams.start_date}–${storedParams.end_date}).`,
          data: cached.data,
        });
      }
    }

    // ── 4. Nothing usable ─────────────────────────────────────────────────────
    console.warn(
      `[Balance Sheet] No snapshot available — clientId=${clientId}` +
      ` start_date=${start_date || "(none)"} end_date=${end_date || "(none)"}`
    );
    return res.status(404).json({
      success: false,
      source: "cached_snapshot",
      disconnected,
      lastSyncAt: result.lastSyncedAt,
      datasetVersion: result.datasetVersion || null,
    });

  } catch (error) {
    const status = /No finalized snapshot/i.test(error.message) ? 404 : 500;
    console.error("Balance Sheet API Error:", error.message);
    return res.status(status).json({
      success: false,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      message: error.message || "Failed to fetch balance sheet snapshot.",
    });
  }
});

module.exports = router;
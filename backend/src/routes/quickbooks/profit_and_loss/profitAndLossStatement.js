const express = require("express");
const {
  serveCachedReport,
  fetchOnDemandReport,
  REPORT_TYPES,
} = require("../../../services/quickbooksReportService");

const router = express.Router();

function normalizeStatementQuery(query = {}) {
  return {
    start_date: String(query.start_date || "").trim(),
    end_date: String(query.end_date || "").trim(),
    accounting_method: String(query.accounting_method || "").trim(),
  };
}

function isExactPeriodMatch(requestedParams, storedParams = {}) {
  const { start_date, end_date, accounting_method } = requestedParams;
  return (
    (!start_date || storedParams.start_date === start_date) &&
    (!end_date || storedParams.end_date === end_date) &&
    (!accounting_method || storedParams.accounting_method === accounting_method)
  );
}

router.get("/profit-and-loss-statement", async (req, res) => {
  const clientId = req.clientId;
  const { start_date, end_date, accounting_method } = normalizeStatementQuery(req.query);
  const disconnected = Boolean(req.qbDisconnected);
  const hasDateFilter = Boolean(start_date || end_date);

  console.log(
    `[P&L Statement] Request — clientId=${clientId}` +
    ` start_date=${start_date || "(none)"} end_date=${end_date || "(none)"}` +
    ` accounting_method=${accounting_method || "(none)"} disconnected=${disconnected}`
  );

  try {
    // ── 1. Try cache first ────────────────────────────────────────────────────
    const cached = await serveCachedReport(
      clientId,
      REPORT_TYPES.PROFIT_AND_LOSS,
      { start_date, end_date, accounting_method },
      { disconnected },
    );

    const cachedIsExact = cached?.data && isExactPeriodMatch(
      { start_date, end_date, accounting_method },
      cached.reportParams
    );

    if (cachedIsExact) {
      console.log(
        `[P&L Statement] Cache hit (exact) — datasetVersion=${cached.datasetVersion}` +
        ` start_date=${cached.reportParams.start_date} end_date=${cached.reportParams.end_date}` +
        ` snapshot_accounting_method=${cached.reportParams?.accounting_method || "(none)"}` +
        ` ReportBasis=${cached.data?.Header?.ReportBasis || "(none)"}`
      );
      return res.json({
        success: true,
        source: "cached_snapshot",
        disconnected,
        lastSyncAt: cached.lastSyncedAt,
        datasetVersion: cached.datasetVersion || null,
        reportParams: cached.reportParams,
        data: cached.data,
      });
    }

    // ── 2. No exact cache — fetch live from QB if connected ───────────────────
    if (!disconnected && hasDateFilter) {
      console.log(
        `[P&L Statement] Cache miss (exact) — fetching live from QB` +
        ` start_date=${start_date} end_date=${end_date}`
      );
      try {
        const live = await fetchOnDemandReport(
          clientId,
          REPORT_TYPES.PROFIT_AND_LOSS,
          "ProfitAndLoss",
          { start_date, end_date, accounting_method },
        );

        console.log(
          `[P&L Statement] Live fetch success — datasetVersion=${live.datasetVersion}` +
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
          `[P&L Statement] Live fetch failed — falling through to coverage cache: ${liveError.message}`
        );
        // fall through to coverage fallback below
      }
    }

    // ── 3. QB disconnected (or live fetch failed) — serve coverage cache ──────
    // The cached result may be a broader period that contains the requested range
    // (e.g. yearly Jan–Dec when Jan–Jan was requested). Surface it with a note.
    if (cached?.data) {
      const storedParams = cached.reportParams || {};
      const storedStartAfter = start_date && storedParams.start_date && storedParams.start_date > start_date;
      const storedEndBefore = end_date && storedParams.end_date && storedParams.end_date < end_date;

      if (storedStartAfter || storedEndBefore) {
        console.warn(
          `[P&L Statement] Coverage cache period does not contain requested range` +
          ` — stored=${storedParams.start_date}–${storedParams.end_date}` +
          ` requested=${start_date}–${end_date}`
        );
      } else {
        console.log(
          `[P&L Statement] Coverage cache hit — stored=${storedParams.start_date}–${storedParams.end_date}` +
          ` requested=${start_date}–${end_date} disconnected=${disconnected}`
        );
        return res.json({
          success: true,
          source: "cached_snapshot",
          disconnected,
          lastSyncAt: cached.lastSyncedAt,
          datasetVersion: cached.datasetVersion || null,
          reportParams: storedParams,
          coverageFallback: true,
          note: `No exact snapshot for ${start_date}–${end_date}. Returning nearest available snapshot (${storedParams.start_date}–${storedParams.end_date}).`,
          data: cached.data,
        });
      }
    }

    // ── 4. Nothing usable found ───────────────────────────────────────────────
    console.warn(
      `[P&L Statement] No snapshot available — clientId=${clientId}` +
      ` start_date=${start_date || "(none)"} end_date=${end_date || "(none)"}`
    );
    return res.status(404).json({
      success: false,
      source: "cached_snapshot",
      disconnected,
      message: disconnected
        ? "QuickBooks is disconnected and no cached snapshot is available for the requested period."
        : "No Profit & Loss snapshot is available for the requested period. Run QuickBooks sync to generate one.",
    });

  } catch (error) {
    console.error("[P&L Statement] Request failed:", error.message);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

module.exports = router;

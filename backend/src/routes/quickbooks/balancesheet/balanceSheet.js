const express = require("express");
const {
  serveCachedReport,
  fetchOnDemandReport,
  REPORT_TYPES,
} = require("../../../services/quickbooksReportService");

const router = express.Router();

function normalizeBalanceSheetQuery(query = {}) {
  // Strip QB/internal params that must not be used as cache-key discriminators.
  const { clientId: _cid, minorversion: _mv, ...rest } = query;
  return {
    start_date:        String(rest.start_date        || "").trim(),
    end_date:          String(rest.end_date          || "").trim(),
    accounting_method: String(rest.accounting_method || "").trim(),
    // QB Balance Sheet uses as_of_date as the snapshot date.
    // Default to end_date when not explicitly provided.
    as_of_date:        String(rest.as_of_date        || rest.end_date || "").trim(),
  };
}

function isExactPeriodMatch(requested, storedParams = {}) {
  const { start_date, end_date, as_of_date, accounting_method } = requested;
  return (
    (!start_date       || storedParams.start_date       === start_date)       &&
    (!end_date         || storedParams.end_date         === end_date)         &&
    (!as_of_date       || storedParams.as_of_date       === as_of_date)       &&
    (!accounting_method || storedParams.accounting_method === accounting_method)
  );
}

router.get("/balance-sheet", async (req, res) => {
  const clientId   = req.clientId;
  const disconnected = Boolean(req.qbDisconnected);
  const { start_date, end_date, accounting_method, as_of_date } =
    normalizeBalanceSheetQuery(req.query);

  const hasDateFilter = Boolean(start_date || end_date || as_of_date);

  console.log(
    `[Balance Sheet] Request — clientId=${clientId}` +
    ` start_date=${start_date || "(none)"} end_date=${end_date || "(none)"}` +
    ` as_of_date=${as_of_date || "(none)"} accounting_method=${accounting_method || "(none)"}` +
    ` disconnected=${disconnected}`
  );

  const queryParams = { start_date, end_date, accounting_method, as_of_date };

  try {
    // ── 1. Cache lookup (exact JSONB → partial JSONB → period-coverage) ───────
    const cached = await serveCachedReport(
      clientId,
      REPORT_TYPES.BALANCE_SHEET,
      queryParams,
      { disconnected },
    );

    const cachedIsExact = cached?.data &&
      isExactPeriodMatch({ start_date, end_date, as_of_date, accounting_method }, cached.reportParams);

    console.log(
      `[Balance Sheet] Cache result: ${cached?.data ? (cachedIsExact ? "exact hit" : "coverage hit") : "miss"}` +
      (cached?.reportParams
        ? ` storedParams=${JSON.stringify(cached.reportParams)}` +
          ` snapshot_accounting_method=${cached.reportParams?.accounting_method || "(none)"}` +
          ` ReportBasis=${cached.data?.Header?.ReportBasis || "(none)"}`
        : "")
    );

    if (cachedIsExact) {
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

    // ── 2. No exact cache — fetch live from QB when connected ─────────────────
    if (!disconnected && hasDateFilter) {
      console.log(
        `[Balance Sheet] Fetching live from QB —` +
        ` start_date=${start_date} end_date=${end_date} as_of_date=${as_of_date}`
      );
      try {
        const live = await fetchOnDemandReport(
          clientId,
          REPORT_TYPES.BALANCE_SHEET,
          "BalanceSheet",
          queryParams,
        );

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
      const storedEndBefore  = end_date   && storedParams.end_date   && storedParams.end_date   < end_date;

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
      message: disconnected
        ? "QuickBooks is disconnected and no cached Balance Sheet snapshot is available for the requested period."
        : "No Balance Sheet snapshot is available for the requested period. Run QuickBooks sync to generate one.",
    });

  } catch (error) {
    console.error("[Balance Sheet] Request failed:", error.message);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

module.exports = router;

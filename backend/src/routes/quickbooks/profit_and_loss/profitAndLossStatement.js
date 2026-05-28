const express = require("express");
const {
  serveCachedReport,
  fetchOnDemandReport,
  REPORT_TYPES,
} = require("../../../services/quickbooksReportService");

const router = express.Router();

function normalizeAccountingMethod(raw) {
  const str = String(raw || "").trim().toLowerCase();
  if (str === "cash") return "Cash";
  if (str === "accrual") return "Accrual";
  return str ? String(raw).trim() : "";
}

function accountingMethodMatches(requestedMethod, storedParams, cachedData) {
  const requested = normalizeAccountingMethod(requestedMethod);
  if (!requested) return true;
  const stored = normalizeAccountingMethod(storedParams && storedParams.accounting_method);
  const basis = String((cachedData && cachedData.Header && cachedData.Header.ReportBasis) || "").trim();
  const storedOk = !stored || stored === requested;
  const basisOk = !basis || basis.toLowerCase() === requested.toLowerCase();
  return storedOk && basisOk;
}

function normalizeStatementQuery(query = {}) {
  return {
    start_date: String(query.start_date || "").trim(),
    end_date: String(query.end_date || "").trim(),
    accounting_method: normalizeAccountingMethod(query.accounting_method),
  };
}

function isExactPeriodMatch(requestedParams, storedParams = {}, cachedData = null) {
  const { start_date, end_date, accounting_method } = requestedParams;
  const datesMatch =
    (!start_date || storedParams.start_date === start_date) &&
    (!end_date || storedParams.end_date === end_date);
  const methodMatch = accountingMethodMatches(accounting_method, storedParams, cachedData);
  return datesMatch && methodMatch;
}

router.get("/profit-and-loss-statement", async (req, res) => {
  const clientId = req.clientId;
  const { start_date, end_date, summarize_columns_by } = req.query;
  const accounting_method = normalizeAccountingMethod(req.query.accounting_method);
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
      { start_date, end_date, accounting_method, summarize_columns_by },
      { disconnected: Boolean(req.qbDisconnected) },
    );

    const cachedIsExact = cached?.data && isExactPeriodMatch(
      { start_date, end_date, accounting_method },
      cached.reportParams,
      cached.data,
    );

    if (cachedIsExact) {
      console.log(
        `[P&L Statement] Cache hit (exact) — datasetVersion=${cached.datasetVersion}` +
        ` start_date=${cached.reportParams.start_date} end_date=${cached.reportParams.end_date}`
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
    // Reject immediately if accounting_method does not match.
    if (cached?.data) {
      const storedParams = cached.reportParams || {};
      const methodOk = accountingMethodMatches(accounting_method, storedParams, cached.data);

      if (!methodOk) {
        console.warn(
          `[P&L Statement] Coverage cache rejected — accounting_method mismatch:` +
          ` requested=${accounting_method || "(none)"}` +
          ` stored=${storedParams.accounting_method || "(none)"}` +
          ` ReportBasis=${cached.data?.Header?.ReportBasis || "(none)"}`
        );
      } else {
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
            ` requested=${start_date}–${end_date} accounting=${accounting_method || "(none)"} disconnected=${disconnected}`
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

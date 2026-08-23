const express = require("express");
const {
  serveCachedReport,
  fetchOnDemandReport,
  REPORT_TYPES,
} = require("../../../services/quickbooksReportService");

const router = express.Router();

function snapshotEnvelope(entry, disconnected) {
  return {
    success: true,
    source: "cached_snapshot",
    disconnected: Boolean(disconnected),
    lastSyncAt: entry?.lastSyncedAt || null,
    datasetVersion: entry?.datasetVersion || null,
    data: entry?.data || null,
  };
}

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

router.get("/qb-cashflow", async (req, res) => {
  const clientId = req.clientId;
  const disconnected = Boolean(req.qbDisconnected);
  const start_date = String(req.query.start_date || "").trim();
  const end_date = String(req.query.end_date || "").trim();
  const accounting_method = normalizeAccountingMethod(req.query.accounting_method || "Accrual");
  const hasDateFilter = Boolean(start_date || end_date);

  const queryParams = { start_date, end_date, accounting_method };

  try {
    // ── 1. Try exact cache hit ────────────────────────────────────────────────
    const cached = await serveCachedReport(
      clientId,
      REPORT_TYPES.CASH_FLOW,
      queryParams,
      { disconnected },
    );

    const storedParams = cached?.reportParams || {};
    const methodOk = accountingMethodMatches(accounting_method, storedParams, cached?.data);

    const cachedIsExact = Boolean(
      cached?.data &&
      methodOk &&
      (!start_date || storedParams.start_date === start_date) &&
      (!end_date || storedParams.end_date === end_date)
    );

    if (cachedIsExact) {
      return res.json(snapshotEnvelope(cached, disconnected));
    }

    // ── 2. No exact cache — fetch live from QB when connected ─────────────────
    if (!disconnected && hasDateFilter) {
      try {
        const live = await fetchOnDemandReport(
          clientId,
          REPORT_TYPES.CASH_FLOW,
          "CashFlow",
          queryParams,
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
        console.error(`[CashFlow] Live fetch failed — falling through to coverage cache: ${liveError.message}`);
      }
    }

    // ── 3. Coverage fallback for disconnected / live failure ──────────────────
    // Reject if accounting_method does not match — never return Accrual for a Cash request.
    if (cached?.data) {
      if (!methodOk) {
        console.warn(
          `[CashFlow] Coverage cache rejected — accounting_method mismatch:` +
          ` requested=${accounting_method} stored=${storedParams.accounting_method || "(none)"}` +
          ` ReportBasis=${cached.data?.Header?.ReportBasis || "(none)"}`
        );
      } else {
        const storedStartAfter = start_date && storedParams.start_date && storedParams.start_date > start_date;
        const storedEndBefore = end_date && storedParams.end_date && storedParams.end_date < end_date;

        if (!storedStartAfter && !storedEndBefore) {
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

    // ── 4. Nothing usable ─────────────────────────────────────────────────────
    return res.status(404).json({
      success: false,
      source: "cached_snapshot",
      disconnected,
      message: disconnected
        ? "QuickBooks is disconnected and no cached Cash Flow snapshot is available for the requested period."
        : "No Cash Flow snapshot is available for the requested period. Run QuickBooks sync to generate one.",
    });

  } catch (error) {
    console.error("[CashFlow] Request failed:", error.message);
    return res.status(500).json({
      success: false,
      source: "cached_snapshot",
      disconnected,
      message: "Failed to load Cash Flow snapshot.",
      error: error.message,
    });
  }
});

module.exports = router;

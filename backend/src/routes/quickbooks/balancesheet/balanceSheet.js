const express = require("express");
const {
  fetchAndCacheReport,
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

// Returns false when the cached snapshot was built for a different accounting
// method than the one requested (checked via both stored params and QB's own
// Header.ReportBasis so nothing slips through).
function accountingMethodMatches(requestedMethod, storedParams, cachedData) {
  const requested = normalizeAccountingMethod(requestedMethod);
  if (!requested) return true;
  const stored = normalizeAccountingMethod(storedParams && storedParams.accounting_method);
  const basis = String((cachedData && cachedData.Header && cachedData.Header.ReportBasis) || "").trim();
  const storedOk = !stored || stored === requested;
  const basisOk = !basis || basis.toLowerCase() === requested.toLowerCase();
  return storedOk && basisOk;
}

router.get("/balance-sheet", async (req, res) => {
  const clientId = req.clientId;
  const disconnected = Boolean(req.qbDisconnected);
  const { clientId: _cid, minorversion, ...queryParams } = req.query;
  const { start_date, end_date, as_of_date } = queryParams;
  const accountingMethod = normalizeAccountingMethod(queryParams.accounting_method);

  console.log(
    `[BalanceSheet] Request — clientId=${clientId}` +
    ` start=${start_date || "(none)"} end=${end_date || "(none)"}` +
    ` asOf=${as_of_date || "(none)"} accounting=${accountingMethod || "(none)"}` +
    ` disconnected=${disconnected}`
  );

  try {
    // ── 1. Try cache ──────────────────────────────────────────────────────────
    let cached = null;
    try {
      cached = await fetchAndCacheReport(
        clientId,
        REPORT_TYPES.BALANCE_SHEET,
        "BalanceSheet",
        queryParams,
      );
    } catch (_cacheErr) {
      // No finalized snapshot — cached stays null; will attempt live fetch below.
    }

    const storedParams = cached ? (cached.reportParams || {}) : {};
    const methodOk = accountingMethodMatches(accountingMethod, storedParams, cached && cached.data);

    if (cached && cached.data) {
      console.log(
        `[BalanceSheet] Cached — stored accounting=${storedParams.accounting_method || "(none)"}` +
        ` ReportBasis=${(cached.data && cached.data.Header && cached.data.Header.ReportBasis) || "(none)"}` +
        ` requested=${accountingMethod || "(none)"} methodOk=${methodOk}`
      );
    }

    // Exact hit: dates + as_of_date + accounting_method all match → serve immediately.
    const cachedIsExact = Boolean(
      cached && cached.data &&
      methodOk &&
      (!start_date  || storedParams.start_date  === start_date) &&
      (!end_date    || storedParams.end_date    === end_date) &&
      (!as_of_date  || storedParams.as_of_date  === as_of_date)
    );

    if (cachedIsExact) {
      console.log(
        `[BalanceSheet] Cache hit (exact) — datasetVersion=${cached.datasetVersion}` +
        ` accounting=${accountingMethod || "(none)"}`
      );
      return res.json({
        success: true,
        source: "cached_snapshot",
        disconnected,
        lastSyncAt: cached.lastSyncedAt,
        datasetVersion: cached.datasetVersion || null,
        reportParams: storedParams,
        data: cached.data,
      });
    }

    // ── 2. QB connected — fetch live from QuickBooks ──────────────────────────
    if (!disconnected) {
      if (!methodOk) {
        console.log(
          `[BalanceSheet] Cache accounting_method mismatch — fetching live.` +
          ` requested=${accountingMethod} cached_basis=${(cached && cached.data && cached.data.Header && cached.data.Header.ReportBasis) || "(none)"}`
        );
      } else {
        console.log(
          `[BalanceSheet] Cache miss (no exact match) — fetching live.` +
          ` start=${start_date} end=${end_date} accounting=${accountingMethod || "(none)"}`
        );
      }

      try {
        const live = await fetchOnDemandReport(
          clientId,
          REPORT_TYPES.BALANCE_SHEET,
          "BalanceSheet",
          queryParams,
        );

        console.log(
          `[BalanceSheet] Live fetch success — datasetVersion=${live.datasetVersion}` +
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
          `[BalanceSheet] Live fetch failed — falling through to coverage cache: ${liveError.message}`
        );
        // fall through to coverage fallback
      }
    }

    // ── 3. Disconnected / live failed — coverage cache if method matches ──────
    if (cached && cached.data) {
      if (!methodOk) {
        console.warn(
          `[BalanceSheet] Coverage cache rejected — accounting_method mismatch:` +
          ` requested=${accountingMethod || "(none)"}` +
          ` stored=${storedParams.accounting_method || "(none)"}` +
          ` ReportBasis=${(cached.data && cached.data.Header && cached.data.Header.ReportBasis) || "(none)"}`
        );
      } else {
        const storedStartAfter = start_date && storedParams.start_date && storedParams.start_date > start_date;
        const storedEndBefore  = end_date   && storedParams.end_date   && storedParams.end_date   < end_date;

        if (!storedStartAfter && !storedEndBefore) {
          console.log(
            `[BalanceSheet] Coverage cache hit — stored=${storedParams.start_date}–${storedParams.end_date}` +
            ` requested=${start_date}–${end_date} accounting=${accountingMethod || "(none)"}`
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
    }

    // ── 4. Nothing usable ─────────────────────────────────────────────────────
    console.warn(
      `[BalanceSheet] No snapshot available — clientId=${clientId}` +
      ` start=${start_date || "(none)"} end=${end_date || "(none)"}` +
      ` accounting=${accountingMethod || "(none)"}`
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
    const status = /No finalized snapshot/i.test(error.message) ? 404 : 500;
    console.error("[BalanceSheet] Request failed:", error.message);
    return res.status(status).json({
      success: false,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      message: error.message || "Failed to fetch balance sheet snapshot.",
    });
  }
});

module.exports = router;

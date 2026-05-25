const express = require("express");
const {
  serveCachedReport,
  REPORT_TYPES,
} = require("../../../services/quickbooksReportService");

const router = express.Router();

router.get("/balance-sheet-detail", async (req, res) => {
  const clientId = req.clientId;
  const { start_date, end_date, accounting_method, summarize_column_by } = req.query;

  try {
    const params = {
      start_date,
      end_date,
      accounting_method,
      summarize_column_by,
    };

    const cachedDetail = await serveCachedReport(
      clientId,
      REPORT_TYPES.BALANCE_SHEET_DETAIL,
      params,
      { disconnected: Boolean(req.qbDisconnected) },
    );

    const fallbackSummary =
      cachedDetail ||
      (await serveCachedReport(
        clientId,
        REPORT_TYPES.BALANCE_SHEET,
        params,
        { disconnected: Boolean(req.qbDisconnected) },
      ));

    if (!fallbackSummary?.data) {
      return res.status(404).json({
        success: false,
        source: "cached_snapshot",
        disconnected: Boolean(req.qbDisconnected),
        message:
          "No finalized Balance Sheet detail snapshot is available. Run QuickBooks sync to generate snapshots.",
      });
    }

    return res.json({
      success: true,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      lastSyncAt: fallbackSummary.lastSyncedAt,
      datasetVersion: fallbackSummary.datasetVersion || null,
      data: fallbackSummary.data,
    });
  } catch (error) {
    console.error("[Balance Sheet Detail] Snapshot read failed:", error.message);
    return res.status(500).json({
      success: false,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      message: "Failed to load Balance Sheet detail snapshot.",
      error: error.message,
    });
  }
});

router.get("/all-reports", async (req, res) => {
  const clientId = req.clientId;
  const { start_date, end_date, accounting_method } = req.query;

  const queryParams = {
    start_date,
    end_date,
    accounting_method,
  };

  const disconnected = Boolean(req.qbDisconnected);

  try {
    // Balance sheet is fetched with a two-step fallback: period-specific first,
    // then latest available (no monthly BS snapshots are stored during sync).
    const balanceSheetFetch =
      serveCachedReport(clientId, REPORT_TYPES.BALANCE_SHEET, queryParams, { disconnected })
        .then((r) => r || serveCachedReport(clientId, REPORT_TYPES.BALANCE_SHEET, {}, { disconnected }))
        .catch(() => null);

    const [
      accountList,
      agedPayableDetail,
      agedReceivableDetail,
      balanceSheet,
      cashSales,
      generalLedger,
      trialBalance,
    ] = await Promise.all([
      serveCachedReport(clientId, REPORT_TYPES.ACCOUNT_LIST, {}, { disconnected }),
      serveCachedReport(clientId, REPORT_TYPES.AGED_PAYABLE_DETAIL, queryParams, { disconnected }),
      serveCachedReport(clientId, REPORT_TYPES.AGED_RECEIVABLE_DETAIL, queryParams, { disconnected }),
      balanceSheetFetch,
      serveCachedReport(clientId, REPORT_TYPES.CASH_SALES, queryParams, { disconnected }),
      serveCachedReport(clientId, REPORT_TYPES.GENERAL_LEDGER, queryParams, { disconnected }),
      serveCachedReport(clientId, REPORT_TYPES.TRIAL_BALANCE, queryParams, { disconnected }),
    ]);

    const lastSyncAt =
      balanceSheet?.lastSyncedAt ||
      generalLedger?.lastSyncedAt ||
      accountList?.lastSyncedAt ||
      null;
    const datasetVersion =
      balanceSheet?.datasetVersion ||
      generalLedger?.datasetVersion ||
      accountList?.datasetVersion ||
      null;
    const combinedData = {
      accountList: accountList?.data || { error: "No snapshot available" },
      agedPayableDetail: agedPayableDetail?.data || { error: "No snapshot available" },
      agedReceivableDetail: agedReceivableDetail?.data || { error: "No snapshot available" },
      balanceSheet: balanceSheet?.data || { error: "No snapshot available" },
      cashSales: cashSales?.data || { error: "No snapshot available" },
      generalLedger: generalLedger?.data || { error: "No snapshot available" },
      trialBalance: trialBalance?.data || { error: "No snapshot available" },
    };
    const responsePayload = {
      success: true,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      lastSyncAt,
      datasetVersion,
      data: combinedData,
      ...combinedData,
      _meta: {
        source: "cached_snapshot",
        disconnected: Boolean(req.qbDisconnected),
        lastSyncAt,
        datasetVersion,
      },
    };

    const hasAnyReport = [
      accountList,
      agedPayableDetail,
      agedReceivableDetail,
      balanceSheet,
      cashSales,
      generalLedger,
      trialBalance,
    ].some((entry) => Boolean(entry?.data));

    if (!hasAnyReport) {
      return res.status(404).json({
        success: false,
        source: "cached_snapshot",
        disconnected: Boolean(req.qbDisconnected),
        message:
          "No finalized snapshot data is available for combined reports. Run QuickBooks sync to generate snapshots.",
        data: combinedData,
      });
    }

    return res.json(responsePayload);
  } catch (error) {
    console.error("[All Reports] Snapshot read failed:", error.message);
    return res.status(500).json({
      success: false,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      message: "Failed to load combined report snapshots.",
      error: error.message,
    });
  }
});

module.exports = router;

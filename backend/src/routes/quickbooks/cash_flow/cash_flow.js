const express = require("express");
const {
  fetchAndCacheReport,
  serveCachedReport,
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

router.get("/qb-transactions", async (req, res) => {
  const clientId = req.clientId;

  try {
    const cached =
      (await serveCachedReport(clientId, REPORT_TYPES.TRANSACTIONS, {}, { disconnected: Boolean(req.qbDisconnected) })) ||
      (await serveCachedReport(clientId, "transactions", {}, { disconnected: Boolean(req.qbDisconnected) }));

    if (!cached?.data) {
      return res.status(404).json({
        success: false,
        source: "cached_snapshot",
        disconnected: Boolean(req.qbDisconnected),
        message: "No finalized transactions snapshot available.",
      });
    }

    return res.json(snapshotEnvelope(cached, req.qbDisconnected));
  } catch (error) {
    console.error("[Cashflow][Transactions] Snapshot read failed:", error.message);
    return res.status(500).json({
      success: false,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      message: "Failed to load transactions snapshot.",
      error: error.message,
    });
  }
});

router.get("/qb-cashflow", async (req, res) => {
  const clientId = req.clientId;
  const { start_date, end_date, accounting_method } = req.query;

  try {
    const cached = await fetchAndCacheReport(
      clientId,
      REPORT_TYPES.CASH_FLOW,
      "CashFlow",
      { start_date, end_date, accounting_method },
    );

    return res.json(snapshotEnvelope(cached, req.qbDisconnected));
  } catch (error) {
    const status = /No finalized snapshot/i.test(error.message) ? 404 : 500;
    return res.status(status).json({
      success: false,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      message: error.message,
    });
  }
});

router.get("/qb-accounts", async (req, res) => {
  const clientId = req.clientId;

  try {
    const cached = await serveCachedReport(
      clientId,
      REPORT_TYPES.ACCOUNTS,
      {},
      { disconnected: Boolean(req.qbDisconnected) },
    );

    if (!cached?.data) {
      return res.status(404).json({
        success: false,
        source: "cached_snapshot",
        disconnected: Boolean(req.qbDisconnected),
        message: "No finalized accounts snapshot available.",
      });
    }

    return res.json(snapshotEnvelope(cached, req.qbDisconnected));
  } catch (error) {
    console.error("[Cashflow][Accounts] Snapshot read failed:", error.message);
    return res.status(500).json({
      success: false,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      message: "Failed to load accounts snapshot.",
      error: error.message,
    });
  }
});

router.get("/qb-cashflow-engine", async (req, res) => {
  const clientId = req.clientId;
  const { start_date, end_date, accounting_method, created_after } = req.query;

  try {
    const explicitEngine = await serveCachedReport(
      clientId,
      REPORT_TYPES.CASHFLOW_ENGINE,
      { start_date, end_date, accounting_method, created_after },
      { disconnected: Boolean(req.qbDisconnected) },
    );

    if (explicitEngine?.data) {
      return res.json(snapshotEnvelope(explicitEngine, req.qbDisconnected));
    }

    const [transactions, accounts, cashflow] = await Promise.all([
      serveCachedReport(clientId, REPORT_TYPES.TRANSACTIONS, {}, { disconnected: Boolean(req.qbDisconnected) }),
      serveCachedReport(clientId, REPORT_TYPES.ACCOUNTS, {}, { disconnected: Boolean(req.qbDisconnected) }),
      serveCachedReport(
        clientId,
        REPORT_TYPES.CASH_FLOW,
        { start_date, end_date, accounting_method },
        { disconnected: Boolean(req.qbDisconnected) },
      ),
    ]);

    if (!accounts?.data && !cashflow?.data && !transactions?.data) {
      return res.status(404).json({
        success: false,
        source: "cached_snapshot",
        disconnected: Boolean(req.qbDisconnected),
        message: "No finalized cashflow engine snapshot data is available.",
      });
    }

    const composed = {
      filtersUsed: {
        start_date: start_date || null,
        end_date: end_date || null,
        accounting_method: accounting_method || null,
        created_after: created_after || null,
      },
      transactions: transactions?.data || {},
      accounts: accounts?.data || {},
      cashflow: cashflow?.data || {},
    };

    return res.json({
      success: true,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      lastSyncAt:
        cashflow?.lastSyncedAt ||
        accounts?.lastSyncedAt ||
        transactions?.lastSyncedAt ||
        null,
      datasetVersion:
        cashflow?.datasetVersion ||
        accounts?.datasetVersion ||
        transactions?.datasetVersion ||
        null,
      data: composed,
    });
  } catch (error) {
    console.error("[Cashflow Engine] Snapshot read failed:", error.message);
    return res.status(500).json({
      success: false,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      message: "Failed to load cashflow engine snapshot.",
      error: error.message,
    });
  }
});

module.exports = router;

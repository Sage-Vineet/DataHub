const express = require("express");
const axios = require("axios");
const { getQBConfig, loadQBConfig } = require("../../../qbconfig");
const tokenManager = require("../../../tokenManager");
const { supabase } = require("../../../db");
const qbBankReconService = require("../../../services/qbBankReconciliationService");
const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Reconciliation
 *   description: Bank vs Books reconciliation APIs
 */

/**
 * @swagger
 * /qb-general-ledger:
 *   get:
 *     tags:
 *       - Reconciliation
 *     summary: Fetch General Ledger transactions
 */
router.get("/qb-general-ledger", async (req, res) => {
  const qb = getQBConfig(req.clientId);
  const { start_date, end_date, accounting_method } = req.query;

  try {
    const response = await axios.get(
      `${qb.baseUrl}/v3/company/${qb.realmId}/reports/GeneralLedger`,
      {
        headers: {
          Authorization: `Bearer ${qb.accessToken}`,
          Accept: "application/json",
        },
        proxy: false,
        params: {
          start_date,
          end_date,
          accounting_method,
          minorversion: 75,
        },
      },
    );

    const sections = response.data.Rows?.Row || [];
    const transactions = [];

    sections.forEach((section) => {
      if (!section.Rows) return;
      section.Rows.Row.forEach((txn) => {
        if (txn.type !== "Data") return;
        const col = txn.ColData;
        const date = col[0]?.value;
        const type = col[1]?.value;
        const name = col[3]?.value;
        const amount = col[6]?.value;
        if (date && amount) {
          transactions.push({ date, type, name, amount });
        }
      });
    });

    await supabase
      .from("reconciliation_transactions")
      .delete()
      .eq("client_id", req.clientId);

    if (transactions.length > 0) {
      const toInsert = transactions.map((txn) => ({
        client_id: req.clientId,
        txn_date: txn.date,
        amount: txn.amount,
        name: txn.name,
        transaction_type: txn.type,
      }));
      
      const { error: insertError } = await supabase
        .from("reconciliation_transactions")
        .insert(toInsert);
      
      if (insertError) throw insertError;
    }


    res.json({
      message: "Data stored successfully",
      totalInserted: transactions.length,
    });
  } catch (error) {
    console.error("GeneralLedger Error:", error);
    res.status(500).json({ error: "Failed to fetch General Ledger" });
  }
});

/**
 * @swagger
 * /qb-reconciliation-transactions:
 *   get:
 *     tags:
 *       - Reconciliation
 *     summary: Fetch transactions for reconciliation
 */
router.get("/qb-reconciliation-transactions", async (req, res) => {
  const qb = getQBConfig(req.clientId);
  const base = `${qb.baseUrl}/v3/company/${qb.realmId}/query`;
  const headers = {
    Authorization: `Bearer ${qb.accessToken}`,
    Accept: "application/json",
  };
  const { start_date, end_date, max_results = 50 } = req.query;

  const queries = {
    invoices: `SELECT * FROM Invoice WHERE TxnDate >= '${start_date}' AND TxnDate <= '${end_date}' MAXRESULTS ${max_results}`,
    payments: `SELECT * FROM Payment WHERE TxnDate >= '${start_date}' AND TxnDate <= '${end_date}' MAXRESULTS ${max_results}`,
    deposits: `SELECT * FROM Deposit WHERE TxnDate >= '${start_date}' AND TxnDate <= '${end_date}' MAXRESULTS ${max_results}`,
    purchases: `SELECT * FROM Purchase WHERE TxnDate >= '${start_date}' AND TxnDate <= '${end_date}' MAXRESULTS ${max_results}`,
  };

  const results = {};
  try {
    for (const key in queries) {
      const response = await axios.get(base, {
        headers,
        proxy: false,
        params: { query: queries[key], minorversion: 75 },
      });
      results[key] = response.data.QueryResponse || {};
    }
    res.json(results);
  } catch (error) {
    console.error(
      "Reconciliation Transactions Error:",
      error.response?.data || error.message,
    );
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

/**
 * @swagger
 * /qb-trial-balance:
 *   get:
 *     tags:
 *       - Reconciliation
 *     summary: Fetch Trial Balance
 */
router.get("/qb-trial-balance", async (req, res) => {
  const qb = getQBConfig(req.clientId);
  try {
    const response = await axios.get(
      `${qb.baseUrl}/v3/company/${qb.realmId}/reports/TrialBalance`,
      {
        headers: {
          Authorization: `Bearer ${qb.accessToken}`,
          Accept: "application/json",
        },
        proxy: false,
        params: {
          start_date: req.query.start_date,
          end_date: req.query.end_date,
          minorversion: 75,
        },
      },
    );
    res.json(response.data);
  } catch (error) {
    console.error(
      "TrialBalance API Error:",
      error.response?.data || error.message,
    );
    res.status(500).json({ error: "Failed to fetch trial balance" });
  }
});

/**
 * @swagger
 * /qb-reconciliation-engine:
 *   get:
 *     tags:
 *       - Reconciliation
 *     summary: Fetch combined reconciliation data
 */
router.get("/qb-reconciliation-engine", async (req, res) => {
  const qb = getQBConfig(req.clientId);
  const { start_date, end_date, accounting_method } = req.query;
  const headers = {
    Authorization: `Bearer ${qb.accessToken}`,
    Accept: "application/json",
  };

  try {
    const [ledger, accounts, trialBalance] = await Promise.all([
      axios.get(
        `${qb.baseUrl}/v3/company/${qb.realmId}/reports/GeneralLedger`,
        {
          headers,
          proxy: false,
          params: { start_date, end_date, accounting_method, minorversion: 75 },
        },
      ),
      axios.get(`${qb.baseUrl}/v3/company/${qb.realmId}/reports/AccountList`, {
        headers,
        proxy: false,
        params: { minorversion: 75 },
      }),
      axios.get(`${qb.baseUrl}/v3/company/${qb.realmId}/reports/TrialBalance`, {
        headers,
        proxy: false,
        params: { start_date, end_date, accounting_method, minorversion: 75 },
      }),
    ]);

    res.json({
      generalLedger: ledger.data,
      accounts: accounts.data,
      trialBalance: trialBalance.data,
    });
  } catch (error) {
    console.error(
      "Reconciliation Engine Error:",
      error.response?.data || error.message,
    );
    res.status(500).json({ error: "Failed to fetch reconciliation data" });
  }
});

/**
 * @swagger
 * /bank-transactions:
 *   post:
 *     summary: Store bank statement transactions
 */
router.post("/bank-transactions", async (req, res) => {
  const transactions = req.body;
  try {
    await supabase
      .from("bank_transactions")
      .delete()
      .eq("client_id", req.clientId);

    if (transactions.length > 0) {
      const toInsert = transactions.map((txn) => ({
        client_id: req.clientId,
        txn_date: txn.date,
        narration: txn.narration,
        amount: txn.amount,
      }));

      const { error: insertError } = await supabase
        .from("bank_transactions")
        .insert(toInsert);

      if (insertError) throw insertError;
    }

    res.json({
      message: "Bank transactions stored successfully",
      totalInserted: transactions.length,
    });
  } catch (error) {
    console.error("Bank Transaction Error:", error);
    res.status(500).json({ error: "Failed to store bank transactions" });
  }
});

/**
 * @swagger
 * /qb-profit-loss-detail:
 *   get:
 *     tags:
 *       - Reconciliation
 *     summary: Fetch Profit and Loss Detail report
 */
router.get("/qb-profit-loss-detail", async (req, res) => {
  const qb = getQBConfig(req.clientId);
  const { start_date, end_date, accounting_method } = req.query;

  try {
    const response = await axios.get(
      `${qb.baseUrl}/v3/company/${qb.realmId}/reports/ProfitAndLossDetail`,
      {
        headers: {
          Authorization: `Bearer ${qb.accessToken}`,
          Accept: "application/json",
        },
        proxy: false,
        params: {
          start_date,
          end_date,
          accounting_method,
          minorversion: 75,
        },
      },
    );

    res.json(response.data);
  } catch (error) {
    console.error(
      "ProfitAndLossDetail API Error:",
      error.response?.data || error.message,
    );
    res.status(500).json({ error: "Failed to fetch Profit & Loss Detail" });
  }
});

/**
 * @swagger
 * /qb-balance-sheet:
 *   get:
 *     tags:
 *       - Reconciliation
 *     summary: Fetch Balance Sheet report
 */
router.get("/qb-balance-sheet", async (req, res) => {
  const qb = getQBConfig(req.clientId);
  const { start_date, end_date, accounting_method } = req.query;

  if (!qb.accessToken || !qb.realmId) {
    return res.status(400).json({
      error: "Missing QuickBooks configuration. Please authenticate first.",
    });
  }

  const url = `${qb.baseUrl}/v3/company/${qb.realmId}/reports/BalanceSheet`;

  try {
    const fetchBalanceSheet = (accessToken) =>
      axios.get(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        proxy: false,
        params: {
          start_date,
          end_date,
          accounting_method,
          minorversion: 75,
        },
      });

    try {
      const response = await fetchBalanceSheet(qb.accessToken);
      return res.json({ success: true, data: response.data });
    } catch (error) {
      if (error.response?.status !== 401) {
        throw error;
      }

      console.log("⚠️ Balance Sheet token expired, attempting refresh...");
      const refreshedToken = await tokenManager.refreshAccessToken(
        req.clientId,
      );
      const retryResponse = await fetchBalanceSheet(refreshedToken);
      return res.json({
        success: true,
        data: retryResponse.data,
        refreshed: true,
      });
    }
  } catch (error) {
    console.error(
      "BalanceSheet API Error:",
      error.response?.data || error.message,
    );
    return res.status(error.response?.status || 500).json({
      error: "Failed to fetch Balance Sheet",
      details: error.response?.data || error.message,
    });
  }
});

/**
 * @swagger
 * /qb-financial-reports:
 *   get:
 *     tags:
 *       - Reconciliation
 *     summary: Fetch Profit & Loss Detail and Balance Sheet reports
 */
router.get("/qb-financial-reports-for-reconciliation", async (req, res) => {
  // Extract clientId with multiple fallbacks (same as bank statement endpoint)
  let clientId = req.clientId;
  if (!clientId && req.query.clientId) {
    clientId = req.query.clientId;
  }
  if (!clientId && req.headers.referer) {
    const referer = req.headers.referer;
    const match = referer.match(/\/client\/([^/]+)/);
    if (match) {
      clientId = match[1];
    }
  }

  if (!clientId) {
    console.error(
      "❌ Missing Client ID in qb-financial-reports-for-reconciliation",
    );
    return res.status(400).json({
      error: "Missing Client ID. Please access this from a company workspace.",
    });
  }

  req.clientId = clientId;
  const qb = getQBConfig(clientId);
  const { start_date, end_date, accounting_method } = req.query;

  console.log(`📊 Fetching financial reports for client: ${clientId}`);

  if (!qb.accessToken || !qb.realmId) {
    console.error(
      `❌ Missing QB configuration for client ${clientId}. accessToken: ${Boolean(qb.accessToken)}, realmId: ${qb.realmId}`,
    );
    return res.status(401).json({
      error: "QuickBooks is not connected for this company.",
      message:
        "Please connect QuickBooks first from the Connections page before fetching financial reports.",
    });
  }

  const headers = {
    Authorization: `Bearer ${qb.accessToken}`,
    Accept: "application/json",
  };

  const params = {
    start_date,
    end_date,
    accounting_method,
    minorversion: 75,
  };

  const profitLossUrl = `${qb.baseUrl}/v3/company/${qb.realmId}/reports/ProfitAndLossDetail`;
  const balanceSheetUrl = `${qb.baseUrl}/v3/company/${qb.realmId}/reports/BalanceSheet`;

  try {
    const fetchReports = (accessToken) =>
      Promise.all([
        axios.get(profitLossUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
          proxy: false,
          params,
        }),
        axios.get(balanceSheetUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
          proxy: false,
          params,
        }),
      ]);

    try {
      const [profitLoss, balanceSheet] = await fetchReports(qb.accessToken);

      return res.json({
        success: true,
        profit_and_loss: profitLoss.data,
        balance_sheet: balanceSheet.data,
      });
    } catch (error) {
      if (error.response?.status !== 401) throw error;

      console.log("⚠️ Token expired, refreshing...");

      const refreshedToken = await tokenManager.refreshAccessToken(
        req.clientId,
      );
      const [profitLoss, balanceSheet] = await fetchReports(refreshedToken);

      return res.json({
        success: true,
        refreshed: true,
        profit_and_loss: profitLoss.data,
        balance_sheet: balanceSheet.data,
      });
    }
  } catch (error) {
    console.error(
      "Financial Reports API Error:",
      error.response?.data || error.message,
    );

    return res.status(error.response?.status || 500).json({
      error: "Failed to fetch financial reports",
      details: error.response?.data || error.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW BACKEND ROUTES — add these to your existing reconciliation router
// ─────────────────────────────────────────────────────────────────────────────
// These routes use the QuickBooks Query API (recommended by your manager) to
// fetch bank account transactions directly, avoiding the bank-statement upload
// dependency for the Balance Review section.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /qb-bank-accounts:
 *   get:
 *     tags:
 *       - Reconciliation
 *     summary: Fetch all bank/cash accounts from QuickBooks Chart of Accounts
 *     description: Returns accounts of type Bank so the UI can map them to
 *                  Holding / Operating / General / Money Market buckets.
 */
router.get("/qb-bank-accounts", async (req, res) => {
  let clientId = req.clientId || req.query.clientId;
  if (!clientId && req.headers.referer) {
    const m = req.headers.referer.match(/\/client\/([^/]+)/);
    if (m) clientId = m[1];
  }
  if (!clientId) return res.status(400).json({ error: "Missing Client ID." });

  const qb = getQBConfig(clientId);
  if (!qb.accessToken || !qb.realmId)
    return res.status(401).json({ error: "QuickBooks not connected." });

  try {
    const query =
      "SELECT * FROM Account WHERE AccountType = 'Bank' MAXRESULTS 100";
    const response = await axios.get(
      `${qb.baseUrl}/v3/company/${qb.realmId}/query`,
      {
        headers: {
          Authorization: `Bearer ${qb.accessToken}`,
          Accept: "application/json",
        },
        proxy: false,
        params: { query, minorversion: 75 },
      },
    );
    const accounts = response.data?.QueryResponse?.Account || [];
    return res.json({ success: true, accounts });
  } catch (error) {
    console.error(
      "QB Bank Accounts Error:",
      error.response?.data || error.message,
    );
    return res.status(500).json({ error: "Failed to fetch bank accounts." });
  }
});

/**
 * @swagger
 * /qb-bank-activity:
 *   get:
 *     tags:
 *       - Reconciliation
 *     summary: Fetch monthly bank activity per account using QB Query API
 *     description: |
 *       Queries Deposit and Purchase (withdrawal) transactions for a given
 *       date range and groups them by month and account name.
 *       Returns structured monthly data matching the Balance Review layout.
 *     parameters:
 *       - name: start_date
 *         in: query
 *         required: true
 *         schema: { type: string, example: "2024-09-01" }
 *       - name: end_date
 *         in: query
 *         required: true
 *         schema: { type: string, example: "2025-08-31" }
 *       - name: accounting_method
 *         in: query
 *         schema: { type: string, enum: [Accrual, Cash], default: Accrual }
 */
/**
 * GET /qb-bank-activity/saved
 * Returns the last persisted QB Online bank reconciliation snapshot for a company.
 * Called on page load so the UI can restore data without requiring a live QB connection.
 */
router.get("/qb-bank-activity/saved", async (req, res) => {
  let clientId = req.clientId || req.query.clientId;
  if (!clientId && req.headers.referer) {
    const m = req.headers.referer.match(/\/client\/([^/]+)/);
    if (m) clientId = m[1];
  }
  if (!clientId) return res.status(400).json({ error: "Missing Client ID." });

  try {
    const snapshot = await qbBankReconService.loadSnapshot(clientId);
    if (!snapshot) return res.json({ found: false });

    console.log(`[Bank Recon] Serving saved snapshot for company=${clientId} updatedAt=${snapshot.updated_at}`);
    return res.json({
      found:       true,
      updatedAt:   snapshot.updated_at,
      startDate:   snapshot.start_date,
      endDate:     snapshot.end_date,
      accountingMethod: snapshot.accounting_method,
      data:        snapshot.data,
    });
  } catch (err) {
    console.error("[Bank Recon] Load snapshot error:", err.message);
    return res.status(500).json({ error: "Failed to load saved bank reconciliation data." });
  }
});

router.get("/qb-bank-activity", async (req, res) => {
  // ── resolve clientId ────────────────────────────────────────────────────────
  let clientId = req.clientId || req.query.clientId;
  if (!clientId && req.headers.referer) {
    const m = req.headers.referer.match(/\/client\/([^/]+)/);
    if (m) clientId = m[1];
  }
  if (!clientId) return res.status(400).json({ error: "Missing Client ID." });

  const qb = getQBConfig(clientId);
  if (!qb.accessToken || !qb.realmId)
    return res.status(401).json({ error: "QuickBooks not connected." });

  const { start_date, end_date } = req.query;
  if (!start_date || !end_date)
    return res
      .status(400)
      .json({ error: "start_date and end_date are required." });

  const baseUrl = `${qb.baseUrl}/v3/company/${qb.realmId}/query`;
  const performFetch = async () => {
    const headers = {
      Authorization: `Bearer ${qb.accessToken}`,
      Accept: "application/json",
    };

    // ── helper: run a QBO query ─────────────────────────────────────────────────
    const runQuery = async (query) => {
      const r = await axios.get(baseUrl, {
        headers,
        proxy: false,
        params: { query, minorversion: 75 },
      });
      return r.data?.QueryResponse || {};
    };

    // ── 1. Fetch all bank accounts ──────────────────────────────────────────
    const accountsQR = await runQuery(
      "SELECT * FROM Account WHERE AccountType = 'Bank' MAXRESULTS 1000",
    );
    const bankAccounts = accountsQR.Account || [];

    // ── 2. Fetch Deposits (credits / inflows) ───────────────────────────────
    const depositQuery = `SELECT * FROM Deposit WHERE TxnDate >= '${start_date}' AND TxnDate <= '${end_date}' MAXRESULTS 1000`;
    const depositQR = await runQuery(depositQuery);
    const deposits = depositQR.Deposit || [];

    // ── 3. Fetch Purchases = withdrawals (checks, expenses paid from bank) ──
    const purchaseQuery = `SELECT * FROM Purchase WHERE TxnDate >= '${start_date}' AND TxnDate <= '${end_date}' MAXRESULTS 1000`;
    const purchaseQR = await runQuery(purchaseQuery);
    const purchases = purchaseQR.Purchase || [];

    // ── 4. Fetch JournalEntries (catches intercompany transfers) ────────────
    const journalQuery = `SELECT * FROM JournalEntry WHERE TxnDate >= '${start_date}' AND TxnDate <= '${end_date}' MAXRESULTS 1000`;
    const journalQR = await runQuery(journalQuery);
    const journals = journalQR.JournalEntry || [];

    // ── 5. Fetch Transfers ──────────────────────────────────────────────────
    const transferQuery = `SELECT * FROM Transfer WHERE TxnDate >= '${start_date}' AND TxnDate <= '${end_date}' MAXRESULTS 1000`;
    const transferQR = await runQuery(transferQuery);
    const transfers = transferQR.Transfer || [];

    // ── 6. Fetch Account balances per month via GeneralLedger report ────────
    //    We call it once per month in the range and pull BankAccounts summary.
    //    This gives us the "Per Balance Sheet" / ending balance from QB books.
    const months = getMonthsRangeBackend(start_date, end_date);

    const monthlyBalances = {}; // { accountId: { "2024-09": endingBalance } }
    for (const month of months) {
      const [y, m] = month.split("-");
      const mStart = `${y}-${m}-01`;
      const lastDay = new Date(+y, +m, 0).getDate();
      const mEnd = `${y}-${m}-${String(lastDay).padStart(2, "0")}`;

      try {
        const bsResp = await axios.get(
          `${qb.baseUrl}/v3/company/${qb.realmId}/reports/BalanceSheet`,
          {
            headers,
            proxy: false,
            params: {
              start_date: mStart,
              end_date: mEnd,
              accounting_method: req.query.accounting_method || "Accrual",
              minorversion: 75,
            },
          },
        );
        const bsRows = bsResp.data?.Rows?.Row || [];
        // walk rows to find bank account balances
        walkBSRows(bsRows, monthlyBalances, month, bankAccounts);
      } catch (e) {
        console.warn(`Balance Sheet fetch failed for ${month}:`, e.message);
      }
    }

    // ── 7. Build per-account monthly activity from transactions ────────────
    // Map: accountId → { month → { deposits, withdrawals, intercompanyDeposits, intercompanyWithdraws } }
    const activityMap = {}; // accountId → month → {...}

    const ensureSlot = (accountId, month) => {
      if (!activityMap[accountId]) activityMap[accountId] = {};
      if (!activityMap[accountId][month])
        activityMap[accountId][month] = {
          deposits: 0,
          withdrawals: 0,
          intercompanyDeposits: 0,
          intercompanyWithdraws: 0,
        };
      return activityMap[accountId][month];
    };

    const txnMonth = (dateStr) => {
      const d = new Date(dateStr);
      if (isNaN(d)) return null;
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    };

    // Process Deposits → credits into a bank account
    for (const dep of deposits) {
      const accountId = dep.DepositToAccountRef?.value;
      const month = txnMonth(dep.TxnDate);
      if (!accountId || !month) continue;
      const amt = parseFloat(dep.TotalAmt || 0);
      const slot = ensureSlot(accountId, month);
      slot.deposits += amt;
    }

    // Process Purchases → withdrawals from a bank account
    for (const pur of purchases) {
      const accountId = pur.AccountRef?.value;
      const month = txnMonth(pur.TxnDate);
      if (!accountId || !month) continue;
      const amt = parseFloat(pur.TotalAmt || 0);
      const slot = ensureSlot(accountId, month);
      slot.withdrawals += Math.abs(amt);
    }

    // Process Transfers — amount moves from FromAccount → ToAccount
    for (const tr of transfers) {
      const fromId = tr.FromAccountRef?.value;
      const toId = tr.ToAccountRef?.value;
      const month = txnMonth(tr.TxnDate);
      if (!month) continue;
      const amt = parseFloat(tr.Amount || 0);

      // Determine if it's intercompany (both accounts are bank accounts)
      const fromIsBank = bankAccounts.some((a) => a.Id === fromId);
      const toIsBank = bankAccounts.some((a) => a.Id === toId);
      const isIntercompany = fromIsBank && toIsBank;

      if (fromId) {
        const slot = ensureSlot(fromId, month);
        slot.withdrawals += amt;
        if (isIntercompany) slot.intercompanyWithdraws += amt;
      }
      if (toId) {
        const slot = ensureSlot(toId, month);
        slot.deposits += amt;
        if (isIntercompany) slot.intercompanyDeposits += amt;
      }
    }

    // Process JournalEntries — look at Line items for bank account hits
    for (const je of journals) {
      const month = txnMonth(je.TxnDate);
      if (!month) continue;
      const lines = je.Line || [];
      for (const line of lines) {
        const detail = line.JournalEntryLineDetail;
        if (!detail) continue;
        const accountId = detail.AccountRef?.value;
        if (!accountId) continue;
        const isBank = bankAccounts.some((a) => a.Id === accountId);
        if (!isBank) continue;
        const amt = parseFloat(line.Amount || 0);
        const postingType = detail.PostingType; // "Debit" or "Credit"
        const slot = ensureSlot(accountId, month);
        if (postingType === "Debit") slot.deposits += amt;
        else slot.withdrawals += amt;
      }
    }

    // ── 8. Build final response ─────────────────────────────────────────────
    const result = bankAccounts.map((acct) => {
      const aid = acct.Id;
      const monthlyActivity = activityMap[aid] || {};
      const monthlyBS = monthlyBalances[aid] || {};

      let runningBalance = parseFloat(acct.CurrentBalance || 0);
      // Find earliest month to back-calculate opening balance
      const sortedMonths = months.slice().sort();
      const firstMonth = sortedMonths[0];
      if (firstMonth) {
        const firstAct = monthlyActivity[firstMonth] || {
          deposits: 0,
          withdrawals: 0,
        };
        const firstEndingFromBS = monthlyBS[firstMonth];
        if (firstEndingFromBS != null) {
          // back-calculate: opening = ending - deposits + withdrawals
          runningBalance =
            firstEndingFromBS - firstAct.deposits + firstAct.withdrawals;
        }
      }

      const monthRows = months.map((month) => {
        const act = monthlyActivity[month] || {
          deposits: 0,
          withdrawals: 0,
          intercompanyDeposits: 0,
          intercompanyWithdraws: 0,
        };
        const startingBalance = runningBalance;
        const endingBalance = startingBalance + act.deposits - act.withdrawals;
        runningBalance = endingBalance;

        const perBalanceSheet = monthlyBS[month] ?? null;
        const variance =
          perBalanceSheet != null ? endingBalance - perBalanceSheet : null;

        return {
          month,
          startingBalance,
          deposits: act.deposits,
          withdrawals: act.withdrawals,
          endingBalance,
          intercompanyDeposits: act.intercompanyDeposits,
          intercompanyWithdraws: act.intercompanyWithdraws,
          perBalanceSheet,
          variance,
        };
      });

      // Add priorMonthCheck
      const withPrior = monthRows.map((r, i) => ({
        ...r,
        priorMonthCheck:
          i === 0 ? 0 : monthRows[i - 1].endingBalance - r.startingBalance,
        footingCheck:
          r.endingBalance - (r.startingBalance + r.deposits - r.withdrawals),
      }));

      return {
        accountId: aid,
        accountName: acct.Name,
        accountNumber: acct.AcctNum || "",
        currentBalance: parseFloat(acct.CurrentBalance || 0),
        monthlyData: withPrior,
      };
    });

    // ── 9. Fetch P&L Summary (monthly) for Sales/Expenses per Financials ─────
    const plFinancials = { totalIncome: {}, totalExpenses: {} };
    try {
      const plResp = await axios.get(
        `${qb.baseUrl}/v3/company/${qb.realmId}/reports/ProfitAndLoss`,
        {
          headers,
          proxy: false,
          params: {
            start_date,
            end_date,
            summarize_column_by: "Month",
            accounting_method: req.query.accounting_method || "Accrual",
            minorversion: 75,
          },
        },
      );
      const plData = plResp.data;
      const columns = plData?.Columns?.Column || [];

      // Build columnIndex → "YYYY-MM" map from column headers like "Jan 2026"
      const colMonthMap = {};
      columns.forEach((col, idx) => {
        if (idx === 0) return; // label column
        const title = String(col.ColTitle || "").trim();
        if (/^total$/i.test(title)) return;
        const parsed = parsePLColTitle(title);
        if (parsed) colMonthMap[idx] = parsed;
      });

      // Walk top-level sections to find Income and Expenses summaries
      const plRows = plData?.Rows?.Row || [];
      for (const section of plRows) {
        if (section.type !== "Section") continue;
        const sectionName = String(section.Header?.ColData?.[0]?.value || "").trim();
        const summaryData = section.Summary?.ColData || [];

        if (/^income$/i.test(sectionName)) {
          for (const [idxStr, monthKey] of Object.entries(colMonthMap)) {
            const raw = summaryData[Number(idxStr)]?.value;
            plFinancials.totalIncome[monthKey] = parseFloat(String(raw || "0").replace(/,/g, "")) || 0;
          }
        } else if (/^(expenses?|total expenses?)$/i.test(sectionName)) {
          for (const [idxStr, monthKey] of Object.entries(colMonthMap)) {
            const raw = summaryData[Number(idxStr)]?.value;
            plFinancials.totalExpenses[monthKey] = Math.abs(parseFloat(String(raw || "0").replace(/,/g, "")) || 0);
          }
        }
      }
    } catch (plErr) {
      console.warn("[Bank Activity] P&L Summary fetch failed (non-fatal):", plErr.message);
    }

    return { success: true, accounts: result, months, plFinancials };
  };

  const saveAndRespond = async (data) => {
    // Persist snapshot in background — never block the response.
    qbBankReconService.saveSnapshot({
      companyId:        clientId,
      fetchedBy:        req.user?.id || null,
      accountingMethod: req.query.accounting_method || "Accrual",
      startDate:        start_date,
      endDate:          end_date,
      data,
    }).catch((saveErr) =>
      console.error("[Bank Recon] Auto-save failed:", saveErr.message)
    );

    console.log(
      `[Audit] [Bank Recon] company=${clientId} accounts=${data?.accounts?.length ?? 0} months=${data?.months?.length ?? 0} fetchedBy=${req.user?.id || "unknown"} at=${new Date().toISOString()}`
    );
    return res.json(data);
  };

  try {
    try {
      const data = await performFetch();
      return saveAndRespond(data);
    } catch (err) {
      if (err.response?.status !== 401) throw err;
      console.log("⚠️ /qb-bank-activity token expired, refreshing...");
      qb.accessToken = await tokenManager.refreshAccessToken(clientId);
      const retryData = await performFetch();
      return saveAndRespond(retryData);
    }
  } catch (error) {
    console.error(
      "QB Bank Activity Error:",
      error.response?.data || error.message,
    );
    return res.status(500).json({
      error: "Failed to fetch bank activity.",
      details: error.response?.data || error.message,
    });
  }
});

// ─── Helpers (backend-only) ───────────────────────────────────────────────────

/**
 * Parse a QB P&L column title like "Jan 2026" into "2026-01".
 * Returns null for unrecognised formats (e.g. "Total").
 */
// ── P&L Line Items for Bank Recon Addback Picker ─────────────────────────────
router.get("/bank-reconciliation-line-items", async (req, res) => {
  const qb = getQBConfig(req.clientId);
  if (!qb.accessToken || !qb.realmId) {
    return res.status(401).json({ success: false, error: "QuickBooks not connected." });
  }
  const { start_date, end_date, accounting_method } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ success: false, error: "start_date and end_date are required." });
  }
  try {
    const authHeaders = { Authorization: `Bearer ${qb.accessToken}`, Accept: "application/json" };
    const plResp = await axios.get(
      `${qb.baseUrl}/v3/company/${qb.realmId}/reports/ProfitAndLoss`,
      {
        headers: authHeaders,
        proxy: false,
        params: {
          start_date,
          end_date,
          summarize_column_by: "Month",
          accounting_method: accounting_method || "Accrual",
          minorversion: 75,
        },
      },
    );
    const plData = plResp.data;
    const columns = plData?.Columns?.Column || [];

    const colMonthMap = {};
    columns.forEach((col, idx) => {
      if (idx === 0) return;
      const title = col.ColTitle || "";
      if (title === "TOTAL" || title === "Total") return;
      const parsed = parsePLColTitle(title);
      if (parsed) colMonthMap[idx] = parsed;
    });

    function toNum(str) {
      const n = parseFloat(String(str || "0").replace(/,/g, ""));
      return Number.isFinite(n) ? n : 0;
    }

    function walkRows(rows, target, sectionType) {
      const arr = Array.isArray(rows) ? rows : rows ? [rows] : [];
      for (const row of arr) {
        if (row.type === "Data") {
          const name = row.ColData?.[0]?.value || "";
          if (!name) continue;
          const monthAmounts = {};
          Object.entries(colMonthMap).forEach(([idxStr, monthKey]) => {
            const val = toNum(row.ColData?.[Number(idxStr)]?.value);
            if (val !== 0) monthAmounts[monthKey] = val;
          });
          target.push({ name, source: sectionType, monthAmounts });
        } else if (row.type === "Section") {
          const sub = row.Rows?.Row;
          if (sub) walkRows(sub, target, sectionType);
        }
      }
    }

    const plIncomeItems = [];
    const plExpenseItems = [];
    const topRows = plData?.Rows?.Row || [];
    for (const section of (Array.isArray(topRows) ? topRows : [topRows])) {
      if (section.type !== "Section") continue;
      const sectionName = String(section.Header?.ColData?.[0]?.value || "").trim().toLowerCase();
      const sub = section.Rows?.Row;
      if (!sub) continue;
      if (sectionName === "income") {
        walkRows(sub, plIncomeItems, "pl_income");
      } else if (sectionName === "expenses" || sectionName === "expense") {
        walkRows(sub, plExpenseItems, "pl_expense");
      }
    }

    // Aggregate totals per month for Sales/Expenses per Financials rows
    const plTotalIncome = {};
    const plTotalExpenses = {};
    plIncomeItems.forEach((item) => {
      Object.entries(item.monthAmounts).forEach(([m, v]) => {
        plTotalIncome[m] = (plTotalIncome[m] || 0) + v;
      });
    });
    plExpenseItems.forEach((item) => {
      Object.entries(item.monthAmounts).forEach(([m, v]) => {
        plTotalExpenses[m] = (plTotalExpenses[m] || 0) + v;
      });
    });

    return res.json({ success: true, plIncomeItems, plExpenseItems, plTotalIncome, plTotalExpenses });
  } catch (error) {
    if (error.response?.status === 401) {
      try { await tokenManager.refreshAccessToken(req.clientId); } catch (_) {}
    }
    console.error("[LineItems]", error.response?.data || error.message);
    return res.status(500).json({ success: false, error: "Failed to fetch line items." });
  }
});

function parsePLColTitle(title) {
  const MONTH_MAP = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const m = String(title || "").trim().match(/^([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return null;
  const mm = MONTH_MAP[m[1].toLowerCase()];
  return mm ? `${m[2]}-${mm}` : null;
}

function getMonthsRangeBackend(start, end) {
  const result = [];
  const [sy, sm] = start.split("-").map(Number);
  const [ey, em] = end.split("-").map(Number);
  for (let y = sy; y <= ey; y++)
    for (let m = y === sy ? sm : 1; m <= (y === ey ? em : 12); m++)
      result.push(`${y}-${String(m).padStart(2, "0")}`);
  return result;
}

/**
 * Walk QuickBooks BalanceSheet Rows recursively.
 * When we find a row whose Header/ColData[0] name matches a known bank account,
 * we store its ColData[1] value as the ending balance for that account+month.
 */
function walkBSRows(rows, monthlyBalances, month, bankAccounts) {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    // Data row — check if it's a bank account line
    if (row.type === "Data" && row.ColData) {
      const rowName = (row.ColData[0]?.value || "").trim();
      const rowId = row.ColData[0]?.id; // QB sometimes provides account ID here
      const rawVal = row.ColData[1]?.value;
      if (rawVal == null || rawVal === "") continue;
      const val = parseFloat(String(rawVal).replace(/,/g, ""));
      if (isNaN(val)) continue;

      // Match by id first, then by name
      let matched = bankAccounts.find((a) => rowId && a.Id === rowId);
      if (!matched) {
        const norm = rowName.toLowerCase();
        matched = bankAccounts.find(
          (a) =>
            a.Name.toLowerCase() === norm ||
            norm.includes(a.Name.toLowerCase()) ||
            a.Name.toLowerCase().includes(norm),
        );
      }
      if (matched) {
        if (!monthlyBalances[matched.Id]) monthlyBalances[matched.Id] = {};
        monthlyBalances[matched.Id][month] = val;
      }
    }

    // Recurse into nested rows
    if (row.Rows?.Row) {
      const nested = Array.isArray(row.Rows.Row)
        ? row.Rows.Row
        : [row.Rows.Row];
      walkBSRows(nested, monthlyBalances, month, bankAccounts);
    }
  }
}

// ── Activity Review (per-account Balance Sheet movement) for QuickBooks Online ─
//
// Key Reports mode gets its "Changes in Assets / Liabilities / Long-Term Assets
// / Long-Term Liabilities" rows from computeActivityReviewFromFs() in
// WorkspaceReconciliation.jsx, fed by a generated financial-statements payload
// shaped as { reports: { balanceSheet: { monthly: [{year, monthNumber,
// statement}] }, profitAndLoss: { monthly: [...] } } }. QuickBooks Online has no
// such generated version — instead, QBO's OWN BalanceSheet/ProfitAndLoss
// reports (fetched with summarize_column_by=Month) already group every account
// into standard sections. Reshaping those sections into the identical payload
// shape lets the frontend reuse computeActivityReviewFromFs() unchanged — only
// the data source differs, not the shape or the classification rules.
//
// Only "Bank Accounts" (excluded — it IS the cash being reconciled) and
// "Accounts Receivable" (routes to the Deposits side, enables the AR-retention
// split) need an explicit reportTag. Every other account is left untagged and
// defaults to the Withdrawals side, exactly like the Manual-GL engine — see
// _sectionForLeaf / _SECTION_BY_REPORT_TAG in WorkspaceReconciliation.jsx.
const BS_SECTION_BUCKETS = [
  { re: /^bank\s+accounts?$/i,                   bucketKey: "currentAssets",      reportTag: "cash" },
  { re: /^accounts?\s+receivable/i,               bucketKey: "currentAssets",      reportTag: "accounts_receivable" },
  { re: /^other\s+current\s+assets?$/i,           bucketKey: "currentAssets",      reportTag: null },
  { re: /^fixed\s+assets?$/i,                     bucketKey: "fixedAssets",        reportTag: null },
  { re: /^other\s+assets?$/i,                     bucketKey: "otherAssets",        reportTag: null },
  { re: /^accounts?\s+payable/i,                  bucketKey: "currentLiabilities", reportTag: null },
  { re: /^credit\s+cards?$/i,                     bucketKey: "currentLiabilities", reportTag: null },
  { re: /^other\s+current\s+liabilit(?:y|ies)$/i, bucketKey: "currentLiabilities", reportTag: null },
  { re: /^long[\s-]?term\s+liabilit(?:y|ies)$/i,  bucketKey: "longTermLiabilities", reportTag: null },
];
const BS_SKIP_SECTION_RE = /^equity$/i;

function parseColDataAmounts(colData) {
  const values = {};
  (colData || []).forEach((cell, idx) => {
    if (idx === 0) return;
    const raw = cell?.value;
    if (raw == null || raw === "") return;
    const num = parseFloat(String(raw).replace(/,/g, ""));
    if (!Number.isNaN(num)) values[idx] = num;
  });
  return values;
}

/**
 * Walks a live QuickBooks BalanceSheet report (summarize_column_by=Month) and
 * appends { bucketKey, reportTag, systemId, name, valuesByCol } to `leaves` for
 * every account line item, classified by whichever known QBO section (see
 * BS_SECTION_BUCKETS) contains it — at any depth, since QBO's exact nesting
 * varies by company report settings.
 */
function collectBsLeaves(rows, ctx, leaves) {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (row.type === "Section") {
      const label = String(row.Header?.ColData?.[0]?.value || "").trim();
      if (BS_SKIP_SECTION_RE.test(label)) continue;
      const matched = BS_SECTION_BUCKETS.find((b) => b.re.test(label));
      const nextCtx = matched ? { bucketKey: matched.bucketKey, reportTag: matched.reportTag } : ctx;
      const nested = row.Rows?.Row;
      if (nested) collectBsLeaves(Array.isArray(nested) ? nested : [nested], nextCtx, leaves);
      continue;
    }
    if (row.type === "Data" && row.ColData && ctx) {
      const name = String(row.ColData[0]?.value || "").trim();
      if (!name) continue;
      leaves.push({
        bucketKey: ctx.bucketKey,
        reportTag: ctx.reportTag,
        systemId: row.ColData[0]?.id || null,
        name,
        valuesByCol: parseColDataAmounts(row.ColData),
      });
    }
  }
}

// Every expense line item under the P&L's "Expenses" section, flattened.
// computeActivityReviewFromFs() classifies depreciation / amortization / bad
// debt purely by ACCOUNT NAME (see _depAmortKind / _isBadDebt) — no reportTag
// needed here, so this only needs name + per-month amounts.
function collectPlExpenseLeaves(rows, insideExpenses, leaves) {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (row.type === "Section") {
      const label = String(row.Header?.ColData?.[0]?.value || "").trim();
      const isExpenses = insideExpenses || /^(operating\s+)?expenses?$/i.test(label);
      const nested = row.Rows?.Row;
      if (nested) collectPlExpenseLeaves(Array.isArray(nested) ? nested : [nested], isExpenses, leaves);
      continue;
    }
    if (row.type === "Data" && row.ColData && insideExpenses) {
      const name = String(row.ColData[0]?.value || "").trim();
      if (!name) continue;
      leaves.push({ name, valuesByCol: parseColDataAmounts(row.ColData) });
    }
  }
}

function buildColMonthMap(columns) {
  const map = {};
  (columns || []).forEach((col, idx) => {
    if (idx === 0) return;
    const title = String(col.ColTitle || "").trim();
    if (/^total$/i.test(title)) return;
    const parsed = parsePLColTitle(title);
    if (parsed) map[idx] = parsed;
  });
  return map;
}

const BS_BUCKET_PATH = {
  currentAssets: ["assets", "currentAssets"],
  fixedAssets: ["assets", "fixedAssets"],
  otherAssets: ["assets", "otherAssets"],
  currentLiabilities: ["liabilities", "currentLiabilities"],
  longTermLiabilities: ["liabilities", "longTermLiabilities"],
};
const BS_BUCKET_LABEL = {
  currentAssets: "Current Assets",
  fixedAssets: "Fixed Assets",
  otherAssets: "Other Assets",
  currentLiabilities: "Current Liabilities",
  longTermLiabilities: "Long-Term Liabilities",
};

function emptyBsStatement() {
  const mkBucket = (bucketKey) => ({ groups: { all: { label: BS_BUCKET_LABEL[bucketKey], accounts: [] } } });
  return {
    assets: {
      currentAssets: mkBucket("currentAssets"),
      fixedAssets: mkBucket("fixedAssets"),
      otherAssets: mkBucket("otherAssets"),
    },
    liabilities: {
      currentLiabilities: mkBucket("currentLiabilities"),
      longTermLiabilities: mkBucket("longTermLiabilities"),
    },
  };
}

/**
 * Reshapes a live QuickBooks BalanceSheet + ProfitAndLoss (both fetched with
 * summarize_column_by=Month) into { balanceSheetMonthly, profitAndLossMonthly },
 * the exact `reports.balanceSheet.monthly` / `reports.profitAndLoss.monthly`
 * shape computeActivityReviewFromFs() (WorkspaceReconciliation.jsx) consumes.
 */
function buildActivityReviewMonthlyStatements(bsReport, plReport) {
  const bsColMonthMap = buildColMonthMap(bsReport?.Columns?.Column);
  const bsLeaves = [];
  collectBsLeaves(bsReport?.Rows?.Row, null, bsLeaves);

  const plColMonthMap = buildColMonthMap(plReport?.Columns?.Column);
  const plLeaves = [];
  collectPlExpenseLeaves(plReport?.Rows?.Row, false, plLeaves);

  const balanceSheetMonthly = Object.entries(bsColMonthMap).map(([colIdx, monthKey]) => {
    const [year, monthNumber] = monthKey.split("-").map(Number);
    const statement = emptyBsStatement();
    for (const leaf of bsLeaves) {
      const amount = leaf.valuesByCol[colIdx];
      if (amount === undefined || !leaf.bucketKey) continue;
      const [section, bucketKey] = BS_BUCKET_PATH[leaf.bucketKey];
      statement[section][bucketKey].groups.all.accounts.push({
        systemId: leaf.systemId,
        accountNumber: null,
        name: leaf.name,
        adjustedName: leaf.name,
        amount,
        reportTag: leaf.reportTag || null,
      });
    }
    return { year, monthNumber, statement };
  }).sort((a, b) => (a.year - b.year) || (a.monthNumber - b.monthNumber));

  const profitAndLossMonthly = Object.entries(plColMonthMap).map(([colIdx, monthKey]) => {
    const [year, monthNumber] = monthKey.split("-").map(Number);
    const accounts = [];
    for (const leaf of plLeaves) {
      const amount = leaf.valuesByCol[colIdx];
      if (amount === undefined) continue;
      accounts.push({ systemId: null, accountNumber: null, name: leaf.name, adjustedName: leaf.name, amount, reportTag: null });
    }
    return {
      year, monthNumber,
      statement: { operatingExpenses: { groups: { all: { label: "Expenses", accounts } } } },
    };
  }).sort((a, b) => (a.year - b.year) || (a.monthNumber - b.monthNumber));

  return { balanceSheetMonthly, profitAndLossMonthly };
}

// GET /qb-activity-review — per-account Balance Sheet movement for the Activity
// Review table's "Changes in Assets / Liabilities / Long-Term Assets / Long-Term
// Liabilities" rows, sourced from live QuickBooks data. Shaped identically to
// GET /key-reports/versions/:id/reports/financial-statements so the frontend's
// existing computeActivityReviewFromFs() needs no changes.
router.get("/qb-activity-review", async (req, res) => {
  const { start_date, end_date } = req.query;
  const accounting_method = req.query.accounting_method || "Accrual";
  let clientId = req.clientId || req.query.clientId;
  if (!clientId && req.headers.referer) {
    const m = req.headers.referer.match(/\/client\/([^/]+)/);
    if (m) clientId = m[1];
  }
  if (!clientId) return res.status(400).json({ error: "Missing Client ID." });
  if (!start_date || !end_date) {
    return res.status(400).json({ error: "start_date and end_date are required" });
  }

  try {
    await loadQBConfig(clientId);
    const qb = getQBConfig(clientId);
    if (!qb.accessToken || !qb.realmId) {
      return res.status(401).json({ error: "QuickBooks is not connected for this company." });
    }

    const fetchReport = async (qbName) => {
      const execute = (token) =>
        axios.get(`${qb.baseUrl}/v3/company/${qb.realmId}/reports/${qbName}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          proxy: false,
          params: { start_date, end_date, summarize_column_by: "Month", accounting_method, minorversion: 75 },
        });
      try {
        return (await execute(qb.accessToken)).data;
      } catch (err) {
        if (err.response?.status !== 401) throw err;
        qb.accessToken = await tokenManager.refreshAccessToken(clientId);
        return (await execute(qb.accessToken)).data;
      }
    };

    const [bsReport, plReport] = await Promise.all([
      fetchReport("BalanceSheet"),
      fetchReport("ProfitAndLoss"),
    ]);

    const { balanceSheetMonthly, profitAndLossMonthly } =
      buildActivityReviewMonthlyStatements(bsReport, plReport);

    return res.json({
      success: true,
      reports: {
        balanceSheet: { monthly: balanceSheetMonthly },
        profitAndLoss: { monthly: profitAndLossMonthly },
      },
    });
  } catch (error) {
    console.error("QB Activity Review Error:", error.response?.data || error.message);
    return res.status(500).json({
      error: "Failed to fetch Activity Review data.",
      details: error.response?.data || error.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ALSO update your existing /qb-financial-reports-for-reconciliation route
// to return account-level balance sheet data (minor addition at the bottom
// of the existing route, inside the try block before the return):
// ─────────────────────────────────────────────────────────────────────────────
//
//   const bankAccountsResp = await axios.get(
//     `${qb.baseUrl}/v3/company/${qb.realmId}/query`,
//     { headers, proxy: false, params: { query: "SELECT * FROM Account WHERE AccountType = 'Bank' MAXRESULTS 100", minorversion: 75 } }
//   );
//
//   return res.json({
//     success: true,
//     profit_and_loss: profitLoss.data,
//     balance_sheet: balanceSheet.data,
//     bank_accounts: bankAccountsResp.data?.QueryResponse?.Account || [],
//   });
//
// ─────────────────────────────────────────────────────────────────────────────

router.get("/qb-one-bank-activity", async (req, res) => {
  try {
    const { accountId, start_date, end_date } = req.query;

    if (!accountId)
      return res.status(400).json({ error: "accountId is required" });

    if (!start_date || !end_date) {
      return res
        .status(400)
        .json({ error: "start_date and end_date are required" });
    }

    let clientId = req.clientId || req.query.clientId;
    if (!clientId && req.headers.referer) {
      const m = req.headers.referer.match(/\/client\/([^/]+)/);
      if (m) clientId = m[1];
    }
    if (!clientId) {
      return res.status(400).json({ error: "Missing Client ID." });
    }

    await loadQBConfig(clientId);
    const qb = getQBConfig(clientId);
    if (!qb.accessToken || !qb.realmId) {
      return res.status(401).json({
        error: "QuickBooks is not connected for this company.",
      });
    }

    const baseUrl = `${qb.baseUrl}/v3/company/${qb.realmId}/query`;
    let accessToken = qb.accessToken;

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    };

    const runQuery = async (query) => {
      const execute = async (token) =>
        axios.get(baseUrl, {
          headers: {
            ...headers,
            Authorization: `Bearer ${token}`,
          },
          proxy: false,
          params: { query, minorversion: 75 },
        });

      try {
        const r = await execute(accessToken);
        return r.data?.QueryResponse || {};
      } catch (error) {
        if (error.response?.status !== 401) throw error;

        accessToken = await tokenManager.refreshAccessToken(clientId);
        const retry = await execute(accessToken);
        return retry.data?.QueryResponse || {};
      }
    };

    // ---------------------------
    // 1️⃣ Fetch Account Info
    // ---------------------------

    const accountQR = await runQuery(
      `SELECT * FROM Account WHERE Id='${accountId}'`,
    );

    const account = accountQR.Account?.[0];

    if (!account)
      return res.status(404).json({ error: "Bank account not found" });

    // ---------------------------
    // 2️⃣ Fetch Deposits
    // ---------------------------

    const depositQR = await runQuery(
      `SELECT * FROM Deposit WHERE TxnDate >= '${start_date}' AND TxnDate <= '${end_date}' MAXRESULTS 1000`,
    );

    const deposits = (depositQR.Deposit || []).filter(
      (d) => d.DepositToAccountRef?.value === accountId,
    );

    // ---------------------------
    // 3️⃣ Fetch Purchases (withdrawals)
    // ---------------------------

    const purchaseQR = await runQuery(
      `SELECT * FROM Purchase WHERE TxnDate >= '${start_date}' AND TxnDate <= '${end_date}' MAXRESULTS 1000`,
    );

    const purchases = (purchaseQR.Purchase || []).filter(
      (p) => p.AccountRef?.value === accountId,
    );

    // ---------------------------
    // 4️⃣ Fetch Transfers
    // ---------------------------

    const transferQR = await runQuery(
      `SELECT * FROM Transfer WHERE TxnDate >= '${start_date}' AND TxnDate <= '${end_date}' MAXRESULTS 1000`,
    );

    const transfers = (transferQR.Transfer || []).filter(
      (t) =>
        t.FromAccountRef?.value === accountId ||
        t.ToAccountRef?.value === accountId,
    );

    // ---------------------------
    // 5️⃣ Build Month Range
    // ---------------------------

    const months = [];
    const start = new Date(start_date);
    const end = new Date(end_date);

    let current = new Date(start);

    while (current <= end) {
      const month = `${current.getFullYear()}-${String(
        current.getMonth() + 1,
      ).padStart(2, "0")}`;
      months.push(month);
      current.setMonth(current.getMonth() + 1);
    }

    // ---------------------------
    // 6️⃣ Activity Map
    // ---------------------------

    const activity = {};

    const getMonth = (date) => {
      const d = new Date(date);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    };

    months.forEach((m) => {
      activity[m] = {
        deposits: 0,
        withdrawals: 0,
      };
    });

    // deposits
    deposits.forEach((d) => {
      const m = getMonth(d.TxnDate);
      if (activity[m]) activity[m].deposits += parseFloat(d.TotalAmt || 0);
    });

    // purchases
    purchases.forEach((p) => {
      const m = getMonth(p.TxnDate);
      if (activity[m])
        activity[m].withdrawals += Math.abs(parseFloat(p.TotalAmt || 0));
    });

    // transfers
    transfers.forEach((t) => {
      const m = getMonth(t.TxnDate);
      const amt = parseFloat(t.Amount || 0);

      if (t.FromAccountRef?.value === accountId) {
        activity[m].withdrawals += amt;
      }

      if (t.ToAccountRef?.value === accountId) {
        activity[m].deposits += amt;
      }
    });

    // ---------------------------
    // 7️⃣ Build monthly table
    // ---------------------------

    let runningBalance = parseFloat(account.CurrentBalance || 0);

    const monthlyData = months.map((month) => {
      const act = activity[month];

      const startingBalance = runningBalance;
      const endingBalance = startingBalance + act.deposits - act.withdrawals;

      runningBalance = endingBalance;

      return {
        month,
        startingBalance,
        deposits: act.deposits,
        withdrawals: act.withdrawals,
        endingBalance,
      };
    });

    // ---------------------------
    // Final Response
    // ---------------------------

    res.json({
      success: true,
      account: {
        accountId: account.Id,
        bankName: account.Name,
        accountNumber: account.AcctNum || "",
      },
      monthlyData,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);

    res.status(500).json({
      error: "Failed to fetch bank activity",
      details: err.response?.data || err.message,
    });
  }
});
module.exports = router;

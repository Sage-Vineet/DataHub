const express = require("express");
const axios = require("axios");
const { getQBConfig, loadQBConfig } = require("../../../qbconfig");
const tokenManager = require("../../../tokenManager");
const { supabase } = require("../../../db");
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

    return { success: true, accounts: result, months };
  };

  try {
    try {
      const data = await performFetch();
      return res.json(data);
    } catch (err) {
      if (err.response?.status !== 401) throw err;
      console.log("⚠️ /qb-bank-activity token expired, refreshing...");
      qb.accessToken = await tokenManager.refreshAccessToken(clientId);
      const retryData = await performFetch();
      return res.json(retryData);
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

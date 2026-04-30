const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const { errorHandler } = require("./middleware/error");

const authRoutes = require("./routes/auth");
const { requireAuth } = require("./middleware/auth");
const userRoutes = require("./routes/users");
const companyRoutes = require("./routes/companies");
const groupRoutes = require("./routes/groups");
const requestRoutes = require("./routes/requests");
const folderRoutes = require("./routes/folders");
const folderAccessRoutes = require("./routes/folderAccess");
const reminderRoutes = require("./routes/reminders");
const activityRoutes = require("./routes/activity");
const uploadRoutes = require("./routes/uploads");
const workspacePageStateRoutes = require("./routes/workspacePageState");
const balanceSheetRoutes = require("./routes/quickbooks/balancesheet/balanceSheet");
const balanceSheetDetailRoutes = require("./routes/quickbooks/balancesheet/balanceSheetFullDetail");
const tokenRoutes = require("./routes/quickbooks/token");
const generalLedgerRoutes = require("./routes/quickbooks/account_detail/generalLedger");
const profitAndLossRoutes = require("./routes/quickbooks/profit_and_loss/profitAndLoss");
const profitAndLossStatementRoutes = require("./routes/quickbooks/profit_and_loss/profitAndLossStatement");
const customerFinanceRoutes = require("./routes/quickbooks/customers/customers");
const invoiceFinanceRoutes = require("./routes/quickbooks/invoices/invoices");
const cashflowRoutes = require("./routes/quickbooks/cash_flow/cash_flow");
const reconciliationRoutes = require("./routes/quickbooks/reconciliation/Reconciliation");
const taxReconciliationRoutes = require("./routes/quickbooks/tax_reconciliation/Tax_Reconciliation");
const geminipdf = require("./routes/quickbooks/tax_reconciliation/geminiPdf");
const bankStatementRoutes = require("./routes/quickbooks/reconciliation/bankStatement");
const bankVsBooksRoutes = require("./routes/quickbooks/reconciliation/bankVsBooks");
const { getQBConfig, loadQBConfig } = require("./qbconfig");
const { logQuickBooksDebug } = require("./quickbooksLogger");

const app = express();

const allowedOrigins = Array.from(
  new Set(
    [
      process.env.FRONTEND_URL,
      process.env.APP_URL,
      process.env.CORS_ORIGIN,
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5175",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:5174",
      "http://127.0.0.1:5175",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ]
      .filter(Boolean)
      .map((origin) => origin.replace(/\/$/, "")),
  ),
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      const normalizedOrigin = origin.replace(/\/$/, "");
      if (allowedOrigins.includes(normalizedOrigin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "10mb" }));
app.use(morgan("dev"));

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRoutes);
app.use("/users", userRoutes);
app.use("/companies", companyRoutes);
app.use("/", tokenRoutes);
app.use("/", uploadRoutes);
app.use("/", workspacePageStateRoutes);

async function checkQBAuth(req, res, next) {
  // 1. Try explicit header
  let clientId = req.headers["x-client-id"];

  // 2. Fallback: Try query parameter
  if (!clientId && req.query.clientId) {
    clientId = req.query.clientId;
  }

  // 3. Fallback: Try authenticated user's company
  if (!clientId && req.user) {
    clientId = req.user.company_id || (req.user.company_ids && req.user.company_ids[0]);
  }

  // 4. Fallback: Try to extract from Referer
  if (!clientId && req.headers.referer) {
    const referer = req.headers.referer;
    const match = referer.match(/\/client\/([^/]+)/);
    if (match) {
      clientId = match[1];
      console.log(`🔍 Recovered Client ID from Referer: ${clientId}`);
    }
  }

  // Final Validation: Ensure it's a valid UUID
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (clientId && !uuidRegex.test(clientId)) {
    console.warn(`[checkQBAuth] Rejected invalid UUID: ${clientId}`);
    clientId = null;
  }

  // 5. QuickBooks requests must always be scoped to a selected DataHub company.
  if (!clientId) {
    return res.status(400).json({
      success: false,
      message:
        "Missing Client ID. QuickBooks requests must include the selected DataHub company.",
      isConnected: false,
    });
  }

  req.clientId = clientId;
  await loadQBConfig(clientId);

  const qb = getQBConfig(clientId);
  req.qb = qb;

  logQuickBooksDebug("route_qb_auth_check", {
    path: req.path,
    clientId,
    realmId: qb.realmId || null,
    hasAccessToken: Boolean(qb.accessToken),
    hasRefreshToken: Boolean(qb.refreshToken),
  });

  if (!qb || !qb.accessToken || !qb.realmId) {
    return res.status(401).json({
      success: false,
      message: `QuickBooks not connected for company ${clientId}`,
      isConnected: false,
    });
  }

  next();
}

function isQuickBooksRoute(pathname = "") {
  return (
    pathname.startsWith("/balance-sheet") ||
    pathname.startsWith("/balance-sheet-detail") ||
    pathname.startsWith("/all-reports") ||
    pathname.startsWith("/general-ledger") ||
    pathname.startsWith("/profit-and-loss") ||
    pathname.startsWith("/profit-and-loss-detail") ||
    pathname.startsWith("/profit-and-loss-statement") ||
    pathname.startsWith("/customers") ||
    pathname.startsWith("/invoices") ||
    pathname.startsWith("/api/invoices") ||
    pathname.startsWith("/api/extract-bank-pdf-records") ||
    pathname.startsWith("/qb-transactions") ||
    pathname.startsWith("/qb-cashflow") ||
    pathname.startsWith("/qb-accounts") ||
    pathname.startsWith("/qb-cashflow-engine") ||
    pathname.startsWith("/qb-general-ledger") ||
    pathname.startsWith("/qb-reconciliation-transactions") ||
    pathname.startsWith("/qb-trial-balance") ||
    pathname.startsWith("/qb-reconciliation-engine") ||
    pathname.startsWith("/bank-transactions") ||
    pathname.startsWith("/bank-vs-books") ||
    pathname.startsWith("/reconciliation-data") ||
    pathname.startsWith("/reconciliation-variance") ||
    pathname.startsWith("/tax-reconciliation") ||
    pathname.startsWith("/reconciliation-matrix") ||
    pathname.startsWith("/pl-data") ||
    pathname.startsWith("/quickbooks-pl") ||
    pathname.startsWith("/tax-data")
  );
}

function quickBooksAuth(req, res, next) {
  if (!isQuickBooksRoute(req.path)) {
    return next();
  }
  // All QuickBooks routes require a valid user session
  return requireAuth(req, res, () => checkQBAuth(req, res, next));
}

app.use("/", quickBooksAuth, balanceSheetRoutes);
app.use("/", quickBooksAuth, balanceSheetDetailRoutes);
app.use("/", quickBooksAuth, generalLedgerRoutes);
app.use("/", quickBooksAuth, profitAndLossRoutes);
app.use("/", quickBooksAuth, profitAndLossStatementRoutes);
app.use("/", quickBooksAuth, customerFinanceRoutes);
app.use("/", quickBooksAuth, invoiceFinanceRoutes);
app.use("/", quickBooksAuth, cashflowRoutes);
app.use("/", quickBooksAuth, reconciliationRoutes);
app.use("/", quickBooksAuth, taxReconciliationRoutes);
app.use("/", quickBooksAuth, geminipdf);
app.use("/", quickBooksAuth, bankStatementRoutes);
app.use("/api", quickBooksAuth, bankVsBooksRoutes);
app.use("/", groupRoutes);
app.use("/", requestRoutes);
app.use("/", folderRoutes);
app.use("/", folderAccessRoutes);
app.use("/", reminderRoutes);
app.use("/", activityRoutes);
app.use(errorHandler);

module.exports = app;

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const { errorHandler } = require("./middleware/error");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const companyRoutes = require("./routes/companies");
const groupRoutes = require("./routes/groups");
const requestRoutes = require("./routes/requests");
const folderRoutes = require("./routes/folders");
const folderAccessRoutes = require("./routes/folderAccess");
const reminderRoutes = require("./routes/reminders");
const activityRoutes = require("./routes/activity");
const uploadRoutes = require("./routes/uploads");
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
const bankStatementRoutes = require("./routes/quickbooks/reconciliation/bankStatement");
const bankVsBooksRoutes = require("./routes/quickbooks/reconciliation/bankVsBooks");
const { getQBConfig, validateConfig } = require("./qbconfig");

const app = express();

const allowedOrigins = Array.from(
  new Set(
    [
      process.env.FRONTEND_URL,
      process.env.APP_URL,
      process.env.CORS_ORIGIN,
      "http://localhost:5173",
      "http://127.0.0.1:5173",
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

function checkQBAuth(req, res, next) {
  // 1. Try explicit header
  let clientId = req.headers["x-client-id"];

  // 2. Fallback: Try query parameter
  if (!clientId && req.query.clientId) {
    clientId = req.query.clientId;
  }

  // 3. Fallback: Try to extract from Referer (useful when header injection fails)
  if (!clientId && req.headers.referer) {
    const referer = req.headers.referer;
    const match = referer.match(/\/client\/([^/]+)/);
    if (match) {
      clientId = match[1];
      console.log(`🔍 Recovered Client ID from Referer: ${clientId}`);
    }
  }

  // 4. Final Fallback: if still no clientId, log it but don't fail immediately.
  // getQBConfig will try to return a default if it can.
  if (!clientId) {
    console.warn(
      "⚠️ Client ID missing in request. Attempting to use default connection.",
    );
  }

  req.clientId = clientId;

  const qb = getQBConfig(clientId);
  if (!qb || !qb.accessToken || !qb.realmId) {
    return res.status(401).json({
      success: false,
      message: `QuickBooks not connected for company ${clientId}`,
      isConnected: false,
    });
  }

  next();
}

app.use("/", checkQBAuth, balanceSheetRoutes);
app.use("/", checkQBAuth, balanceSheetDetailRoutes);
app.use("/", checkQBAuth, generalLedgerRoutes);
app.use("/", checkQBAuth, profitAndLossRoutes);
app.use("/", checkQBAuth, profitAndLossStatementRoutes);
app.use("/", checkQBAuth, customerFinanceRoutes);
app.use("/", checkQBAuth, invoiceFinanceRoutes);
app.use("/", checkQBAuth, cashflowRoutes);
app.use("/", checkQBAuth, reconciliationRoutes);
app.use("/", checkQBAuth, bankStatementRoutes);
app.use("/", checkQBAuth, bankVsBooksRoutes);
app.use("/", groupRoutes);
app.use("/", requestRoutes);
app.use("/", folderRoutes);
app.use("/", folderAccessRoutes);
app.use("/", reminderRoutes);
app.use("/", activityRoutes);

app.use(errorHandler);

module.exports = app;

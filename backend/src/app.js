const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const { errorHandler } = require("./middleware/error");

// Routes
const authRoutes = require("./routes/auth");
const publicRoutes = require("./routes/public");
const { requireAuth } = require("./middleware/auth");
const { quickBooksAuth } = require("./middleware/quickbooksAuth");
const userRoutes = require("./routes/users");
const companyRoutes = require("./routes/companies");
const groupRoutes = require("./routes/groups");
const requestRoutes = require("./routes/requests");
const folderRoutes = require("./routes/folders");
const folderAccessRoutes = require("./routes/folderAccess");
const reminderRoutes = require("./routes/reminders");
const activityRoutes = require("./routes/activity");
const uploadRoutes = require("./routes/uploads");
const messageRoutes = require("./routes/messages");
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
const syncRoutes = require("./routes/quickbooks/sync");

const app = express();

function normalizeOrigin(origin) {
  try {
    return new URL(origin).origin;
  } catch (_error) {
    return String(origin || "").replace(/\/$/, "");
  }
}

function parseOriginList(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map(normalizeOrigin);
}

function isAllowedVercelPreview(origin) {
  try {
    const { hostname, protocol } = new URL(origin);
    return (
      protocol === "https:" &&
      (
        hostname.endsWith(".vercel.app") ||
        hostname === "centuriuum.com" ||
        hostname === "www.centuriuum.com"
      )
    );
  } catch (_error) {
    return false;
  }
}

const allowedOrigins = Array.from(
  new Set([
    process.env.FRONTEND_URL,
    process.env.APP_URL,
    process.env.CORS_ORIGIN,
    ...parseOriginList(process.env.CORS_ORIGIN),
    "https://data-hub-fawn.vercel.app",
    "https://datahub-sl3y.onrender.com",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "http://127.0.0.1:5175",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ])
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      const normalizedOrigin = normalizeOrigin(origin);
      if (
        allowedOrigins.includes(normalizedOrigin) ||
        isAllowedVercelPreview(normalizedOrigin)
      ) {
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

// Standard Routes
app.use("/auth", authRoutes);
app.use("/public", publicRoutes);
app.use("/users", userRoutes);
app.use("/companies", companyRoutes);
app.use("/", tokenRoutes);
app.use("/", uploadRoutes);
app.use("/", workspacePageStateRoutes);

// QuickBooks & Financial Routes (with consolidated auth)
const financialRoutes = [
  balanceSheetRoutes,
  balanceSheetDetailRoutes,
  generalLedgerRoutes,
  profitAndLossRoutes,
  profitAndLossStatementRoutes,
  customerFinanceRoutes,
  invoiceFinanceRoutes,
  cashflowRoutes,
  reconciliationRoutes,
  taxReconciliationRoutes,
  geminipdf,
  bankStatementRoutes,
  bankVsBooksRoutes,
  syncRoutes,
];

financialRoutes.forEach(route => {
  app.use("/", quickBooksAuth, route);
});

// Non-QuickBooks Routes
app.use("/", groupRoutes);
app.use("/", requestRoutes);
app.use("/", folderRoutes);
app.use("/", folderAccessRoutes);
app.use("/", reminderRoutes);
app.use("/", activityRoutes);
app.use("/", messageRoutes);

app.use(errorHandler);

module.exports = app;

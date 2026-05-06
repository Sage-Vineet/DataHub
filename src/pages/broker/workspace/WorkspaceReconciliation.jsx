import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import Header from "../../../components/Header";
import ExportDestinationModal from "../../../components/common/ExportDestinationModal";
import { useAuth } from "../../../context/AuthContext";
import { useToast } from "../../../context/ToastContext";
import { getStoredToken } from "../../../lib/api";
import { cn } from "../../../lib/utils";
import { createWorkbookBlob, downloadBlob } from "../../../lib/export-utils";
import {
  buildReportFileName,
  REPORT_FOLDER_PATHS,
  uploadReportToDataRoom,
} from "../../../lib/dataroom-report-exports";
import { buildStyledReconciliationExcel } from "../../../lib/bank-reconciliation-excel";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  RefreshCw,
  LoaderCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import QBDisconnectedBanner from "../../../components/common/QBDisconnectedBanner";

const MONTHS = [
  { value: "01", label: "January" },
  { value: "02", label: "February" },
  { value: "03", label: "March" },
  { value: "04", label: "April" },
  { value: "05", label: "May" },
  { value: "06", label: "June" },
  { value: "07", label: "July" },
  { value: "08", label: "August" },
  { value: "09", label: "September" },
  { value: "10", label: "October" },
  { value: "11", label: "November" },
  { value: "12", label: "December" },
];
const YEARS = Array.from({ length: 10 }, (_, i) => 2020 + i);

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";
const QB_BANK_ACTIVITY_ENDPOINT = `${API_BASE_URL}/qb-bank-activity`;
const QB_ONE_BANK_ACTIVITY_ENDPOINT = `${API_BASE_URL}/qb-one-bank-activity`;
const RECONCILIATION_STORAGE_PREFIX = "workspace-reconciliation";

const getErrMsg = (e) => (e instanceof Error ? e.message : String(e));
const getWorkspaceStorageKey = (clientId) =>
  `${RECONCILIATION_STORAGE_PREFIX}:${clientId || "default"}`;
const getDefaultExpandedAccounts = () => ({});
const getLastFourDigits = (accountNumber) =>
  String(accountNumber ?? "").slice(-4);
const TABLE_LABEL_COL_WIDTH = "w-[280px]";
const TABLE_VALUE_COL_WIDTH = "w-[150px]";
const getStoredWorkspaceState = (clientId) => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(getWorkspaceStorageKey(clientId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};
const fmtAmt = (val) => {
  if (val == null || val === 0) return "-";
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val);
};
const fmtAcct = (val) => {
  if (val == null || val === 0) return "-";
  const abs = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(val));
  return val < 0 ? `(${abs})` : abs;
};
const fmtVarianceAmt = (val) => {
  if (val == null || val === 0)
    return { display: "-", colorClass: "text-text-muted" };
  const abs = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(val));
  if (val < 0)
    return { display: `-${abs}`, colorClass: "text-red-600 font-medium" };
  return { display: `+${abs}`, colorClass: "text-green-600 font-medium" };
};
const fmtVariancePct = (val) => {
  if (val == null) return { display: "-", colorClass: "text-text-muted" };
  const fixed = parseFloat(val).toFixed(1);
  if (parseFloat(fixed) === 0)
    return { display: "0.0%", colorClass: "text-text-muted" };
  if (val < 0)
    return { display: `${fixed}%`, colorClass: "text-red-600 font-medium" };
  return { display: `+${fixed}%`, colorClass: "text-green-600 font-medium" };
};
const monthLabel = (ym) => {
  const [y, m] = ym.split("-");
  return new Date(+y, +m - 1, 1).toLocaleDateString("en-US", {
    year: "2-digit",
    month: "short",
  });
};

// ── Helper: generate all YYYY-MM strings between two YYYY-MM values ──────────
const generateMonthRange = (startYM, endYM) => {
  const [sy, sm] = startYM.split("-").map(Number);
  const [ey, em] = endYM.split("-").map(Number);
  const months = [];
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return months;
};

// ── Static PDF Bank Data ──────────────────────────────────────────────────────
// All 12 months of data keyed by YYYY-MM so we can slice by filter
const PDF_BANKS_RAW = [
  {
    name: "Checking ()",
    data: {
      "2026-01": {
        startingBalance: null,
        deposits: null,
        withdrawals: null,
        endingBalance: null,
      },
      "2026-02": {
        startingBalance: null,
        deposits: null,
        withdrawals: null,
        endingBalance: null,
      },
      "2026-03": {
        startingBalance: null,
        deposits: null,
        withdrawals: null,
        endingBalance: null,
      },
      "2026-04": {
        startingBalance: null,
        deposits: null,
        withdrawals: null,
        endingBalance: null,
      },
      "2026-05": {
        startingBalance: null,
        deposits: null,
        withdrawals: null,
        endingBalance: null,
      },
      "2026-06": {
        startingBalance: null,
        deposits: null,
        withdrawals: null,
        endingBalance: null,
      },
      "2026-07": {
        startingBalance: null,
        deposits: null,
        withdrawals: null,
        endingBalance: null,
      },
      "2026-08": {
        startingBalance: null,
        deposits: null,
        withdrawals: null,
        endingBalance: null,
      },
      "2026-09": {
        startingBalance: null,
        deposits: null,
        withdrawals: null,
        endingBalance: null,
      },
      "2026-10": {
        startingBalance: null,
        deposits: null,
        withdrawals: null,
        endingBalance: null,
      },
      "2026-11": {
        startingBalance: null,
        deposits: 189336.96,
        withdrawals: 189336.96,
        endingBalance: null,
      },
      "2026-12": {
        startingBalance: null,
        deposits: 305491,
        withdrawals: 305491,
        endingBalance: null,
      },
    },
  },
  {
    name: "Savings ()",
    data: {
      "2026-01": {
        startingBalance: null,
        deposits: 350923.65,
        withdrawals: 335030.65,
        endingBalance: 15893,
      },
      "2026-02": {
        startingBalance: 15893,
        deposits: 386711.11,
        withdrawals: 402604.11,
        endingBalance: null,
      },
      "2026-03": {
        startingBalance: null,
        deposits: 380483.84,
        withdrawals: 380483.84,
        endingBalance: null,
      },
      "2026-04": {
        startingBalance: null,
        deposits: 462270.21,
        withdrawals: 462270.21,
        endingBalance: null,
      },
      "2026-05": {
        startingBalance: null,
        deposits: 248471.02,
        withdrawals: 248471.02,
        endingBalance: null,
      },
      "2026-06": {
        startingBalance: null,
        deposits: 279933.76,
        withdrawals: 279933.76,
        endingBalance: null,
      },
      "2026-07": {
        startingBalance: null,
        deposits: 258564.7,
        withdrawals: 256990.46,
        endingBalance: 1574.24,
      },
      "2026-08": {
        startingBalance: 1574.24,
        deposits: 415664.01,
        withdrawals: 417238.25,
        endingBalance: null,
      },
      "2026-09": {
        startingBalance: null,
        deposits: 249540.92,
        withdrawals: 249540.92,
        endingBalance: null,
      },
      "2026-10": {
        startingBalance: null,
        deposits: 264895.99,
        withdrawals: 264895.99,
        endingBalance: null,
      },
      "2026-11": {
        startingBalance: null,
        deposits: 102674.52,
        withdrawals: 102674.52,
        endingBalance: null,
      },
      "2026-12": {
        startingBalance: null,
        deposits: null,
        withdrawals: null,
        endingBalance: null,
      },
    },
  },
];

const PDF_METRIC_KEYS = [
  { key: "startingBalance", label: "Starting Balance", bold: true },
  { key: "deposits", label: "Deposits", bold: false },
  { key: "withdrawals", label: "Withdrawals", bold: false },
  { key: "endingBalance", label: "Ending Balance", bold: true },
];

const fmtPdf = (val) => {
  if (val == null || val === 0) return "-";
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val);
};

const BALANCE_EXPORT_METRICS = [
  { key: "startingBalance", label: "Starting Balance" },
  { key: "deposits", label: "Deposits" },
  { key: "withdrawals", label: "Withdrawals" },
  { key: "endingBalance", label: "Ending Balance" },
  { key: "intercompanyDeposits", label: "Intercompany Deposits" },
  { key: "intercompanyWithdraws", label: "Intercompany Withdraws" },
  { key: "footingCheck", label: "Footing Check" },
  { key: "priorMonthCheck", label: "Prior Month Check" },
  { key: "perBalanceSheet", label: "Per Balance Sheet" },
  { key: "variance", label: "Variance" },
  { key: "outstandingChecks", label: "Outstanding Checks" },
  { key: "unreconciledDollar", label: "Unreconciled $ Variance" },
  { key: "unreconciledPct", label: "Unreconciled % Variance" },
];
const ACTIVITY_EXPORT_METRICS = [
  { section: "Deposits", key: "totalDeposits", label: "Total Deposits" },
  {
    section: "Deposits",
    key: "intercompanyTransfers",
    label: "Intercompany Transfers",
  },
  { section: "Deposits", key: "externalDeposits", label: "External Deposits" },
  {
    section: "Deposits",
    key: "salesPerFinancials",
    label: "Sales per Financials",
  },
  { section: "Deposits", key: "depositsDollarVar", label: "$ Variance" },
  { section: "Deposits", key: "depositsPctVar", label: "% Variance" },
  { section: "Deposits", key: "changeInAR", label: "Change in AR" },
  {
    section: "Deposits",
    key: "changeInARRetentions",
    label: "Change in Accts Receivable- Retentions",
  },
  {
    section: "Deposits",
    key: "fixedAssetDisposals",
    label: "Fixed Asset Disposals",
  },
  { section: "Deposits", key: "depositsOther", label: "Other" },
  {
    section: "Deposits",
    key: "depositsUnreconciledDollar",
    label: "Unreconciled Variance $",
  },
  {
    section: "Deposits",
    key: "depositsUnreconciledPct",
    label: "Unreconciled Variance %",
  },
  {
    section: "Withdrawals",
    key: "totalWithdrawals",
    label: "Total Withdrawals",
  },
  {
    section: "Withdrawals",
    key: "withdrawIntercompanyTransfers",
    label: "Intercompany Transfers",
  },
  {
    section: "Withdrawals",
    key: "externalWithdraws",
    label: "External Withdraws",
  },
  {
    section: "Withdrawals",
    key: "expensesPerFinancials",
    label: "Expenses per Financials",
  },
  { section: "Withdrawals", key: "withdrawsDollarVar", label: "$ Variance" },
  { section: "Withdrawals", key: "withdrawsPctVar", label: "% Variance" },
  { section: "Withdrawals", key: "ownerWithdraws", label: "Owner Withdraws" },
  {
    section: "Withdrawals",
    key: "changeInCurrentLiabilities",
    label: "Change in Current Liabilities",
  },
  {
    section: "Withdrawals",
    key: "changeInLTLiabilities",
    label: "Change in LT Liabilities",
  },
  {
    section: "Withdrawals",
    key: "depreciationExpense",
    label: "Depreciation Expense",
  },
  {
    section: "Withdrawals",
    key: "amortizationExpense",
    label: "Amortization Expense",
  },
  { section: "Withdrawals", key: "badDebtExpense", label: "Bad Debt Expense" },
  {
    section: "Withdrawals",
    key: "fixedAssetPurchases",
    label: "Fixed Asset Purchases",
  },
  { section: "Withdrawals", key: "withdrawsOther", label: "Other" },
  {
    section: "Withdrawals",
    key: "withdrawsUnreconciledDollar",
    label: "Unreconciled Variance $",
  },
  {
    section: "Withdrawals",
    key: "withdrawsUnreconciledPct",
    label: "Unreconciled Variance %",
  },
];

function buildEmptyTTM() {
  return {
    startingBalance: 0,
    deposits: 0,
    withdrawals: 0,
    endingBalance: 0,
    intercompanyDeposits: 0,
    intercompanyWithdraws: 0,
    footingCheck: 0,
    priorMonthCheck: 0,
    perBalanceSheet: 0,
    variance: 0,
    outstandingChecks: 0,
    unreconciledDollar: 0,
    unreconciledPct: 0,
  };
}

function buildEmptyActivityReviewRow() {
  return {
    totalDeposits: 0,
    intercompanyTransfers: 0,
    externalDeposits: 0,
    salesPerFinancials: 0,
    depositsDollarVar: 0,
    depositsPctVar: 0,
    changeInAR: 0,
    changeInARRetentions: 0,
    fixedAssetDisposals: 0,
    depositsOther: 0,
    depositsUnreconciledDollar: 0,
    depositsUnreconciledPct: 0,
    totalWithdrawals: 0,
    withdrawIntercompanyTransfers: 0,
    externalWithdraws: 0,
    expensesPerFinancials: 0,
    withdrawsDollarVar: 0,
    withdrawsPctVar: 0,
    ownerWithdraws: 0,
    changeInCurrentLiabilities: 0,
    changeInLTLiabilities: 0,
    depreciationExpense: 0,
    amortizationExpense: 0,
    badDebtExpense: 0,
    fixedAssetPurchases: 0,
    withdrawsOther: 0,
    withdrawsUnreconciledDollar: 0,
    withdrawsUnreconciledPct: 0,
  };
}

export default function WorkspaceReconciliation() {
  const { clientId } = useParams();
  const { user } = useAuth();
  const { showToast } = useToast();
  const storedState = getStoredWorkspaceState(clientId);
  const [expandedAccounts, setExpandedAccounts] = useState(
    storedState?.expandedAccounts || getDefaultExpandedAccounts(),
  );
  const [bankActivityStartMonth, setBankActivityStartMonth] = useState(
    storedState?.bankActivityStartMonth || "2026-01",
  );
  const [bankActivityEndMonth, setBankActivityEndMonth] = useState(
    storedState?.bankActivityEndMonth || "2026-04",
  );
  const [bankActivityAccountingMethod, setBankActivityAccountingMethod] =
    useState(storedState?.bankActivityAccountingMethod || "Accrual");
  const [qbBankActivity, setQbBankActivity] = useState(
    storedState?.qbBankActivity || null,
  );
  const [isLoadingBankActivity, setIsLoadingBankActivity] = useState(false);
  const [bankActivityError, setBankActivityError] = useState("");
  const [bankActivityFetchStatus, setBankActivityFetchStatus] = useState({
    status: storedState?.qbBankActivity ? "success" : "idle",
    message: storedState?.qbBankActivity
      ? "Restored saved QuickBooks bank activity."
      : "",
  });
  const [selectedBalanceBankId, setSelectedBalanceBankId] = useState(
    storedState?.selectedBalanceBankId || "",
  );
  const [oneBankAccountId, setOneBankAccountId] = useState(
    storedState?.oneBankAccountId || "",
  );
  const [qbOneBankActivity, setQbOneBankActivity] = useState(
    storedState?.qbOneBankActivity || null,
  );
  const [isLoadingOneBankActivity, setIsLoadingOneBankActivity] =
    useState(false);
  const [oneBankActivityError, setOneBankActivityError] = useState("");
  const [oneBankActivityFetchStatus, setOneBankActivityFetchStatus] = useState({
    status: storedState?.qbOneBankActivity ? "success" : "idle",
    message: storedState?.qbOneBankActivity
      ? "Restored saved single-account QuickBooks activity."
      : "",
  });
  const [isExporting, setIsExporting] = useState(false);
  const [showExportDestinationModal, setShowExportDestinationModal] =
    useState(false);

  const getHeaders = useCallback(() => {
    const token = getStoredToken();
    return {
      ...(token
        ? {
            Authorization: `Bearer ${token}`,
            "X-Access-Token": token,
            "X-Auth-Token": token,
            "X-Token": token,
          }
        : {}),
      ...(clientId ? { "X-Client-Id": clientId } : {}),
    };
  }, [clientId]);

  useEffect(() => {
    const nextState = getStoredWorkspaceState(clientId);
    setExpandedAccounts(
      nextState?.expandedAccounts || getDefaultExpandedAccounts(),
    );
    setBankActivityStartMonth(nextState?.bankActivityStartMonth || "2026-01");
    setBankActivityEndMonth(nextState?.bankActivityEndMonth || "2026-04");
    setBankActivityAccountingMethod(
      nextState?.bankActivityAccountingMethod || "Accrual",
    );
    setQbBankActivity(nextState?.qbBankActivity || null);
    setBankActivityFetchStatus({
      status: nextState?.qbBankActivity ? "success" : "idle",
      message: nextState?.qbBankActivity
        ? "Restored saved QuickBooks bank activity."
        : "",
    });
    setBankActivityError("");
    setSelectedBalanceBankId(nextState?.selectedBalanceBankId || "");
    setOneBankAccountId(nextState?.oneBankAccountId || "");
    setQbOneBankActivity(nextState?.qbOneBankActivity || null);
    setOneBankActivityFetchStatus({
      status: nextState?.qbOneBankActivity ? "success" : "idle",
      message: nextState?.qbOneBankActivity
        ? "Restored saved single-account QuickBooks activity."
        : "",
    });
    setOneBankActivityError("");
  }, [clientId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const key = getWorkspaceStorageKey(clientId);
      const existing = getStoredWorkspaceState(clientId) || {};
      window.sessionStorage.setItem(
        key,
        JSON.stringify({
          ...existing,
          expandedAccounts,
          bankActivityStartMonth,
          bankActivityEndMonth,
          bankActivityAccountingMethod,
          qbBankActivity: qbBankActivity ?? existing.qbBankActivity ?? null,
          selectedBalanceBankId,
          oneBankAccountId,
          qbOneBankActivity:
            qbOneBankActivity ?? existing.qbOneBankActivity ?? null,
        }),
      );
    } catch {
      // Ignore storage issues
    }
  }, [
    clientId,
    expandedAccounts,
    bankActivityStartMonth,
    bankActivityEndMonth,
    bankActivityAccountingMethod,
    qbBankActivity,
    selectedBalanceBankId,
    oneBankAccountId,
    qbOneBankActivity,
  ]);

  const loadQBBankActivity = async () => {
    setIsLoadingBankActivity(true);
    setBankActivityError("");
    setBankActivityFetchStatus({
      status: "loading",
      message: "Fetching QuickBooks bank activity...",
    });
    try {
      const [sy, sm] = bankActivityStartMonth.split("-");
      const [ey, em] = bankActivityEndMonth.split("-");
      const start_date = `${sy}-${sm}-01`;
      const lastDay = new Date(+ey, +em, 0).getDate();
      const end_date = `${ey}-${em}-${String(lastDay).padStart(2, "0")}`;

      const params = new URLSearchParams({
        start_date,
        end_date,
        accounting_method: bankActivityAccountingMethod,
      });
      if (clientId) params.append("clientId", clientId);

      const resp = await fetch(`${QB_BANK_ACTIVITY_ENDPOINT}?${params}`, {
        cache: "no-store",
        headers: getHeaders(),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);

      setQbBankActivity(data);
      setBankActivityFetchStatus({
        status: "success",
        message: `Loaded ${data?.months?.length ?? 0} month(s) across ${data?.accounts?.length ?? 0} account(s).`,
      });
    } catch (e) {
      setBankActivityError(getErrMsg(e));
      setBankActivityFetchStatus({ status: "error", message: getErrMsg(e) });
      setQbBankActivity(null);
    } finally {
      setIsLoadingBankActivity(false);
    }
  };

  const loadQBOneBankActivity = async () => {
    if (!oneBankAccountId) {
      const msg = "Please select a QuickBooks bank account.";
      setOneBankActivityError(msg);
      setOneBankActivityFetchStatus({ status: "error", message: msg });
      return;
    }

    setIsLoadingOneBankActivity(true);
    setOneBankActivityError("");
    setOneBankActivityFetchStatus({
      status: "loading",
      message: "Fetching selected QuickBooks bank activity...",
    });

    try {
      const [sy, sm] = bankActivityStartMonth.split("-");
      const [ey, em] = bankActivityEndMonth.split("-");
      const start_date = `${sy}-${sm}-01`;
      const lastDay = new Date(+ey, +em, 0).getDate();
      const end_date = `${ey}-${em}-${String(lastDay).padStart(2, "0")}`;

      const params = new URLSearchParams({
        accountId: oneBankAccountId,
        start_date,
        end_date,
      });
      if (clientId) params.append("clientId", clientId);

      const resp = await fetch(`${QB_ONE_BANK_ACTIVITY_ENDPOINT}?${params}`, {
        cache: "no-store",
        headers: getHeaders(),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);

      setQbOneBankActivity(data);
      setOneBankActivityFetchStatus({
        status: "success",
        message: `Loaded ${data?.monthlyData?.length ?? 0} month(s) for ${data?.account?.bankName || "selected account"}.`,
      });
    } catch (e) {
      setOneBankActivityError(getErrMsg(e));
      setOneBankActivityFetchStatus({ status: "error", message: getErrMsg(e) });
      setQbOneBankActivity(null);
    } finally {
      setIsLoadingOneBankActivity(false);
    }
  };

  const reportMonths = qbBankActivity?.months?.length
    ? qbBankActivity.months
    : [];
  const hasData = reportMonths.length > 0;

  // ── Compute filtered PDF months aligned with the date filter ─────────────
  // This generates months from the filter range and intersects with available PDF data
  const filteredPdfMonths = useMemo(() => {
    return generateMonthRange(bankActivityStartMonth, bankActivityEndMonth);
  }, [bankActivityStartMonth, bankActivityEndMonth]);

  // ── Build filtered PDF banks (only months in filteredPdfMonths) ───────────
  const filteredPdfBanks = useMemo(() => {
    return PDF_BANKS_RAW.map((bank) => ({
      name: bank.name,
      rows: PDF_METRIC_KEYS.reduce((acc, metric) => {
        acc[metric.key] = filteredPdfMonths.map(
          (ym) => bank.data[ym]?.[metric.key] ?? null,
        );
        return acc;
      }, {}),
    }));
  }, [filteredPdfMonths]);

  const balanceBankOptions = useMemo(() => {
    if (!qbBankActivity?.accounts?.length) return [];
    return qbBankActivity.accounts.map((account) => ({
      value: account.accountId,
      label: `${account.accountName} (${getLastFourDigits(account.accountNumber)})`,
    }));
  }, [qbBankActivity]);
  const oneBankAccountOptions = useMemo(() => {
    if (!qbBankActivity?.accounts?.length) return [];
    return qbBankActivity.accounts
      .filter(
        (account, idx, all) =>
          all.findIndex((item) => item.accountId === account.accountId) === idx,
      )
      .map((account) => ({
        value: account.accountId,
        label: `${account.accountName}${account.accountNumber ? ` (${account.accountNumber})` : ""}`,
      }));
  }, [qbBankActivity]);

  useEffect(() => {
    const accounts = qbBankActivity?.accounts || [];
    if (!accounts.length) return;
    setExpandedAccounts((prev) => {
      const next = Object.fromEntries(
        accounts.map((account, index) => [
          account.accountId,
          prev?.[account.accountId] ?? index === 0,
        ]),
      );
      const hasSameKeys =
        Object.keys(next).length === Object.keys(prev || {}).length &&
        Object.keys(next).every((key) => key in (prev || {}));
      const hasSameValues = Object.keys(next).every(
        (key) => next[key] === prev?.[key],
      );
      return hasSameKeys && hasSameValues ? prev : next;
    });
  }, [qbBankActivity]);

  useEffect(() => {
    if (
      balanceBankOptions.length > 0 &&
      !balanceBankOptions.some(
        (option) => option.value === selectedBalanceBankId,
      )
    ) {
      setSelectedBalanceBankId(balanceBankOptions[0].value);
    }
  }, [balanceBankOptions, selectedBalanceBankId]);

  useEffect(() => {
    if (!selectedBalanceBankId) return;
    setExpandedAccounts((prev) => ({ ...prev, [selectedBalanceBankId]: true }));
  }, [selectedBalanceBankId]);

  useEffect(() => {
    if (!oneBankAccountId && oneBankAccountOptions.length > 0) {
      setOneBankAccountId(oneBankAccountOptions[0].value);
    }
  }, [oneBankAccountId, oneBankAccountOptions]);

  const buildAccountBalanceDataFromQB = (account) => {
    if (!account) return { rows: [], ttm: buildEmptyTTM() };

    const monthlyMap = Object.fromEntries(
      (account.monthlyData || []).map((row) => [row.month, row]),
    );

    const rows = reportMonths.map((month) => {
      const row = monthlyMap[month];
      return {
        month,
        startingBalance: row?.startingBalance ?? 0,
        deposits: row?.deposits ?? 0,
        withdrawals: row?.withdrawals ?? 0,
        endingBalance: row?.endingBalance ?? 0,
        intercompanyDeposits: row?.intercompanyDeposits ?? 0,
        intercompanyWithdraws: row?.intercompanyWithdraws ?? 0,
        perBalanceSheet: row?.perBalanceSheet ?? 0,
        variance: row?.variance ?? 0,
        outstandingChecks: 0,
        priorMonthCheck: row?.priorMonthCheck ?? 0,
        footingCheck: row?.footingCheck ?? 0,
        unreconciledDollar: 0,
        unreconciledPct: 0,
        _perBSCount: row?.perBalanceSheet != null ? 1 : 0,
      };
    });

    const withDerived = rows.map((r, i) => {
      const footingCheck =
        r.endingBalance - (r.startingBalance + r.deposits - r.withdrawals);
      const priorMonthCheck =
        i === 0 ? 0 : rows[i - 1].endingBalance - r.startingBalance;
      const variance =
        r._perBSCount > 0 ? r.endingBalance - r.perBalanceSheet : 0;
      const outstandingChecks = 0;
      const unreconciledDollar = variance - outstandingChecks;
      const unreconciledPct =
        r.perBalanceSheet !== 0
          ? (unreconciledDollar / r.perBalanceSheet) * 100
          : 0;
      return {
        ...r,
        footingCheck,
        priorMonthCheck,
        variance,
        outstandingChecks,
        unreconciledDollar,
        unreconciledPct,
      };
    });

    const ttmRows = withDerived.slice(-12);
    const ttm = ttmRows.reduce(
      (acc, r, i) => ({
        startingBalance: i === 0 ? r.startingBalance : acc.startingBalance,
        deposits: acc.deposits + r.deposits,
        withdrawals: acc.withdrawals + r.withdrawals,
        endingBalance: r.endingBalance,
        intercompanyDeposits: acc.intercompanyDeposits + r.intercompanyDeposits,
        intercompanyWithdraws:
          acc.intercompanyWithdraws + r.intercompanyWithdraws,
        footingCheck: acc.footingCheck + r.footingCheck,
        priorMonthCheck: acc.priorMonthCheck + r.priorMonthCheck,
        perBalanceSheet: r.perBalanceSheet,
        variance: r.endingBalance - r.perBalanceSheet,
        outstandingChecks: acc.outstandingChecks + r.outstandingChecks,
        unreconciledDollar: acc.unreconciledDollar + r.unreconciledDollar,
        unreconciledPct: r.unreconciledPct,
      }),
      buildEmptyTTM(),
    );

    return { rows: withDerived, ttm };
  };

  const visibleBalanceAccounts = selectedBalanceBankId
    ? qbBankActivity?.accounts?.filter(
        (account) => account.accountId === selectedBalanceBankId,
      ) || []
    : qbBankActivity?.accounts || [];
  const allBankMonthlyMaps =
    qbBankActivity?.accounts?.map((account) =>
      Object.fromEntries(
        (account.monthlyData || []).map((row) => [row.month, row]),
      ),
    ) || [];

  const activityRows = reportMonths.map((month) => {
    const totalDeposits = allBankMonthlyMaps.reduce(
      (sum, m) => sum + (m[month]?.deposits || 0),
      0,
    );
    const totalWithdrawals = allBankMonthlyMaps.reduce(
      (sum, m) => sum + (m[month]?.withdrawals || 0),
      0,
    );
    const intercompanyDeposits = allBankMonthlyMaps.reduce(
      (sum, m) => sum + (m[month]?.intercompanyDeposits || 0),
      0,
    );
    const intercompanyWithdraws = allBankMonthlyMaps.reduce(
      (sum, m) => sum + (m[month]?.intercompanyWithdraws || 0),
      0,
    );
    const intercompanyTransfers = intercompanyDeposits + intercompanyWithdraws;
    const externalDeposits = totalDeposits - intercompanyTransfers;
    const salesPerFinancials = 0;
    const depositsDollarVar = salesPerFinancials - externalDeposits;
    const depositsPctVar =
      salesPerFinancials !== 0
        ? (depositsDollarVar / salesPerFinancials) * 100
        : 0;
    const changeInAR = 0;
    const changeInARRetentions = 0;
    const fixedAssetDisposals = 0;
    const depositsOther = 0;
    const depositsUnreconciledDollar =
      depositsDollarVar +
      changeInAR +
      changeInARRetentions +
      fixedAssetDisposals +
      depositsOther;
    const depositsUnreconciledPct =
      salesPerFinancials !== 0
        ? (depositsUnreconciledDollar / salesPerFinancials) * 100
        : 0;
    const withdrawIntercompanyTransfers = intercompanyWithdraws;
    const externalWithdraws = totalWithdrawals - withdrawIntercompanyTransfers;
    const expensesPerFinancials = 0;
    const withdrawsDollarVar = externalWithdraws - expensesPerFinancials;
    const withdrawsPctVar =
      expensesPerFinancials !== 0
        ? (withdrawsDollarVar / expensesPerFinancials) * 100
        : 0;
    const ownerWithdraws = 0;
    const changeInCurrentLiabilities = 0;
    const changeInLTLiabilities = 0;
    const depreciationExpense = 0;
    const amortizationExpense = 0;
    const badDebtExpense = 0;
    const fixedAssetPurchases = 0;
    const withdrawsOther = 0;
    const withdrawsUnreconciledDollar =
      withdrawsDollarVar +
      ownerWithdraws +
      changeInCurrentLiabilities +
      changeInLTLiabilities +
      depreciationExpense +
      amortizationExpense +
      badDebtExpense +
      fixedAssetPurchases +
      withdrawsOther;
    const withdrawsUnreconciledPct =
      expensesPerFinancials !== 0
        ? (withdrawsUnreconciledDollar / expensesPerFinancials) * 100
        : 0;

    return {
      month,
      totalDeposits,
      intercompanyTransfers,
      externalDeposits,
      salesPerFinancials,
      depositsDollarVar,
      depositsPctVar,
      changeInAR,
      changeInARRetentions,
      fixedAssetDisposals,
      depositsOther,
      depositsUnreconciledDollar,
      depositsUnreconciledPct,
      totalWithdrawals,
      withdrawIntercompanyTransfers,
      externalWithdraws,
      expensesPerFinancials,
      withdrawsDollarVar,
      withdrawsPctVar,
      ownerWithdraws,
      changeInCurrentLiabilities,
      changeInLTLiabilities,
      depreciationExpense,
      amortizationExpense,
      badDebtExpense,
      fixedAssetPurchases,
      withdrawsOther,
      withdrawsUnreconciledDollar,
      withdrawsUnreconciledPct,
    };
  });

  const activityTTM = activityRows.slice(-12).reduce(
    (acc, r) => ({
      totalDeposits: acc.totalDeposits + r.totalDeposits,
      intercompanyTransfers:
        acc.intercompanyTransfers + r.intercompanyTransfers,
      externalDeposits: acc.externalDeposits + r.externalDeposits,
      salesPerFinancials: acc.salesPerFinancials + r.salesPerFinancials,
      depositsDollarVar: acc.depositsDollarVar + r.depositsDollarVar,
      depositsPctVar:
        acc.salesPerFinancials + r.salesPerFinancials !== 0
          ? ((acc.depositsDollarVar + r.depositsDollarVar) /
              (acc.salesPerFinancials + r.salesPerFinancials)) *
            100
          : 0,
      changeInAR: acc.changeInAR + r.changeInAR,
      changeInARRetentions: acc.changeInARRetentions + r.changeInARRetentions,
      fixedAssetDisposals: acc.fixedAssetDisposals + r.fixedAssetDisposals,
      depositsOther: acc.depositsOther + r.depositsOther,
      depositsUnreconciledDollar:
        acc.depositsUnreconciledDollar + r.depositsUnreconciledDollar,
      depositsUnreconciledPct:
        acc.salesPerFinancials + r.salesPerFinancials !== 0
          ? ((acc.depositsUnreconciledDollar + r.depositsUnreconciledDollar) /
              (acc.salesPerFinancials + r.salesPerFinancials)) *
            100
          : 0,
      totalWithdrawals: acc.totalWithdrawals + r.totalWithdrawals,
      withdrawIntercompanyTransfers:
        acc.withdrawIntercompanyTransfers + r.withdrawIntercompanyTransfers,
      externalWithdraws: acc.externalWithdraws + r.externalWithdraws,
      expensesPerFinancials:
        acc.expensesPerFinancials + r.expensesPerFinancials,
      withdrawsDollarVar: acc.withdrawsDollarVar + r.withdrawsDollarVar,
      withdrawsPctVar:
        acc.expensesPerFinancials + r.expensesPerFinancials !== 0
          ? ((acc.withdrawsDollarVar + r.withdrawsDollarVar) /
              (acc.expensesPerFinancials + r.expensesPerFinancials)) *
            100
          : 0,
      ownerWithdraws: acc.ownerWithdraws + r.ownerWithdraws,
      changeInCurrentLiabilities:
        acc.changeInCurrentLiabilities + r.changeInCurrentLiabilities,
      changeInLTLiabilities:
        acc.changeInLTLiabilities + r.changeInLTLiabilities,
      depreciationExpense: acc.depreciationExpense + r.depreciationExpense,
      amortizationExpense: acc.amortizationExpense + r.amortizationExpense,
      badDebtExpense: acc.badDebtExpense + r.badDebtExpense,
      fixedAssetPurchases: acc.fixedAssetPurchases + r.fixedAssetPurchases,
      withdrawsOther: acc.withdrawsOther + r.withdrawsOther,
      withdrawsUnreconciledDollar:
        acc.withdrawsUnreconciledDollar + r.withdrawsUnreconciledDollar,
      withdrawsUnreconciledPct:
        acc.expensesPerFinancials + r.expensesPerFinancials !== 0
          ? ((acc.withdrawsUnreconciledDollar + r.withdrawsUnreconciledDollar) /
              (acc.expensesPerFinancials + r.expensesPerFinancials)) *
            100
          : 0,
    }),
    buildEmptyActivityReviewRow(),
  );

  // ── Shared table sub-components ──────────────────────────────────────────

  const SpacerRow = ({ colCount }) => (
    <tr>
      <td
        colSpan={colCount}
        className="border-x border-border bg-slate-100 py-[3px]"
      />
    </tr>
  );

  const TableColGroup = ({ months }) => (
    <colgroup>
      <col className={TABLE_LABEL_COL_WIDTH} />
      {months.map((month) => (
        <col key={month} className={TABLE_VALUE_COL_WIDTH} />
      ))}
      <col className={TABLE_VALUE_COL_WIDTH} />
    </colgroup>
  );

  const TableHeader = ({ label, months }) => (
    <tr className="border-b border-primary/15 bg-[#F8FBF1]">
      <th
        className={cn(
          "sticky left-0 z-10 border border-border bg-[#F8FBF1] px-4 py-3 text-left text-[12px] font-semibold text-primary",
          TABLE_LABEL_COL_WIDTH,
        )}
      >
        {label}
      </th>
      {months.map((m) => (
        <th
          key={m}
          className={cn(
            "whitespace-nowrap border border-border px-4 py-3 text-center text-[12px] font-semibold text-primary",
            TABLE_VALUE_COL_WIDTH,
          )}
        >
          {monthLabel(m)}
        </th>
      ))}
      <th
        className={cn(
          "border border-border px-4 py-3 text-center text-[12px] font-semibold text-primary",
          TABLE_VALUE_COL_WIDTH,
        )}
      >
        TTM
      </th>
    </tr>
  );

  const DR = ({
    label,
    values,
    rawValues,
    bold,
    indent,
    check,
    rowType = "normal",
  }) => {
    const isVarianceRow =
      rowType === "variance-amt" || rowType === "variance-pct";

    const renderCell = (val, rawVal, i) => {
      if (isVarianceRow) {
        const numVal =
          rawVal != null ? rawVal : typeof val === "number" ? val : null;
        let formatted, colorClass;
        if (rowType === "variance-amt") {
          const result = fmtVarianceAmt(numVal);
          formatted = result.display;
          colorClass = result.colorClass;
        } else {
          const result = fmtVariancePct(numVal);
          formatted = result.display;
          colorClass = result.colorClass;
        }
        return (
          <td
            key={i}
            className={cn(
              "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums",
              colorClass,
            )}
          >
            {formatted}
          </td>
        );
      }
      return (
        <td
          key={i}
          className={cn(
            "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums",
            bold ? "font-semibold text-text-primary" : "text-text-primary",
            check ? "text-amber-700 italic" : "",
          )}
        >
          {val}
        </td>
      );
    };

    return (
      <tr
        className={cn(
          bold
            ? "bg-white"
            : check
              ? "bg-amber-50/40"
              : isVarianceRow
                ? "bg-white"
                : "bg-white hover:bg-slate-50/60",
        )}
      >
        <td
          className={cn(
            "border border-border px-3 py-[7px] text-[12px] text-text-primary whitespace-nowrap",
            TABLE_LABEL_COL_WIDTH,
            indent && "pl-7",
            bold && "font-semibold",
            check && "text-amber-700 italic",
          )}
        >
          {label}
        </td>
        {values.map((val, i) =>
          renderCell(val, rawValues ? rawValues[i] : null, i),
        )}
      </tr>
    );
  };

  const StatusBanner = ({ sync }) =>
    sync.status === "idle" ? null : (
      <div
        className={cn(
          "mt-4 flex items-center gap-2 rounded-xl border bg-white px-4 py-2.5 text-[13px]",
          sync.status === "error"
            ? "border-negative/20 text-negative"
            : sync.status === "success"
              ? "border-primary/20 text-primary"
              : "border-border text-text-secondary",
        )}
      >
        {sync.status === "loading" ? (
          <LoaderCircle size={16} className="animate-spin" />
        ) : sync.status === "error" ? (
          <AlertCircle size={16} />
        ) : (
          <CheckCircle2 size={16} />
        )}
        {sync.message}
      </div>
    );

  const renderOneBankActivityTable = () => {
    const rows = qbOneBankActivity?.monthlyData || [];
    if (!rows.length) return null;
    return (
      <div className="mt-4 overflow-x-auto rounded-xl border border-border shadow-sm">
        <table className="min-w-full border-collapse bg-white text-[13px]">
          <thead>
            <tr className="border-b border-primary/15 bg-[#F8FBF1]">
              <th className="min-w-[110px] border border-border px-4 py-3 text-left text-[12px] font-semibold text-primary">
                Month
              </th>
              <th className="min-w-[140px] border border-border px-4 py-3 text-right text-[12px] font-semibold text-primary">
                Starting Balance
              </th>
              <th className="min-w-[110px] border border-border px-4 py-3 text-right text-[12px] font-semibold text-primary">
                Deposits
              </th>
              <th className="min-w-[110px] border border-border px-4 py-3 text-right text-[12px] font-semibold text-primary">
                Withdrawals
              </th>
              <th className="min-w-[130px] border border-border px-4 py-3 text-right text-[12px] font-semibold text-primary">
                Ending Balance
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.month} className="bg-white hover:bg-slate-50/60">
                <td className="border border-border px-3 py-[7px] text-[12px] text-text-primary">
                  {monthLabel(row.month)}
                </td>
                <td className="border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary">
                  {fmtAmt(row.startingBalance)}
                </td>
                <td className="border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary">
                  {fmtAmt(row.deposits)}
                </td>
                <td className="border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary">
                  {fmtAmt(row.withdrawals)}
                </td>
                <td className="border border-border px-3 py-[7px] text-right text-[12px] font-semibold tabular-nums text-text-primary">
                  {fmtAmt(row.endingBalance)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  // ── Bank vs Book dropdown state ──────────────────────────────────────────
  const [selectedBvBBankId, setSelectedBvBBankId] = useState("");

  useEffect(() => {
    if (!selectedBvBBankId && balanceBankOptions.length > 0) {
      setSelectedBvBBankId(balanceBankOptions[0].value);
    }
  }, [balanceBankOptions, selectedBvBBankId]);

  // ── Bank vs Book renderer ─────────────────────────────────────────────────
  const renderBankVsBookTable = () => {
    const displayMonths = filteredPdfMonths;
    const colCount = displayMonths.length + 2; // label + months + Total

    // Find the selected QB account
    const qbAccount = qbBankActivity?.accounts?.find(
      (a) => a.accountId === selectedBvBBankId,
    );

    // Find the matching PDF bank by account name (best-effort match)
    const qbAccountName = qbAccount?.accountName?.toLowerCase() ?? "";
    const pdfBank =
      filteredPdfBanks.find((b) =>
        b.name
          .toLowerCase()
          .includes(qbAccountName.split(" ")[0] || "__none__"),
      ) ?? filteredPdfBanks[0];

    // Build QB monthly map
    const qbMonthlyMap = Object.fromEntries(
      (qbAccount?.monthlyData ?? []).map((r) => [r.month, r]),
    );

    // Account label for header
    const accountLabel = qbAccount
      ? `${qbAccount.accountName}${qbAccount.accountNumber ? ` (${qbAccount.accountNumber})` : ""}`
      : "Select an account";

    const METRIC_GROUPS = [
      {
        bankKey: "startingBalance",
        qbKey: "startingBalance",
        bankLabel: "Bank Starting Balance",
        qbLabel: "QB Starting Balance",
        diffLabel: "Starting Balance Difference",
      },
      {
        bankKey: "deposits",
        qbKey: "deposits",
        bankLabel: "Bank Deposits",
        qbLabel: "QB Deposits",
        diffLabel: "Deposit Difference",
      },
      {
        bankKey: "withdrawals",
        qbKey: "withdrawals",
        bankLabel: "Bank Withdrawals",
        qbLabel: "QB Withdrawals",
        diffLabel: "Withdrawals Difference",
      },
      {
        bankKey: "endingBalance",
        qbKey: "endingBalance",
        bankLabel: "Bank Ending Balance",
        qbLabel: "QB Ending Balance",
        diffLabel: "Ending Balance Difference",
      },
    ];

    const getBankVal = (metricKey, monthIdx) =>
      pdfBank?.rows?.[metricKey]?.[monthIdx] ?? null;

    const getQBVal = (metricKey, ym) => qbMonthlyMap[ym]?.[metricKey] ?? null;

    const getDiff = (bankVal, qbVal) => {
      if (bankVal == null && qbVal == null) return null;
      return (bankVal ?? 0) - (qbVal ?? 0);
    };

    // Totals across displayed months
    const getBankTotal = (metricKey) => {
      const sum = displayMonths.reduce(
        (acc, _, i) => acc + (getBankVal(metricKey, i) ?? 0),
        0,
      );
      return sum === 0 ? null : sum;
    };
    const getQBTotal = (metricKey) => {
      const sum = displayMonths.reduce(
        (acc, ym) => acc + (getQBVal(metricKey, ym) ?? 0),
        0,
      );
      return sum === 0 ? null : sum;
    };

    const fmtDiff = (val) => {
      if (val == null || val === 0)
        return { display: "-", colorClass: "text-text-muted" };
      const abs = new Intl.NumberFormat("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(Math.abs(val));
      if (val < 0)
        return { display: `-${abs}`, colorClass: "text-red-600 font-semibold" };
      return { display: `+${abs}`, colorClass: "text-green-600 font-semibold" };
    };

    return (
      <div className="overflow-x-auto rounded-xl border border-border shadow-sm">
        <table className="min-w-full table-fixed border-collapse bg-white text-[13px]">
          <colgroup>
            <col className={TABLE_LABEL_COL_WIDTH} />
            {displayMonths.map((m) => (
              <col key={m} className={TABLE_VALUE_COL_WIDTH} />
            ))}
            <col className={TABLE_VALUE_COL_WIDTH} />
          </colgroup>

          {/* Account name spanning header */}
          <thead>
            <tr className="bg-[#EAF4DA]">
              <th
                colSpan={colCount}
                className="border border-border px-4 py-2.5 text-left text-[13px] font-semibold text-primary"
              >
                {accountLabel}
              </th>
            </tr>
            {/* Month header row */}
            <tr className="border-b border-primary/15 bg-[#F8FBF1]">
              <th
                className={cn(
                  "sticky left-0 z-10 border border-border bg-[#F8FBF1] px-4 py-3 text-left text-[12px] font-semibold text-primary",
                  TABLE_LABEL_COL_WIDTH,
                )}
              >
                Metric
              </th>
              {displayMonths.map((m) => (
                <th
                  key={m}
                  className={cn(
                    "whitespace-nowrap border border-border px-4 py-3 text-center text-[12px] font-semibold text-primary",
                    TABLE_VALUE_COL_WIDTH,
                  )}
                >
                  {monthLabel(m)}
                </th>
              ))}
              <th
                className={cn(
                  "border border-border px-4 py-3 text-center text-[12px] font-semibold text-primary",
                  TABLE_VALUE_COL_WIDTH,
                )}
              >
                Total
              </th>
            </tr>
          </thead>

          <tbody>
            {METRIC_GROUPS.map((group, gIdx) => {
              const bankTotal = getBankTotal(group.bankKey);
              const qbTotal = getQBTotal(group.qbKey);
              const diffTotal = getDiff(bankTotal, qbTotal);

              return (
                <>
                  {/* Spacer between groups (not before first) */}
                  {gIdx > 0 && (
                    <tr key={`spacer-${gIdx}`}>
                      <td
                        colSpan={colCount}
                        className="border-x border-border bg-slate-100 py-[3px]"
                      />
                    </tr>
                  )}

                  {/* Bank row */}
                  <tr
                    key={`${group.bankKey}-bank`}
                    className="bg-white hover:bg-slate-50/60"
                  >
                    <td
                      className={cn(
                        "border border-border px-3 py-[7px] text-[12px] text-text-secondary whitespace-nowrap pl-4",
                        TABLE_LABEL_COL_WIDTH,
                      )}
                    >
                      {group.bankLabel}
                    </td>
                    {displayMonths.map((_, i) => (
                      <td
                        key={i}
                        className="border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary"
                      >
                        {fmtPdf(getBankVal(group.bankKey, i))}
                      </td>
                    ))}
                    <td className="border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary">
                      {fmtPdf(bankTotal)}
                    </td>
                  </tr>

                  {/* QB row */}
                  <tr
                    key={`${group.qbKey}-qb`}
                    className="bg-white hover:bg-slate-50/60"
                  >
                    <td
                      className={cn(
                        "border border-border px-3 py-[7px] text-[12px] text-text-secondary whitespace-nowrap pl-4",
                        TABLE_LABEL_COL_WIDTH,
                      )}
                    >
                      {group.qbLabel}
                    </td>
                    {displayMonths.map((_, i) => (
                      <td
                        key={i}
                        className="border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary"
                      >
                        {fmtAmt(getQBVal(group.qbKey, displayMonths[i]))}
                      </td>
                    ))}
                    <td className="border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary">
                      {fmtAmt(qbTotal)}
                    </td>
                  </tr>

                  {/* Difference row */}
                  <tr key={`${group.bankKey}-diff`} className="bg-[#FAFAFA]">
                    <td
                      className={cn(
                        "border border-border px-3 py-[7px] text-[12px] font-semibold text-text-primary whitespace-nowrap pl-4",
                        TABLE_LABEL_COL_WIDTH,
                      )}
                    >
                      {group.diffLabel}
                    </td>
                    {displayMonths.map((_, i) => {
                      const bv = getBankVal(group.bankKey, i);
                      const qv = getQBVal(group.qbKey, displayMonths[i]);
                      const diff = getDiff(bv, qv);
                      const { display, colorClass } = fmtDiff(diff);
                      return (
                        <td
                          key={i}
                          className={cn(
                            "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums font-semibold",
                            colorClass,
                          )}
                        >
                          {display}
                        </td>
                      );
                    })}
                    {/* Total diff */}
                    {(() => {
                      const { display, colorClass } = fmtDiff(diffTotal);
                      return (
                        <td
                          className={cn(
                            "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums font-semibold",
                            colorClass,
                          )}
                        >
                          {display}
                        </td>
                      );
                    })()}
                  </tr>
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  // ── Balance account table renderer ───────────────────────────────────────

  const renderBalanceAccountTable = (account) => {
    const { rows, ttm } = buildAccountBalanceDataFromQB(account);
    const isExpanded = expandedAccounts[account.accountId];
    const colCount = reportMonths.length + 2;
    const accountLabel = `${account.accountName} (${account.accountNumber ?? ""})`;

    const v = (f) => [...rows.map((r) => fmtAmt(r[f])), fmtAmt(ttm[f])];
    const va = (f) => [...rows.map((r) => fmtAcct(r[f])), fmtAcct(ttm[f])];
    const rawNums = (f) => [...rows.map((r) => r[f] ?? null), ttm[f] ?? null];

    return (
      <div
        key={account.accountId}
        className="mb-4 overflow-hidden rounded-[var(--radius-card)] border border-border bg-white shadow-[0_10px_30px_rgba(15,23,42,0.04)]"
      >
        <button
          type="button"
          className="flex w-full items-center justify-between border-b border-primary/15 bg-[#F8FBF1] px-4 py-3 font-semibold text-primary transition-colors hover:bg-[#F2F8E7]"
          onClick={() =>
            setExpandedAccounts((p) => ({
              ...p,
              [account.accountId]: !p?.[account.accountId],
            }))
          }
        >
          <div className="flex items-center gap-3">
            <span className="text-[14px] font-semibold">
              {account.accountName}
            </span>
            <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium tracking-wide text-primary">
              QB: {accountLabel}
            </span>
          </div>
          {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </button>

        {isExpanded && (
          <div className="overflow-x-auto border-t border-border bg-white">
            {isLoadingBankActivity ? (
              <div className="flex items-center gap-2 px-4 py-5 text-[13px] text-text-secondary">
                <LoaderCircle size={15} className="animate-spin" />
                Loading QuickBooks bank activity...
              </div>
            ) : rows.length === 0 ? (
              <div className="px-4 py-5 text-[13px] text-text-muted">
                No data for this bank account.
              </div>
            ) : (
              <table className="min-w-full table-fixed border-collapse bg-white text-[13px]">
                <TableColGroup months={reportMonths} />
                <thead>
                  <TableHeader
                    label={account.accountName}
                    months={reportMonths}
                  />
                </thead>
                <tbody>
                  <DR
                    label="Starting Balance"
                    values={v("startingBalance")}
                    bold
                  />
                  <DR label="Deposits" values={v("deposits")} />
                  <DR label="Withdrawals" values={v("withdrawals")} />
                  <DR label="Ending Balance" values={v("endingBalance")} bold />
                  <SpacerRow colCount={colCount} />
                  <DR
                    label="Intercompany Deposits"
                    values={v("intercompanyDeposits")}
                    indent
                  />
                  <DR
                    label="Intercompany Withdraws"
                    values={v("intercompanyWithdraws")}
                    indent
                  />
                  <SpacerRow colCount={colCount} />
                  <DR label="Footing Check" values={va("footingCheck")} check />
                  <DR
                    label="Prior Month Check"
                    values={va("priorMonthCheck")}
                    check
                  />
                  <SpacerRow colCount={colCount} />
                  <DR
                    label="Per Balance Sheet"
                    values={v("perBalanceSheet")}
                    bold
                  />
                  <DR
                    label="Variance"
                    values={rawNums("variance")}
                    rawValues={rawNums("variance")}
                    rowType="variance-amt"
                  />
                  <SpacerRow colCount={colCount} />
                  <DR
                    label="Outstanding Checks"
                    values={v("outstandingChecks")}
                  />
                  <DR
                    label="Unreconciled $ Variance"
                    values={rawNums("unreconciledDollar")}
                    rawValues={rawNums("unreconciledDollar")}
                    rowType="variance-amt"
                  />
                  <DR
                    label="Unreconciled % Variance"
                    values={rawNums("unreconciledPct")}
                    rawValues={rawNums("unreconciledPct")}
                    rowType="variance-pct"
                  />
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── Activity Review renderer ──────────────────────────────────────────────

  const renderActivityTable = () => {
    if (!hasData) return null;
    const colCount = reportMonths.length + 2;
    const av = (f) => [
      ...activityRows.map((r) => fmtAmt(r[f])),
      fmtAmt(activityTTM[f]),
    ];
    const avRaw = (f) => [
      ...activityRows.map((r) => r[f] ?? null),
      activityTTM[f] ?? null,
    ];

    return (
      <div className="overflow-x-auto rounded-xl border border-border shadow-sm">
        <table className="min-w-full table-fixed border-collapse bg-white text-[13px]">
          <TableColGroup months={reportMonths} />
          <thead>
            <TableHeader label="Activity Review" months={reportMonths} />
          </thead>
          <tbody>
            <DR label="Total Deposits" values={av("totalDeposits")} bold />
            <DR
              label="Intercompany Transfers"
              values={av("intercompanyTransfers")}
              indent
            />
            <DR
              label="External Deposits"
              values={av("externalDeposits")}
              bold
            />
            <DR
              label="Sales per Financials"
              values={av("salesPerFinancials")}
            />
            <DR
              label="$ Variance"
              values={avRaw("depositsDollarVar")}
              rawValues={avRaw("depositsDollarVar")}
              rowType="variance-amt"
            />
            <DR
              label="% Variance"
              values={avRaw("depositsPctVar")}
              rawValues={avRaw("depositsPctVar")}
              rowType="variance-pct"
            />
            <SpacerRow colCount={colCount} />
            <DR label="Change in AR" values={av("changeInAR")} indent />
            <DR
              label="Change in Accts Receivable- Retentions"
              values={av("changeInARRetentions")}
              indent
            />
            <DR
              label="Fixed Asset Disposals"
              values={av("fixedAssetDisposals")}
              indent
            />
            <DR label="Other" values={av("depositsOther")} indent />
            <DR
              label="Unreconciled Variance $"
              values={avRaw("depositsUnreconciledDollar")}
              rawValues={avRaw("depositsUnreconciledDollar")}
              rowType="variance-amt"
            />
            <DR
              label="Unreconciled Variance %"
              values={avRaw("depositsUnreconciledPct")}
              rawValues={avRaw("depositsUnreconciledPct")}
              rowType="variance-pct"
            />
            <SpacerRow colCount={colCount} />
            <DR
              label="Total Withdrawals"
              values={av("totalWithdrawals")}
              bold
            />
            <DR
              label="Intercompany Transfers"
              values={av("withdrawIntercompanyTransfers")}
              indent
            />
            <DR
              label="External Withdraws"
              values={av("externalWithdraws")}
              bold
            />
            <DR
              label="Expenses per Financials"
              values={av("expensesPerFinancials")}
            />
            <DR
              label="$ Variance"
              values={avRaw("withdrawsDollarVar")}
              rawValues={avRaw("withdrawsDollarVar")}
              rowType="variance-amt"
            />
            <DR
              label="% Variance"
              values={avRaw("withdrawsPctVar")}
              rawValues={avRaw("withdrawsPctVar")}
              rowType="variance-pct"
            />
            <SpacerRow colCount={colCount} />
            <DR label="Owner Withdraws" values={av("ownerWithdraws")} indent />
            <DR
              label="Change in Current Liabilities"
              values={av("changeInCurrentLiabilities")}
              indent
            />
            <DR
              label="Change in LT Liabilities"
              values={av("changeInLTLiabilities")}
              indent
            />
            <DR
              label="Depreciation Expense"
              values={av("depreciationExpense")}
              indent
            />
            <DR
              label="Amortization Expense"
              values={av("amortizationExpense")}
              indent
            />
            <DR label="Bad Debt Expense" values={av("badDebtExpense")} indent />
            <DR
              label="Fixed Asset Purchases"
              values={av("fixedAssetPurchases")}
              indent
            />
            <DR label="Other" values={av("withdrawsOther")} indent />
            <DR
              label="Unreconciled Variance $"
              values={avRaw("withdrawsUnreconciledDollar")}
              rawValues={avRaw("withdrawsUnreconciledDollar")}
              rowType="variance-amt"
            />
            <DR
              label="Unreconciled Variance %"
              values={avRaw("withdrawsUnreconciledPct")}
              rawValues={avRaw("withdrawsUnreconciledPct")}
              rowType="variance-pct"
            />
          </tbody>
        </table>
      </div>
    );
  };

  // ── Extracted Bank PDF Records renderer ──────────────────────────────────
  // Uses same single-label-column layout as Bank Account Balances so month
  // columns align perfectly. Bank name is shown as a full-width section header
  // row (like the collapsible account header), and each metric row sits in the
  // shared label column — matching TABLE_LABEL_COL_WIDTH / TABLE_VALUE_COL_WIDTH.

  const renderExtractedBankPDFTable = () => {
    const displayMonths = filteredPdfMonths;
    // +2 = label col + Total col (mirrors TTM col in Bank Account Balances)
    const colCount = displayMonths.length + 2;

    // Per-bank row totals (sum across all displayed months per metric)
    const getBankRowTotal = (bank, metricKey) => {
      const sum = bank.rows[metricKey].reduce((acc, v) => acc + (v ?? 0), 0);
      return sum === 0 ? null : sum;
    };

    // All Banks totals per month index
    const allBanksTotals = PDF_METRIC_KEYS.reduce((acc, metric) => {
      acc[metric.key] = displayMonths.map((_, i) => {
        const sum = filteredPdfBanks.reduce(
          (s, bank) => s + (bank.rows[metric.key][i] ?? 0),
          0,
        );
        return sum === 0 ? null : sum;
      });
      return acc;
    }, {});

    // All Banks grand total per metric (sum of all months across all banks)
    const allBanksGrandTotal = PDF_METRIC_KEYS.reduce((acc, metric) => {
      const sum = filteredPdfBanks.reduce(
        (s, bank) =>
          s + bank.rows[metric.key].reduce((a, v) => a + (v ?? 0), 0),
        0,
      );
      acc[metric.key] = sum === 0 ? null : sum;
      return acc;
    }, {});

    return (
      <div className="overflow-x-auto rounded-xl border border-border shadow-sm">
        <table className="min-w-full table-fixed border-collapse bg-white text-[13px]">
          {/* Exactly matches Bank Account Balances colgroup: label + months + Total */}
          <colgroup>
            <col className={TABLE_LABEL_COL_WIDTH} />
            {displayMonths.map((m) => (
              <col key={m} className={TABLE_VALUE_COL_WIDTH} />
            ))}
            <col className={TABLE_VALUE_COL_WIDTH} />
          </colgroup>

          {/* Header — identical structure to TableHeader (label + months + Total) */}
          <thead>
            <tr className="border-b border-primary/15 bg-[#F8FBF1]">
              <th
                className={cn(
                  "sticky left-0 z-10 border border-border bg-[#F8FBF1] px-4 py-3 text-left text-[12px] font-semibold text-primary",
                  TABLE_LABEL_COL_WIDTH,
                )}
              >
                Bank Statement
              </th>
              {displayMonths.map((m) => (
                <th
                  key={m}
                  className={cn(
                    "whitespace-nowrap border border-border px-4 py-3 text-center text-[12px] font-semibold text-primary",
                    TABLE_VALUE_COL_WIDTH,
                  )}
                >
                  {monthLabel(m)}
                </th>
              ))}
              <th
                className={cn(
                  "border border-border px-4 py-3 text-center text-[12px] font-semibold text-primary",
                  TABLE_VALUE_COL_WIDTH,
                )}
              >
                Total
              </th>
            </tr>
          </thead>

          <tbody>
            {/* Per-bank sections */}
            {filteredPdfBanks.map((bank) => (
              <>
                {/* Bank name section header */}
                <tr key={`${bank.name}-header`} className="bg-[#F8FBF1]">
                  <td
                    colSpan={colCount}
                    className="border border-border px-4 py-2 text-[12px] font-semibold text-primary"
                  >
                    {bank.name}
                  </td>
                </tr>

                {/* Metric rows with Total column */}
                {PDF_METRIC_KEYS.map((metric) => (
                  <tr
                    key={`${bank.name}-${metric.key}`}
                    className="bg-white hover:bg-slate-50/60"
                  >
                    <td
                      className={cn(
                        "border border-border px-3 py-[7px] pl-7 text-[12px] text-text-primary whitespace-nowrap",
                        TABLE_LABEL_COL_WIDTH,
                        metric.bold && "font-semibold",
                      )}
                    >
                      {metric.label}
                    </td>
                    {displayMonths.map((_, i) => (
                      <td
                        key={i}
                        className={cn(
                          "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary",
                          TABLE_VALUE_COL_WIDTH,
                          metric.bold && "font-semibold",
                        )}
                      >
                        {fmtPdf(bank.rows[metric.key][i])}
                      </td>
                    ))}
                    {/* Total cell */}
                    <td
                      className={cn(
                        "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary",
                        TABLE_VALUE_COL_WIDTH,
                        metric.bold && "font-semibold",
                      )}
                    >
                      {fmtPdf(getBankRowTotal(bank, metric.key))}
                    </td>
                  </tr>
                ))}

                {/* Spacer between banks */}
                <tr key={`${bank.name}-spacer`}>
                  <td
                    colSpan={colCount}
                    className="border-x border-border bg-slate-100 py-[3px]"
                  />
                </tr>
              </>
            ))}

            {/* All Banks section header */}
            <tr className="bg-[#F0F7E6]">
              <td
                colSpan={colCount}
                className="border border-border px-4 py-2 text-[12px] font-semibold text-primary"
              >
                All Banks
              </td>
            </tr>

            {/* All Banks metric rows with Total column */}
            {PDF_METRIC_KEYS.map((metric) => (
              <tr key={`allbanks-${metric.key}`} className="bg-[#F8FBF1]">
                <td
                  className={cn(
                    "border border-border px-3 py-[7px] pl-7 text-[12px] text-primary whitespace-nowrap",
                    TABLE_LABEL_COL_WIDTH,
                    metric.bold && "font-semibold",
                  )}
                >
                  {metric.label}
                </td>
                {allBanksTotals[metric.key].map((val, i) => (
                  <td
                    key={i}
                    className={cn(
                      "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-primary",
                      TABLE_VALUE_COL_WIDTH,
                      metric.bold && "font-semibold",
                    )}
                  >
                    {fmtPdf(val)}
                  </td>
                ))}
                {/* Grand total cell */}
                <td
                  className={cn(
                    "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-primary",
                    TABLE_VALUE_COL_WIDTH,
                    metric.bold && "font-semibold",
                  )}
                >
                  {fmtPdf(allBanksGrandTotal[metric.key])}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  // ── Export helpers ────────────────────────────────────────────────────────

  const getBankExportDateRange = () => {
    const [startYear, startMonth] = bankActivityStartMonth.split("-");
    const [endYear, endMonth] = bankActivityEndMonth.split("-");
    const endDay = String(new Date(+endYear, +endMonth, 0).getDate()).padStart(
      2,
      "0",
    );
    return {
      startDate: `${startYear}-${startMonth}-01`,
      endDate: `${endYear}-${endMonth}-${endDay}`,
    };
  };

  const buildBankExport = async () => {
    const { startDate, endDate } = getBankExportDateRange();

    if (!hasData) {
      throw new Error("No bank reconciliation data found to export.");
    }

    const blob = await buildStyledReconciliationExcel({
      startDate,
      endDate,
      reportMonths,
      visibleBalanceAccounts,
      qbBankActivity,
      buildAccountBalanceDataFromQB,
      activityRows,
      activityTTM,
      BALANCE_EXPORT_METRICS,
      ACTIVITY_EXPORT_METRICS,
    });

    return {
      blob,
      fileName: buildReportFileName({
        reportKey: "bankreconciliation",
        extension: "xlsx",
        accountingMethod: bankActivityAccountingMethod,
        ...getBankExportDateRange(),
      }),
      folderPath: REPORT_FOLDER_PATHS.bankreconciliation,
    };
  };

  const handleBankExportDestination = async (destination) => {
    setIsExporting(true);
    try {
      const { blob, fileName, folderPath } = await buildBankExport();
      if (destination === "local") {
        downloadBlob(blob, fileName);
        showToast({
          type: "success",
          title: "Bank reconciliation export ready",
          message: `${fileName} was downloaded locally.`,
        });
      } else {
        await uploadReportToDataRoom({
          companyId: clientId,
          userId: user?.id,
          blob,
          fileName,
          folderPath,
        });
        showToast({
          type: "success",
          title: "Uploaded to DataRoom",
          message: `${fileName} was uploaded to ${folderPath.join(" / ")}.`,
          duration: 4500,
        });
      }
      setShowExportDestinationModal(false);
    } catch (exportError) {
      console.error("Bank reconciliation export failed:", exportError);
      showToast({
        type: "error",
        title: "Could not export bank reconciliation",
        message: exportError.message || "Please try again.",
        duration: 4500,
      });
    } finally {
      setIsExporting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <Header title="Reconciliation" />
      <div className="page-content">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="text-[24px] font-bold text-text-primary">
            Reconciliation
          </h1>
        </div>
        <QBDisconnectedBanner pageName="Reconciliation" />

        {/* QB Bank Activity */}
        <section className="card-base w-full p-5">
          <h2 className="text-[18px] font-semibold text-text-primary">
            QuickBooks Bank Activity
          </h2>
          <p className="mt-1 text-[13px] text-text-secondary">
            Fetches bank account activity directly from QuickBooks for the
            selected date range.
          </p>
          <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr_220px_auto]">
            {/* Start Month */}
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                Start Month
              </label>
              <div className="flex gap-2">
                <select
                  className="input-base h-10"
                  value={bankActivityStartMonth.split("-")[1]}
                  onChange={(e) =>
                    setBankActivityStartMonth(
                      `${bankActivityStartMonth.split("-")[0]}-${e.target.value}`,
                    )
                  }
                >
                  {MONTHS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <select
                  className="input-base h-10"
                  value={bankActivityStartMonth.split("-")[0]}
                  onChange={(e) =>
                    setBankActivityStartMonth(
                      `${e.target.value}-${bankActivityStartMonth.split("-")[1]}`,
                    )
                  }
                >
                  {YEARS.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* End Month */}
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                End Month
              </label>
              <div className="flex gap-2">
                <select
                  className="input-base h-10"
                  value={bankActivityEndMonth.split("-")[1]}
                  onChange={(e) =>
                    setBankActivityEndMonth(
                      `${bankActivityEndMonth.split("-")[0]}-${e.target.value}`,
                    )
                  }
                >
                  {MONTHS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <select
                  className="input-base h-10"
                  value={bankActivityEndMonth.split("-")[0]}
                  onChange={(e) =>
                    setBankActivityEndMonth(
                      `${e.target.value}-${bankActivityEndMonth.split("-")[1]}`,
                    )
                  }
                >
                  {YEARS.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Accounting Method */}
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                Accounting Type
              </label>
              <select
                value={bankActivityAccountingMethod}
                onChange={(e) =>
                  setBankActivityAccountingMethod(e.target.value)
                }
                className="input-base h-10"
              >
                <option value="Accrual">Accrual</option>
                <option value="Cash">Cash</option>
              </select>
            </div>

            {/* Buttons */}
            <div className="flex items-end gap-3">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowExportDestinationModal(true)}
                disabled={isExporting || !hasData}
              >
                <Download size={16} />
                Export Excel
              </button>
              <button
                type="button"
                className="btn-primary w-full"
                onClick={() => void loadQBBankActivity()}
                disabled={isLoadingBankActivity}
              >
                {isLoadingBankActivity ? (
                  <LoaderCircle size={16} className="animate-spin" />
                ) : (
                  <RefreshCw size={16} />
                )}{" "}
                Fetch Activity
              </button>
            </div>
          </div>
          <StatusBanner sync={bankActivityFetchStatus} />
        </section>

        {/* HIDING BANK STATEMENT & BANK VS BOOK RECONCILIATION AS REQUESTED */}
        {false && (
          <>
            {/* Extracted Bank PDF Records */}
            <section className="card-base card-p w-full">
              <div className="mb-4">
                <h2 className="text-[18px] font-semibold text-text-primary">
                  Bank Statement
                </h2>
              </div>
              {renderExtractedBankPDFTable()}
            </section>

            {/* Bank vs Book Reconciliation */}
            <section className="card-base card-p w-full">
              <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h2 className="text-[18px] font-semibold text-text-primary">
                    Bank vs Book Reconciliation
                  </h2>
                </div>
                <div className="min-w-[280px]">
                  <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                    Bank Account
                  </label>
                  <select
                    className="input-base h-10 w-full"
                    value={selectedBvBBankId}
                    onChange={(e) => setSelectedBvBBankId(e.target.value)}
                    disabled={!balanceBankOptions.length}
                  >
                    {balanceBankOptions.length ? (
                      balanceBankOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))
                    ) : (
                      <option value="">No bank accounts available</option>
                    )}
                  </select>
                </div>
              </div>
              {hasData ? (
                renderBankVsBookTable()
              ) : (
                <div className="rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-[14px] text-text-muted">
                  Fetch bank activity to see the Bank vs Book reconciliation.
                </div>
              )}
            </section>
          </>
        )}

        {/* Bank Account Balances */}
        <section className="card-base card-p w-full">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-[18px] font-semibold text-text-primary">
                Bank Account Balances
              </h2>
              <p className="text-[14px] text-text-secondary">
                Per-account balance detail from QuickBooks with reconciliation
                checks.
              </p>
            </div>
            <div className="min-w-[280px]">
              <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                Bank Account
              </label>
              <select
                className="input-base h-10 w-full"
                value={selectedBalanceBankId}
                onChange={(e) => setSelectedBalanceBankId(e.target.value)}
                disabled={!balanceBankOptions.length}
              >
                {balanceBankOptions.length ? (
                  balanceBankOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))
                ) : (
                  <option value="">No bank accounts available</option>
                )}
              </select>
            </div>
          </div>
          {hasData ? (
            visibleBalanceAccounts.map((account) =>
              renderBalanceAccountTable(account),
            )
          ) : (
            <div className="rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-[14px] text-text-muted">
              Fetch bank activity to see account balances.
            </div>
          )}
        </section>

        {/* Activity Review */}
        <section className="card-base card-p w-full">
          <div className="mb-5">
            <h2 className="text-[18px] font-semibold text-text-primary">
              Activity Review
            </h2>
            <p className="text-[14px] text-text-secondary">
              Deposits and withdrawals compared to P&amp;L financials, with
              reconciling items.
            </p>
          </div>
          {hasData ? (
            renderActivityTable()
          ) : (
            <div className="rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-[14px] text-text-muted">
              Fetch bank activity to see the Activity Review.
            </div>
          )}
        </section>

        <ExportDestinationModal
          isOpen={showExportDestinationModal}
          title="Export Bank Reconciliation"
          description="Choose whether to download this Excel export locally or upload it into the Bank Reconciliation folder in DataRoom."
          onClose={() => {
            if (!isExporting) setShowExportDestinationModal(false);
          }}
          onSelect={handleBankExportDestination}
          isSubmitting={isExporting}
        />
      </div>
    </>
  );
}

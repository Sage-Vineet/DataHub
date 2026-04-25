"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import Header from "../../../components/Header";
import ExtractedBankRecords from "../../../components/ExtractedBankRecords";
import { getStoredToken } from "../../../lib/api";
import { cn } from "../../../lib/utils";
import {
  AlertCircle,
  CheckCircle2,
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
const EXTRACT_BANK_PDF_RECORDS_ENDPOINT = `${API_BASE_URL}/api/extract-bank-pdf-records`;
const RECONCILIATION_STORAGE_PREFIX = "workspace-reconciliation";

const getErrMsg = (e) => (e instanceof Error ? e.message : String(e));
const getWorkspaceStorageKey = (clientId) =>
  `${RECONCILIATION_STORAGE_PREFIX}:${clientId || "default"}`;
const getDefaultExpandedAccounts = () => ({});
const getLastFourDigits = (accountNumber) => String(accountNumber ?? "").slice(-4);
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

/**
 * Normalize the API response into the shape consumed by the table renderer.
 *
 * API shape (per bank):
 *   bank.bank_name          string
 *   bank.accounts[0].months[]  { monthKey, startingBalance, deposits, withdrawals, endingBalance }
 *   bank.accounts[0].totals    { startingBalance, deposits, withdrawals, endingBalance }
 *
 * Normalised shape (per bank):
 *   { bankName, months[], totals }
 */

const normalizeExtractedBankPdfData = (payload) => {
  if (!payload?.banks?.length || !payload?.months?.length) return null;

  const banks = payload.banks.map((bank) => {
    const acct = bank.accounts?.[0];
    return {
      bankName: bank.bank_name,
      months: (acct?.months || []).map((m) => ({
        monthKey: m.monthKey,
        startingBalance: m.startingBalance ?? 0,
        deposits: m.deposits ?? 0,
        withdrawals: m.withdrawals ?? 0,
        endingBalance: m.endingBalance ?? 0,
      })),
      totals: {
        startingBalance:
          acct?.totals?.startingBalance ??
          (acct?.months || []).reduce(
            (sum, m) => sum + (m.startingBalance || 0),
            0,
          ),
        deposits:
          acct?.totals?.deposits ??
          (acct?.months || []).reduce((sum, m) => sum + (m.deposits || 0), 0),
        withdrawals:
          acct?.totals?.withdrawals ??
          (acct?.months || []).reduce(
            (sum, m) => sum + (m.withdrawals || 0),
            0,
          ),
        endingBalance:
          acct?.totals?.endingBalance ??
          (acct?.months || []).reduce(
            (sum, m) => sum + (m.endingBalance || 0),
            0,
          ),
      },
    };
  });

  return {
    months: payload.months,
    banks,
    totals: payload.totals || [],
  };
};
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
  const [extractedBankPdfData, setExtractedBankPdfData] = useState(
    storedState?.extractedBankPdfData || null,
  );
  const [isLoadingExtractedBankPdfData, setIsLoadingExtractedBankPdfData] =
    useState(false);
  const [extractedBankPdfError, setExtractedBankPdfError] = useState("");
  const [extractedBankPdfFetchStatus, setExtractedBankPdfFetchStatus] =
    useState({
      status: storedState?.extractedBankPdfData ? "success" : "idle",
      message: storedState?.extractedBankPdfData
        ? "Restored saved bank PDF extraction."
        : "",
    });

  const getHeaders = useCallback(
    () => {
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
    },
    [clientId],
  );

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
    setExtractedBankPdfData(nextState?.extractedBankPdfData || null);
    setExtractedBankPdfFetchStatus({
      status: nextState?.extractedBankPdfData ? "success" : "idle",
      message: nextState?.extractedBankPdfData
        ? "Restored saved bank PDF extraction."
        : "",
    });
    setExtractedBankPdfError("");
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
          extractedBankPdfData:
            extractedBankPdfData ?? existing.extractedBankPdfData ?? null,
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
    extractedBankPdfData,
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
        message: `Loaded ${data?.months?.length ?? 0} month(s) across ${
          data?.accounts?.length ?? 0
        } account(s).`,
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
        message: `Loaded ${data?.monthlyData?.length ?? 0} month(s) for ${
          data?.account?.bankName || "selected account"
        }.`,
      });
    } catch (e) {
      setOneBankActivityError(getErrMsg(e));
      setOneBankActivityFetchStatus({
        status: "error",
        message: getErrMsg(e),
      });
      setQbOneBankActivity(null);
    } finally {
      setIsLoadingOneBankActivity(false);
    }
  };

  const loadExtractedBankPdfData = useCallback(async () => {
    setIsLoadingExtractedBankPdfData(true);
    setExtractedBankPdfError("");
    setExtractedBankPdfFetchStatus({
      status: "loading",
      message: "Loading extracted bank PDF records...",
    });

    try {
      const resp = await fetch(EXTRACT_BANK_PDF_RECORDS_ENDPOINT, {
        cache: "no-store",
        headers: getHeaders(),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);

      const normalized = normalizeExtractedBankPdfData(data);
      setExtractedBankPdfData(normalized);
      setExtractedBankPdfFetchStatus({
        status: "success",
        message: `Loaded ${normalized?.banks?.length ?? 0} bank(s) across ${
          normalized?.months?.length ?? 0
        } month(s).`,
      });
    } catch (e) {
      setExtractedBankPdfError(getErrMsg(e));
      setExtractedBankPdfFetchStatus({
        status: "error",
        message: getErrMsg(e),
      });
      setExtractedBankPdfData(null);
    } finally {
      setIsLoadingExtractedBankPdfData(false);
    }
  }, [getHeaders]);

  useEffect(() => {
    if (storedState?.extractedBankPdfData) return;
    void loadExtractedBankPdfData();
  }, [loadExtractedBankPdfData, storedState?.extractedBankPdfData]);

  const reportMonths = qbBankActivity?.months?.length
    ? qbBankActivity.months
    : [];
  const hasData = reportMonths.length > 0;
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
        label: `${account.accountName}${
          account.accountNumber ? ` (${account.accountNumber})` : ""
        }`,
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
      !balanceBankOptions.some((option) => option.value === selectedBalanceBankId)
    ) {
      setSelectedBalanceBankId(balanceBankOptions[0].value);
    }
  }, [balanceBankOptions, selectedBalanceBankId]);

  useEffect(() => {
    if (!selectedBalanceBankId) return;

    setExpandedAccounts((prev) => ({
      ...prev,
      [selectedBalanceBankId]: true,
    }));
  }, [selectedBalanceBankId]);

  useEffect(() => {
    if (!oneBankAccountId && oneBankAccountOptions.length > 0) {
      setOneBankAccountId(oneBankAccountOptions[0].value);
    }
  }, [oneBankAccountId, oneBankAccountOptions]);

  const buildAccountBalanceDataFallback = () => {
    return { rows: [], ttm: buildEmptyTTM() };
  };

  const buildAccountBalanceDataFromQB = (account) => {
    if (!account) {
      return buildAccountBalanceDataFallback();
    }

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
      Object.fromEntries((account.monthlyData || []).map((row) => [row.month, row])),
    ) || [];

  const activityRows = reportMonths.map((month) => {
    const totalDeposits = allBankMonthlyMaps.reduce(
      (sum, monthlyMap) => sum + (monthlyMap[month]?.deposits || 0),
      0,
    );
    const totalWithdrawals = allBankMonthlyMaps.reduce(
      (sum, monthlyMap) => sum + (monthlyMap[month]?.withdrawals || 0),
      0,
    );
    const intercompanyDeposits = allBankMonthlyMaps.reduce(
      (sum, monthlyMap) =>
        sum + (monthlyMap[month]?.intercompanyDeposits || 0),
      0,
    );
    const intercompanyWithdraws = allBankMonthlyMaps.reduce(
      (sum, monthlyMap) =>
        sum + (monthlyMap[month]?.intercompanyWithdraws || 0),
      0,
    );
    const intercompanyTransfers =
      intercompanyDeposits + intercompanyWithdraws;
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
    const externalWithdraws =
      totalWithdrawals - withdrawIntercompanyTransfers;
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
      changeInARRetentions:
        acc.changeInARRetentions + r.changeInARRetentions,
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
      depreciationExpense:
        acc.depreciationExpense + r.depreciationExpense,
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

  // ── Extracted Bank PDF table renderer ────────────────────────────────────
  // Renders one section per bank with rows:
  //   Starting Balance | [month cols] | Total
  //   Deposits         | ...
  //   Withdrawals      | ...
  //   Ending Balance   | ...
  // Plus a final "All Banks" totals section.

  const renderExtractedBankPdfTable = () => {
    const { months, banks, totals } = extractedBankPdfData;

    if (!banks?.length || !months?.length) return null;

    const METRICS = [
      { key: "startingBalance", label: "Starting Balance", bold: true },
      { key: "deposits", label: "Deposits", bold: false },
      { key: "withdrawals", label: "Withdrawals", bold: false },
      { key: "endingBalance", label: "Ending Balance", bold: true },
    ];

    // Build a monthKey → column-index map for fast look-ups
    const monthIndexMap = Object.fromEntries(months.map((m, i) => [m.key, i]));

    return (
      <div className="overflow-x-auto rounded-xl border border-border shadow-sm">
        <table className="min-w-full border-collapse bg-white text-[13px]">
          {/* ── Header ── */}
          <thead>
            <tr className="border-b border-primary/15 bg-[#F8FBF1]">
              <th className="sticky left-0 z-10 w-40 border border-border bg-[#F8FBF1] px-4 py-3 text-left text-[12px] font-semibold text-primary">
                Bank
              </th>
              <th className="w-36 border border-border bg-[#F8FBF1] px-4 py-3 text-left text-[12px] font-semibold text-primary">
                Metric
              </th>
              {months.map((m) => (
                <th
                  key={m.key}
                  className="min-w-[110px] whitespace-nowrap border border-border px-4 py-3 text-center text-[12px] font-semibold text-primary"
                >
                  {m.label}
                </th>
              ))}
              <th className="min-w-[110px] border border-border px-4 py-3 text-center text-[12px] font-semibold text-primary">
                Total
              </th>
            </tr>
          </thead>

          <tbody>
            {/* ── Per-bank rows ── */}
            {banks.map((bank, bi) => {
              // Index bank months by monthKey for O(1) access
              const bankMonthMap = Object.fromEntries(
                (bank.months || []).map((m) => [m.monthKey, m]),
              );

              return METRICS.map((metric, mi) => (
                <tr
                  key={`${bi}-${metric.key}`}
                  className={
                    metric.bold ? "bg-white" : "bg-white hover:bg-slate-50/60"
                  }
                >
                  {/* Bank name cell — spans all metric rows */}
                  {mi === 0 && (
                    <td
                      rowSpan={METRICS.length}
                      className="border border-border px-3 py-[7px] text-[12px] font-semibold text-text-primary align-middle"
                    >
                      {bank.bankName}
                    </td>
                  )}

                  {/* Metric label */}
                  <td
                    className={cn(
                      "border border-border px-3 py-[7px] text-[12px] text-text-primary whitespace-nowrap",
                      metric.bold && "font-semibold",
                    )}
                  >
                    {metric.label}
                  </td>

                  {/* One cell per month */}
                  {months.map((m) => {
                    const val = bankMonthMap[m.key]?.[metric.key] ?? null;
                    return (
                      <td
                        key={m.key}
                        className={cn(
                          "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary",
                          metric.bold && "font-semibold",
                        )}
                      >
                        {fmtAmt(val)}
                      </td>
                    );
                  })}

                  {/* Per-bank totals column */}
                  <td
                    className={cn(
                      "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary",
                      metric.bold && "font-semibold",
                    )}
                  >
                    {fmtAmt(bank.totals?.[metric.key] ?? null)}
                  </td>
                </tr>
              ));
            })}

            {/* ── Spacer between banks and cross-bank totals ── */}
            <tr>
              <td
                colSpan={months.length + 3}
                className="border-x border-border bg-slate-100 py-[3px]"
              />
            </tr>

            {/* ── All Banks totals section ── */}
            {METRICS.map((metric) => {
              // Build per-month cross-bank totals
              const monthValues = months.map((m) => {
                const entry = (totals || []).find((t) => t.monthKey === m.key);
                return entry?.[metric.key] ?? null;
              });

              // Grand total across all months for this metric
              const grandTotal = monthValues.reduce(
                (sum, v) => sum + (v ?? 0),
                0,
              );

              return (
                <tr
                  key={`total-${metric.key}`}
                  className={
                    metric.bold
                      ? "bg-[#F8FBF1]"
                      : "bg-[#F8FBF1] hover:bg-[#F2F8E7]"
                  }
                >
                  {/* "All Banks" label only on first metric row */}
                  {metric.key === "startingBalance" && (
                    <td
                      rowSpan={METRICS.length}
                      className="border border-border px-3 py-[7px] text-[12px] font-semibold text-primary align-middle"
                    >
                      All Banks
                    </td>
                  )}
                  {metric.key !== "startingBalance" ? null : null}

                  <td
                    className={cn(
                      "border border-border px-3 py-[7px] text-[12px] text-primary whitespace-nowrap",
                      metric.bold && "font-semibold",
                    )}
                  >
                    {metric.label}
                  </td>

                  {monthValues.map((val, i) => (
                    <td
                      key={i}
                      className={cn(
                        "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-primary",
                        metric.bold && "font-semibold",
                      )}
                    >
                      {fmtAmt(val)}
                    </td>
                  ))}

                  <td
                    className={cn(
                      "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-primary",
                      metric.bold && "font-semibold",
                    )}
                  >
                    {fmtAmt(grandTotal)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

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
            <span className="text-[14px] font-semibold">{account.accountName}</span>
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
                  <TableHeader label={account.accountName} months={reportMonths} />
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
              values={av("withdrawIntercompanyTransfers")}
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
              values={av("intercompanyTransfers")}
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

            {/* Fetch Button */}
            <div className="flex items-end">
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

        {/* Extracted Bank PDF Records */}
        <section className="card-base card-p w-full">
          <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h2 className="text-[18px] font-semibold text-text-primary">
                Extracted Bank PDF Records
              </h2>
              <p className="mt-1 text-[13px] text-text-secondary">
                Bank summary table extracted from the PDF parser and grouped by
                bank — showing Starting Balance, Deposits, Withdrawals, and
                Ending Balance per month.
              </p>
              {extractedBankPdfError && (
                <div className="mt-2 flex items-center gap-2 rounded-lg border border-negative/20 bg-white px-3 py-2 text-[13px] text-negative">
                  <AlertCircle size={14} />
                  {extractedBankPdfError}
                </div>
              )}
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void loadExtractedBankPdfData()}
              disabled={isLoadingExtractedBankPdfData}
            >
              {isLoadingExtractedBankPdfData ? (
                <LoaderCircle size={16} className="animate-spin" />
              ) : (
                <RefreshCw size={16} />
              )}
              Refresh
            </button>
          </div>
          <StatusBanner sync={extractedBankPdfFetchStatus} />
          {isLoadingExtractedBankPdfData && !extractedBankPdfData ? (
            <div className="rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-[14px] text-text-muted">
              Loading extracted bank PDF records...
            </div>
          ) : extractedBankPdfData?.banks?.length ? (
            <div className="mt-4">{renderExtractedBankPdfTable()}</div>
          ) : (
            <div className="rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-[14px] text-text-muted">
              {isLoadingExtractedBankPdfData
                ? "Loading extracted bank PDF records..."
                : "Refresh to load the extracted bank PDF summary."}
            </div>
          )}
        </section>

        {/* Extracted Bank Records component */}
        <ExtractedBankRecords clientId={clientId} />

        {/* Balance Sheet Accounts */}
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
            <div>
              <h2 className="text-[18px] font-semibold text-text-primary">
                Activity Review
              </h2>
              <p className="text-[14px] text-text-secondary">
                Deposits and withdrawals compared to P&amp;L financials, with
                reconciling items.
              </p>
            </div>
          </div>
          {hasData ? (
            renderActivityTable()
          ) : (
            <div className="rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-[14px] text-text-muted">
              Fetch bank activity to see the Activity Review.
            </div>
          )}
        </section>
      </div>
    </>
  );
}

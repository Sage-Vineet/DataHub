"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Header from "../../../components/Header";
import { cn } from "../../../lib/utils";
import {
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  LockKeyhole,
  FileJson,
  FileSpreadsheet,
  FileText,
  LoaderCircle,
  Upload,
  X,
  BrainCircuit,
  Building2,
} from "lucide-react";
import QBDisconnectedBanner from "../../../components/common/QBDisconnectedBanner";
import { parseDetailReport } from "../../../lib/report-parsers";
import {
  parseAllSections,
  detectBankName,
  readExcelFile,
} from "./Bankstatementparser.JS";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";
const BANK_STATEMENT_UPLOAD_ENDPOINT = `${API_BASE_URL}/upload-bank-statement`;
const RECONCILIATION_DATA_ENDPOINTS = [`${API_BASE_URL}/reconciliation-data`];
const RECONCILIATION_VARIANCE_ENDPOINTS = [
  `${API_BASE_URL}/reconciliation-variance`,
];
const QB_GENERAL_LEDGER_ENDPOINT = `${API_BASE_URL}/qb-general-ledger`;
const QB_FINANCIAL_REPORTS_ENDPOINT = `${API_BASE_URL}/qb-financial-reports-for-reconciliation`;

const ACCEPTED_FILE_TYPES = [
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
const ACCEPTED_EXTENSIONS = [".pdf", ".xls", ".xlsx"];
const STATUS_FILTERS = ["All", "Match", "Not match"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const formatFileSize = (size) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const isAcceptedFile = (file) => {
  const lowerName = file.name.toLowerCase();
  return (
    ACCEPTED_FILE_TYPES.includes(file.type) ||
    ACCEPTED_EXTENSIONS.some((ext) => lowerName.endsWith(ext))
  );
};

const isPdfFile = (file) => file.name.toLowerCase().endsWith(".pdf");

const getErrorMessage = (error) =>
  error instanceof Error ? error.message : String(error);

const normalizeName = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
};

const toDateKey = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
};

const normalizeAmountValue = (value) => Number.parseFloat(value || "0");

const formatCurrencyValue = (value) => {
  const amount = Number.parseFloat(value || "0");
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
};

const formatPercentageValue = (value) => {
  const amount = Number.parseFloat(value || "0");
  return `${amount.toFixed(2)}%`;
};

const areNamesClose = (left, right) => {
  const l = normalizeName(left);
  const r = normalizeName(right);
  if (!l || !r) return false;
  if (l === r || l.includes(r) || r.includes(l)) return true;
  const lw = new Set(l.split(" "));
  const rw = new Set(r.split(" "));
  let overlap = 0;
  for (const w of lw) if (rw.has(w)) overlap++;
  return overlap >= Math.min(2, lw.size, rw.size);
};

const buildReconciliationRows = (bankTransactions, quickbooksTransactions) => {
  const groupedBank = new Map();
  const groupedQB = new Map();
  for (const txn of bankTransactions) {
    const key = toDateKey(txn.date || txn.txn_date);
    const arr = groupedBank.get(key) || [];
    arr.push(txn);
    groupedBank.set(key, arr);
  }
  for (const txn of quickbooksTransactions) {
    const key = toDateKey(txn.date || txn.txn_date);
    const arr = groupedQB.get(key) || [];
    arr.push(txn);
    groupedQB.set(key, arr);
  }
  const dateKeys = Array.from(
    new Set([...groupedBank.keys(), ...groupedQB.keys()]),
  ).sort((a, b) => a.localeCompare(b));
  const rows = [];
  for (const dateKey of dateKeys) {
    const bankItems = [...(groupedBank.get(dateKey) || [])];
    const qbItems = [...(groupedQB.get(dateKey) || [])];
    const usedQB = new Set();
    for (const bankTxn of bankItems) {
      const bankAmt = normalizeAmountValue(bankTxn.amount);
      const exactIdx = qbItems.findIndex((qb, i) => {
        if (usedQB.has(i)) return false;
        return (
          normalizeAmountValue(qb.amount) === bankAmt &&
          areNamesClose(bankTxn.name, qb.name)
        );
      });
      if (exactIdx !== -1) {
        usedQB.add(exactIdx);
        rows.push({
          bank: bankTxn,
          quickbooks: qbItems[exactIdx],
          status: "Match",
        });
        continue;
      }
      const partialIdx = qbItems.findIndex((qb, i) => {
        if (usedQB.has(i)) return false;
        return normalizeAmountValue(qb.amount) === bankAmt;
      });
      if (partialIdx !== -1) {
        usedQB.add(partialIdx);
        rows.push({
          bank: bankTxn,
          quickbooks: qbItems[partialIdx],
          status: "Partially match",
        });
        continue;
      }
      rows.push({ bank: bankTxn, status: "Not match" });
    }
    qbItems.forEach((qb, i) => {
      if (!usedQB.has(i)) rows.push({ quickbooks: qb, status: "Not match" });
    });
  }
  return rows;
};

const getRowDateKey = (row) =>
  toDateKey(row.bank?.date || row.quickbooks?.date || "");
const getRowDateLabel = (row) =>
  normalizeDate(row.bank?.date || row.quickbooks?.date || "");

const isExcelPasswordError = (error) => {
  const msg = getErrorMessage(error).toLowerCase();
  return (
    msg.includes("password") ||
    msg.includes("encrypted") ||
    msg.includes("decrypt")
  );
};

const isPdfTextItem = (item) =>
  item &&
  typeof item === "object" &&
  typeof item.str === "string" &&
  Array.isArray(item.transform) &&
  typeof item.width === "number" &&
  typeof item.hasEOL === "boolean";

const isReconciliationApiResponse = (p) =>
  p &&
  typeof p === "object" &&
  "bank_transactions" in p &&
  "reconciliation_transactions" in p;

const isReconciliationVarianceResponse = (p) =>
  p &&
  typeof p === "object" &&
  "bank_total" in p &&
  "books_total" in p &&
  "variance_amount" in p &&
  "variance_percentage" in p;

const countProfitLossTransactions = (groups = []) =>
  groups.reduce(
    (groupTotal, group) =>
      groupTotal +
      (group?.accounts || []).reduce(
        (accountTotal, account) =>
          accountTotal + (account?.transactions || []).length,
        0,
      ),
    0,
  );

const getRouteNotFoundMessage = (payload) => {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.error === "string") return payload.error;
  if (typeof payload.message === "string") return payload.message;
  return "";
};

const fetchFirstAvailableJson = async (endpoints, headers = {}) => {
  let lastResponse = null;
  let lastPayload = null;
  for (const endpoint of endpoints) {
    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: { ...headers, "Cache-Control": "no-store" },
    });
    const payload = await response.json();
    if (response.ok) return { response, payload };
    lastResponse = response;
    lastPayload = payload;
    const msg = getRouteNotFoundMessage(payload).toLowerCase();
    if (!(response.status === 404 || msg.includes("route not found"))) break;
  }
  if (!lastResponse || !lastPayload)
    throw new Error("No endpoint could be reached.");
  return { response: lastResponse, payload: lastPayload };
};

// ─── PDF reader ───────────────────────────────────────────────────────────────

const buildPdfPageText = (items) => {
  const positioned = items
    .map((item) => ({
      text: item.str,
      x: item.transform[4] ?? 0,
      y: item.transform[5] ?? 0,
      width: item.width ?? 0,
      hasEOL: item.hasEOL,
    }))
    .filter((item) => item.text.trim().length > 0)
    .sort((a, b) => (Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x));
  const lines = [];
  for (const item of positioned) {
    const cur = lines.at(-1);
    if (!cur || Math.abs(cur.y - item.y) > 4) {
      lines.push({
        y: item.y,
        parts: [
          {
            text: item.text,
            x: item.x,
            width: item.width,
            hasEOL: item.hasEOL,
          },
        ],
      });
      continue;
    }
    cur.parts.push({
      text: item.text,
      x: item.x,
      width: item.width,
      hasEOL: item.hasEOL,
    });
  }
  return (
    lines
      .map((line) => {
        const sorted = [...line.parts].sort((a, b) => a.x - b.x);
        let cursorX = 0;
        let content = "";
        for (const part of sorted) {
          const gap = part.x - cursorX;
          if (content.length > 0)
            content += gap > 24 ? "    " : gap > 6 ? " " : "";
          content += part.text;
          cursorX = part.x + part.width;
          if (part.hasEOL) break;
        }
        return content.trimEnd();
      })
      .join("\n")
      .trim() || "No extractable text on this page."
  );
};

const readPdfFile = async (file, password, requestPassword) => {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: buffer, password });
  if (requestPassword) {
    loadingTask.onPassword = async (updatePassword, reason) => {
      const pw = await requestPassword(reason === 1 ? "need" : "incorrect");
      if (pw === null) {
        loadingTask.destroy();
        return;
      }
      updatePassword(pw);
    };
  }
  const pdf = await loadingTask.promise;
  const sections = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const items = textContent.items.filter(isPdfTextItem);
    sections.push({ title: `Page ${pageNum}`, text: buildPdfPageText(items) });
  }
  return sections;
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function WorkspaceReconciliation() {
  const { clientId } = useParams();
  const fileInputRef = useRef(null);
  const passwordResolverRef = useRef(null);

  const [selectedFile, setSelectedFile] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [isReading, setIsReading] = useState(false);
  const [isContentVisible, setIsContentVisible] = useState(false);
  const [fileSections, setFileSections] = useState([]);

  const [reconciliationRows, setReconciliationRows] = useState([]);
  const [varianceData, setVarianceData] = useState(null);
  const [statusFilter, setStatusFilter] = useState("All");
  const [isLoadingReconciliation, setIsLoadingReconciliation] = useState(false);
  const [isLoadingVariance, setIsLoadingVariance] = useState(false);
  const [reconciliationError, setReconciliationError] = useState("");
  const [varianceError, setVarianceError] = useState("");

  const [ledgerStartDate, setLedgerStartDate] = useState("2026-01-01");
  const [ledgerEndDate, setLedgerEndDate] = useState("2026-03-31");
  const [ledgerAccountingMethod, setLedgerAccountingMethod] =
    useState("Accrual");
  const [generalLedgerSync, setGeneralLedgerSync] = useState({
    status: "idle",
    message: "",
  });
  const [balanceSheetStartDate, setBalanceSheetStartDate] =
    useState("2026-01-01");
  const [balanceSheetEndDate, setBalanceSheetEndDate] = useState("2026-03-31");
  const [balanceSheetAccountingMethod, setBalanceSheetAccountingMethod] =
    useState("Accrual");
  const [financialReportsSync, setFinancialReportsSync] = useState({
    status: "idle",
    message: "",
  });

  const [backendUpload, setBackendUpload] = useState({
    status: "idle",
    message: "",
  });
  const [passwordPrompt, setPasswordPrompt] = useState({
    isOpen: false,
    message: "",
    password: "",
  });
  const [aiParsing, setAiParsing] = useState({
    status: "idle",
    message: "",
    bankName: "",
    transactionCount: 0,
  });

  const getHeaders = () => {
    const headers = {};
    if (clientId) headers["X-Client-Id"] = clientId;
    return headers;
  };

  // ─── Password modal ───────────────────────────────────────────────────────

  const handleOpenPicker = () => fileInputRef.current?.click();

  const requestPassword = (reason) =>
    new Promise((resolve) => {
      passwordResolverRef.current = resolve;
      setPasswordPrompt({
        isOpen: true,
        message:
          reason === "incorrect"
            ? "That password was incorrect. Please enter the correct password."
            : "This file is password protected. Enter the password to open it.",
        password: "",
      });
    });

  const closePasswordPrompt = () =>
    setPasswordPrompt({ isOpen: false, message: "", password: "" });

  const resolvePasswordPrompt = (password) => {
    const resolver = passwordResolverRef.current;
    passwordResolverRef.current = null;
    closePasswordPrompt();
    resolver?.(password);
  };

  // ─── Data loaders ─────────────────────────────────────────────────────────

  const loadReconciliationData = async () => {
    setIsLoadingReconciliation(true);
    setReconciliationError("");
    try {
      const { response, payload } = await fetchFirstAvailableJson(
        RECONCILIATION_DATA_ENDPOINTS,
        getHeaders(),
      );
      if (!response.ok)
        throw new Error(
          payload?.error || "Failed to load reconciliation data.",
        );
      if (!isReconciliationApiResponse(payload))
        throw new Error("Invalid reconciliation data response.");
      setReconciliationRows(
        buildReconciliationRows(
          payload.bank_transactions,
          payload.reconciliation_transactions,
        ),
      );
    } catch (error) {
      console.error("Reconciliation load error:", error);
      setReconciliationError(getErrorMessage(error));
      setReconciliationRows([]);
    } finally {
      setIsLoadingReconciliation(false);
    }
  };

  const loadVarianceData = async () => {
    setIsLoadingVariance(true);
    setVarianceError("");
    try {
      const { response, payload } = await fetchFirstAvailableJson(
        RECONCILIATION_VARIANCE_ENDPOINTS,
        getHeaders(),
      );
      if (!response.ok)
        throw new Error(payload?.error || "Failed to load variance.");
      if (!isReconciliationVarianceResponse(payload))
        throw new Error("Invalid variance response.");
      setVarianceData(payload);
    } catch (error) {
      console.error("Variance load error:", error);
      setVarianceError(getErrorMessage(error));
      setVarianceData(null);
    } finally {
      setIsLoadingVariance(false);
    }
  };

  useEffect(() => {
    void loadReconciliationData();
    void loadVarianceData();
  }, []);

  const loadGeneralLedger = async () => {
    setGeneralLedgerSync({
      status: "loading",
      message: "Fetching QuickBooks general ledger...",
    });
    try {
      const params = new URLSearchParams({
        start_date: ledgerStartDate,
        end_date: ledgerEndDate,
        accounting_method: ledgerAccountingMethod,
      });
      const response = await fetch(`${QB_GENERAL_LEDGER_ENDPOINT}?${params}`, {
        cache: "no-store",
        headers: getHeaders(),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error || "Failed to fetch general ledger.");
      setGeneralLedgerSync({
        status: "success",
        message:
          payload.message && payload.totalInserted !== undefined
            ? `${payload.message} (${payload.totalInserted} records)`
            : payload.message || "General ledger fetched successfully.",
      });
      await loadReconciliationData();
      await loadVarianceData();
    } catch (error) {
      console.error("General ledger error:", error);
      setGeneralLedgerSync({
        status: "error",
        message: getErrorMessage(error),
      });
    }
  };

  const loadFinancialReports = async () => {
    setFinancialReportsSync({
      status: "loading",
      message: "Fetching Profit & Loss Detail and Balance Sheet...",
    });
    try {
      const params = new URLSearchParams({
        start_date: balanceSheetStartDate,
        end_date: balanceSheetEndDate,
        accounting_method: balanceSheetAccountingMethod,
      });
      const response = await fetch(
        `${QB_FINANCIAL_REPORTS_ENDPOINT}?${params}`,
        { cache: "no-store", headers: getHeaders() },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          payload?.error ||
            payload?.message ||
            "Failed to fetch financial reports.",
        );
      const parsedProfitLoss = parseDetailReport(
        payload?.profit_and_loss ?? {},
      );
      const profitLossTransactions = countProfitLossTransactions(
        parsedProfitLoss.groups,
      );
      setFinancialReportsSync({
        status: "success",
        message:
          profitLossTransactions > 0
            ? `Loaded ${profitLossTransactions} Profit & Loss Detail transactions and the Balance Sheet.`
            : "Loaded Profit & Loss Detail and Balance Sheet successfully.",
      });
    } catch (error) {
      console.error("Financial reports error:", error);
      setFinancialReportsSync({
        status: "error",
        message: getErrorMessage(error),
      });
    }
  };

  // ─── Upload to backend ────────────────────────────────────────────────────
  //
  // KEY CHANGE: for XLS/XLSX files, sections may already carry `transactions`
  // (directlyParsed === true). We use those directly and SKIP the AI call.
  // For PDFs and unrecognized XLS formats, we fall through to AI parsing.

  const uploadToBackend = async (file, sections) => {
    const fullText = sections.map((s) => s.text).join("\n");

    // ── Fast path: XLS/XLSX was directly parsed (no AI needed) ─────────────
    const directTransactions = sections
      .filter((s) => s.directlyParsed && Array.isArray(s.transactions))
      .flatMap((s) => s.transactions);

    const detectedBank =
      sections.find((s) => s.bankFormat)?.bankFormat ||
      detectBankName(fullText);

    let normalizedTransactions = [];
    let finalBankName = detectedBank;

    if (directTransactions.length > 0) {
      normalizedTransactions = directTransactions;
      setAiParsing({
        status: "success",
        message: `${finalBankName || "Bank"} statement parsed directly — ${normalizedTransactions.length} transaction${normalizedTransactions.length !== 1 ? "s" : ""} found (no AI needed).`,
        bankName: finalBankName,
        transactionCount: normalizedTransactions.length,
      });
    } else {
      // ── AI path: PDF or unrecognized XLS format ─────────────────────────
      setAiParsing({
        status: "parsing",
        message: detectedBank
          ? `Detected ${detectedBank} — parsing all transactions with AI...`
          : "Detecting bank format and parsing all transactions with AI...",
        bankName: detectedBank,
        transactionCount: 0,
      });

      try {
        const result = await parseAllSections(
          sections,
          (progressMessage) => {
            setAiParsing((prev) => ({ ...prev, message: progressMessage }));
          },
          getHeaders(),
        );
        normalizedTransactions = result.transactions;
        finalBankName = result.bankName || detectedBank;
        if (
          normalizedTransactions.length === 0 &&
          result.parseErrors.length > 0
        ) {
          throw new Error(
            "AI could not extract transactions: " +
              result.parseErrors.join("; "),
          );
        }
        setAiParsing({
          status: "success",
          message: `${finalBankName || "Bank"} statement parsed — ${normalizedTransactions.length} transaction${normalizedTransactions.length !== 1 ? "s" : ""} found.`,
          bankName: finalBankName,
          transactionCount: normalizedTransactions.length,
        });
      } catch (aiError) {
        console.error("AI parsing failed:", aiError);
        setAiParsing({
          status: "error",
          message: `AI parsing failed: ${aiError.message}. Uploading raw file as fallback.`,
          bankName: finalBankName,
          transactionCount: 0,
        });
      }
    }

    // ── Step 2: Upload to backend ─────────────────────────────────────────
    setBackendUpload({
      status: "uploading",
      message: "Sending to backend for processing...",
    });
    try {
      let response;
      const headers = getHeaders();

      if (normalizedTransactions.length > 0) {
        response = await fetch(BANK_STATEMENT_UPLOAD_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({
            type: "normalized",
            fileName: file.name,
            bankName: finalBankName || "Unknown",
            transactions: normalizedTransactions,
            rawText: fullText.slice(0, 5000),
          }),
        });
      } else {
        if (isPdfFile(file)) {
          response = await fetch(BANK_STATEMENT_UPLOAD_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify({
              type: "pdf",
              fileName: file.name,
              text: fullText,
            }),
          });
        } else {
          // For raw Excel files: send FormData without explicit Content-Type
          // The browser will automatically set Content-Type: multipart/form-data
          const formData = new FormData();
          formData.append("file", file);

          // Build URL with clientId as query param for extra reliability
          let uploadUrl = BANK_STATEMENT_UPLOAD_ENDPOINT;
          if (clientId) {
            uploadUrl += `?clientId=${encodeURIComponent(clientId)}`;
          }

          response = await fetch(uploadUrl, {
            method: "POST",
            headers: headers,
            body: formData,
          });
        }
      }

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const errorMsg =
          payload?.error || payload?.message || `HTTP ${response.status}`;
        throw new Error(errorMsg);
      }

      setBackendUpload({
        status: "success",
        message:
          payload?.message && payload?.totalRecords !== undefined
            ? `${payload.message} (${payload.totalRecords} records)`
            : payload?.message || "Uploaded successfully.",
      });
    } catch (uploadError) {
      setBackendUpload({
        status: "error",
        message: getErrorMessage(uploadError),
      });
      throw uploadError;
    }
  };

  // ─── File processing ──────────────────────────────────────────────────────

  const processFile = async (file) => {
    setSelectedFile(file);
    setErrorMessage("");
    setFileSections([]);
    setIsContentVisible(false);
    setBackendUpload({ status: "idle", message: "" });
    setAiParsing({
      status: "idle",
      message: "",
      bankName: "",
      transactionCount: 0,
    });
    setIsReading(true);

    const requestPasswordForFile = async (reason) =>
      await requestPassword(reason);

    const tryProcess = async (password) => {
      const sections = isPdfFile(file)
        ? await readPdfFile(file, password, requestPasswordForFile)
        : await readExcelFile(file, password);
      setFileSections(sections);
      await uploadToBackend(file, sections);
      await loadReconciliationData();
      await loadVarianceData();
    };

    try {
      await tryProcess(undefined);
    } catch (error) {
      if (!isPdfFile(file) && isExcelPasswordError(error)) {
        const password = await requestPasswordForFile("need");
        if (password === null) {
          setErrorMessage("Password entry was cancelled.");
          setIsReading(false);
          return;
        }
        try {
          await tryProcess(password);
          setIsReading(false);
          return;
        } catch (pwError) {
          if (isExcelPasswordError(pwError)) {
            const retryPw = await requestPasswordForFile("incorrect");
            if (retryPw === null) {
              setErrorMessage("Password entry was cancelled.");
              setIsReading(false);
              return;
            }
            try {
              await tryProcess(retryPw);
              setIsReading(false);
              return;
            } catch (retryErr) {
              setErrorMessage(
                getErrorMessage(retryErr) || "Incorrect password.",
              );
              setIsReading(false);
              return;
            }
          }
          throw pwError;
        }
      }
      console.error("File processing error:", error);
      setFileSections([]);
      setErrorMessage(
        getErrorMessage(error) || "The selected file could not be read.",
      );
      setBackendUpload({ status: "error", message: "" });
    } finally {
      setIsReading(false);
    }
  };

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!isAcceptedFile(file)) {
      setSelectedFile(null);
      setFileSections([]);
      setErrorMessage("Only PDF, XLS, and XLSX files are allowed.");
      event.target.value = "";
      return;
    }
    await processFile(file);
  };

  const handleClearFile = () => {
    if (passwordResolverRef.current) {
      passwordResolverRef.current(null);
      passwordResolverRef.current = null;
    }
    setSelectedFile(null);
    setErrorMessage("");
    setFileSections([]);
    setIsContentVisible(false);
    setIsReading(false);
    setBackendUpload({ status: "idle", message: "" });
    setAiParsing({
      status: "idle",
      message: "",
      bankName: "",
      transactionCount: 0,
    });
    closePasswordPrompt();
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ─── Derived state ────────────────────────────────────────────────────────

  const filteredRows =
    statusFilter === "All"
      ? reconciliationRows
      : reconciliationRows.filter((r) => r.status === statusFilter);

  const groupedRows = filteredRows.reduce((groups, row) => {
    const dateKey = getRowDateKey(row);
    const dateLabel = getRowDateLabel(row);
    const prev = groups.at(-1);
    if (!prev || prev.dateKey !== dateKey) {
      groups.push({ dateKey, dateLabel, rows: [row] });
    } else {
      prev.rows.push(row);
    }
    return groups;
  }, []);

  const SelectedFileIcon = selectedFile?.name.toLowerCase().endsWith(".pdf")
    ? FileText
    : FileSpreadsheet;

  // ─── Render ───────────────────────────────────────────────────────────────

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

        {/* ── QuickBooks General Ledger ── */}
        <section className="card-base w-full p-5">
          <h2 className="text-[18px] font-semibold text-text-primary">
            QuickBooks General Ledger
          </h2>
          <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr_220px_auto]">
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                Start Date
              </label>
              <input
                type="date"
                value={ledgerStartDate}
                onChange={(e) => setLedgerStartDate(e.target.value)}
                className="input-base h-10"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                End Date
              </label>
              <input
                type="date"
                value={ledgerEndDate}
                onChange={(e) => setLedgerEndDate(e.target.value)}
                className="input-base h-10"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                Accounting Type
              </label>
              <select
                value={ledgerAccountingMethod}
                onChange={(e) => setLedgerAccountingMethod(e.target.value)}
                className="input-base h-10"
              >
                <option value="Accrual">Accrual</option>
                <option value="Cash">Cash</option>
              </select>
            </div>
            <div className="flex items-end">
              <button
                type="button"
                className="btn-primary w-full"
                onClick={() => void loadGeneralLedger()}
                disabled={generalLedgerSync.status === "loading"}
              >
                {generalLedgerSync.status === "loading" ? (
                  <LoaderCircle size={16} className="animate-spin" />
                ) : (
                  <RefreshCw size={16} />
                )}
                Fetch Ledger
              </button>
            </div>
          </div>
          {generalLedgerSync.status !== "idle" && (
            <div
              className={cn(
                "mt-3 flex items-center gap-2 rounded-lg border bg-white px-4 py-2.5 text-[13px]",
                generalLedgerSync.status === "error"
                  ? "border-negative/20 text-negative"
                  : generalLedgerSync.status === "success"
                    ? "border-primary/20 text-primary"
                    : "border-border text-text-secondary",
              )}
            >
              {generalLedgerSync.status === "loading" ? (
                <LoaderCircle size={16} className="animate-spin" />
              ) : generalLedgerSync.status === "error" ? (
                <AlertCircle size={16} />
              ) : (
                <CheckCircle2 size={16} />
              )}
              {generalLedgerSync.message}
            </div>
          )}
        </section>

        {/* ── Reconciliation Financial Reports ── */}
        <section className="card-base w-full p-5">
          <h2 className="text-[18px] font-semibold text-text-primary">
            Reconciliation Financial Reports
          </h2>
          <p className="mt-1 text-[13px] text-text-secondary">
            Fetch Profit & Loss Detail and Balance Sheet together for the same
            period.
          </p>
          <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr_220px_auto]">
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                Start Date
              </label>
              <input
                type="date"
                value={balanceSheetStartDate}
                onChange={(e) => setBalanceSheetStartDate(e.target.value)}
                className="input-base h-10"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                End Date
              </label>
              <input
                type="date"
                value={balanceSheetEndDate}
                onChange={(e) => setBalanceSheetEndDate(e.target.value)}
                className="input-base h-10"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                Accounting Type
              </label>
              <select
                value={balanceSheetAccountingMethod}
                onChange={(e) =>
                  setBalanceSheetAccountingMethod(e.target.value)
                }
                className="input-base h-10"
              >
                <option value="Accrual">Accrual</option>
                <option value="Cash">Cash</option>
              </select>
            </div>
            <div className="flex items-end">
              <button
                type="button"
                className="btn-primary w-full"
                onClick={() => void loadFinancialReports()}
                disabled={financialReportsSync.status === "loading"}
              >
                {financialReportsSync.status === "loading" ? (
                  <LoaderCircle size={16} className="animate-spin" />
                ) : (
                  <RefreshCw size={16} />
                )}
                Fetch Financial Reports
              </button>
            </div>
          </div>
          {financialReportsSync.status !== "idle" && (
            <div
              className={cn(
                "mt-3 flex items-center gap-2 rounded-lg border bg-white px-4 py-2.5 text-[13px]",
                financialReportsSync.status === "error"
                  ? "border-negative/20 text-negative"
                  : financialReportsSync.status === "success"
                    ? "border-primary/20 text-primary"
                    : "border-border text-text-secondary",
              )}
            >
              {financialReportsSync.status === "loading" ? (
                <LoaderCircle size={16} className="animate-spin" />
              ) : financialReportsSync.status === "error" ? (
                <AlertCircle size={16} />
              ) : (
                <CheckCircle2 size={16} />
              )}
              {financialReportsSync.message}
            </div>
          )}
        </section>

        {/* ── File Upload ── */}
        <section className="card-base card-p w-full">
          <div className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
            <div
              className={cn(
                "flex h-full flex-col justify-center rounded-2xl border border-dashed p-8 transition-colors",
                errorMessage
                  ? "border-negative bg-red-50/60"
                  : "border-border bg-bg-page/60",
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.xls,.xlsx,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={handleFileChange}
              />
              <div className="flex flex-col items-start gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Upload size={24} />
                </div>
                <div className="space-y-1">
                  <h2 className="text-[20px] font-semibold text-text-primary">
                    Choose a PDF or Excel file
                  </h2>
                  {/* <p className="text-[13px] text-text-muted">
                    Works with any bank — SBI, HDFC, ICICI, Axis, Kotak, Chase,
                    HSBC and more. Structured Excel files are parsed instantly;
                    PDFs use AI.
                  </p> */}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button onClick={handleOpenPicker} className="btn-primary">
                    <Upload size={16} />
                    Select File
                  </button>
                  {fileSections.length > 0 && (
                    <button
                      onClick={() => setIsContentVisible((v) => !v)}
                      className="btn-secondary"
                    >
                      <FileText size={16} />
                      {isContentVisible ? "Hide Content" : "View Content"}
                    </button>
                  )}
                  {selectedFile && (
                    <button onClick={handleClearFile} className="btn-secondary">
                      <X size={16} />
                      Remove File
                    </button>
                  )}
                </div>

                {errorMessage && (
                  <div className="flex items-center gap-2 rounded-lg border border-negative/20 bg-white px-4 py-3 text-[14px] text-negative">
                    <AlertCircle size={16} />
                    {errorMessage}
                  </div>
                )}
                {isReading && (
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-white px-4 py-3 text-[14px] text-text-secondary">
                    <LoaderCircle size={16} className="animate-spin" />
                    Reading file — extracting all pages/rows...
                  </div>
                )}
                {aiParsing.status !== "idle" && (
                  <div
                    className={cn(
                      "flex items-center gap-2 rounded-lg border bg-white px-4 py-3 text-[14px]",
                      aiParsing.status === "error"
                        ? "border-negative/20 text-negative"
                        : aiParsing.status === "success"
                          ? "border-primary/20 text-primary"
                          : "border-border text-text-secondary",
                    )}
                  >
                    {aiParsing.status === "parsing" ? (
                      <LoaderCircle size={16} className="animate-spin" />
                    ) : aiParsing.status === "error" ? (
                      <AlertCircle size={16} />
                    ) : (
                      <BrainCircuit size={16} />
                    )}
                    {aiParsing.message}
                  </div>
                )}
                {backendUpload.status !== "idle" && (
                  <div
                    className={cn(
                      "flex items-center gap-2 rounded-lg border bg-white px-4 py-3 text-[14px]",
                      backendUpload.status === "error"
                        ? "border-negative/20 text-negative"
                        : backendUpload.status === "success"
                          ? "border-primary/20 text-primary"
                          : "border-border text-text-secondary",
                    )}
                  >
                    {backendUpload.status === "uploading" ? (
                      <LoaderCircle size={16} className="animate-spin" />
                    ) : backendUpload.status === "error" ? (
                      <AlertCircle size={16} />
                    ) : (
                      <FileJson size={16} />
                    )}
                    {backendUpload.message}
                  </div>
                )}
              </div>
            </div>

            {/* Summary panel */}
            <div className="flex h-full flex-col rounded-2xl border border-border bg-bg-page/60 p-6">
              <h3 className="text-[16px] font-semibold text-text-primary">
                Upload Summary
              </h3>
              {selectedFile ? (
                <div className="mt-5 space-y-4">
                  <div className="flex items-start gap-3 rounded-xl bg-bg-card p-4 shadow-sm">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <SelectedFileIcon size={20} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-semibold text-text-primary">
                        {selectedFile.name}
                      </p>
                      <p className="text-[13px] text-text-secondary">
                        {formatFileSize(selectedFile.size)}
                      </p>
                    </div>
                  </div>
                  <div className="space-y-3 text-[14px] text-text-secondary">
                    <div className="flex items-center justify-between gap-3">
                      <span>Detected type</span>
                      <span className="font-medium text-text-primary">
                        {isPdfFile(selectedFile)
                          ? "PDF Document"
                          : "Excel Workbook"}
                      </span>
                    </div>
                    {aiParsing.bankName && (
                      <div className="flex items-center justify-between gap-3">
                        <span>Detected bank</span>
                        <span className="flex items-center gap-1.5 font-medium text-text-primary">
                          <Building2 size={14} />
                          {aiParsing.bankName}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-3">
                      <span>Parse method</span>
                      <span className="font-medium text-text-primary">
                        {fileSections.some((s) => s.directlyParsed)
                          ? "Direct (no AI)"
                          : isPdfFile(selectedFile)
                            ? "AI (PDF)"
                            : "AI (fallback)"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Status</span>
                      <span className="font-medium text-primary">
                        {isReading
                          ? "Reading all content..."
                          : aiParsing.status === "parsing"
                            ? "AI parsing transactions..."
                            : backendUpload.status === "uploading"
                              ? "Uploading to backend"
                              : backendUpload.status === "success"
                                ? "Uploaded to backend"
                                : "Content extracted"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Sections / pages</span>
                      <span className="font-medium text-text-primary">
                        {fileSections.length}
                      </span>
                    </div>
                    {fileSections.length > 0 && (
                      <div className="flex items-center justify-between gap-3">
                        <span>Total rows in file</span>
                        <span className="font-medium text-text-primary">
                          {fileSections.reduce(
                            (sum, s) => sum + (s.rowCount ?? 0),
                            0,
                          ) || "—"}
                        </span>
                      </div>
                    )}
                    {aiParsing.status === "success" &&
                      aiParsing.transactionCount > 0 && (
                        <div className="flex items-center justify-between gap-3">
                          <span>Transactions parsed</span>
                          <span className="font-bold text-primary">
                            {aiParsing.transactionCount}
                          </span>
                        </div>
                      )}
                  </div>
                  {isContentVisible && fileSections.length > 0 && (
                    <div className="max-h-[420px] space-y-3 overflow-y-auto pr-1">
                      {fileSections.map((section, index) => (
                        <div
                          key={`${section.title}-${index}`}
                          className="rounded-xl border border-border bg-white p-4"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <h4 className="text-[14px] font-semibold text-text-primary">
                              {section.title}
                            </h4>
                            {section.rowCount !== undefined && (
                              <span className="text-[12px] text-text-muted">
                                {section.rowCount} rows
                              </span>
                            )}
                          </div>
                          <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-[12px] leading-5 text-text-secondary">
                            {section.text}
                          </pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="mt-5 text-[14px] text-text-muted">
                  No file selected yet. Attach a PDF or Excel bank statement —
                  any bank format is supported.
                </p>
              )}
            </div>
          </div>
        </section>

        {/* ── Variance Summary ── */}
        <section className="card-base card-p w-full">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-[18px] font-semibold text-text-primary">
                Variance Summary
              </h2>
              <p className="text-[14px] text-text-secondary">
                Bank versus books totals and current variance percentage.
              </p>
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void loadVarianceData()}
              disabled={isLoadingVariance}
            >
              {isLoadingVariance ? (
                <LoaderCircle size={16} className="animate-spin" />
              ) : (
                <RefreshCw size={16} />
              )}
              Refresh Variance
            </button>
          </div>
          {varianceError && (
            <div className="mt-6 flex items-center gap-2 rounded-lg border border-negative/20 bg-white px-4 py-3 text-[14px] text-negative">
              <AlertCircle size={16} />
              {varianceError}
            </div>
          )}
          {isLoadingVariance ? (
            <div className="mt-6 flex items-center gap-2 rounded-lg border border-border bg-bg-page/40 px-4 py-5 text-[14px] text-text-secondary">
              <LoaderCircle size={16} className="animate-spin" />
              Loading variance summary...
            </div>
          ) : varianceData ? (
            <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {[
                {
                  label: "Bank Statement Total",
                  value: formatCurrencyValue(varianceData.bank_total),
                },
                {
                  label: "QuickBooks General Ledger Total",
                  value: formatCurrencyValue(varianceData.books_total),
                },
                {
                  label: "Variance Amount",
                  value: formatCurrencyValue(varianceData.variance_amount),
                },
                {
                  label: "Variance %",
                  value: formatPercentageValue(
                    varianceData.variance_percentage,
                  ),
                },
              ].map(({ label, value }) => (
                <div
                  key={label}
                  className="rounded-2xl border border-border bg-bg-card p-5"
                >
                  <p className="text-[13px] font-medium text-text-secondary">
                    {label}
                  </p>
                  <p className="mt-2 text-[28px] font-bold text-text-primary">
                    {value}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-6 rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-[14px] text-text-muted">
              No variance data available.
            </div>
          )}
        </section>

        {/* ── Reconciliation Table ── */}
        <section className="card-base card-p w-full">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-[18px] font-semibold text-text-primary">
                Reconciliation Data
              </h2>
              <p className="text-[14px] text-text-secondary">
                Bank statement transactions matched against QuickBooks
                transactions.
              </p>
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void loadReconciliationData()}
              disabled={isLoadingReconciliation}
            >
              {isLoadingReconciliation ? (
                <LoaderCircle size={16} className="animate-spin" />
              ) : (
                <RefreshCw size={16} />
              )}
              Refresh Data
            </button>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <span className="text-[14px] font-medium text-text-secondary">
              Status Filter
            </span>
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter}
                type="button"
                className={cn(
                  "rounded-full border px-4 py-2 text-[13px] font-semibold transition-colors",
                  statusFilter === filter
                    ? "border-primary bg-primary text-white"
                    : "border-border bg-bg-card text-text-secondary hover:bg-bg-page",
                )}
                onClick={() => setStatusFilter(filter)}
              >
                {filter}
              </button>
            ))}
          </div>

          {reconciliationError && (
            <div className="mt-6 flex items-center gap-2 rounded-lg border border-negative/20 bg-white px-4 py-3 text-[14px] text-negative">
              <AlertCircle size={16} />
              {reconciliationError}
            </div>
          )}

          <div className="mt-6 overflow-x-auto rounded-xl border border-border bg-bg-card">
            <table className="min-w-full border-collapse">
              <thead>
                <tr className="bg-bg-page/80">
                  <th
                    rowSpan={2}
                    className="border-b border-r border-border px-3 py-4 text-left text-[14px] font-semibold text-text-primary"
                  >
                    Day
                  </th>
                  <th
                    colSpan={3}
                    className="border-b border-r border-border px-3 py-4 text-left text-[14px] font-semibold text-text-primary"
                  >
                    Bank Statement
                  </th>
                  <th
                    colSpan={3}
                    className="border-b border-r border-border px-3 py-4 text-left text-[14px] font-semibold text-text-primary"
                  >
                    QuickBooks Transactions
                  </th>
                  <th className="border-b border-border px-3 py-4 text-left text-[14px] font-semibold text-text-primary">
                    Status
                  </th>
                </tr>
                <tr className="bg-bg-page/40">
                  {[
                    "Date",
                    "Name",
                    "Amount",
                    "Date",
                    "Name",
                    "Amount",
                    "Status",
                  ].map((h, i) => (
                    <th
                      key={`${h}-${i}`}
                      className={cn(
                        "border-b border-border px-3 py-3 text-left text-[14px] font-semibold text-text-primary",
                        i < 6 ? "border-r" : "",
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoadingReconciliation ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-4 py-8 text-center text-[14px] text-text-secondary"
                    >
                      Loading reconciliation data...
                    </td>
                  </tr>
                ) : groupedRows.length > 0 ? (
                  groupedRows.map((group, groupIndex) =>
                    group.rows.map((row, rowIndex) => (
                      <tr
                        key={`${group.dateKey}-${rowIndex}`}
                        className={cn(
                          groupIndex % 2 === 0
                            ? "bg-primary/5"
                            : "bg-slate-100/60",
                        )}
                      >
                        {rowIndex === 0 && (
                          <td
                            rowSpan={group.rows.length}
                            className={cn(
                              "border-b border-r border-border px-3 py-3 align-top text-[14px] font-semibold text-text-primary",
                              groupIndex % 2 === 0
                                ? "bg-primary/10"
                                : "bg-slate-100",
                            )}
                          >
                            <div className="sticky top-0">
                              {group.dateLabel}
                            </div>
                          </td>
                        )}
                        <td className="border-b border-r border-border px-3 py-3 align-top text-[14px] text-text-primary">
                          {row.bank ? normalizeDate(row.bank.date) : ""}
                        </td>
                        <td className="border-b border-r border-border px-3 py-3 align-top text-[14px] text-text-primary">
                          <div className="max-w-[260px] whitespace-pre-wrap break-words">
                            {row.bank?.name || ""}
                          </div>
                        </td>
                        <td className="border-b border-r border-border px-3 py-3 align-top text-[14px] font-medium text-text-primary">
                          {row.bank?.amount !== undefined
                            ? row.bank.amount
                            : ""}
                        </td>
                        <td className="border-b border-r border-border px-3 py-3 align-top text-[14px] text-text-primary">
                          {row.quickbooks
                            ? normalizeDate(row.quickbooks.date)
                            : ""}
                        </td>
                        <td className="border-b border-r border-border px-3 py-3 align-top text-[14px] text-text-primary">
                          <div className="max-w-[260px] whitespace-pre-wrap break-words">
                            {row.quickbooks?.name || ""}
                          </div>
                        </td>
                        <td className="border-b border-r border-border px-3 py-3 align-top text-[14px] font-medium text-text-primary">
                          {row.quickbooks?.amount !== undefined
                            ? row.quickbooks.amount
                            : ""}
                        </td>
                        <td className="border-b border-border px-3 py-3 align-top">
                          <span
                            className={cn(
                              "inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12px] font-semibold",
                              row.status === "Match"
                                ? "bg-primary/10 text-primary"
                                : row.status === "Partially match"
                                  ? "bg-[#F68C1F]/10 text-[#F68C1F]"
                                  : "bg-negative/10 text-negative",
                            )}
                          >
                            {row.status === "Match" ? (
                              <CheckCircle2 size={14} />
                            ) : (
                              <AlertCircle size={14} />
                            )}
                            {row.status}
                          </span>
                        </td>
                      </tr>
                    )),
                  )
                ) : (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-4 py-8 text-center text-[14px] text-text-secondary"
                    >
                      No reconciliation rows for the selected filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* ── Password Modal ── */}
      {passwordPrompt.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-bg-card p-6 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <LockKeyhole size={20} />
              </div>
              <div className="flex-1">
                <h2 className="text-[18px] font-semibold text-text-primary">
                  Enter File Password
                </h2>
                <p className="mt-2 text-[14px] text-text-secondary">
                  {passwordPrompt.message}
                </p>
              </div>
            </div>
            <div className="mt-5">
              <input
                type="password"
                value={passwordPrompt.password}
                autoFocus
                onChange={(e) =>
                  setPasswordPrompt((cur) => ({
                    ...cur,
                    password: e.target.value,
                  }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter")
                    resolvePasswordPrompt(passwordPrompt.password);
                }}
                placeholder="Enter password"
                className="input-base"
              />
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => resolvePasswordPrompt(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => resolvePasswordPrompt(passwordPrompt.password)}
              >
                Open File
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

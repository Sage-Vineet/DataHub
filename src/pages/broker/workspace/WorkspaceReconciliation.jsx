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
  Search,
  Filter,
} from "lucide-react";
import QBDisconnectedBanner from "../../../components/common/QBDisconnectedBanner";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";
const BANK_STATEMENT_UPLOAD_ENDPOINT = `${API_BASE_URL}/upload-bank-statement`;
const RECONCILIATION_DATA_ENDPOINTS = [`${API_BASE_URL}/reconciliation-data`];
const RECONCILIATION_VARIANCE_ENDPOINTS = [
  `${API_BASE_URL}/reconciliation-variance`,
];
const QB_GENERAL_LEDGER_ENDPOINT = `${API_BASE_URL}/qb-general-ledger`;

const ACCEPTED_FILE_TYPES = [
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

const ACCEPTED_EXTENSIONS = [".pdf", ".xls", ".xlsx"];
const STATUS_FILTERS = ["All", "Match", "Partially match", "Not match"];

// --- Helpers ---

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
  if (Number.isNaN(date.getTime())) return value;

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
  const leftNormalized = normalizeName(left);
  const rightNormalized = normalizeName(right);

  if (!leftNormalized || !rightNormalized) return false;

  if (
    leftNormalized === rightNormalized ||
    leftNormalized.includes(rightNormalized) ||
    rightNormalized.includes(leftNormalized)
  ) {
    return true;
  }

  const leftWords = new Set(leftNormalized.split(" "));
  const rightWords = new Set(rightNormalized.split(" "));
  let overlap = 0;

  for (const word of leftWords) {
    if (rightWords.has(word)) overlap += 1;
  }

  return overlap >= Math.min(2, leftWords.size, rightWords.size);
};

const buildReconciliationRows = (bankTransactions, quickbooksTransactions) => {
  const groupedBankTransactions = new Map();
  const groupedQuickbooksTransactions = new Map();

  for (const transaction of bankTransactions) {
    const dateKey = toDateKey(transaction.date || transaction.txn_date);
    const existing = groupedBankTransactions.get(dateKey) || [];
    existing.push(transaction);
    groupedBankTransactions.set(dateKey, existing);
  }

  for (const transaction of quickbooksTransactions) {
    const dateKey = toDateKey(transaction.date || transaction.txn_date);
    const existing = groupedQuickbooksTransactions.get(dateKey) || [];
    existing.push(transaction);
    groupedQuickbooksTransactions.set(dateKey, existing);
  }

  const orderedDateKeys = Array.from(
    new Set([
      ...groupedBankTransactions.keys(),
      ...groupedQuickbooksTransactions.keys(),
    ]),
  ).sort((left, right) => left.localeCompare(right));

  const rows = [];

  for (const dateKey of orderedDateKeys) {
    const bankItems = [...(groupedBankTransactions.get(dateKey) || [])];
    const quickbooksItems = [
      ...(groupedQuickbooksTransactions.get(dateKey) || []),
    ];
    const usedQuickbooks = new Set();

    for (const bankTransaction of bankItems) {
      const bankAmount = normalizeAmountValue(bankTransaction.amount);

      const exactMatchIndex = quickbooksItems.findIndex(
        (quickbooksTxn, index) => {
          if (usedQuickbooks.has(index)) {
            return false;
          }

          return (
            normalizeAmountValue(quickbooksTxn.amount) === bankAmount &&
            areNamesClose(bankTransaction.name, quickbooksTxn.name)
          );
        },
      );

      if (exactMatchIndex !== -1) {
        usedQuickbooks.add(exactMatchIndex);
        rows.push({
          bank: bankTransaction,
          quickbooks: quickbooksItems[exactMatchIndex],
          status: "Match",
        });
        continue;
      }

      const partialMatchIndex = quickbooksItems.findIndex(
        (quickbooksTxn, index) => {
          if (usedQuickbooks.has(index)) {
            return false;
          }

          return normalizeAmountValue(quickbooksTxn.amount) === bankAmount;
        },
      );

      if (partialMatchIndex !== -1) {
        usedQuickbooks.add(partialMatchIndex);
        rows.push({
          bank: bankTransaction,
          quickbooks: quickbooksItems[partialMatchIndex],
          status: "Partially match",
        });
        continue;
      }

      rows.push({
        bank: bankTransaction,
        status: "Not match",
      });
    }

    quickbooksItems.forEach((quickbooksTxn, index) => {
      if (usedQuickbooks.has(index)) {
        return;
      }

      rows.push({
        quickbooks: quickbooksTxn,
        status: "Not match",
      });
    });
  }

  return rows;
};

const getRowDateKey = (row) =>
  toDateKey(row.bank?.date || row.quickbooks?.date || "");
const getRowDateLabel = (row) =>
  normalizeDate(row.bank?.date || row.quickbooks?.date || "");

const isExcelPasswordError = (error) => {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("password") ||
    message.includes("encrypted") ||
    message.includes("decrypt")
  );
};

const isPdfTextItem = (item) => {
  if (!item || typeof item !== "object") {
    return false;
  }

  return (
    typeof item.str === "string" &&
    Array.isArray(item.transform) &&
    typeof item.width === "number" &&
    typeof item.hasEOL === "boolean"
  );
};

const isReconciliationApiResponse = (payload) =>
  payload &&
  typeof payload === "object" &&
  "bank_transactions" in payload &&
  "reconciliation_transactions" in payload;

const isReconciliationVarianceResponse = (payload) =>
  payload &&
  typeof payload === "object" &&
  "bank_total" in payload &&
  "books_total" in payload &&
  "variance_amount" in payload &&
  "variance_percentage" in payload;

const getRouteNotFoundMessage = (payload) => {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  if ("error" in payload && typeof payload.error === "string") {
    return payload.error;
  }

  if ("message" in payload && typeof payload.message === "string") {
    return payload.message;
  }

  return "";
};

const fetchFirstAvailableJson = async (endpoints, headers = {}) => {
  let lastResponse = null;
  let lastPayload = null;

  for (const endpoint of endpoints) {
    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: {
        ...headers,
        "Cache-Control": "no-store",
      },
    });
    const payload = await response.json();

    if (response.ok) {
      return { response, payload };
    }

    lastResponse = response;
    lastPayload = payload;

    const routeMessage = getRouteNotFoundMessage(payload).toLowerCase();
    const isRouteNotFound =
      response.status === 404 || routeMessage.includes("route not found");

    if (!isRouteNotFound) {
      break;
    }
  }

  if (!lastResponse || !lastPayload) {
    throw new Error("No reconciliation endpoint could be reached.");
  }

  return { response: lastResponse, payload: lastPayload };
};

const readExcelFile = async (file, password) => {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", password });

  return workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
    });
    const previewRows = rows.slice(0, 50);
    const previewText = previewRows
      .map((row) =>
        row
          .map((cell) => String(cell ?? "").trim())
          .filter(Boolean)
          .join(" | "),
      )
      .filter(Boolean)
      .join("\n");

    return {
      title: sheetName,
      text: previewText || "No readable rows found in this sheet.",
      rowCount: rows.length,
    };
  });
};

const buildPdfPageText = (items) => {
  const positionedItems = items
    .map((item) => ({
      text: item.str,
      x: item.transform[4] ?? 0,
      y: item.transform[5] ?? 0,
      width: item.width ?? 0,
      hasEOL: item.hasEOL,
    }))
    .filter((item) => item.text.trim().length > 0)
    .sort((left, right) =>
      Math.abs(left.y - right.y) > 2 ? right.y - left.y : left.x - right.x,
    );

  const lines = [];

  for (const item of positionedItems) {
    const currentLine = lines.at(-1);
    if (!currentLine || Math.abs(currentLine.y - item.y) > 4) {
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

    currentLine.parts.push({
      text: item.text,
      x: item.x,
      width: item.width,
      hasEOL: item.hasEOL,
    });
  }

  return (
    lines
      .map((line) => {
        const sorted = [...line.parts].sort((left, right) => left.x - right.x);
        let cursorX = 0;
        let content = "";

        for (const part of sorted) {
          const gap = part.x - cursorX;
          if (content.length > 0) {
            content += gap > 24 ? "    " : gap > 6 ? " " : "";
          }
          content += part.text;
          cursorX = part.x + part.width;
          if (part.hasEOL) break;
        }

        return content.trimEnd();
      })
      .join("\n")
      .trim() || "No extractable text found on this page."
  );
};

const readPdfFile = async (file, password, requestPassword) => {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: buffer, password });

  if (requestPassword) {
    loadingTask.onPassword = async (updatePassword, reason) => {
      const passwordValue = await requestPassword(
        reason === 1 ? "need" : "incorrect",
      );
      if (passwordValue === null) {
        loadingTask.destroy();
        return;
      }
      updatePassword(passwordValue);
    };
  }

  const pdf = await loadingTask.promise;
  const sections = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageItems = textContent.items.filter(isPdfTextItem);
    sections.push({
      title: `Page ${pageNumber}`,
      text: buildPdfPageText(pageItems),
    });
  }

  return sections;
};

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
  const [ledgerStartDate, setLedgerStartDate] = useState("2026-01-01");
  const [ledgerEndDate, setLedgerEndDate] = useState("2026-03-31");
  const [ledgerAccountingMethod, setLedgerAccountingMethod] =
    useState("Accrual");
  const [generalLedgerSync, setGeneralLedgerSync] = useState({
    status: "idle",
    message: "",
  });
  const [statusFilter, setStatusFilter] = useState("All");
  const [isLoadingReconciliation, setIsLoadingReconciliation] = useState(false);
  const [isLoadingVariance, setIsLoadingVariance] = useState(false);
  const [reconciliationError, setReconciliationError] = useState("");
  const [varianceError, setVarianceError] = useState("");
  const [backendUpload, setBackendUpload] = useState({
    status: "idle",
    message: "",
  });
  const [passwordPrompt, setPasswordPrompt] = useState({
    isOpen: false,
    message: "",
    password: "",
  });

  const getHeaders = () => {
    const headers = {};
    if (clientId) {
      headers["X-Client-Id"] = clientId;
    }
    return headers;
  };

  const handleOpenPicker = () => fileInputRef.current?.click();

  const requestPassword = (reason) =>
    new Promise((resolve) => {
      passwordResolverRef.current = resolve;
      setPasswordPrompt({
        isOpen: true,
        message:
          reason === "incorrect"
            ? "That password was incorrect. Enter the correct password to open the file."
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

  const loadReconciliationData = async () => {
    setIsLoadingReconciliation(true);
    setReconciliationError("");

    try {
      const { response, payload } = await fetchFirstAvailableJson(
        RECONCILIATION_DATA_ENDPOINTS,
        getHeaders(),
      );

      if (!response.ok) {
        throw new Error(
          payload && payload.error
            ? payload.error
            : "Failed to load reconciliation data.",
        );
      }

      if (!isReconciliationApiResponse(payload)) {
        throw new Error("Invalid reconciliation data response.");
      }

      setReconciliationRows(
        buildReconciliationRows(
          payload.bank_transactions,
          payload.reconciliation_transactions,
        ),
      );
    } catch (error) {
      console.error("Failed to load reconciliation data:", error);
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

      if (!response.ok) {
        throw new Error(
          payload && payload.error
            ? payload.error
            : "Failed to load reconciliation variance.",
        );
      }

      if (!isReconciliationVarianceResponse(payload)) {
        throw new Error("Invalid reconciliation variance response.");
      }

      setVarianceData(payload);
    } catch (error) {
      console.error("Failed to load reconciliation variance:", error);
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
      message: "Fetching QuickBooks general ledger data...",
    });

    try {
      const params = new URLSearchParams();
      params.set("start_date", ledgerStartDate);
      params.set("end_date", ledgerEndDate);
      params.set("accounting_method", ledgerAccountingMethod);

      const response = await fetch(
        `${QB_GENERAL_LEDGER_ENDPOINT}?${params.toString()}`,
        {
          cache: "no-store",
          headers: getHeaders(),
        },
      );
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Failed to fetch general ledger.");
      }

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
      console.error("Failed to fetch general ledger:", error);
      setGeneralLedgerSync({
        status: "error",
        message: getErrorMessage(error),
      });
    }
  };

  const filteredReconciliationRows =
    statusFilter === "All"
      ? reconciliationRows
      : reconciliationRows.filter((row) => row.status === statusFilter);

  const groupedReconciliationRows = filteredReconciliationRows.reduce(
    (groups, row) => {
      const dateKey = getRowDateKey(row);
      const dateLabel = getRowDateLabel(row);
      const previousGroup = groups.at(-1);

      if (!previousGroup || previousGroup.dateKey !== dateKey) {
        groups.push({
          dateKey,
          dateLabel,
          rows: [row],
        });
        return groups;
      }

      previousGroup.rows.push(row);
      return groups;
    },
    [],
  );

  const uploadToBackend = async (file, sections, password) => {
    setBackendUpload({
      status: "uploading",
      message: "Sending to backend for processing...",
    });

    let response;

    if (isPdfFile(file)) {
      const fullText = sections.map((section) => section.text).join("\n");
      response = await fetch(BANK_STATEMENT_UPLOAD_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getHeaders(),
        },
        body: JSON.stringify({
          type: "pdf",
          fileName: file.name,
          text: fullText,
        }),
      });
    } else {
      const formData = new FormData();
      formData.append("file", file);
      if (password) {
        formData.append("password", password);
      }
      response = await fetch(BANK_STATEMENT_UPLOAD_ENDPOINT, {
        method: "POST",
        headers: getHeaders(),
        body: formData,
      });
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        payload?.error || payload?.message || "Failed to upload to backend.",
      );
    }

    setBackendUpload({
      status: "success",
      message:
        payload?.message && payload?.totalRecords !== undefined
          ? `${payload.message} (${payload.totalRecords} records)`
          : payload?.message || "Uploaded successfully.",
    });
  };

  const processFile = async (file) => {
    setSelectedFile(file);
    setErrorMessage("");
    setFileSections([]);
    setIsContentVisible(false);
    setBackendUpload({ status: "idle", message: "" });
    setIsReading(true);
    let unlockedPassword = "";

    const requestPasswordForFile = async (reason) => {
      const password = await requestPassword(reason);
      if (password) {
        unlockedPassword = password;
      }
      return password;
    };

    try {
      const sections = isPdfFile(file)
        ? await readPdfFile(file, undefined, requestPasswordForFile)
        : await readExcelFile(file);

      setFileSections(sections);
      await uploadToBackend(file, sections, unlockedPassword || undefined);
      await loadReconciliationData();
      await loadVarianceData();
    } catch (error) {
      if (!isPdfFile(file) && isExcelPasswordError(error)) {
        const password = await requestPasswordForFile("need");
        if (password === null) {
          setErrorMessage("Password entry was cancelled.");
          setIsReading(false);
          return;
        }

        try {
          const sections = await readExcelFile(file, password);
          setFileSections(sections);
          setErrorMessage("");
          await uploadToBackend(file, sections, password);
          await loadReconciliationData();
          await loadVarianceData();
          setIsReading(false);
          return;
        } catch (passwordError) {
          if (isExcelPasswordError(passwordError)) {
            const retryPassword = await requestPasswordForFile("incorrect");
            if (retryPassword === null) {
              setErrorMessage("Password entry was cancelled.");
              setIsReading(false);
              return;
            }

            const sections = await readExcelFile(file, retryPassword);
            setFileSections(sections);
            setErrorMessage("");
            await uploadToBackend(file, sections, retryPassword);
            await loadReconciliationData();
            await loadVarianceData();
            setIsReading(false);
            return;
          }

          throw passwordError;
        }
      }

      console.error("Failed to read file:", error);
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
    closePasswordPrompt();

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const SelectedFileIcon = selectedFile?.name.toLowerCase().endsWith(".pdf")
    ? FileText
    : FileSpreadsheet;

  return (
    <>
      <Header title="Reconciliation" />
      <div className="page-content">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-bold text-text-primary">
              Reconciliation
            </h1>
          </div>
        </div>

        <QBDisconnectedBanner pageName="Reconciliation" />

        <section className="card-base w-full p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-[18px] font-semibold text-text-primary">
                QuickBooks General Ledger
              </h2>
            </div>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr_220px_auto]">
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                Start Date
              </label>
              <input
                type="date"
                value={ledgerStartDate}
                onChange={(event) => setLedgerStartDate(event.target.value)}
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
                onChange={(event) => setLedgerEndDate(event.target.value)}
                className="input-base h-10"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                Accounting Type
              </label>
              <select
                value={ledgerAccountingMethod}
                onChange={(event) =>
                  setLedgerAccountingMethod(event.target.value)
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

          {generalLedgerSync.status !== "idle" ? (
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
          ) : null}
        </section>

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

                <div className="space-y-2">
                  <h2 className="text-[20px] font-semibold text-text-primary">
                    Choose a PDF or Excel file
                  </h2>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <button onClick={handleOpenPicker} className="btn-primary">
                    <Upload size={16} />
                    Select File
                  </button>

                  {fileSections.length > 0 ? (
                    <button
                      onClick={() => setIsContentVisible((current) => !current)}
                      className="btn-secondary"
                    >
                      <FileText size={16} />
                      {isContentVisible ? "Hide Content" : "View Content"}
                    </button>
                  ) : null}

                  {selectedFile ? (
                    <button onClick={handleClearFile} className="btn-secondary">
                      <X size={16} />
                      Remove File
                    </button>
                  ) : null}
                </div>

                {errorMessage ? (
                  <div className="flex items-center gap-2 rounded-lg border border-negative/20 bg-white px-4 py-3 text-[14px] text-negative">
                    <AlertCircle size={16} />
                    {errorMessage}
                  </div>
                ) : null}

                {isReading ? (
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-white px-4 py-3 text-[14px] text-text-secondary">
                    <LoaderCircle size={16} className="animate-spin" />
                    Reading file content...
                  </div>
                ) : null}

                {backendUpload.status !== "idle" ? (
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
                ) : null}
              </div>
            </div>

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
                        {selectedFile.name.toLowerCase().endsWith(".pdf")
                          ? "PDF Document"
                          : "Excel Workbook"}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <span>Status</span>
                      <span className="font-medium text-primary">
                        {isReading
                          ? "Reading content"
                          : backendUpload.status === "uploading"
                            ? "Uploading to backend"
                            : backendUpload.status === "success"
                              ? "Uploaded to backend"
                              : "Content extracted"}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <span>Sections found</span>
                      <span className="font-medium text-text-primary">
                        {fileSections.length}
                      </span>
                    </div>
                  </div>

                  {isContentVisible && fileSections.length > 0 ? (
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
                            {section.rowCount !== undefined ? (
                              <span className="text-[12px] text-text-muted">
                                {section.rowCount} rows
                              </span>
                            ) : null}
                          </div>
                          <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-[12px] leading-5 text-text-secondary">
                            {section.text}
                          </pre>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="mt-5 text-[14px] text-text-muted">
                  No file selected yet. Use the button to attach a PDF or Excel
                  file for reconciliation.
                </p>
              )}
            </div>
          </div>
        </section>

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

          {varianceError ? (
            <div className="mt-6 flex items-center gap-2 rounded-lg border border-negative/20 bg-white px-4 py-3 text-[14px] text-negative">
              <AlertCircle size={16} />
              {varianceError}
            </div>
          ) : null}

          {isLoadingVariance ? (
            <div className="mt-6 flex items-center gap-2 rounded-lg border border-border bg-bg-page/40 px-4 py-5 text-[14px] text-text-secondary">
              <LoaderCircle size={16} className="animate-spin" />
              Loading variance summary...
            </div>
          ) : varianceData ? (
            <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl border border-border bg-bg-card p-5">
                <p className="text-[13px] font-medium text-text-secondary">
                  Bank Total
                </p>
                <p className="mt-2 text-[28px] font-bold text-text-primary">
                  {formatCurrencyValue(varianceData.bank_total)}
                </p>
              </div>

              <div className="rounded-2xl border border-border bg-bg-card p-5">
                <p className="text-[13px] font-medium text-text-secondary">
                  Books Total
                </p>
                <p className="mt-2 text-[28px] font-bold text-text-primary">
                  {formatCurrencyValue(varianceData.books_total)}
                </p>
              </div>

              <div className="rounded-2xl border border-border bg-bg-card p-5">
                <p className="text-[13px] font-medium text-text-secondary">
                  Variance Amount
                </p>
                <p className="mt-2 text-[28px] font-bold text-text-primary">
                  {formatCurrencyValue(varianceData.variance_amount)}
                </p>
              </div>

              <div className="rounded-2xl border border-border bg-bg-card p-5">
                <p className="text-[13px] font-medium text-text-secondary">
                  Variance %
                </p>
                <p className="mt-2 text-[28px] font-bold text-text-primary">
                  {formatPercentageValue(varianceData.variance_percentage)}
                </p>
              </div>
            </div>
          ) : (
            <div className="mt-6 rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-[14px] text-text-muted">
              No variance data available.
            </div>
          )}
        </section>

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

          {reconciliationError ? (
            <div className="mt-6 flex items-center gap-2 rounded-lg border border-negative/20 bg-white px-4 py-3 text-[14px] text-negative">
              <AlertCircle size={16} />
              {reconciliationError}
            </div>
          ) : null}

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
                  <th className="border-b border-r border-border px-3 py-3 text-left text-[14px] font-semibold text-text-primary">
                    Date
                  </th>
                  <th className="border-b border-r border-border px-3 py-3 text-left text-[14px] font-semibold text-text-primary">
                    Name
                  </th>
                  <th className="border-b border-r border-border px-3 py-3 text-left text-[14px] font-semibold text-text-primary">
                    Amount
                  </th>
                  <th className="border-b border-r border-border px-3 py-3 text-left text-[14px] font-semibold text-text-primary">
                    Date
                  </th>
                  <th className="border-b border-r border-border px-3 py-3 text-left text-[14px] font-semibold text-text-primary">
                    Name
                  </th>
                  <th className="border-b border-r border-border px-3 py-3 text-left text-[14px] font-semibold text-text-primary">
                    Amount
                  </th>
                  <th className="border-b border-border px-3 py-3 text-left text-[14px] font-semibold text-text-primary">
                    Status
                  </th>
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
                ) : groupedReconciliationRows.length > 0 ? (
                  groupedReconciliationRows.map((group, groupIndex) =>
                    group.rows.map((row, rowIndex) => (
                      <tr
                        key={`${group.dateKey}-${row.bank?.date || "bank"}-${row.quickbooks?.date || "qb"}-${rowIndex}`}
                        className={cn(
                          groupIndex % 2 === 0
                            ? "bg-primary/5"
                            : "bg-slate-100/60",
                        )}
                      >
                        {rowIndex === 0 ? (
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
                        ) : null}

                        <td className="border-b border-r border-border px-3 py-3 align-top text-[14px] text-text-primary">
                          {row.bank ? normalizeDate(row.bank.date) : ""}
                        </td>
                        <td className="border-b border-r border-border px-3 py-3 align-top text-[14px] text-text-primary">
                          <div className="max-w-[260px] whitespace-pre-wrap break-words">
                            {row.bank?.name || ""}
                          </div>
                        </td>
                        <td className="border-b border-r border-border px-3 py-3 align-top text-[14px] font-medium text-text-primary">
                          {row.bank?.amount || ""}
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
                          {row.quickbooks?.amount || ""}
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
                      No reconciliation rows available for the selected status
                      filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {passwordPrompt.isOpen ? (
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
                onChange={(event) =>
                  setPasswordPrompt((current) => ({
                    ...current,
                    password: event.target.value,
                  }))
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    resolvePasswordPrompt(passwordPrompt.password);
                  }
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
      ) : null}
    </>
  );
}

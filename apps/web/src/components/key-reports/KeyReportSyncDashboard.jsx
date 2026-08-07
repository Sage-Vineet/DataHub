import { Fragment, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";
import ExtractedDataModal from "./ExtractedDataModal";

const PROCESS_STEPS = [
  "Read linked files",
  "Extract financial data",
  "Generate chart of accounts",
  "Run validations",
  "Publish validated version",
];

const VALIDATION_ROW_ORDER = [
  { key: "tax_return", label: "Tax Return Data" },
  { key: "bank_statement", label: "Bank Statement Data" },
  { key: "chart_of_accounts", label: "Chart of Accounts Data" },
  { key: "general_ledger", label: "General Ledger Data" },
  { key: "balance_sheet", label: "Balance Sheet Data" },
  { key: "profit_loss", label: "Profit & Loss Data" },
];

const EXTRA_ROW_LABEL = (key) =>
  key
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const STATUS_META = {
  success: {
    label: "Success",
    badge: "border-green-200 bg-green-100 text-green-700",
    cell: "border-green-200 bg-green-50 text-green-800",
    step: "border-green-200 bg-green-50 text-green-700",
  },
  warning: {
    label: "Warning",
    badge: "border-amber-200 bg-amber-100 text-amber-700",
    cell: "border-amber-200 bg-amber-50 text-amber-800",
    step: "border-amber-200 bg-amber-50 text-amber-700",
  },
  error: {
    label: "Error",
    badge: "border-red-200 bg-red-100 text-red-700",
    cell: "border-red-200 bg-red-50 text-red-800",
    step: "border-red-200 bg-red-50 text-red-700",
  },
  idle: {
    label: "Queued",
    badge: "border-border bg-bg-page text-text-muted",
    cell: "border-border bg-bg-page text-text-muted",
    step: "border-border bg-white text-text-muted",
  },
  active: {
    label: "Processing",
    badge: "border-primary/20 bg-primary/10 text-primary",
    cell: "border-primary/20 bg-primary/10 text-primary",
    step: "border-primary/20 bg-primary/10 text-primary",
  },
  complete: {
    label: "Complete",
    badge: "border-green-200 bg-green-100 text-green-700",
    cell: "border-green-200 bg-green-50 text-green-700",
    step: "border-green-200 bg-green-50 text-green-700",
  },
};

function normalizeStatus(value) {
  const status = String(value || "").toLowerCase();
  if (status === "success" || status === "warning" || status === "error") return status;
  return "idle";
}

function statusWeight(status) {
  switch (normalizeStatus(status)) {
    case "idle":
      return 0;
    case "success":
      return 1;
    case "warning":
      return 2;
    case "error":
      return 3;
    default:
      return 0;
  }
}

function formatTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function buildSummaryBadges(summary = {}, warnings = [], validationResults = []) {
  const items = [];

  if (summary && typeof summary === "object") {
    if (typeof summary.extractedDocs === "number") {
      items.push({ label: `${summary.extractedDocs} extracted doc${summary.extractedDocs === 1 ? "" : "s"}` });
    }
    if (typeof summary.glFiles === "number") {
      items.push({ label: `${summary.glFiles} GL file${summary.glFiles === 1 ? "" : "s"}` });
    }
    if (typeof summary.bsFiles === "number") {
      items.push({ label: `${summary.bsFiles} BS file${summary.bsFiles === 1 ? "" : "s"}` });
    }
    if (typeof summary.insertedTransactions === "number") {
      items.push({ label: `${summary.insertedTransactions.toLocaleString()} transactions` });
    }
    if (typeof summary.snapshotCount === "number") {
      items.push({ label: `${summary.snapshotCount} snapshot${summary.snapshotCount === 1 ? "" : "s"}` });
    }
    if (summary.chartOfAccounts && typeof summary.chartOfAccounts.accountCount === "number") {
      items.push({ label: `${summary.chartOfAccounts.accountCount} COA account${summary.chartOfAccounts.accountCount === 1 ? "" : "s"}` });
    }
    if (summary.reused) {
      items.push({ label: "Reused existing dataset" });
    }
  }

  if (Array.isArray(warnings) && warnings.length) {
    items.push({ label: `${warnings.length} warning${warnings.length === 1 ? "" : "s"}` });
  }

  if (Array.isArray(validationResults) && validationResults.length) {
    items.push({ label: `${validationResults.length} validation check${validationResults.length === 1 ? "" : "s"}` });
  }

  return items.slice(0, 8);
}

function buildValidationMatrix(validationResults = []) {
  if (!Array.isArray(validationResults) || validationResults.length === 0) {
    return {
      columns: [],
      rows: [],
      summaryCounts: { success: 0, warning: 0, error: 0, idle: 0 },
      detailRows: [],
    };
  }

  const yearSet = new Set();
  const rowMap = new Map();
  const extraKeys = new Set();

  validationResults.forEach((row) => {
    const dataType = String(row?.dataType || "").trim();
    if (!dataType) return;

    const parsedYear = Number(row?.year);
    const hasYear = Number.isInteger(parsedYear) && parsedYear > 0;
    const yearKey = hasYear ? String(parsedYear) : "All";
    if (hasYear) yearSet.add(parsedYear);

    if (!VALIDATION_ROW_ORDER.some((item) => item.key === dataType)) {
      extraKeys.add(dataType);
    }

    const status = normalizeStatus(row?.status || row?.severity);
    const message = String(row?.message || "").trim();
    const existingRow = rowMap.get(dataType) || new Map();
    const existingCell = existingRow.get(yearKey) || { status: "idle", messages: [] };

    if (statusWeight(status) > statusWeight(existingCell.status)) {
      existingCell.status = status;
    }
    if (message && !existingCell.messages.includes(message)) {
      existingCell.messages.push(message);
    }

    existingRow.set(yearKey, existingCell);
    rowMap.set(dataType, existingRow);
  });

  const columns = Array.from(yearSet).sort((a, b) => a - b).map((year) => String(year));
  if (!columns.length) columns.push("All");

  const rowOrder = [
    ...VALIDATION_ROW_ORDER.map((item) => item.key),
    ...Array.from(extraKeys).sort(),
  ];

  const rows = rowOrder.map((key) => {
    const config = VALIDATION_ROW_ORDER.find((item) => item.key === key);
    const cells = rowMap.get(key) || new Map();
    const hasAnyYearCell = columns.some(col => col !== "All" && cells.has(col));
    const isYearIndependent = cells.has("All") || key === "chart_of_accounts" || !hasAnyYearCell;
    return {
      key,
      label: config?.label || EXTRA_ROW_LABEL(key),
      cells,
      isYearIndependent,
    };
  });

  const summaryCounts = { success: 0, warning: 0, error: 0, idle: 0 };
  const detailRows = [];

  rows.forEach((row) => {
    if (row.isYearIndependent) {
      const cell = row.cells.get("All") || { status: "idle", messages: [] };
      summaryCounts[cell.status] = (summaryCounts[cell.status] || 0) + 1;
      if (cell.messages.length) {
        detailRows.push({
          rowKey: row.key,
          rowLabel: row.label,
          column: "All",
          status: cell.status,
          message: cell.messages.join(" | "),
        });
      }
    } else {
      columns.forEach((column) => {
        const cell = row.cells.get(column) || { status: "idle", messages: [] };
        summaryCounts[cell.status] = (summaryCounts[cell.status] || 0) + 1;
        if (cell.messages.length) {
          detailRows.push({
            rowKey: row.key,
            rowLabel: row.label,
            column,
            status: cell.status,
            message: cell.messages.join(" | "),
          });
        }
      });
    }
  });

  return { columns, rows, summaryCounts, detailRows };
}

function getProcessStepStatus(stateStatus, index) {
  if (stateStatus === "error") return index === 0 ? "error" : "idle";
  if (stateStatus === "validation") return "complete";
  if (stateStatus === "processing") return index === 0 ? "active" : "idle";
  return "idle";
}

function StepIcon({ status }) {
  if (status === "complete") {
    return <CheckCircle2 size={12} className="text-white" />;
  }
  if (status === "active") {
    return <Loader2 size={12} className="animate-spin text-white" />;
  }
  if (status === "error") {
    return <AlertCircle size={12} className="text-white" />;
  }
  return null;
}

export default function KeyReportSyncDashboard({
  version,
  syncState,
  hasLinkedDocuments = false,
}) {
  const [modal, setModal] = useState({ open: false, dataType: null, year: null });

  const state = syncState || {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    summary: null,
    warnings: [],
    validationResults: [],
    error: null,
  };

  const validationResults = useMemo(
    () => (Array.isArray(state.validationResults) ? state.validationResults : []),
    [state.validationResults],
  );
  const matrix = useMemo(() => buildValidationMatrix(validationResults), [validationResults]);
  const summaryBadges = useMemo(
    () => buildSummaryBadges(state.summary || {}, state.warnings || [], validationResults),
    [state.summary, state.warnings, validationResults],
  );

  const isProcessing = state.status === "processing";
  const isComplete = state.status === "validation";
  const isError = state.status === "error";
  const versionLabel = version?.versionName || (version?.versionNumber ? `Version ${version.versionNumber}` : "Selected version");

  const title = isProcessing
    ? "Processing dashboard"
    : isComplete
      ? "Validation dashboard"
      : isError
        ? "Sync failed"
        : "Sync dashboard";

  const subtitle = isProcessing
    ? `Processing ${versionLabel} now. Stay on this page while the sync finishes.`
    : isComplete
      ? `Latest sync results for ${versionLabel}.`
      : isError
        ? "The last sync attempt failed. Fix the issue and sync again."
        : hasLinkedDocuments
          ? `Linked files are ready to sync for ${versionLabel}.`
          : "Link at least one supported file before running Sync.";

  const statusTone = isProcessing
    ? "border-primary/20 bg-primary/10 text-primary"
    : isComplete
      ? "border-green-200 bg-green-100 text-green-700"
      : isError
        ? "border-red-200 bg-red-100 text-red-700"
        : "border-border bg-bg-page text-text-muted";

  const summaryLabel = isProcessing
    ? "Working"
    : isComplete
      ? "Validated"
      : isError
        ? "Attention needed"
        : "Idle";

  const displayTimestamp = state.finishedAt || state.startedAt || version?.lastSyncedAt || null;

  return (
    <div className="mt-4 space-y-4">
      <section className="rounded-2xl border border-primary/20 bg-gradient-to-br from-white to-[#F8FBF3] p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Processing dashboard
            </p>
            <h2 className="mt-1 text-sm font-bold text-text-primary">{title}</h2>
            <p className="mt-1 text-sm text-text-secondary">{subtitle}</p>
            {displayTimestamp ? (
              <p className="mt-2 text-xs text-text-muted">
                {isProcessing ? "Started" : "Finished"} {formatTimestamp(displayTimestamp)}
              </p>
            ) : null}
          </div>
          <span className={cn("rounded-full border px-3 py-1 text-xs font-semibold", statusTone)}>
            {summaryLabel}
          </span>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {PROCESS_STEPS.map((step, index) => {
            const stepStatus = getProcessStepStatus(state.status, index);
            const meta = STATUS_META[stepStatus];
            return (
              <div key={step} className={cn("rounded-xl border px-3 py-2.5", meta.step)}>
                <div className="flex items-center gap-2">
                  <div
                    className={cn(
                      "flex h-5 w-5 items-center justify-center rounded-full",
                      stepStatus === "complete" ? "bg-green-500" :
                      stepStatus === "active" ? "bg-primary" :
                      stepStatus === "error" ? "bg-red-500" :
                      "bg-border",
                    )}
                  >
                    <StepIcon status={stepStatus} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-text-primary">{step}</p>
                    <p className="text-[11px] text-text-muted">{meta.label}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {summaryBadges.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {summaryBadges.map((item) => (
              <span
                key={item.label}
                className="rounded-full border border-border bg-white px-2.5 py-1 text-[11px] font-medium text-text-secondary"
              >
                {item.label}
              </span>
            ))}
          </div>
        )}

        {isError && state.error && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {state.error}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-secondary">
              Validation dashboard
            </p>
            <h2 className="mt-1 text-sm font-bold text-text-primary">
              Year by year validation results
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {isComplete
                ? "The latest sync results are shown below."
                : "Validation results will appear here after Sync completes."}
            </p>
          </div>
          <span className="rounded-full border border-border bg-bg-page px-3 py-1 text-xs font-semibold text-text-muted">
            {matrix.columns.length && matrix.rows.length
              ? `${matrix.columns.length * matrix.rows.length} checks`
              : "No checks yet"}
          </span>
        </div>

        {matrix.columns.length > 0 && matrix.rows.length > 0 ? (
          <>
            <div className="mt-4 overflow-x-auto rounded-xl border border-border">
              <div
                className="grid min-w-[760px] bg-border text-left"
                style={{
                  gridTemplateColumns: `minmax(220px, 1.35fr) repeat(${matrix.columns.length}, minmax(140px, 1fr))`,
                  gap: "1px",
                }}
              >
                <div className="bg-bg-page px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                  Data type
                </div>
                {matrix.columns.map((column) => (
                  <div
                    key={column}
                    className="bg-bg-page px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted"
                  >
                    {column}
                  </div>
                ))}

                {matrix.rows.map((row) => (
                  <Fragment key={row.key}>
                    <div className="bg-white px-3 py-3">
                      <p className="text-sm font-semibold text-text-primary">{row.label}</p>
                    </div>
                    {row.isYearIndependent ? (
                      (() => {
                        const cell = row.cells.get("All") || { status: "idle", messages: [] };
                        const meta = STATUS_META[cell.status] || STATUS_META.idle;
                        const message = cell.messages.length
                          ? cell.messages.join(" | ")
                          : "No result yet.";
                        return (
                          <div
                            key={`${row.key}:all`}
                            className={cn("bg-white px-3 py-3", meta.cell)}
                            style={{ gridColumn: `span ${matrix.columns.length}` }}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-semibold", meta.badge)}>
                                {meta.label}
                              </span>
                            </div>
                            <p className="mt-2 text-[11px] leading-4 text-inherit" title={message}>
                              {message}
                            </p>
                            {(cell.status === "success" || cell.status === "warning") && row.key !== "chart_of_accounts" && (
                              <button
                                onClick={() => setModal({ open: true, dataType: row.key, year: null })}
                                className="mt-1.5 text-[11px] font-semibold text-primary hover:underline"
                                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "block" }}
                              >
                                View data →
                              </button>
                            )}
                          </div>
                        );
                      })()
                    ) : (
                      matrix.columns.map((column) => {
                        const cell = row.cells.get(column) || { status: "idle", messages: [] };
                        const meta = STATUS_META[cell.status] || STATUS_META.idle;
                        const message = cell.messages.length
                          ? cell.messages.join(" | ")
                          : "No result yet.";
                        return (
                          <div key={`${row.key}:${column}`} className={cn("bg-white px-3 py-3", meta.cell)}>
                            <div className="flex items-start justify-between gap-2">
                              <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-semibold", meta.badge)}>
                                {meta.label}
                              </span>
                            </div>
                            <p className="mt-2 text-[11px] leading-4 text-inherit" title={message}>
                              {message}
                            </p>
                            {(cell.status === "success" || cell.status === "warning") && row.key !== "chart_of_accounts" && (
                              <button
                                onClick={() => setModal({ open: true, dataType: row.key, year: parseInt(column, 10) || null })}
                                className="mt-1.5 text-[11px] font-semibold text-primary hover:underline"
                                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "block" }}
                              >
                                View data →
                              </button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </Fragment>
                ))}
              </div>
            </div>

            {matrix.detailRows.length > 0 && (
              <div className="mt-4 space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-secondary">
                  Validation messages
                </h3>
                <div className="space-y-2">
                  {matrix.detailRows.slice(0, 12).map((item) => {
                    const meta = STATUS_META[item.status] || STATUS_META.idle;
                    return (
                      <div
                        key={`${item.rowKey}:${item.column}:${item.message}`}
                        className="rounded-xl border border-border bg-bg-page px-3 py-2"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-semibold", meta.badge)}>
                            {meta.label}
                          </span>
                          <span className="text-xs font-semibold text-text-primary">
                            {item.rowLabel}
                          </span>
                          <span className="text-xs text-text-muted">{item.column}</span>
                        </div>
                        <p className="mt-1 text-sm text-text-secondary">{item.message}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-border bg-bg-page px-4 py-8 text-center">
            <p className="text-sm font-medium text-text-primary">
              No validation results yet.
            </p>
            <p className="mt-1 text-sm text-text-secondary">
              Sync the selected Key Reports version to generate the dashboard.
            </p>
          </div>
        )}
      </section>

      <ExtractedDataModal
        open={modal.open}
        onClose={() => setModal({ open: false, dataType: null, year: null })}
        versionId={version?.id}
        dataType={modal.dataType}
        year={modal.year}
      />
    </div>
  );
}

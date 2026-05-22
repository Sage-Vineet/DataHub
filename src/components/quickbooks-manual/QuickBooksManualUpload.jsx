import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  HardDrive,
  Loader2,
  Minus,
  RefreshCw,
  Trash2,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import {
  getManualFolderFiles,
  getQMSUploadSourceTree,
  syncQMSUploadSource,
  parseQMSDocuments,
  uploadFile,
} from "../../lib/api";
import { cn } from "../../lib/utils";
import { useToast } from "../../context/ToastContext";

// ─── Constants ─────────────────────────────────────────────────────────────

const STATEMENT_META = {
  balance_sheet: { label: "Balance Sheet", page: "Balance Sheet page" },
  profit_and_loss: { label: "Profit & Loss", page: "Reports page" },
  cash_flow: { label: "Cash Flow", page: "Cash Flow page" },
};

const FOLDER_PAGE_MAP = {
  "bank statement": "Bank Statement page",
  "tax return": "Tax Return page",
};

const REPORT_TYPE_OPTIONS = [
  { value: "", label: "— Select report type —" },
  { value: "balance_sheet", label: "Balance Sheet" },
  { value: "profit_and_loss", label: "Profit & Loss" },
  { value: "cash_flow", label: "Cash Flow" },
  { value: "bank_statement", label: "Bank Statement" },
  { value: "tax_return", label: "Tax Return" },
];

function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function guessReportType(fileName) {
  const lower = fileName.toLowerCase();
  // trial balance, general ledger, journal, etc. are not financial statements
  if (lower.includes("trial") || lower.includes("general_ledger") || lower.includes("general ledger") || lower.includes("journal") || lower.includes("ledger")) return "";
  if (lower.includes("balance") || lower.includes("bs_") || lower.includes("_bs")) return "balance_sheet";
  if (lower.includes("profit") || lower.includes("loss") || lower.includes("p&l") || lower.includes("pl_") || lower.includes("_pl")) return "profit_and_loss";
  if (lower.includes("cash") || lower.includes("flow") || lower.includes("cf_") || lower.includes("_cf")) return "cash_flow";
  if (lower.includes("bank") || lower.includes("statement")) return "bank_statement";
  if (lower.includes("tax") || lower.includes("return")) return "tax_return";
  return "";
}

function FileIcon({ fileName, ext, size = 13 }) {
  const isPdf =
    String(ext || "").toLowerCase() === "pdf" ||
    String(fileName || "").toLowerCase().endsWith(".pdf");
  return isPdf ? (
    <FileText size={size} className="text-red-500 shrink-0" />
  ) : (
    <FileSpreadsheet size={size} className="text-primary shrink-0" />
  );
}

// ─── Folder files popup ────────────────────────────────────────────────────

function FolderFilesPopup({ folder, companyId, anchorRef, onClose }) {
  const [files, setFiles] = useState(null);
  const [loading, setLoading] = useState(true);
  const popupRef = useRef(null);
  const [style, setStyle] = useState({});

  useEffect(() => {
    if (!anchorRef?.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const popupWidth = 320;
    const spaceRight = window.innerWidth - rect.right - 8;
    const spaceLeft = rect.left - 8;
    let left;
    if (spaceRight >= popupWidth) left = rect.right + 8;
    else if (spaceLeft >= popupWidth) left = rect.left - popupWidth - 8;
    else left = Math.max(8, rect.left);
    const top = Math.min(rect.top, window.innerHeight - 320);
    setStyle({ position: "fixed", top, left, width: popupWidth, zIndex: 50 });
  }, [anchorRef]);

  useEffect(() => {
    function handleKey(e) { if (e.key === "Escape") onClose(); }
    function handleClick(e) {
      if (popupRef.current && !popupRef.current.contains(e.target) &&
          anchorRef?.current && !anchorRef.current.contains(e.target)) onClose();
    }
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose, anchorRef]);

  useEffect(() => {
    if (!folder?.id || !companyId) return;
    setLoading(true);
    getManualFolderFiles({ clientId: companyId, folderId: folder.id })
      .then(setFiles)
      .catch(() => setFiles([]))
      .finally(() => setLoading(false));
  }, [folder?.id, companyId]);

  if (!style.top && !style.left) return null;

  return (
    <div ref={popupRef} style={style} className="rounded-2xl border border-border bg-bg-card shadow-[var(--shadow-dropdown)] overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border bg-bg-page">
        <div className="flex items-center gap-2 min-w-0">
          <FolderOpen size={14} className="text-primary shrink-0" />
          <span className="text-[13px] font-semibold text-text-primary truncate">{folder.name}</span>
        </div>
        <button onClick={onClose} className="shrink-0 rounded-md p-1 text-text-muted hover:bg-border hover:text-text-primary transition-colors">
          <X size={14} />
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto">
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-5 text-[13px] text-text-secondary">
            <Loader2 size={13} className="animate-spin shrink-0" />
            Loading files…
          </div>
        ) : !files || files.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-5 text-[13px] text-text-muted">
            <FolderOpen size={13} className="shrink-0" />
            No files uploaded yet.
          </div>
        ) : (
          <div>
            {files.map((file, i) => (
              <div key={file.id || i} className="flex items-center gap-2.5 px-4 py-2.5 border-b border-border last:border-b-0 hover:bg-bg-page/60 transition-colors">
                <FileIcon fileName={file.name} ext={file.ext} size={13} />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-text-primary truncate" title={file.name}>{file.name}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    {file.uploaded_at && (
                      <span className="text-[11px] text-text-muted">
                        {new Date(file.uploaded_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      </span>
                    )}
                    {file.size > 0 && <span className="text-[11px] text-text-muted">· {formatBytes(file.size)}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {files && files.length > 0 && (
        <div className="px-4 py-2 border-t border-border bg-bg-page">
          <span className="text-[11px] text-text-muted">{files.length} file{files.length !== 1 ? "s" : ""}</span>
        </div>
      )}
    </div>
  );
}

// ─── Folder row (full-sync mode) ───────────────────────────────────────────

function FolderRow({ folder, statementType, page, isSubItem = false, companyId }) {
  const meta = statementType ? STATEMENT_META[statementType] : null;
  const destinationPage = page || meta?.page || null;
  const [popupOpen, setPopupOpen] = useState(false);
  const rowRef = useRef(null);

  return (
    <>
      <div
        ref={rowRef}
        onClick={() => setPopupOpen((v) => !v)}
        className={cn(
          "flex items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-b-0 cursor-pointer hover:bg-primary/5 transition-colors",
          isSubItem && "pl-8 bg-bg-page/50",
          popupOpen && "bg-primary/5",
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <FolderOpen size={15} className={cn("shrink-0", isSubItem ? "text-text-muted" : "text-primary")} />
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-text-primary truncate">{folder.name}</div>
            {destinationPage && <div className="text-[11px] text-text-muted mt-0.5">→ {destinationPage}</div>}
          </div>
        </div>
        <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold", folder.fileCount > 0 ? "bg-primary/10 text-primary" : "bg-bg-page text-text-muted ring-1 ring-border")}>
          {folder.fileCount} file{folder.fileCount !== 1 ? "s" : ""}
        </span>
      </div>
      {popupOpen && (
        <FolderFilesPopup folder={folder} companyId={companyId} anchorRef={rowRef} onClose={() => setPopupOpen(false)} />
      )}
    </>
  );
}

// ─── Sync result panel ─────────────────────────────────────────────────────

function SyncResultPanel({ result }) {
  if (!result) return null;
  const { processed = [], failed = [], syncedAt } = result;
  const total = processed.length + failed.length;
  const syncTimeLabel = syncedAt
    ? new Date(syncedAt).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <div className="rounded-2xl border border-border bg-bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-bg-page">
        <div className="flex items-center gap-3">
          <span className="text-[14px] font-semibold text-text-primary">Last Sync Result</span>
          {syncTimeLabel && <span className="text-[12px] text-text-muted">· Synced {syncTimeLabel}</span>}
        </div>
        <span className="text-[12px] text-text-muted">{total} file{total !== 1 ? "s" : ""} found</span>
      </div>
      {processed.length === 0 && failed.length === 0 && (
        <div className="px-5 py-4 text-[13px] text-text-secondary">No files were found in the mapped folders.</div>
      )}
      {processed.length > 0 && (
        <div className="px-5 py-4 border-b border-border last:border-b-0">
          <div className="flex items-center gap-1.5 mb-2">
            <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
            <span className="text-[12px] font-semibold text-emerald-700">{processed.length} file{processed.length !== 1 ? "s" : ""} read successfully</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {processed.map((item, i) => (
              <span key={`proc-${item.documentId || i}`} className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-[12px] font-medium text-emerald-800 ring-1 ring-emerald-200">
                <FileIcon fileName={item.fileName} />
                <span className="truncate max-w-[200px]" title={item.fileName}>{item.fileName}</span>
                {item.folderName && <span className="text-emerald-500">· {item.folderName}</span>}
              </span>
            ))}
          </div>
        </div>
      )}
      {failed.length > 0 && (
        <div className="px-5 py-4">
          <div className="flex items-center gap-1.5 mb-2">
            <XCircle size={13} className="text-red-500 shrink-0" />
            <span className="text-[12px] font-semibold text-red-700">{failed.length} file{failed.length !== 1 ? "s" : ""} could not be read</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {failed.map((item, i) => (
              <span key={`fail-${item.documentId || i}`} className="flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1 text-[12px] font-medium text-red-800 ring-1 ring-red-200" title={item.reason || ""}>
                <XCircle size={10} className="text-red-400 shrink-0" />
                <span className="truncate max-w-[180px]">{item.fileName || item.folderName}</span>
                {item.reason && <span className="text-red-400 truncate max-w-[160px]">· {item.reason}</span>}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Local file row (choose-folder mode) ──────────────────────────────────

function LocalFileRow({ entry, onRemove, onTypeChange }) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <FileIcon fileName={entry.file.name} ext={entry.file.name.split(".").pop()} size={15} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-text-primary truncate" title={entry.file.name}>
          {entry.file.name}
        </div>
        <div className="text-[11px] text-text-muted mt-0.5">{formatBytes(entry.file.size)}</div>
      </div>
      <select
        value={entry.reportType}
        onChange={(e) => onTypeChange(entry.id, e.target.value)}
        className={cn(
          "shrink-0 rounded-lg border border-border bg-bg-page px-2 py-1.5 text-[12px] font-medium focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors",
          !entry.reportType ? "text-text-muted" : "text-text-primary",
        )}
      >
        {REPORT_TYPE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      {entry.status === "uploading" && <Loader2 size={15} className="text-primary animate-spin shrink-0" />}
      {entry.status === "done" && <CheckCircle2 size={15} className="text-emerald-500 shrink-0" />}
      {entry.status === "error" && <XCircle size={15} className="text-red-500 shrink-0" title={entry.error} />}
      {entry.status === "skipped" && (
        <span title="No report type assigned — file skipped" className="shrink-0 flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-text-muted ring-1 ring-border">
          <Minus size={10} />
          Skipped
        </span>
      )}
      {!entry.status && (
        <button onClick={() => onRemove(entry.id)} className="shrink-0 rounded-md p-1 text-text-muted hover:text-red-500 hover:bg-red-50 transition-colors">
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

// ─── Drop zone ─────────────────────────────────────────────────────────────

const ALLOWED_EXTS = ["xlsx", "xls", "pdf", "csv"];

function isAllowedFile(file) {
  return ALLOWED_EXTS.includes(file.name.split(".").pop().toLowerCase());
}

async function collectFolderFiles(entry) {
  const result = [];
  async function walk(e) {
    if (e.isFile) {
      const file = await new Promise((resolve, reject) => e.file(resolve, reject));
      if (isAllowedFile(file)) result.push(file);
    } else if (e.isDirectory) {
      const reader = e.createReader();
      // readEntries may return results in batches — keep reading until empty
      let batch;
      do {
        batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        for (const child of batch) await walk(child);
      } while (batch.length > 0);
    }
  }
  await walk(entry);
  return result;
}

function DropZone({ onFilesSelected }) {
  const inputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  async function handleDrop(e) {
    e.preventDefault();
    setIsDragging(false);
    const items = Array.from(e.dataTransfer.items || []);
    if (items.length === 0) return;

    // Use FileSystem API to walk dropped folders
    const files = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.();
      if (!entry) continue;
      const collected = await collectFolderFiles(entry);
      files.push(...collected);
    }
    if (files.length) onFilesSelected(files);
  }

  function handleInputChange(e) {
    const files = Array.from(e.target.files || []).filter(isAllowedFile);
    if (files.length) onFilesSelected(files);
    // Reset so re-selecting the same folder triggers onChange
    e.target.value = "";
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-8 py-10 cursor-pointer transition-all",
        isDragging
          ? "border-primary bg-primary/5 scale-[1.01]"
          : "border-border bg-bg-page hover:border-primary/50 hover:bg-primary/3",
      )}
    >
      <div className={cn("flex h-12 w-12 items-center justify-center rounded-2xl transition-colors", isDragging ? "bg-primary text-white" : "bg-gray-100 text-gray-500")}>
        <FolderOpen size={22} />
      </div>
      <div className="text-center">
        <p className="text-[14px] font-semibold text-text-primary">
          {isDragging ? "Drop folder here" : "Select a folder from your computer"}
        </p>
        <p className="mt-1 text-[12px] text-text-muted">
          Click to open a folder picker — reads Excel (.xlsx, .xls), PDF, and CSV files inside
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        // eslint-disable-next-line react/no-unknown-property
        webkitdirectory=""
        directory=""
        multiple
        className="hidden"
        onChange={handleInputChange}
      />
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

const MODE_QMS = "qms";
const MODE_FOLDER = "folder";

export default function QuickBooksManualUpload({ companyId }) {
  const { showToast } = useToast();
  const [mode, setMode] = useState(MODE_QMS);
  const [sourceTree, setSourceTree] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(null);
  // { phase: "upload"|"parse"|"sync", done: number, total: number, label: string }
  const [localFiles, setLocalFiles] = useState([]);
  const [lastSyncResult, setLastSyncResult] = useState(() => {
    if (!companyId) return null;
    try {
      const stored = sessionStorage.getItem(`qms-source-result-${companyId}`);
      return stored ? JSON.parse(stored) : null;
    } catch { return null; }
  });

  useEffect(() => {
    if (!companyId) return;
    if (lastSyncResult) sessionStorage.setItem(`qms-source-result-${companyId}`, JSON.stringify(lastSyncResult));
    else sessionStorage.removeItem(`qms-source-result-${companyId}`);
  }, [companyId, lastSyncResult]);

  // Clear any legacy uploadedDocHistory keys from previous sessions
  useEffect(() => {
    if (companyId) sessionStorage.removeItem(`qms-uploaded-docs-${companyId}`);
  }, [companyId]);

  const loadTree = useCallback(async () => {
    if (!companyId) return;
    setIsLoading(true);
    try {
      const tree = await getQMSUploadSourceTree({ clientId: companyId });
      setSourceTree(tree);
    } catch (error) {
      setSourceTree(null);
      showToast({ type: "error", title: "Load failed", message: error?.message || "Could not load Quickbooks Manual Source folder." });
    } finally {
      setIsLoading(false);
    }
  }, [companyId, showToast]);

  useEffect(() => { loadTree(); }, [loadTree]);

  const totalFiles = sourceTree
    ? (sourceTree.children || []).reduce((sum, item) => {
        if (item.isGroup) return sum + (item.children || []).reduce((s, c) => s + (c.fileCount || 0), 0);
        return sum + (item.fileCount || 0);
      }, 0)
    : 0;

  // ── File selection helpers ──

  const handleFilesSelected = (files) => {
    const entries = files.map((file) => ({
      id: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`,
      file,
      reportType: guessReportType(file.name),
      status: null,
      error: null,
    }));
    setLocalFiles((prev) => [...prev, ...entries]);
  };

  const handleRemoveFile = (id) => setLocalFiles((prev) => prev.filter((e) => e.id !== id));
  const handleTypeChange = (id, reportType) =>
    setLocalFiles((prev) => prev.map((e) => e.id === id ? { ...e, reportType } : e));

  // ── Single unified Sync All ──
  // If local files are selected → upload them and parse (Choose Folder path).
  // Otherwise → sync from DataRoom QMS source folder.

  const handleModeChange = (newMode) => {
    if (newMode === mode) return;
    setMode(newMode);
    if (newMode === MODE_QMS) setLocalFiles([]);
  };

  const handleSyncAll = async () => {
    if (!companyId) return;

    setIsSyncing(true);

    if (mode === MODE_FOLDER) {
      // ── Choose Folder path ──
      const toUpload = localFiles.filter((e) => e.reportType);
      setLocalFiles((prev) => prev.map((e) => ({ ...e, status: e.reportType ? "uploading" : "skipped" })));
      setSyncProgress({ phase: "upload", done: 0, total: toUpload.length, label: `Uploading 0 of ${toUpload.length} file${toUpload.length !== 1 ? "s" : ""}…` });

      const docs = [];
      for (let i = 0; i < toUpload.length; i++) {
        const entry = toUpload[i];
        try {
          const uploaded = await uploadFile(entry.file, { fileName: entry.file.name, prefix: "qms-uploads" });
          setLocalFiles((prev) => prev.map((e) => e.id === entry.id ? { ...e, status: "done" } : e));
          docs.push({ uploadId: uploaded.id, statementType: entry.reportType, fileName: entry.file.name });
        } catch (err) {
          setLocalFiles((prev) => prev.map((e) => e.id === entry.id ? { ...e, status: "error", error: err.message } : e));
        }
        setSyncProgress({
          phase: "upload",
          done: i + 1,
          total: toUpload.length,
          label: `Uploaded ${i + 1} of ${toUpload.length} file${toUpload.length !== 1 ? "s" : ""}…`,
        });
      }

      if (docs.length === 0) {
        showToast({ type: "error", title: "Nothing to sync", message: "No files were uploaded successfully." });
        setSyncProgress(null);
        setIsSyncing(false);
        return;
      }

      setSyncProgress({ phase: "parse", done: docs.length, total: docs.length, label: "Processing reports…" });

      try {
        const result = await parseQMSDocuments({ clientId: companyId, documents: docs, clearFirst: true });
        setLastSyncResult({ processed: result?.processed || [], failed: result?.failed || [], syncedAt: new Date().toISOString() });
        setLocalFiles([]);
        const p = result?.processed?.length || 0;
        const f = result?.failed?.length || 0;
        showToast({
          type: p > 0 ? "success" : "error",
          title: p > 0 ? "Sync complete" : "Sync finished with errors",
          message: f > 0 ? `${p} file(s) synced, ${f} could not be read.` : `${p} file(s) synced successfully.`,
        });
      } catch (err) {
        showToast({ type: "error", title: "Sync failed", message: err.message });
      }
    } else {
      // ── DataRoom source path ──
      setSyncProgress({ phase: "sync", done: 0, total: totalFiles, label: "Reading files from Quickbooks Manual Source…" });

      try {
        const result = await syncQMSUploadSource({ clientId: companyId });
        setLastSyncResult({ ...result, syncedAt: new Date().toISOString() });
        await loadTree();
        const p = result?.processedCount || 0;
        const f = result?.failed?.length || 0;
        showToast({
          type: p > 0 ? "success" : "error",
          title: p > 0 ? "Sync complete" : "Sync finished with errors",
          message: f > 0 ? `${p} file(s) read, ${f} could not be processed.` : `${p} file(s) read from Quickbooks Manual Source.`,
        });
      } catch (err) {
        showToast({ type: "error", title: "Sync failed", message: err?.message || "Could not sync Quickbooks Manual Source." });
      }
    }

    setSyncProgress(null);
    setIsSyncing(false);
  };

  const hasLocalTyped = localFiles.some((e) => e.reportType);
  const canSync = !isSyncing && !isLoading && (
    mode === MODE_QMS ? totalFiles > 0 : hasLocalTyped
  );

  return (
    <div className="card-base overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-5">
        <div>
          <h2 className="text-[24px] font-semibold text-text-primary">QuickBooks Manual</h2>
          <p className="mt-1 text-[14px] text-text-secondary">
            Choose a source to sync financial reports from.
          </p>
        </div>
        <button type="button" onClick={loadTree} disabled={isLoading || isSyncing} className="btn-secondary">
          <RefreshCw size={16} className={cn(isLoading ? "animate-spin" : "")} />
          Refresh
        </button>
      </div>

      <div className="space-y-5 p-6">

        {/* Mode selector cards */}
        <div className="grid grid-cols-2 gap-3">
          {/* Option 1 — DataRoom source */}
          <button
            type="button"
            onClick={() => handleModeChange(MODE_QMS)}
            disabled={isSyncing}
            className={cn(
              "group relative flex items-start gap-3 rounded-2xl border-2 p-4 text-left transition-all",
              mode === MODE_QMS
                ? "border-primary bg-primary/5 shadow-sm"
                : "border-border bg-bg-card hover:border-primary/40 hover:bg-primary/3",
            )}
          >
            <div className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors",
              mode === MODE_QMS ? "bg-primary text-white" : "bg-gray-100 text-gray-500 group-hover:bg-primary/10 group-hover:text-primary",
            )}>
              <HardDrive size={18} />
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold text-text-primary">QuickBooks Manual Source</span>
                {mode === MODE_QMS && <CheckCircle2 size={14} className="text-primary shrink-0" />}
              </div>
              <p className="mt-0.5 text-[12px] text-text-muted leading-relaxed">
                Sync from the mapped folder in your DataRoom
              </p>
              {mode === MODE_QMS && totalFiles > 0 && (
                <span className="mt-1.5 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                  {totalFiles} file{totalFiles !== 1 ? "s" : ""} ready
                </span>
              )}
            </div>
          </button>

          {/* Option 2 — Local folder upload */}
          <button
            type="button"
            onClick={() => handleModeChange(MODE_FOLDER)}
            disabled={isSyncing}
            className={cn(
              "group relative flex items-start gap-3 rounded-2xl border-2 p-4 text-left transition-all",
              mode === MODE_FOLDER
                ? "border-primary bg-primary/5 shadow-sm"
                : "border-border bg-bg-card hover:border-primary/40 hover:bg-primary/3",
            )}
          >
            <div className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors",
              mode === MODE_FOLDER ? "bg-primary text-white" : "bg-gray-100 text-gray-500 group-hover:bg-primary/10 group-hover:text-primary",
            )}>
              <Upload size={18} />
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold text-text-primary">Choose Folder</span>
                {mode === MODE_FOLDER && <CheckCircle2 size={14} className="text-primary shrink-0" />}
              </div>
              <p className="mt-0.5 text-[12px] text-text-muted leading-relaxed">
                Upload files directly from your computer
              </p>
              {mode === MODE_FOLDER && localFiles.length > 0 && (
                <span className="mt-1.5 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                  {localFiles.length} file{localFiles.length !== 1 ? "s" : ""} selected
                </span>
              )}
            </div>
          </button>
        </div>

        {/* ── DataRoom source view ── */}
        {mode === MODE_QMS && (
          <div className="rounded-2xl border border-border bg-bg-card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-page">
              <div className="flex items-center gap-2">
                <FolderOpen size={16} className="text-primary" />
                <span className="text-[13px] font-semibold text-text-primary">Quickbooks Manual Source</span>
              </div>
              <span className="text-[12px] text-text-muted">{totalFiles} total file{totalFiles !== 1 ? "s" : ""}</span>
            </div>

            {isLoading ? (
              <div className="flex items-center gap-2 px-4 py-6 text-[13px] text-text-secondary">
                <Loader2 size={14} className="animate-spin" />
                Loading folder structure…
              </div>
            ) : !sourceTree ? (
              <div className="flex items-center gap-2 px-4 py-6 text-[13px] text-text-secondary">
                <AlertCircle size={14} className="text-amber-500" />
                "Quickbooks Manual Source" folder not found. It will be created automatically when you visit the Data Room.
              </div>
            ) : (
              <div>
                {(sourceTree.children || []).map((item) => {
                  if (item.isGroup) {
                    return (
                      <div key={item.id}>
                        <div className="flex items-center gap-2 px-4 py-2 bg-bg-page/80 border-b border-border">
                          <FolderOpen size={14} className="text-text-muted" />
                          <span className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">{item.name}</span>
                        </div>
                        {(item.children || []).map((sub) => (
                          <FolderRow key={sub.id} folder={sub} statementType={sub.statementType} isSubItem companyId={companyId} />
                        ))}
                      </div>
                    );
                  }
                  const nameLower = item.name.toLowerCase().trim();
                  const page = FOLDER_PAGE_MAP[nameLower] || null;
                  return <FolderRow key={item.id} folder={item} statementType={item.statementType} page={page} companyId={companyId} />;
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Choose Folder view ── */}
        {mode === MODE_FOLDER && (
          <div className="rounded-2xl border border-border bg-bg-card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-page">
              <div className="flex items-center gap-2">
                <FolderOpen size={15} className="text-primary" />
                <span className="text-[13px] font-semibold text-text-primary">Upload Folders</span>
              </div>
              {localFiles.length > 0 && !isSyncing && (
                <button type="button" onClick={() => setLocalFiles([])} className="text-[12px] text-text-muted hover:text-red-500 transition-colors">
                  Clear all
                </button>
              )}
            </div>

            {localFiles.length === 0 ? (
              <div className="p-4">
                <DropZone onFilesSelected={handleFilesSelected} />
              </div>
            ) : (
              <>
                <div>
                  {localFiles.map((entry) => (
                    <LocalFileRow key={entry.id} entry={entry} onRemove={handleRemoveFile} onTypeChange={handleTypeChange} />
                  ))}
                </div>
                {!isSyncing && (
                  <div className="px-4 py-3 border-t border-border">
                    <button
                      type="button"
                      onClick={() => {
                        const input = document.createElement("input");
                        input.type = "file";
                        input.webkitdirectory = true;
                        input.multiple = true;
                        input.onchange = (e) => {
                          const files = Array.from(e.target.files || []).filter(isAllowedFile);
                          if (files.length) handleFilesSelected(files);
                        };
                        input.click();
                      }}
                      className="flex items-center gap-2 text-[13px] font-medium text-primary hover:underline transition-colors"
                    >
                      <FolderOpen size={14} />
                      Add another folder
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Progress bar */}
        {syncProgress && (
          <div className="rounded-2xl border border-border bg-bg-card px-5 py-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium text-text-primary">{syncProgress.label}</span>
              {syncProgress.phase === "upload" && (
                <span className="text-[12px] text-text-muted tabular-nums">{syncProgress.done}/{syncProgress.total}</span>
              )}
            </div>
            <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
              {syncProgress.phase === "upload" ? (
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
                  style={{ width: `${Math.max(4, Math.round((syncProgress.done / syncProgress.total) * 100))}%` }}
                />
              ) : (
                <div className="h-full rounded-full bg-primary/60 animate-pulse" style={{ width: "100%" }} />
              )}
            </div>
          </div>
        )}

        {/* Sync All button */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSyncAll}
            disabled={!canSync}
            className="btn-primary h-11 px-6 justify-center"
          >
            {isSyncing ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
            {isSyncing ? "Syncing…" : "Sync All"}
          </button>
          <p className="text-[13px] text-text-secondary">
            {mode === MODE_FOLDER
              ? "Uploads and syncs the selected files. Replaces any previously synced data."
              : "Reads all files from each mapped subfolder and pushes them to their report pages."}
          </p>
        </div>

        <SyncResultPanel result={lastSyncResult} />
      </div>
    </div>
  );
}

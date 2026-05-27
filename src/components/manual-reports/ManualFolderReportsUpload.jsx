import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Loader2,
  RefreshCw,
  X,
  XCircle,
} from "lucide-react";
import { getManualFolderFiles, getManualUploadSourceTree, getManualUploadProgress, syncManualUploadSource } from "../../lib/api";
import { cn } from "../../lib/utils";
import { useToast } from "../../context/ToastContext";

const STATEMENT_META = {
  balance_sheet: { label: "Balance Sheet", page: "Balance Sheet page" },
  profit_and_loss: { label: "Profit & Loss", page: "Reports page" },
  cash_flow: { label: "Cash Flow", page: "Cash Flow page" },
};

const FOLDER_PAGE_MAP = {
  "bank statement": "Bank Statement page",
  "tax return": "Tax Return page",
};

function FileIcon({ fileName, ext, size = 13 }) {
  const isPdf = String(ext || "").toLowerCase() === "pdf" ||
    String(fileName || "").toLowerCase().endsWith(".pdf");
  return isPdf
    ? <FileText size={size} className="text-red-500 shrink-0" />
    : <FileSpreadsheet size={size} className="text-primary shrink-0" />;
}

// ─── Folder files popup ───────────────────────────────────────────────────────

function FolderFilesPopup({ folder, companyId, anchorRef, onClose }) {
  const [files, setFiles] = useState(null);
  const [loading, setLoading] = useState(true);
  const popupRef = useRef(null);

  // Position the popup relative to the anchor row
  const [style, setStyle] = useState({});
  useEffect(() => {
    if (!anchorRef?.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const popupWidth = 320;
    const spaceRight = window.innerWidth - rect.right - 8;
    const spaceLeft = rect.left - 8;
    let left;
    if (spaceRight >= popupWidth) {
      left = rect.right + 8;
    } else if (spaceLeft >= popupWidth) {
      left = rect.left - popupWidth - 8;
    } else {
      left = Math.max(8, rect.left);
    }
    const top = Math.min(rect.top, window.innerHeight - 320);
    setStyle({ position: "fixed", top, left, width: popupWidth, zIndex: 50 });
  }, [anchorRef]);

  // Dismiss on outside click or Escape
  useEffect(() => {
    function handleKey(e) { if (e.key === "Escape") onClose(); }
    function handleClick(e) {
      if (popupRef.current && !popupRef.current.contains(e.target) &&
          anchorRef?.current && !anchorRef.current.contains(e.target)) {
        onClose();
      }
    }
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose, anchorRef]);

  useEffect(() => {
    if (folder?.isGenerated) {
      setFiles([]);
      setLoading(false);
      return;
    }
    if (!folder?.id || !companyId) return;
    setLoading(true);
    getManualFolderFiles({ clientId: companyId, folderId: folder.id })
      .then(setFiles)
      .catch(() => setFiles([]))
      .finally(() => setLoading(false));
  }, [folder?.id, folder?.isGenerated, companyId]);

  if (!style.top && !style.left) return null;

  return (
    <div
      ref={popupRef}
      style={style}
      className="rounded-2xl border border-border bg-bg-card shadow-[var(--shadow-dropdown)] overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border bg-bg-page">
        <div className="flex items-center gap-2 min-w-0">
          <FolderOpen size={14} className="text-primary shrink-0" />
          <span className="text-[13px] font-semibold text-text-primary truncate">{folder.name}</span>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 rounded-md p-1 text-text-muted hover:bg-border hover:text-text-primary transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* Body */}
      <div className="max-h-64 overflow-y-auto">
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-5 text-[13px] text-text-secondary">
            <Loader2 size={13} className="animate-spin shrink-0" />
            Loading files…
          </div>
        ) : !files || files.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-5 text-[13px] text-text-muted">
            <FolderOpen size={13} className="shrink-0" />
            {folder?.isGenerated
              ? `${folder.fileCount || 0} statement${(folder.fileCount || 0) !== 1 ? "s" : ""} auto-generated during Sync All`
              : "No files uploaded yet."}
          </div>
        ) : (
          <div>
            {files.map((file, i) => (
              <div
                key={file.id || i}
                className="flex items-center gap-2.5 px-4 py-2.5 border-b border-border last:border-b-0 hover:bg-bg-page/60 transition-colors"
              >
                <FileIcon fileName={file.name} ext={file.ext} size={13} />
                <div className="min-w-0 flex-1">
                  <div
                    className="text-[12px] font-medium text-text-primary truncate"
                    title={file.name}
                  >
                    {file.name}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    {file.uploaded_at && (
                      <span className="text-[11px] text-text-muted">
                        {new Date(file.uploaded_at).toLocaleDateString("en-US", {
                          month: "short", day: "numeric", year: "numeric",
                        })}
                      </span>
                    )}
                    {file.size > 0 && (
                      <span className="text-[11px] text-text-muted">
                        · {file.size < 1024 * 1024
                          ? `${Math.round(file.size / 1024)} KB`
                          : `${(file.size / (1024 * 1024)).toFixed(1)} MB`}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      {files && files.length > 0 && (
        <div className="px-4 py-2 border-t border-border bg-bg-page">
          <span className="text-[11px] text-text-muted">
            {files.length} file{files.length !== 1 ? "s" : ""}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Folder row ───────────────────────────────────────────────────────────────

function FolderRow({ folder, statementType, page, isSubItem = false, companyId }) {
  const meta = statementType ? STATEMENT_META[statementType] : null;
  const destinationPage = page || meta?.page || null;
  const { name, fileCount } = folder;

  const [popupOpen, setPopupOpen] = useState(false);
  const rowRef = useRef(null);

  return (
    <>
      <div
        ref={rowRef}
        onClick={() => setPopupOpen((v) => !v)}
        className={cn(
          "flex items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-b-0 cursor-pointer",
          "hover:bg-primary/5 transition-colors",
          isSubItem && "pl-8 bg-bg-page/50 hover:bg-primary/5",
          popupOpen && "bg-primary/5",
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <FolderOpen size={15} className={cn("shrink-0", isSubItem ? "text-text-muted" : "text-primary")} />
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-text-primary truncate">{name}</div>
            {destinationPage && (
              <div className="text-[11px] text-text-muted mt-0.5">→ {destinationPage}</div>
            )}
          </div>
        </div>
        <div className="shrink-0">
          <span
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
              fileCount > 0
                ? "bg-primary/10 text-primary"
                : "bg-bg-page text-text-muted ring-1 ring-border",
            )}
          >
            {fileCount} file{fileCount !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {popupOpen && (
        <FolderFilesPopup
          folder={folder}
          companyId={companyId}
          anchorRef={rowRef}
          onClose={() => setPopupOpen(false)}
        />
      )}
    </>
  );
}

// ─── Sync result panel ────────────────────────────────────────────────────────

function SyncResultPanel({ result }) {
  if (!result) return null;
  const { processed = [], failed = [], syncedAt } = result;
  const total = processed.length + failed.length;

  const syncTimeLabel = syncedAt
    ? new Date(syncedAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  return (
    <div className="rounded-2xl border border-border bg-bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-bg-page">
        <div className="flex items-center gap-3">
          <span className="text-[14px] font-semibold text-text-primary">Last Sync Result</span>
          {syncTimeLabel && (
            <span className="text-[12px] text-text-muted">
              · Synced {syncTimeLabel}
            </span>
          )}
        </div>
        <span className="text-[12px] text-text-muted">
          {total} file{total !== 1 ? "s" : ""} found
        </span>
      </div>

      {processed.length === 0 && failed.length === 0 && (
        <div className="px-5 py-4 text-[13px] text-text-secondary">
          No files were found in the mapped folders.
        </div>
      )}

      {processed.length > 0 && (
        <div className="px-5 py-4 border-b border-border last:border-b-0">
          <div className="flex items-center gap-1.5 mb-2">
            <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
            <span className="text-[12px] font-semibold text-emerald-700">
              {processed.length} file{processed.length !== 1 ? "s" : ""} read successfully
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {processed.map((item, i) => (
              <span
                key={`proc-${item.documentId || i}`}
                className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-[12px] font-medium text-emerald-800 ring-1 ring-emerald-200"
              >
                <FileIcon fileName={item.fileName} />
                <span className="truncate max-w-[200px]" title={item.fileName}>{item.fileName}</span>
                {item.folderName && (
                  <span className="text-emerald-500">· {item.folderName}</span>
                )}
                {item.taxYear && (
                  <span className="text-emerald-500">· FY {item.taxYear}</span>
                )}
                {item.plYear && (
                  <span className="text-emerald-500">· FY {item.plYear}</span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {failed.length > 0 && (
        <div className="px-5 py-4">
          <div className="flex items-center gap-1.5 mb-2">
            <XCircle size={13} className="text-red-500 shrink-0" />
            <span className="text-[12px] font-semibold text-red-700">
              {failed.length} file{failed.length !== 1 ? "s" : ""} could not be read
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {failed.map((item, i) => (
              <span
                key={`fail-${item.documentId || i}`}
                className="flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1 text-[12px] font-medium text-red-800 ring-1 ring-red-200"
                title={item.reason || ""}
              >
                <XCircle size={10} className="text-red-400 shrink-0" />
                <span className="truncate max-w-[180px]">{item.fileName || item.folderName}</span>
                {item.reason && (
                  <span className="text-red-400 truncate max-w-[160px]">· {item.reason}</span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ManualFolderReportsUpload({
  companyId,
  title = "Manual Upload (Excel or PDF)",
  description = "Files uploaded to the 'Manual Upload Source' folder in Data Room are automatically mapped to their respective report pages.",
}) {
  const { showToast } = useToast();
  const [sourceTree, setSourceTree] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState("");
  const [manualUploadProgress, setManualUploadProgress] = useState(null);
  const syncPollRef = useRef(null);
  const [lastSyncResult, setLastSyncResult] = useState(() => {
    if (!companyId) return null;
    try {
      const stored = sessionStorage.getItem(`conn-source-result-${companyId}`);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (!companyId) return;
    if (lastSyncResult) {
      sessionStorage.setItem(`conn-source-result-${companyId}`, JSON.stringify(lastSyncResult));
    } else {
      sessionStorage.removeItem(`conn-source-result-${companyId}`);
    }
  }, [companyId, lastSyncResult]);

  const loadTree = useCallback(async () => {
    if (!companyId) return;
    setIsLoading(true);
    try {
      const tree = await getManualUploadSourceTree({ clientId: companyId });
      setSourceTree(tree);
    } catch (error) {
      setSourceTree(null);
      showToast({ type: "error", title: "Load failed", message: error?.message || "Could not load Manual Upload Source folder." });
    } finally {
      setIsLoading(false);
    }
  }, [companyId, showToast]);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  const totalFiles = sourceTree
    ? sourceTree.children?.reduce((sum, item) => {
        if (item.isGroup) return sum + (item.children || []).reduce((s, c) => s + (c.fileCount || 0), 0);
        return sum + (item.fileCount || 0);
      }, 0)
    : 0;

  const handleSync = async () => {
    if (!companyId) return;
    if (totalFiles === 0) {
      showToast({ type: "error", title: "No files", message: "Upload files to the Manual Upload Source folder first." });
      return;
    }
    try {
      setIsSyncing(true);
      setSyncProgress("Reading all files…");
      setManualUploadProgress({ totalFiles: 0, processedFiles: 0, currentFile: "", currentStep: "Starting...", percentage: 0, active: true });

      // Poll for live progress every second while sync runs
      syncPollRef.current = setInterval(async () => {
        try {
          const prog = await getManualUploadProgress({ clientId: companyId });
          if (prog) setManualUploadProgress(prog);
        } catch { /* ignore poll errors */ }
      }, 1000);

      const result = await syncManualUploadSource({ clientId: companyId });

      clearInterval(syncPollRef.current);
      syncPollRef.current = null;

      // Show 100% briefly then clear
      setManualUploadProgress({ totalFiles: result?.processedCount || 0, processedFiles: result?.processedCount || 0, currentFile: "", currentStep: "Sync completed successfully", percentage: 100, active: false });
      setTimeout(() => setManualUploadProgress(null), 5000);

      setLastSyncResult({ ...result, syncedAt: new Date().toISOString() });
      await loadTree();
      const p = result?.processedCount || 0;
      const f = result?.failed?.length || 0;
      showToast({
        type: p > 0 ? "success" : "error",
        title: p > 0 ? "Sync complete" : "Sync finished with errors",
        message: f > 0
          ? `${p} file(s) read successfully, ${f} could not be processed.`
          : `${p} file(s) read successfully from Manual Upload Source.`,
      });
    } catch (error) {
      clearInterval(syncPollRef.current);
      syncPollRef.current = null;
      setManualUploadProgress(null);
      showToast({ type: "error", title: "Sync failed", message: error?.message || "Could not sync Manual Upload Source." });
    } finally {
      setIsSyncing(false);
      setSyncProgress("");
    }
  };

  return (
    <div className="card-base overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-6 py-5">
        <div>
          <h2 className="text-[24px] font-semibold text-text-primary">{title}</h2>
          <p className="mt-1 text-[14px] text-text-secondary">{description}</p>
        </div>
        <button
          type="button"
          onClick={loadTree}
          disabled={isLoading || isSyncing}
          className="btn-secondary"
        >
          <RefreshCw size={16} className={cn(isLoading ? "animate-spin" : "")} />
          Refresh
        </button>
      </div>

      <div className="space-y-6 p-6">
        <div className="rounded-2xl border border-border bg-bg-card overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-page">
            <div className="flex items-center gap-2">
              <FolderOpen size={16} className="text-primary" />
              <span className="text-[13px] font-semibold text-text-primary">Manual Upload Source</span>
            </div>
            <span className="text-[12px] text-text-muted">{totalFiles} total file(s)</span>
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 px-4 py-6 text-[13px] text-text-secondary">
              <Loader2 size={14} className="animate-spin" />
              Loading folder structure…
            </div>
          ) : !sourceTree ? (
            <div className="flex items-center gap-2 px-4 py-6 text-[13px] text-text-secondary">
              <AlertCircle size={14} className="text-amber-500" />
              "Manual Upload Source" folder not found. It will be created automatically when you visit the Data Room.
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
                        <FolderRow
                          key={sub.id}
                          folder={sub}
                          statementType={sub.statementType}
                          isSubItem
                          companyId={companyId}
                        />
                      ))}
                    </div>
                  );
                }
                const nameLower = item.name.toLowerCase().trim();
                const page = FOLDER_PAGE_MAP[nameLower] || null;
                return (
                  <FolderRow
                    key={item.id}
                    folder={item}
                    statementType={item.statementType}
                    page={page}
                    companyId={companyId}
                  />
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSync}
            disabled={isSyncing || isLoading || !sourceTree}
            className="btn-primary h-11 px-6 justify-center"
          >
            {isSyncing ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <CheckCircle2 size={16} />
            )}
            {isSyncing ? "Syncing…" : "Sync All"}
          </button>
          {!isSyncing && !manualUploadProgress && (
            <p className="text-[13px] text-text-secondary">
              Reads all files from each mapped subfolder and pushes them to their respective report pages.
            </p>
          )}
        </div>

        {manualUploadProgress && (
          <div className="rounded-2xl border border-border bg-bg-card px-5 py-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold text-text-primary">
                {manualUploadProgress.percentage === 100 ? "Sync Complete" : "Syncing files..."}
              </span>
              <span className="text-[12px] font-semibold text-primary tabular-nums">
                {manualUploadProgress.percentage}%
              </span>
            </div>
            <div className="h-2.5 rounded-full bg-gray-100 overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
                style={{ width: `${Math.max(2, manualUploadProgress.percentage)}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[12px] text-text-muted">
              <span>{manualUploadProgress.processedFiles} / {manualUploadProgress.totalFiles} files processed</span>
              {manualUploadProgress.percentage === 100 && (
                <span className="flex items-center gap-1 text-green-600 font-medium">
                  <CheckCircle2 size={13} /> Sync Complete
                </span>
              )}
            </div>
            {manualUploadProgress.currentFile && manualUploadProgress.percentage < 100 && (
              <div className="rounded-xl border border-border bg-bg-page px-3 py-2 space-y-0.5">
                <p className="text-[11px] text-text-muted">Current file</p>
                <p className="text-[12px] font-medium text-text-primary truncate">{manualUploadProgress.currentFile}</p>
                {manualUploadProgress.currentStep && (
                  <p className="text-[11px] text-text-muted">{manualUploadProgress.currentStep}...</p>
                )}
              </div>
            )}
          </div>
        )}

        <SyncResultPanel result={lastSyncResult} />
      </div>
    </div>
  );
}

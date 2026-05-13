import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  listFolderDocuments,
  listFolderTree,
  syncManualReportFolder,
} from "../../lib/api";
import { cn } from "../../lib/utils";
import { useToast } from "../../context/ToastContext";

function flattenFolderTree(nodes = [], depth = 0, parentPath = "") {
  return nodes.flatMap((node) => {
    const pathLabel = parentPath ? `${parentPath} / ${node.name}` : node.name;
    const current = {
      id: node.id,
      name: node.name || "Untitled Folder",
      depth,
      pathLabel,
    };
    return [
      current,
      ...flattenFolderTree(node.children || [], depth + 1, pathLabel),
    ];
  });
}

function inferReportLabel(name = "") {
  const normalized = String(name || "").toLowerCase();
  if (normalized.includes("balance")) return "Balance Sheet";
  if (normalized.includes("profit") || normalized.includes("income"))
    return "Profit & Loss";
  if (normalized.includes("cash")) return "Cash Flow";
  return "Other File";
}

export default function ManualFolderReportsUpload({
  companyId,
  title = "Manual Upload (Excel or PDF)",
  description = "Select a Data Room folder that contains Balance Sheet, Profit & Loss, and Cash Flow files.",
}) {
  const { showToast } = useToast();
  const [folders, setFolders] = useState([]);
  const [selectedFolderId, setSelectedFolderId] = useState("");
  const [folderDocuments, setFolderDocuments] = useState([]);
  const [isLoadingFolders, setIsLoadingFolders] = useState(true);
  const [isLoadingDocuments, setIsLoadingDocuments] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncResult, setLastSyncResult] = useState(null);

  const refreshFolders = useCallback(async () => {
    if (!companyId) {
      setFolders([]);
      setSelectedFolderId("");
      setIsLoadingFolders(false);
      return;
    }

    try {
      setIsLoadingFolders(true);
      const tree = await listFolderTree(companyId);
      const flattened = flattenFolderTree(tree || []);
      setFolders(flattened);
      setSelectedFolderId((current) =>
        current && flattened.some((folder) => folder.id === current)
          ? current
          : flattened[0]?.id || "",
      );
    } catch (error) {
      setFolders([]);
      showToast({
        type: "error",
        title: "Folder load failed",
        message: error?.message || "Could not load Data Room folders.",
      });
    } finally {
      setIsLoadingFolders(false);
    }
  }, [companyId, showToast]);

  const refreshDocuments = useCallback(async () => {
    if (!selectedFolderId) {
      setFolderDocuments([]);
      return;
    }

    try {
      setIsLoadingDocuments(true);
      const documents = await listFolderDocuments(selectedFolderId);
      setFolderDocuments(Array.isArray(documents) ? documents : []);
    } catch (error) {
      setFolderDocuments([]);
      showToast({
        type: "error",
        title: "Document load failed",
        message:
          error?.message || "Could not load documents for the selected folder.",
      });
    } finally {
      setIsLoadingDocuments(false);
    }
  }, [selectedFolderId, showToast]);

  useEffect(() => {
    Promise.resolve().then(() => {
      refreshFolders();
    });
  }, [refreshFolders]);

  useEffect(() => {
    Promise.resolve().then(() => {
      refreshDocuments();
    });
  }, [refreshDocuments]);

  const selectedFolder = useMemo(
    () => folders.find((folder) => folder.id === selectedFolderId) || null,
    [folders, selectedFolderId],
  );

  const reportCandidates = useMemo(
    () =>
      folderDocuments.filter((doc) =>
        [".xlsx", ".xls", ".csv", ".pdf"].some((extension) =>
          String(doc?.name || "")
            .toLowerCase()
            .endsWith(extension),
        ),
      ),
    [folderDocuments],
  );

  const handleSync = async () => {
    if (!companyId || !selectedFolderId || !selectedFolder) {
      showToast({
        type: "error",
        title: "Select a folder",
        message:
          "Choose a folder that contains the financial report files first.",
      });
      return;
    }

    try {
      setIsSyncing(true);
      const result = await syncManualReportFolder(
        {
          folderId: selectedFolderId,
          folderName: selectedFolder.pathLabel || selectedFolder.name,
        },
        { clientId: companyId },
      );
      setLastSyncResult(result);
      showToast({
        type: "success",
        title: "Folder synced",
        message: `Processed ${result?.processedCount || 0} report file(s) from the selected folder.`,
      });
    } catch (error) {
      setLastSyncResult(null);
      showToast({
        type: "error",
        title: "Sync failed",
        message: error?.message || "Could not sync the selected report folder.",
      });
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div className="card-base overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-6 py-5">
        <div>
          <h2 className="text-[24px] font-semibold text-text-primary">
            {title}
          </h2>
          <p className="mt-1 text-[14px] text-text-secondary">{description}</p>
        </div>
        <button
          type="button"
          onClick={refreshFolders}
          disabled={isLoadingFolders || isSyncing}
          className="btn-secondary"
        >
          <RefreshCw
            size={16}
            className={cn(isLoadingFolders ? "animate-spin" : "")}
          />
          Refresh
        </button>
      </div>

      <div className="space-y-6 p-6">
        <div className="grid gap-5 lg:grid-cols-[minmax(280px,360px)_1fr]">
          <div className="space-y-3">
            <label className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">
              Report Folder
            </label>
            <div className="relative">
              <select
                value={selectedFolderId}
                onChange={(event) => setSelectedFolderId(event.target.value)}
                disabled={isLoadingFolders || !folders.length}
                className="h-11 w-full rounded-lg border border-border-input bg-bg-card px-3 text-[14px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {!folders.length && (
                  <option value="">No folders available</option>
                )}
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.pathLabel}
                  </option>
                ))}
              </select>
            </div>
            <div className="rounded-xl border border-border bg-bg-page px-4 py-3 text-[13px] text-text-secondary">
              <div className="flex items-center gap-2 font-medium text-text-primary">
                <FolderOpen size={16} className="text-primary" />
                {selectedFolder?.pathLabel || "No folder selected"}
              </div>
              {/* <p className="mt-2">
                The sync will scan this folder for Excel, CSV, and PDF files that look like
                Balance Sheet, Profit & Loss, or Cash Flow reports.
              </p> */}
            </div>
            <button
              type="button"
              onClick={handleSync}
              disabled={isSyncing || !selectedFolderId}
              className="btn-primary h-11 w-full justify-center"
            >
              {isSyncing ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <CheckCircle2 size={16} />
              )}
              Sync Folder Reports
            </button>
          </div>

          <div className="rounded-2xl border border-border bg-bg-card p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-[13px] font-semibold uppercase tracking-wide text-text-muted">
                  Folder Documents
                </h3>
                <p className="mt-1 text-[13px] text-text-secondary">
                  Files in the selected folder that can be used for report
                  ingestion.
                </p>
              </div>
              <span className="rounded-full bg-bg-page px-3 py-1 text-[12px] font-medium text-text-secondary">
                {reportCandidates.length} candidate file(s)
              </span>
            </div>

            <div className="mt-4 max-h-[360px] overflow-y-auto rounded-xl border border-border bg-white">
              {isLoadingDocuments ? (
                <div className="flex items-center gap-2 px-4 py-5 text-[13px] text-text-secondary">
                  <Loader2 size={14} className="animate-spin" />
                  Loading folder documents...
                </div>
              ) : !reportCandidates.length ? (
                <div className="px-4 py-5 text-[13px] text-text-secondary">
                  No Excel, CSV, or PDF report files found in this folder yet.
                </div>
              ) : (
                reportCandidates.map((doc) => (
                  <div
                    key={doc.id}
                    className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="truncate text-[14px] font-medium text-text-primary">
                          {doc.name}
                        </div>
                        {String(doc.name || "").toLowerCase().endsWith(".pdf") && (
                          <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-red-50 text-red-600 ring-1 ring-red-200">
                            PDF
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-[12px] text-text-secondary">
                        {inferReportLabel(doc.name)}
                      </div>
                    </div>
                    {String(doc.name || "").toLowerCase().endsWith(".pdf") ? (
                      <FileText size={16} className="shrink-0 text-red-500" />
                    ) : (
                      <FileSpreadsheet size={16} className="shrink-0 text-primary" />
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {lastSyncResult && (
          <div className="rounded-2xl border border-primary/20 bg-primary/5 px-5 py-4">
            <div className="text-[14px] font-semibold text-text-primary">
              Last Sync Result
            </div>
            <p className="mt-1 text-[13px] text-text-secondary">
              Processed {lastSyncResult.processedCount || 0} file(s) from{" "}
              <span className="font-medium text-text-primary">
                {lastSyncResult.folderName ||
                  selectedFolder?.pathLabel ||
                  "selected folder"}
              </span>
              .
            </p>
            {!!lastSyncResult.processed?.length && (
              <div className="mt-3 flex flex-wrap gap-2">
                {lastSyncResult.processed.map((item) => (
                  <span
                    key={`${item.documentId}-${item.statementType}`}
                    className="rounded-full bg-white px-3 py-1 text-[12px] font-medium text-text-secondary ring-1 ring-border"
                  >
                    {item.fileName} • {item.statementType.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

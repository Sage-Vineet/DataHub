import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Plus,
  Copy,
  CheckCircle2,
  RefreshCw,
  Link2,
  Trash2,
  FileText,
  Loader2,
  Star,
} from "lucide-react";
import {
  getKeyReportVersions,
  createKeyReportVersion,
  getKeyReportVersion,
  duplicateKeyReportVersion,
  activateKeyReportVersion,
  addKeyReportMapping,
  removeKeyReportMapping,
  syncKeyReportVersion,
  getKeyReportPopupPreference,
  setKeyReportPopupPreference,
} from "../../../lib/api";
import { useToast } from "../../../context/ToastContext";
import DataRoomFilePicker from "../../../components/key-reports/DataRoomFilePicker";
import KeyReportsEducationPopup from "../../../components/key-reports/KeyReportsEducationPopup";
import ChartOfAccountsPanel from "../../../components/key-reports/ChartOfAccountsPanel";
import KeyReportSyncDashboard from "../../../components/key-reports/KeyReportSyncDashboard";

const CATEGORIES = [
  { key: "profit_loss", label: "Profit & Loss" },
  { key: "balance_sheet", label: "Balance Sheet" },
  { key: "general_ledger", label: "General Ledger" },
  { key: "bank_statement", label: "Bank Statements" },
  { key: "tax_return", label: "Tax Returns" },
];

function createInitialSyncState() {
  return {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    summary: null,
    warnings: [],
    validationResults: [],
    error: null,
  };
}

export default function WorkspaceKeyReports() {
  const { clientId } = useParams();
  const toast = useToast();

  const [versions, setVersions] = useState([]);
  const [selectedVersionId, setSelectedVersionId] = useState(null);
  const [detail, setDetail] = useState(null); // { version, mappingsByCategory, syncLogs }
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncState, setSyncState] = useState(() => createInitialSyncState());
  const [pickerCategory, setPickerCategory] = useState(null);
  const [showPopup, setShowPopup] = useState(false);

  const notify = useCallback(
    (msg, type = "info") => {
      toast?.showToast?.({ type, title: msg });
    },
    [toast]
  );

  // First-visit educational popup
  useEffect(() => {
    let cancelled = false;
    getKeyReportPopupPreference()
      .then((res) => {
        if (!cancelled && res && !res.dismissed) setShowPopup(true);
      })
      .catch(() => { });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadVersions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getKeyReportVersions();
      const list = res?.versions || [];
      setVersions(list);
      setSelectedVersionId((prev) => {
        if (prev && list.some((v) => v.id === prev)) return prev;
        const active = list.find((v) => v.isActive);
        return active?.id || list[0]?.id || null;
      });
    } catch (e) {
      notify(e.message || "Failed to load Key Reports.", "error");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void Promise.resolve().then(() => loadVersions());
  }, [loadVersions]);

  const loadDetail = useCallback(async (versionId) => {
    if (!versionId) {
      setDetail(null);
      return;
    }
    try {
      const res = await getKeyReportVersion(versionId);
      setDetail(res);
    } catch {
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => loadDetail(selectedVersionId));
  }, [selectedVersionId, loadDetail]);

  useEffect(() => {
    void Promise.resolve().then(() => setSyncState(createInitialSyncState()));
  }, [selectedVersionId]);

  const linkedDocumentIds = useMemo(() => {
    if (!detail?.mappingsByCategory) return [];
    return Object.values(detail.mappingsByCategory)
      .flat()
      .map((m) => m.documentId)
      .filter(Boolean);
  }, [detail]);

  const linkedDocumentCount = linkedDocumentIds.length;

  const handleCreateVersion = async () => {
    setBusy(true);
    try {
      await createKeyReportVersion(clientId, {});
      await loadVersions();
      notify("New version created (mappings copied from the latest version).", "success");
    } catch (e) {
      notify(e.message || "Failed to create version.", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleDuplicate = async () => {
    if (!selectedVersionId) return;
    setBusy(true);
    try {
      const res = await duplicateKeyReportVersion(selectedVersionId, {});
      await loadVersions();
      if (res?.version?.id) setSelectedVersionId(res.version.id);
      notify("Version duplicated.", "success");
    } catch (e) {
      notify(e.message || "Failed to duplicate version.", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleActivate = async () => {
    if (!selectedVersionId) return;
    setBusy(true);
    try {
      await activateKeyReportVersion(selectedVersionId);
      await loadVersions();
      await loadDetail(selectedVersionId);
      notify("This version is now the official source of truth.", "success");
    } catch (e) {
      notify(e.message || "Failed to activate version.", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleSync = async () => {
    if (!selectedVersionId) return;
    const startedAt = new Date().toISOString();
    setSyncing(true);
    setSyncState({
      status: "processing",
      startedAt,
      finishedAt: null,
      summary: null,
      warnings: [],
      validationResults: [],
      error: null,
    });
    try {
      const res = await syncKeyReportVersion(selectedVersionId);
      setSyncState({
        status: "validation",
        startedAt,
        finishedAt: new Date().toISOString(),
        summary: res?.result?.summary || null,
        warnings: Array.isArray(res?.warnings) ? res.warnings : [],
        validationResults: Array.isArray(res?.validationResults) ? res.validationResults : [],
        error: null,
      });
      await Promise.all([
        loadDetail(selectedVersionId),
        loadVersions(),
      ]);
      const warnCount = res?.warnings?.length || 0;
      notify(`Sync complete${warnCount ? ` (${warnCount} warning${warnCount === 1 ? "" : "s"})` : ""}.`, "success");
    } catch (e) {
      const message = e.message || "Sync failed.";
      setSyncState({
        status: "error",
        startedAt,
        finishedAt: new Date().toISOString(),
        summary: null,
        warnings: [],
        validationResults: [],
        error: message,
      });
      notify(message, "error");
    } finally {
      setSyncing(false);
    }
  };

  const handleSyncClick = () => {
    if (linkedDocumentCount === 0) {
      notify("Link at least one document in Key Reports before syncing.", "error");
      return;
    }

    void handleSync();
  };

  const handleLinkFiles = async (docs) => {
    if (!selectedVersionId || !pickerCategory || !docs?.length) return;
    try {
      await addKeyReportMapping(selectedVersionId, {
        reportCategory: pickerCategory,
        documentIds: docs.map((d) => d.id),
      });
      setSyncState(createInitialSyncState());
      await loadDetail(selectedVersionId);
      notify(`Linked ${docs.length} file${docs.length === 1 ? "" : "s"}.`, "success");
    } catch (e) {
      notify(e.message || "Failed to link files.", "error");
    }
  };

  const handleUnlink = async (mappingId) => {
    try {
      await removeKeyReportMapping(mappingId);
      setSyncState(createInitialSyncState());
      await loadDetail(selectedVersionId);
      notify("File unlinked.", "success");
    } catch (e) {
      notify(e.message || "Failed to unlink file.", "error");
    }
  };

  const dismissPopupForever = () => {
    setKeyReportPopupPreference(true).catch(() => { });
  };

  const version = detail?.version;
  const mappingsByCategory = detail?.mappingsByCategory || {};
  const lastSync = detail?.syncLogs?.[0];
  const persistedValidationResults = Array.isArray(detail?.validationResults) ? detail.validationResults : [];
  const displaySyncState = {
    ...syncState,
    status: syncState.status === "idle" && persistedValidationResults.length > 0 ? "validation" : syncState.status,
    validationResults: Array.isArray(syncState.validationResults) && syncState.validationResults.length > 0
      ? syncState.validationResults
      : persistedValidationResults,
  };

  return (
    <div className="p-6">
      {showPopup && (
        <KeyReportsEducationPopup onClose={() => setShowPopup(false)} onDismissForever={dismissPopupForever} />
      )}

      <DataRoomFilePicker
        isOpen={!!pickerCategory}
        companyId={clientId}
        title={`Link files - ${CATEGORIES.find((c) => c.key === pickerCategory)?.label || ""}`}
        alreadyLinkedIds={linkedDocumentIds}
        onClose={() => setPickerCategory(null)}
        onSelect={handleLinkFiles}
      />

      {/* Header */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Key Reports</h1>
          <p className="mt-1 text-sm text-secondary">
            Select the official files that drive financial reports, CIM Preparation, and Quality of Earnings.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Version selector */}
          <select
            value={selectedVersionId || ""}
            onChange={(e) => setSelectedVersionId(e.target.value)}
            disabled={syncing}
            className="rounded-xl border border-border bg-white px-3 py-2 text-sm text-text-primary disabled:opacity-50"
          >
            {versions.length === 0 && <option value="">No versions</option>}
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.versionName || `Version ${v.versionNumber}`}
                {v.isActive ? " * (official)" : ""}
              </option>
            ))}
          </select>
          <button
            onClick={handleCreateVersion}
            disabled={busy || syncing}
            className="flex items-center gap-1.5 rounded-xl border border-border bg-white px-3 py-2 text-sm font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
          >
            <Plus size={15} /> New
          </button>
          <button
            onClick={handleDuplicate}
            disabled={busy || syncing || !selectedVersionId}
            className="flex items-center gap-1.5 rounded-xl border border-border bg-white px-3 py-2 text-sm font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
          >
            <Copy size={15} /> Duplicate
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-16 text-sm text-text-muted">
          <Loader2 size={16} className="animate-spin" /> Loading...
        </div>
      ) : versions.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-white p-10 text-center">
          <FileText size={28} className="mx-auto text-text-muted" />
          <p className="mt-3 text-sm font-medium text-text-primary">No Key Report versions yet</p>
          <p className="mt-1 text-sm text-secondary">Create your first version to start linking official files.</p>
          <button
            onClick={handleCreateVersion}
            disabled={busy}
            className="mx-auto mt-4 flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            <Plus size={15} /> Create Version 1
          </button>
        </div>
      ) : (
        <>
          {/* Version status bar */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-white px-5 py-3">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-text-primary">
                {version?.versionName || `Version ${version?.versionNumber}`}
              </span>
              {version?.isActive ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-[#EEF6E0] px-2.5 py-0.5 text-xs font-semibold text-primary">
                  <Star size={12} /> Official source
                </span>
              ) : (
                <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-text-muted">
                  {version?.status || "draft"}
                </span>
              )}
              {version?.lastSyncedAt && (
                <span className="text-xs text-text-muted">
                  Last synced {new Date(version.lastSyncedAt).toLocaleString()}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {!version?.isActive && (
                <button
                  onClick={handleActivate}
                  disabled={busy || syncing}
                  className="flex items-center gap-1.5 rounded-xl border border-primary px-3 py-2 text-sm font-semibold text-primary hover:bg-[#F0F7E6] disabled:opacity-50"
                >
                  <CheckCircle2 size={15} /> Set as official
                </button>
              )}
              <button
                onClick={handleSyncClick}
                disabled={!selectedVersionId || syncing}
                className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {syncing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                {syncing ? "Syncing..." : "Sync"}
              </button>
            </div>
          </div>

          {lastSync?.sync_status === "failed" && (
            <div className="mb-4 rounded-xl bg-red-50 px-4 py-2 text-sm text-negative">
              Last sync failed: {lastSync.error_message}
            </div>
          )}

          <KeyReportSyncDashboard
            version={version}
            syncState={displaySyncState}
            hasLinkedDocuments={linkedDocumentCount > 0}
          />

          {/* Category panels */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {CATEGORIES.map((cat) => {
              const items = mappingsByCategory[cat.key] || [];
              return (
                <div key={cat.key} className="rounded-2xl border border-border bg-white p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-bold text-text-primary">{cat.label}</h3>
                    <button
                      onClick={() => setPickerCategory(cat.key)}
                      disabled={syncing}
                      className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
                    >
                      <Link2 size={13} /> Link Files
                    </button>
                  </div>
                  {items.length === 0 ? (
                    <p className="py-3 text-center text-xs text-text-muted">No files linked yet.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {items.map((m) => (
                        <li
                          key={m.id}
                          className="flex items-center gap-2 rounded-lg bg-bg-page px-2.5 py-1.5 text-sm"
                        >
                          <CheckCircle2 size={14} className="shrink-0 text-primary" />
                          <span className="truncate text-text-primary" title={m.fileName}>
                            {m.fileName || "Untitled file"}
                          </span>
                          <button
                            onClick={() => handleUnlink(m.id)}
                            disabled={syncing}
                            className="ml-auto rounded p-1 text-text-muted hover:bg-white hover:text-negative disabled:opacity-50"
                            title="Unlink"
                          >
                            <Trash2 size={13} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>

          {/* Chart of Accounts (generated by Sync from this version's GL/BS data) */}
          <ChartOfAccountsPanel
            versionId={selectedVersionId}
            hasSyncedData={Boolean(version?.resolvedBatchId) && !syncing}
            notify={notify}
          />
        </>
      )}
    </div>
  );
}

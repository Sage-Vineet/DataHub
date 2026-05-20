import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Link2,
  Loader2,
} from "lucide-react";
import {
  getCompanyRequest,
  getReportSources,
  setSelectedReportSource,
  ensureCompanyDefaultFolders,
} from "../../../lib/api";
import Header from "../../../components/Header";
import QuickBooksConnection from "../../../components/quickbooks/QuickBooksConnection";
import ManualGLUpload from "../../../components/manual-gl/ManualGLUpload";
import ManualFolderReportsUpload from "../../../components/manual-reports/ManualFolderReportsUpload";
import { cn } from "../../../lib/utils";
import {
  getReportSourceLabel,
  normalizeReportSourceKey,
  REPORT_SOURCE_KEYS,
} from "../../../lib/report-source";
import { emitWorkspaceDataSourceUpdated } from "../../../lib/dataSourceEvents";
import { useToast } from "../../../context/ToastContext";

const INITIAL_SOURCE_STATE = {
  selectedSource: null,
  activeSource: null,
  quickbooksConnected: false,
  manualUploadActive: false,
  lastSourceSwitchAt: null,
  sources: [],
};

const CONNECTIONS_STORAGE_PREFIX = "datahub-workspace-connections";

function getConnectionsStorageKey(clientId) {
  return `${CONNECTIONS_STORAGE_PREFIX}:${clientId || "default"}`;
}

function getStoredConnectionsState(clientId) {
  if (!clientId || typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(getConnectionsStorageKey(clientId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveStoredConnectionsState(clientId, state) {
  if (!clientId || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      getConnectionsStorageKey(clientId),
      JSON.stringify(state),
    );
  } catch {
    // Ignore storage errors.
  }
}

function formatTimestamp(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getSourceRecord(sources, sourceKey) {
  return Array.isArray(sources)
    ? sources.find(
      (source) => normalizeReportSourceKey(source?.sourceKey) === sourceKey,
    ) || null
    : null;
}

function SourceCard({
  icon,
  title,
  description,
  statusLabel,
  isActive,
  lastActivityLabel,
  actionLabel,
  onAction,
  disabled = false,
  isBusy = false,
  comingSoon = false,
}) {
  return (
    <div
      className={cn(
        "group relative flex flex-col justify-between overflow-hidden rounded-2xl border p-6 transition-all duration-400",
        isActive
          ? "border-primary shadow-md bg-white z-10"
          : comingSoon
            ? "border-border bg-gray-50/50 opacity-60"
            : "border-border bg-bg-card hover:-translate-y-1.5 hover:border-primary/40 hover:shadow-[0_20px_40px_rgba(0,0,0,0.06)]",
      )}
    >

      <div className="relative z-10 flex items-start justify-between gap-3">
        <div className="flex flex-col items-start gap-4 xl:flex-row">
          <div
            className={cn(
              "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl shadow-sm transition-transform duration-500 ease-out group-hover:scale-110 group-hover:rotate-3",
              isActive
                ? "bg-primary text-white shadow-[0_4px_20px_rgba(139,197,61,0.4)]"
                : "bg-gray-100 text-gray-500 group-hover:bg-primary/10 group-hover:text-primary",
            )}
          >
            {icon}
          </div>
          <div className="flex-1">
            <h3 className={cn("text-[17px] font-bold tracking-tight transition-colors duration-300", isActive ? "text-primary-dark" : "text-text-primary group-hover:text-primary-dark")}>
              {title}
            </h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-text-secondary xl:line-clamp-3">
              {description}
            </p>
          </div>
        </div>
      </div>

      <div className="relative z-10 mt-6 flex flex-col gap-4">
        <div className="space-y-3 rounded-xl bg-gray-50/80 p-3.5 backdrop-blur-sm transition-colors duration-300 group-hover:bg-gray-50/95">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[12px] font-medium text-text-secondary">
              <CheckCircle2
                size={16}
                strokeWidth={2.5}
                className={cn(
                  "transition-colors duration-300",
                  isActive ? "text-primary" : comingSoon ? "text-text-muted" : "text-gray-400 group-hover:text-primary/70"
                )}
              />
              <span className={cn(isActive && "text-primary-dark font-semibold")}>{statusLabel}</span>
            </div>
            {isActive ? (
              <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-primary/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-primary ring-1 ring-inset ring-primary/20">
                <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                Active
              </span>
            ) : comingSoon ? (
              <span className="shrink-0 rounded-full bg-gray-200/60 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-500 ring-1 ring-inset ring-black/5">
                Soon
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-3 text-[11px] font-medium text-text-muted">
            <div className="h-px flex-1 bg-gradient-to-r from-transparent via-border to-transparent opacity-60" />
            <span className="whitespace-nowrap">{lastActivityLabel}</span>
            <div className="h-px flex-1 bg-gradient-to-r from-transparent via-border to-transparent opacity-60" />
          </div>
        </div>

        <button
          type="button"
          onClick={onAction}
          disabled={disabled || isBusy || comingSoon}
          className={cn(
            "relative w-full overflow-hidden rounded-xl py-3 text-[13px] font-bold transition-all duration-300",
            isActive
              ? "bg-gray-100 text-text-secondary"
              : comingSoon
                ? "bg-gray-100 text-gray-400"
                : "bg-primary text-white hover:bg-primary-dark shadow-[0_4px_10px_rgba(139,197,61,0.25)] hover:shadow-md hover:-translate-y-0.5",
            (disabled || isBusy || comingSoon) && "cursor-not-allowed",
            (!isActive && !comingSoon && disabled) && "opacity-60 hover:bg-primary hover:shadow-none hover:translate-y-0"
          )}
        >
          <span className="relative z-10 flex items-center justify-center gap-2">
            {isBusy ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                <span>Updating...</span>
              </>
            ) : (
              actionLabel
            )}
          </span>
        </button>
      </div>
    </div>
  );
}

export default function WorkspaceConnections() {
  const { clientId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { showToast } = useToast();
  const storedState = getStoredConnectionsState(clientId);

  const [company, setCompany] = useState(null);
  const [sourceState, setSourceState] = useState(
    storedState?.sourceState || INITIAL_SOURCE_STATE,
  );
  const [isLoadingSources, setIsLoadingSources] = useState(false);
  const [isSwitchingSource, setIsSwitchingSource] = useState(false);
  const [switchingTargetKey, setSwitchingTargetKey] = useState(null);
  const [sourceSwitchModal, setSourceSwitchModal] = useState({
    isOpen: false,
    title: "",
    message: "",
    targetSourceKey: null,
    switchOptions: {},
  });
  const [selectedCardKey, setSelectedCardKey] = useState(
    storedState?.selectedCardKey || null,
  );

  const quickbooksRecord = useMemo(
    () => getSourceRecord(sourceState.sources, REPORT_SOURCE_KEYS.QUICKBOOKS),
    [sourceState.sources],
  );
  const manualRecord = useMemo(
    () => getSourceRecord(sourceState.sources, REPORT_SOURCE_KEYS.MANUAL_GL),
    [sourceState.sources],
  );
  const manualUploadRecord = useMemo(
    () => getSourceRecord(sourceState.sources, REPORT_SOURCE_KEYS.MANUAL_UPLOAD),
    [sourceState.sources],
  );

  const activeSourceKey = normalizeReportSourceKey(
    sourceState.activeSource || sourceState.selectedSource || null,
  );
  const activeSourceLabel = getReportSourceLabel(activeSourceKey);
  const quickbooksConnected = Boolean(
    sourceState.quickbooksConnected || quickbooksRecord?.isConnected,
  );

  const selectedView = useMemo(() => {
    const source = searchParams.get("source");
    if (source === "manual") return "manual";
    if (source === "quickbooks") return "quickbooks";
    if (source === "manual_upload") return "manual_upload";
    if (source === "quickbooks_manual") return "quickbooks_manual";
    if (activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_GL) return "manual";
    if (activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) return "manual_upload";
    return "quickbooks";
  }, [activeSourceKey, searchParams]);

  useEffect(() => {
    setSelectedCardKey(
      selectedView === "manual"
        ? REPORT_SOURCE_KEYS.MANUAL_GL
        : selectedView === "manual_upload"
          ? REPORT_SOURCE_KEYS.MANUAL_UPLOAD
          : selectedView === "quickbooks_manual"
            ? REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL
            : REPORT_SOURCE_KEYS.QUICKBOOKS,
    );
  }, [selectedView]);

  const refreshSourceState = useCallback(async () => {
    if (!clientId) {
      setSourceState(INITIAL_SOURCE_STATE);
      return INITIAL_SOURCE_STATE;
    }

    setIsLoadingSources(true);
    try {
      const payload = await getReportSources({ clientId });
      const nextState = {
        selectedSource: payload?.selectedSource || null,
        activeSource: payload?.activeSource || null,
        quickbooksConnected: Boolean(payload?.quickbooksConnected),
        manualUploadActive: Boolean(payload?.manualUploadActive),
        lastSourceSwitchAt: payload?.lastSourceSwitchAt || null,
        sources: Array.isArray(payload?.sources) ? payload.sources : [],
      };
      setSourceState(nextState);
      return nextState;
    } catch (error) {
      console.error("[WorkspaceConnections] Failed to load source state:", error);
      setSourceState(INITIAL_SOURCE_STATE);
      return INITIAL_SOURCE_STATE;
    } finally {
      setIsLoadingSources(false);
    }
  }, [clientId]);

  useEffect(() => {
    if (!clientId) return;

    const restored = getStoredConnectionsState(clientId);
    if (!restored || typeof restored !== "object") return;

    if (restored.sourceState && typeof restored.sourceState === "object") {
      setSourceState((previous) => ({
        ...previous,
        ...restored.sourceState,
      }));
    }

    const currentView = searchParams.get("source");
    const validViews = ["manual", "quickbooks", "manual_upload", "quickbooks_manual"];
    if (
      validViews.includes(currentView) ||
      !validViews.includes(restored.selectedView)
    ) {
      return;
    }

    setSearchParams({ source: restored.selectedView }, { replace: true });
  }, [clientId, searchParams, setSearchParams]);

  useEffect(() => {
    Promise.resolve().then(() => {
      refreshSourceState();
    });
  }, [refreshSourceState]);

  useEffect(() => {
    if (!clientId) return;
    getCompanyRequest(clientId)
      .then(setCompany)
      .catch(() => setCompany(null));
  }, [clientId]);

  useEffect(() => {
    const sourceParam = searchParams.get("source");
    if (["manual", "quickbooks", "manual_upload", "quickbooks_manual"].includes(sourceParam)) return;
    let fallback = "quickbooks";
    if (activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_GL) fallback = "manual";
    else if (activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) fallback = "manual_upload";
    setSearchParams({ source: fallback }, { replace: true });
  }, [activeSourceKey, searchParams, setSearchParams]);

  const closeSourceSwitchModal = useCallback(() => {
    if (isSwitchingSource) return;
    setSourceSwitchModal((previous) => ({ ...previous, isOpen: false }));
  }, [isSwitchingSource]);

  const executeSourceSwitch = useCallback(
    async (targetKey, switchOptions = {}) => {
      if (!clientId || !targetKey) return;

      setIsSwitchingSource(true);
      setSwitchingTargetKey(targetKey);
      try {
        const payload = await setSelectedReportSource(targetKey, {
          clientId,
          confirmSwitch: true,
          ...switchOptions,
        });
        const next = {
          selectedSource: payload?.selectedSource || null,
          activeSource: payload?.activeSource || payload?.selectedSource || null,
          quickbooksConnected: Boolean(payload?.quickbooksConnected),
          manualUploadActive:
            normalizeReportSourceKey(payload?.activeSource) === REPORT_SOURCE_KEYS.MANUAL_GL ||
            normalizeReportSourceKey(payload?.activeSource) === REPORT_SOURCE_KEYS.MANUAL_UPLOAD,
          lastSourceSwitchAt: new Date().toISOString(),
          sources: Array.isArray(payload?.sources) ? payload.sources : [],
        };

        setSourceState(next);
        const resolvedSourceKey = normalizeReportSourceKey(
          next.activeSource || next.selectedSource || targetKey,
        );
        const nextView =
          resolvedSourceKey === REPORT_SOURCE_KEYS.MANUAL_GL
            ? "manual"
            : resolvedSourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD
              ? "manual_upload"
              : resolvedSourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL
                ? "quickbooks_manual"
                : "quickbooks";
        setSearchParams({ source: nextView });

        emitWorkspaceDataSourceUpdated({
          clientId,
          sourceKey: resolvedSourceKey,
        });

        showToast({
          type: "success",
          title: "Source updated",
          message: `Current source is now ${getReportSourceLabel(resolvedSourceKey)}.`,
        });
      } catch (error) {
        showToast({
          type: "error",
          title: "Source switch failed",
          message: error?.message || "Could not switch source. Please try again.",
        });
      } finally {
        setIsSwitchingSource(false);
        setSwitchingTargetKey(null);
        setSourceSwitchModal({
          isOpen: false,
          title: "",
          message: "",
          targetSourceKey: null,
          switchOptions: {},
        });
        await refreshSourceState();
      }
    },
    [clientId, refreshSourceState, setSearchParams, showToast],
  );

  const confirmSourceSwitch = useCallback(async () => {
    if (!sourceSwitchModal.targetSourceKey) return;
    await executeSourceSwitch(
      sourceSwitchModal.targetSourceKey,
      sourceSwitchModal.switchOptions || {},
    );
  }, [executeSourceSwitch, sourceSwitchModal.switchOptions, sourceSwitchModal.targetSourceKey]);

  const requestQuickBooksSwitch = useCallback(() => {
    if (activeSourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS) {
      setSearchParams({ source: "quickbooks" });
      return;
    }

    setSourceSwitchModal({
      isOpen: true,
      title: "Switch To QuickBooks?",
      message:
        "QuickBooks will become the active source for reports, dashboards, and DataHub. Continue?",
      targetSourceKey: REPORT_SOURCE_KEYS.QUICKBOOKS,
      switchOptions: { confirmSwitch: true },
    });
  }, [activeSourceKey, setSearchParams]);

  const requestManualSwitch = useCallback(() => {
    if (activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_GL) {
      setSearchParams({ source: "manual" });
      return;
    }

    setSourceSwitchModal({
      isOpen: true,
      title: "Switch To Manual GL Upload?",
      message: quickbooksConnected
        ? "Manual GL Upload will become active. QuickBooks connection is kept for cached history, but sync stays inactive until you switch back."
        : "Manual GL Upload will become the active source for reports, dashboards, and DataHub. Continue?",
      targetSourceKey: REPORT_SOURCE_KEYS.MANUAL_GL,
      switchOptions: { confirmSwitch: true },
    });
  }, [activeSourceKey, quickbooksConnected, setSearchParams]);

  const requestManualUploadSwitch = useCallback(() => {
    if (activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) {
      setSearchParams({ source: "manual_upload" });
      return;
    }

    setSourceSwitchModal({
      isOpen: true,
      title: "Switch To Manual Upload (Excel/PDF)?",
      message: quickbooksConnected
        ? "Manual Upload (Excel/PDF) will become active. QuickBooks connection is kept for cached history, but sync stays inactive until you switch back."
        : "Manual Upload (Excel/PDF) will become the active source for reports, dashboards, and DataHub. Continue?",
      targetSourceKey: REPORT_SOURCE_KEYS.MANUAL_UPLOAD,
      switchOptions: { confirmSwitch: true },
    });
  }, [activeSourceKey, quickbooksConnected, setSearchParams]);

  const quickbooksStatusLabel = useMemo(() => {
    if (quickbooksConnected && activeSourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS) {
      return "Connected • Currently Active";
    }
    if (quickbooksConnected) return "Connected • Inactive";
    if (quickbooksRecord?.isAvailable) return "Disconnected • Cached Data Available";
    return "Not Connected";
  }, [activeSourceKey, quickbooksConnected, quickbooksRecord?.isAvailable]);

  const manualStatusLabel = useMemo(() => {
    if (activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_GL) {
      return "Ready • Currently Active";
    }
    if (manualRecord?.isAvailable) return "Staged Data Available • Inactive";
    return "Not Staged Yet";
  }, [activeSourceKey, manualRecord?.isAvailable]);

  const manualUploadStatusLabel = useMemo(() => {
    if (activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) {
      return "Ready • Currently Active";
    }
    if (manualUploadRecord?.isAvailable) return "Uploaded Data Available • Inactive";
    return "No Files Uploaded Yet";
  }, [activeSourceKey, manualUploadRecord?.isAvailable]);

  const hasAnySourceData = Boolean(
    quickbooksConnected || quickbooksRecord?.isAvailable || manualRecord?.isAvailable,
  );

  const manualLockMessage = quickbooksConnected
    ? "QuickBooks is currently the active source. Switch source to Manual Upload to continue."
    : "Manual Upload is currently inactive. Switch source to Manual Upload to continue.";

  useEffect(() => {
    if (!clientId) return;

    saveStoredConnectionsState(clientId, {
      sourceState,
      selectedView,
      selectedCardKey,
      isSwitchingSource,
      switchingTargetKey,
      activeSourceKey,
      connectionState: {
        quickbooksConnected,
        manualUploadActive:
          activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_GL,
      },
      cachedState: {
        quickbooksCached: Boolean(
          quickbooksRecord?.isAvailable && !quickbooksConnected,
        ),
        manualStaged: Boolean(manualRecord?.isAvailable),
      },
      lastSyncAt: quickbooksRecord?.lastSyncedAt || quickbooksRecord?.lastConnectedAt || null,
      lastUploadAt: manualRecord?.metadata?.latestBatchCreatedAt || manualRecord?.lastSyncedAt || null,
      sourceSwitchState: {
        isSwitchingSource,
        switchingTargetKey,
      },
      savedAt: new Date().toISOString(),
    });
  }, [
    activeSourceKey,
    clientId,
    manualRecord?.isAvailable,
    manualRecord?.lastSyncedAt,
    manualRecord?.metadata?.latestBatchCreatedAt,
    quickbooksConnected,
    quickbooksRecord?.isAvailable,
    quickbooksRecord?.lastConnectedAt,
    quickbooksRecord?.lastSyncedAt,
    selectedCardKey,
    selectedView,
    sourceState,
    isSwitchingSource,
    switchingTargetKey,
  ]);

  return (
    <div className="page-container flex h-full flex-col bg-gray-50/30">
      <Header title="Connections" />
      <div className="page-content flex-1 space-y-8 p-6 md:p-8 lg:px-10">
        <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
          <div className="max-w-2xl">
            <h1 className="bg-gradient-to-r from-navy via-navy to-primary/90 bg-clip-text text-[32px] font-black tracking-tight text-transparent">
              Manage Connections
            </h1>
            <p className="mt-3 text-[15px] leading-relaxed text-text-secondary">
              Centralize your financial ecosystem. Choose and manage the single active data source for this workspace to ensure consistent reporting.
            </p>
          </div>
        </div>

        {isLoadingSources ? (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-white px-5 py-4 text-[13px] font-medium text-text-secondary shadow-sm">
            <Loader2 size={16} className="animate-spin text-primary" />
            Refreshing workspace source state and connection health...
          </div>
        ) : null}

        {!hasAnySourceData ? (
          <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-white to-[#FAFCF7] p-8 shadow-sm">
            <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-primary/5 blur-3xl" />
            <div className="relative z-10 max-w-3xl">
              <h2 className="text-[20px] font-bold text-navy">
                Choose a financial data source
              </h2>
              <p className="mt-3 text-[14px] leading-relaxed text-text-secondary">
                Connect QuickBooks for automated sync, or stage Manual GL files for upload-based reporting. This configures the root data pipeline for standard reports.
              </p>
              <div className="mt-6 flex flex-wrap gap-4">
                <button
                  type="button"
                  onClick={requestQuickBooksSwitch}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-6 text-[14px] font-bold text-white shadow-[0_4px_14px_rgba(139,197,61,0.3)] transition-all hover:bg-primary-dark hover:-translate-y-0.5 hover:shadow-[0_8px_20px_rgba(139,197,61,0.4)]"
                >
                  <Link2 size={16} />
                  Connect QuickBooks
                </button>
                <button
                  type="button"
                  onClick={requestManualSwitch}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-white px-6 text-[14px] font-bold text-text-primary shadow-sm transition-all hover:border-text-primary/20 hover:bg-gray-50 hover:-translate-y-0.5"
                >
                  <FileSpreadsheet size={16} className="text-text-muted" />
                  Upload General Ledger
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <SourceCard
            icon={<Link2 size={18} />}
            title="QuickBooks Online"
            description="Live accounting sync with customers, invoices, and financial statements."
            statusLabel={quickbooksStatusLabel}
            isActive={activeSourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS}
            lastActivityLabel={`Last sync: ${formatTimestamp(
              quickbooksRecord?.lastSyncedAt || quickbooksRecord?.lastConnectedAt,
            )}`}
            actionLabel={
              activeSourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS
                ? "Currently Active"
                : "Switch To QuickBooks"
            }
            onAction={requestQuickBooksSwitch}
            disabled={activeSourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS}
            isBusy={
              isSwitchingSource &&
              switchingTargetKey === REPORT_SOURCE_KEYS.QUICKBOOKS
            }
          />

          <SourceCard
            icon={<FileSpreadsheet size={18} />}
            title="Manual GL Upload"
            description="Upload and stage multi-year GL datasets with controlled report generation."
            statusLabel={manualStatusLabel}
            isActive={activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_GL}
            lastActivityLabel={`Last staged: ${formatTimestamp(
              manualRecord?.metadata?.latestBatchCreatedAt || manualRecord?.lastSyncedAt,
            )}`}
            actionLabel={
              activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_GL
                ? "Currently Active"
                : "Switch To Manual GL"
            }
            onAction={requestManualSwitch}
            disabled={activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_GL}
            isBusy={
              isSwitchingSource &&
              switchingTargetKey === REPORT_SOURCE_KEYS.MANUAL_GL
            }
          />

          <SourceCard
            icon={<FileSpreadsheet size={18} />}
            title="Manual Upload (Excel/PDF)"
            description="Upload financial reports directly as Excel or PDF files for structured analysis."
            statusLabel={manualUploadStatusLabel}
            isActive={activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD}
            lastActivityLabel={`Last upload: ${formatTimestamp(
              manualUploadRecord?.metadata?.latestBatchCreatedAt || manualUploadRecord?.lastSyncedAt,
            )}`}
            actionLabel={
              activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD
                ? "Currently Active"
                : "Switch To Manual Upload"
            }
            onAction={requestManualUploadSwitch}
            disabled={activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD}
            isBusy={
              isSwitchingSource &&
              switchingTargetKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD
            }
          />

          <SourceCard
            icon={<Link2 size={18} />}
            title="QuickBooks Manual"
            description="Manually reconcile and import QuickBooks-exported data for controlled reporting."
            statusLabel="Not Available Yet"
            isActive={false}
            lastActivityLabel="Coming soon — no activity yet"
            actionLabel="Coming Soon"
            onAction={() => { }}
            disabled={true}
            comingSoon={true}
          />
        </div>

        <div className="rounded-2xl border border-border bg-bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[16px] font-semibold text-text-primary">
              {selectedView === "quickbooks"
                ? "QuickBooks Connection"
                : selectedView === "manual_upload"
                  ? "Manual Upload (Excel/PDF)"
                  : selectedView === "quickbooks_manual"
                    ? "QuickBooks Manual"
                    : "Manual GL Upload"}
            </h2>
            <span className="text-[12px] text-text-muted">
              Last source switch: {formatTimestamp(sourceState.lastSourceSwitchAt)}
            </span>
          </div>

          {selectedView === "quickbooks" ? (
            <QuickBooksConnection
              company={company}
              isSourceActive={activeSourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS}
              onConnectionStateChange={refreshSourceState}
              onRequireSourceSwitch={requestQuickBooksSwitch}
            />
          ) : selectedView === "manual_upload" ? (
            <ManualFolderReportsUpload
              companyId={clientId}
            />
          ) : selectedView === "quickbooks_manual" ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-bg-page">
                <Link2 size={22} className="text-text-muted" />
              </div>
              <h3 className="text-[16px] font-semibold text-text-primary">Coming Soon</h3>
              <p className="mt-2 max-w-sm text-[13px] text-text-secondary">
                QuickBooks Manual integration is under development. Check back later.
              </p>
            </div>
          ) : (
            <ManualGLUpload
              companyId={clientId}
              isLocked={activeSourceKey !== REPORT_SOURCE_KEYS.MANUAL_GL}
              lockMessage={manualLockMessage}
              onStageComplete={refreshSourceState}
            />
          )}
        </div>
      </div>

      {sourceSwitchModal.isOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={closeSourceSwitchModal}
          />
          <div className="relative w-full max-w-md rounded-xl border border-border bg-bg-card p-6 shadow-2xl">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#fef2f2] text-[#C62026]">
              <AlertTriangle size={22} />
            </div>
            <h3 className="text-center text-[18px] font-semibold text-text-primary">
              {sourceSwitchModal.title}
            </h3>
            <p className="mt-2 text-center text-[14px] leading-relaxed text-text-secondary">
              {sourceSwitchModal.message}
            </p>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={closeSourceSwitchModal}
                disabled={isSwitchingSource}
                className="h-10 flex-1 rounded-md border border-border text-[14px] font-medium text-text-secondary transition-colors hover:bg-bg-page disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmSourceSwitch}
                disabled={isSwitchingSource}
                className="h-10 flex-1 rounded-md bg-[#C62026] text-[14px] font-semibold text-white transition-colors hover:bg-[#9f1b20] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSwitchingSource ? "Switching..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

    </div>
  );
}

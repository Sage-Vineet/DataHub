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
} from "../../../lib/api";
import Header from "../../../components/Header";
import QuickBooksConnection from "../../../components/quickbooks/QuickBooksConnection";
import ManualGLUpload from "../../../components/manual-gl/ManualGLUpload";
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
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border bg-bg-card p-5 transition-all",
        isActive
          ? "border-primary shadow-[0_8px_30px_rgba(139,197,61,0.15)]"
          : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "flex h-11 w-11 items-center justify-center rounded-xl",
              isActive ? "bg-primary text-white" : "bg-bg-page text-text-secondary",
            )}
          >
            {icon}
          </div>
          <div>
            <h3 className="text-[16px] font-semibold text-text-primary">{title}</h3>
            <p className="mt-1 text-[13px] text-text-secondary">{description}</p>
          </div>
        </div>
        {isActive ? (
          <span className="rounded-full bg-primary/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-primary">
            Active Source
          </span>
        ) : null}
      </div>

      <div className="mt-4 space-y-2">
        <div className="flex items-center gap-2 text-[12px] text-text-secondary">
          <CheckCircle2 size={14} className="text-primary" />
          <span>{statusLabel}</span>
        </div>
        <div className="text-[12px] text-text-muted">{lastActivityLabel}</div>
      </div>

      <div className="mt-5">
        <button
          type="button"
          onClick={onAction}
          disabled={disabled || isBusy}
          className={cn(
            "inline-flex h-10 items-center justify-center rounded-lg px-4 text-[13px] font-semibold transition-colors",
            isActive
              ? "bg-bg-page text-text-secondary"
              : "bg-primary text-white hover:bg-primary/90",
            (disabled || isBusy) && "cursor-not-allowed opacity-60",
          )}
        >
          {isBusy ? (
            <>
              <Loader2 size={14} className="mr-2 animate-spin" />
              Updating...
            </>
          ) : (
            actionLabel
          )}
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
    return activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_GL
      ? "manual"
      : "quickbooks";
  }, [activeSourceKey, searchParams]);

  useEffect(() => {
    setSelectedCardKey(
      selectedView === "manual"
        ? REPORT_SOURCE_KEYS.MANUAL_GL
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
    if (
      (currentView === "manual" || currentView === "quickbooks") ||
      (restored.selectedView !== "manual" && restored.selectedView !== "quickbooks")
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
    if (sourceParam === "manual" || sourceParam === "quickbooks") return;
    const fallback =
      activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_GL ? "manual" : "quickbooks";
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
            normalizeReportSourceKey(payload?.activeSource) ===
            REPORT_SOURCE_KEYS.MANUAL_GL,
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
      title: "Switch To Manual Upload?",
      message: quickbooksConnected
        ? "Manual Upload will become active. QuickBooks connection is kept for cached history, but sync stays inactive until you switch back."
        : "Manual Upload will become the active source for reports, dashboards, and DataHub. Continue?",
      targetSourceKey: REPORT_SOURCE_KEYS.MANUAL_GL,
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
    <div className="page-container flex h-full flex-col">
      <Header title="Connections" />
      <div className="page-content flex-1 space-y-5 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-[24px] font-bold text-[#050505]">
              Manage Connections
            </h1>
            <p className="mt-1 text-[13px] text-text-secondary">
              Choose and manage the single active data source for this workspace.
            </p>
          </div>
          <div className="rounded-full border border-border bg-bg-card px-4 py-1.5 text-[12px] font-medium text-text-secondary">
            Current Source:{" "}
            <span className="font-semibold text-text-primary">{activeSourceLabel}</span>
          </div>
        </div>

        {isLoadingSources ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-card px-4 py-3 text-[13px] text-text-secondary">
            <Loader2 size={14} className="animate-spin" />
            Refreshing workspace source state...
          </div>
        ) : null}

        {!hasAnySourceData ? (
          <div className="rounded-2xl border border-dashed border-border bg-bg-card p-6">
            <h2 className="text-[18px] font-semibold text-text-primary">
              Choose a financial data source
            </h2>
            <p className="mt-2 text-[13px] text-text-secondary">
              Connect QuickBooks for automated sync, or stage Manual GL files for upload-based reporting.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={requestQuickBooksSwitch}
                className="btn-primary h-10 px-4 text-[13px] font-semibold"
              >
                Connect QuickBooks
              </button>
              <button
                type="button"
                onClick={requestManualSwitch}
                className="btn-secondary h-10 px-4 text-[13px] font-semibold"
              >
                Upload General Ledger
              </button>
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
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
                : "Switch To Manual Upload"
            }
            onAction={requestManualSwitch}
            disabled={activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_GL}
            isBusy={
              isSwitchingSource &&
              switchingTargetKey === REPORT_SOURCE_KEYS.MANUAL_GL
            }
          />
        </div>

        <div className="rounded-2xl border border-border bg-bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[16px] font-semibold text-text-primary">
              {selectedView === "quickbooks" ? "QuickBooks Connection" : "Manual GL Upload"}
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

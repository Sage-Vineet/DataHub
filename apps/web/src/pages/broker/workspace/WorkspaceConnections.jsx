import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import ManualFolderReportsUpload from "../../../components/manual-reports/ManualFolderReportsUpload";
import QuickBooksManualUpload from "../../../components/quickbooks-manual/QuickBooksManualUpload";
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

const LOCAL_SOURCE_KEY_PREFIX = "datahub-active-source";

function getLocalActiveSource(clientId) {
  if (!clientId || typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(`${LOCAL_SOURCE_KEY_PREFIX}:${clientId}`) || null;
  } catch { return null; }
}

function setLocalActiveSource(clientId, source) {
  if (!clientId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${LOCAL_SOURCE_KEY_PREFIX}:${clientId}`, source);
  } catch { /* ignore quota errors */ }
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
  isSelected,
  lastActivityLabel,
  actionLabel,
  onAction,
  onSelect,
  disabled = false,
  isBusy = false,
  comingSoon = false,
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect?.(); }}
      className={cn(
        "group relative flex flex-col justify-between overflow-hidden rounded-2xl border p-6 transition-all duration-400 cursor-pointer",
        isActive
          ? "border-primary shadow-md bg-white z-10"
          : isSelected
            ? "border-primary/60 shadow-sm bg-white z-10"
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
          onClick={(e) => { e.stopPropagation(); onSelect?.(); onAction?.(); }}
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
  // Capture session-stored selectedView once at mount. Used as fallback in the selectedView
  // useMemo so the correct panel is shown immediately on navigation-back, before the
  // URL-setting effect can restore ?source= and without relying on activeSourceKey (which
  // may have been reverted to the server's value by refreshSourceState on the previous visit).
  const initialStoredViewRef = useRef(storedState?.selectedView ?? null);

  const [company, setCompany] = useState(null);
  const [sourceState, setSourceState] = useState(() => {
    const localActiveSource = getLocalActiveSource(clientId);
    const base = storedState?.sourceState || INITIAL_SOURCE_STATE;
    return localActiveSource ? { ...base, activeSource: localActiveSource } : base;
  });
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
  const qmsRecord = useMemo(
    () => getSourceRecord(sourceState.sources, REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL),
    [sourceState.sources],
  );

  const activeSourceKey = normalizeReportSourceKey(
    sourceState.activeSource || sourceState.selectedSource || null,
  );
  // Keep a ref to the latest activeSourceKey so the URL-init effect can read it
  // without adding it to the dependency array (which would cause the effect to fire
  // on every refreshSourceState call and potentially override a user's selection).
  const activeSourceKeyRef = useRef(activeSourceKey);
  activeSourceKeyRef.current = activeSourceKey;

  // Source lock — true at all times except inside executeSourceSwitch while a
  // user-confirmed switch is in flight. Any code path that is not executeSourceSwitch
  // must NOT change activeSource while this is true.
  const sourceLocked = useRef(true);

  const quickbooksConnected = Boolean(
    sourceState.quickbooksConnected || quickbooksRecord?.isConnected,
  );

  const selectedView = useMemo(() => {
    const source = searchParams.get("source");
    const validViews = ["manual", "quickbooks", "manual_upload", "quickbooks_manual"];
    if (validViews.includes(source)) return source;
    if (initialStoredViewRef.current && validViews.includes(initialStoredViewRef.current)) {
      return initialStoredViewRef.current;
    }
    if (activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_GL) return "manual";
    if (activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) return "manual_upload";
    if (activeSourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) return "quickbooks_manual";
    return "quickbooks";
  }, [activeSourceKey, searchParams]);

  // Synchronously set the selected view in both the URL and session storage.
  // Using an imperative helper (instead of relying solely on the reactive session-save
  // effect) ensures the session is always up-to-date before any navigation happens —
  // eliminating the race condition where navigating away before the effect runs left
  // the session with a stale view that would be restored on the next visit.
  const navigateToView = useCallback((view) => {
    if (!view) return;
    setSearchParams({ source: view });
    initialStoredViewRef.current = view;
    const current = getStoredConnectionsState(clientId) || {};
    saveStoredConnectionsState(clientId, { ...current, selectedView: view });
  }, [clientId, setSearchParams]);

  const refreshSourceState = useCallback(async () => {
    if (!clientId) return null;

    setIsLoadingSources(true);
    try {
      const payload = await getReportSources({ clientId });
      const localSource = getLocalActiveSource(clientId);

      // Metadata that can safely be refreshed from the backend on every call.
      const metadataUpdate = {
        sources: Array.isArray(payload?.sources) ? payload.sources : [],
        quickbooksConnected: Boolean(payload?.quickbooksConnected),
        lastSourceSwitchAt: payload?.lastSourceSwitchAt || null,
      };

      if (localSource) {
        // localStorage is authoritative — update ONLY metadata.
        // activeSource, selectedSource, and manualUploadActive are NEVER overwritten here.
        const serverSource = payload?.activeSource || payload?.selectedSource;
        const serverNormalized = serverSource ? normalizeReportSourceKey(serverSource) : null;
        if (serverNormalized && serverNormalized !== localSource) {
          console.log("[SOURCE_CHANGE_BLOCKED]", {
            attemptedSource: serverNormalized,
            currentSource: localSource,
            trigger: "refreshSourceState_backend_override",
          });
        }
        setSourceState((prev) => ({ ...prev, ...metadataUpdate }));
      } else {
        // First visit — localStorage is empty. Seed it from the backend and set full state.
        const serverSource = payload?.activeSource || payload?.selectedSource;
        const normalized = serverSource
          ? normalizeReportSourceKey(serverSource) || serverSource
          : null;
        if (normalized) setLocalActiveSource(clientId, normalized);
        setSourceState((prev) => ({
          ...prev,
          ...metadataUpdate,
          selectedSource: payload?.selectedSource || null,
          activeSource: normalized,
          manualUploadActive: Boolean(payload?.manualUploadActive),
        }));
      }

      return payload;
    } catch (error) {
      console.error("[WorkspaceConnections] Failed to load source state:", error);
      // NEVER reset state on error — preserve the user's active source.
      console.log("[SOURCE_CHANGE_BLOCKED]", {
        attemptedSource: null,
        currentSource: getLocalActiveSource(clientId),
        trigger: "refreshSourceState_error_reset_blocked",
      });
      return null;
    } finally {
      setIsLoadingSources(false);
    }
  }, [clientId]);

  // Restore sourceState from session — runs ONLY when clientId changes (mount / company switch).
  // Must NOT depend on searchParams: executeSourceSwitch calls setSearchParams, which would
  // re-fire this effect with stale session storage and overwrite the just-set active source.
  useEffect(() => {
    if (!clientId) return;
    const restored = getStoredConnectionsState(clientId);
    if (restored?.sourceState && typeof restored.sourceState === "object") {
      const mergedState = { ...restored.sourceState };
      // localStorage is the durable source of truth — override any stale sessionStorage value.
      const localSource = getLocalActiveSource(clientId);
      if (localSource) {
        mergedState.activeSource = localSource;
        mergedState.manualUploadActive =
          localSource === REPORT_SOURCE_KEYS.MANUAL_GL ||
          localSource === REPORT_SOURCE_KEYS.MANUAL_UPLOAD ||
          localSource === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL;
      }
      setSourceState((previous) => ({ ...previous, ...mergedState }));
    }
  }, [clientId]);

  // Set ?source= when absent — runs only when the URL param is missing/invalid.
  // activeSourceKey is intentionally NOT in the dependency array: we read it via
  // activeSourceKeyRef so that refreshSourceState() completing (which changes
  // activeSourceKey) never triggers this effect and never overrides a selection
  // the user already made.
  useEffect(() => {
    if (!clientId) return;
    const currentView = searchParams.get("source");
    const validViews = ["manual", "quickbooks", "manual_upload", "quickbooks_manual"];
    if (validViews.includes(currentView)) return; // URL already valid — nothing to do
    // (2) Restore from session
    const restored = getStoredConnectionsState(clientId);
    if (restored && validViews.includes(restored.selectedView)) {
      setSearchParams({ source: restored.selectedView }, { replace: true });
      return;
    }
    // (3) Derive from active source key (read via ref — no dep on the reactive value)
    const activeKey = activeSourceKeyRef.current;
    if (!activeKey) return;
    const fallback =
      activeKey === REPORT_SOURCE_KEYS.MANUAL_GL ? "manual" :
      activeKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD ? "manual_upload" :
      activeKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL ? "quickbooks_manual" :
      "quickbooks";
    setSearchParams({ source: fallback }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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


  const closeSourceSwitchModal = useCallback(() => {
    if (isSwitchingSource) return;
    setSourceSwitchModal((previous) => ({ ...previous, isOpen: false }));
  }, [isSwitchingSource]);

  const executeSourceSwitch = useCallback(
    async (targetKey, switchOptions = {}) => {
      if (!clientId || !targetKey) return;

      // Unlock the source lock — this is the ONLY place where activeSource may change.
      // The lock is re-applied in the finally block regardless of success or failure.
      sourceLocked.current = false;
      setIsSwitchingSource(true);
      setSwitchingTargetKey(targetKey);
      let switchSucceeded = false;
      try {
        const payload = await setSelectedReportSource(targetKey, {
          clientId,
          confirmSwitch: true,
          ...switchOptions,
        });

        // Use targetKey as the authoritative activeSource — the server response may be
        // stale and return the old activeSource, which would revert the card highlight.
        const resolvedSourceKey = normalizeReportSourceKey(targetKey);
        const next = {
          selectedSource: payload?.selectedSource || targetKey,
          activeSource: targetKey,
          quickbooksConnected: Boolean(payload?.quickbooksConnected),
          manualUploadActive:
            resolvedSourceKey === REPORT_SOURCE_KEYS.MANUAL_GL ||
            resolvedSourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD ||
            resolvedSourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL,
          lastSourceSwitchAt: new Date().toISOString(),
          sources: Array.isArray(payload?.sources) ? payload.sources : [],
        };

        setSourceState(next);
        setLocalActiveSource(clientId, resolvedSourceKey);
        const nextView =
          resolvedSourceKey === REPORT_SOURCE_KEYS.MANUAL_GL
            ? "manual"
            : resolvedSourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD
              ? "manual_upload"
              : resolvedSourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL
                ? "quickbooks_manual"
                : "quickbooks";
        navigateToView(nextView);

        emitWorkspaceDataSourceUpdated({
          clientId,
          sourceKey: resolvedSourceKey,
        });

        showToast({
          type: "success",
          title: "Source updated",
          message: `Current source is now ${getReportSourceLabel(resolvedSourceKey)}.`,
        });
        switchSucceeded = true;
      } catch (error) {
        showToast({
          type: "error",
          title: "Source switch failed",
          message: error?.message || "Could not switch source. Please try again.",
        });
      } finally {
        sourceLocked.current = true; // re-lock — source is frozen again
        setIsSwitchingSource(false);
        setSwitchingTargetKey(null);
        setSourceSwitchModal({
          isOpen: false,
          title: "",
          message: "",
          targetSourceKey: null,
          switchOptions: {},
        });
        // Only refresh on failure — the switch response already contains the
        // correct full state. Refreshing after success can overwrite it with
        // stale data if the read-after-write hasn't propagated yet.
        if (!switchSucceeded) {
          await refreshSourceState();
        }
      }
    },
    [clientId, navigateToView, refreshSourceState, showToast],
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
      return;
    }

    setSourceSwitchModal({
      isOpen: true,
      title: "Switch To QuickBooks?",
      message:
        "QuickBooks will become the active source for reports, dashboards, and M&A Hub. Continue?",
      targetSourceKey: REPORT_SOURCE_KEYS.QUICKBOOKS,
      switchOptions: { confirmSwitch: true },
    });
  }, [activeSourceKey]);

  const requestManualSwitch = useCallback(() => {
    if (activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_GL) {
      return;
    }

    setSourceSwitchModal({
      isOpen: true,
      title: "Switch To Manual GL Upload?",
      message: quickbooksConnected
        ? "Manual GL Upload will become active. QuickBooks connection is kept for cached history, but sync stays inactive until you switch back."
        : "Manual GL Upload will become the active source for reports, dashboards, and M&A Hub. Continue?",
      targetSourceKey: REPORT_SOURCE_KEYS.MANUAL_GL,
      switchOptions: { confirmSwitch: true },
    });
  }, [activeSourceKey, quickbooksConnected]);

  const requestManualUploadSwitch = useCallback(() => {
    if (activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) {
      return;
    }

    setSourceSwitchModal({
      isOpen: true,
      title: "Switch To Manual Upload (Excel/PDF)?",
      message: quickbooksConnected
        ? "Manual Upload (Excel/PDF) will become active. QuickBooks connection is kept for cached history, but sync stays inactive until you switch back."
        : "Manual Upload (Excel/PDF) will become the active source for reports, dashboards, and M&A Hub. Continue?",
      targetSourceKey: REPORT_SOURCE_KEYS.MANUAL_UPLOAD,
      switchOptions: { confirmSwitch: true },
    });
  }, [activeSourceKey, quickbooksConnected]);

  const requestQMSSwitch = useCallback(() => {
    if (activeSourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
      return;
    }

    setSourceSwitchModal({
      isOpen: true,
      title: "Switch To QuickBooks Manual?",
      message: quickbooksConnected
        ? "QuickBooks Manual will become active. QuickBooks connection is kept for cached history, but live sync stays inactive until you switch back."
        : "QuickBooks Manual will become the active source. Upload QuickBooks-exported files to the 'Quickbooks Manual Source' folder, then sync. Continue?",
      targetSourceKey: REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL,
      switchOptions: { confirmSwitch: true },
    });
  }, [activeSourceKey, quickbooksConnected]);

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

  const qmsStatusLabel = useMemo(() => {
    if (activeSourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
      return "Ready • Currently Active";
    }
    if (qmsRecord?.isAvailable) return "Synced Data Available • Inactive";
    return "Not Synced Yet";
  }, [activeSourceKey, qmsRecord?.isAvailable]);

  const manualLockMessage = quickbooksConnected
    ? "QuickBooks is currently the active source. Switch source to Manual Upload to continue."
    : "Manual Upload is currently inactive. Switch source to Manual Upload to continue.";

  useEffect(() => {
    if (!clientId) return;

    saveStoredConnectionsState(clientId, {
      sourceState,
      // selectedView is written synchronously by navigateToView — not here, to avoid
      // overwriting a user's selection with a stale searchParams value from this closure.
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

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <SourceCard
            icon={<Link2 size={18} />}
            title="QuickBooks Online"
            description="Live accounting sync with customers, invoices, and financial statements."
            statusLabel={quickbooksStatusLabel}
            isActive={activeSourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS}
            isSelected={selectedView === "quickbooks"}
            lastActivityLabel={`Last sync: ${formatTimestamp(
              quickbooksRecord?.lastSyncedAt || quickbooksRecord?.lastConnectedAt,
            )}`}
            actionLabel={
              activeSourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS
                ? "Currently Active"
                : "Switch To QuickBooks"
            }
            onAction={requestQuickBooksSwitch}
            onSelect={() => navigateToView("quickbooks")}
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
            isSelected={selectedView === "manual"}
            lastActivityLabel={`Last staged: ${formatTimestamp(
              manualRecord?.metadata?.latestBatchCreatedAt || manualRecord?.lastSyncedAt,
            )}`}
            actionLabel={
              activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_GL
                ? "Currently Active"
                : "Switch To Manual GL"
            }
            onAction={requestManualSwitch}
            onSelect={() => navigateToView("manual")}
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
            isSelected={selectedView === "manual_upload"}
            lastActivityLabel={`Last upload: ${formatTimestamp(
              manualUploadRecord?.metadata?.latestBatchCreatedAt || manualUploadRecord?.lastSyncedAt,
            )}`}
            actionLabel={
              activeSourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD
                ? "Currently Active"
                : "Switch To Manual Upload"
            }
            onAction={requestManualUploadSwitch}
            onSelect={() => navigateToView("manual_upload")}
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
            statusLabel={qmsStatusLabel}
            isActive={activeSourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL}
            isSelected={selectedView === "quickbooks_manual"}
            lastActivityLabel={`Last sync: ${formatTimestamp(
              qmsRecord?.lastSyncedAt || qmsRecord?.lastConnectedAt,
            )}`}
            actionLabel={
              activeSourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL
                ? "Currently Active"
                : "Switch To QuickBooks Manual"
            }
            onAction={requestQMSSwitch}
            onSelect={() => navigateToView("quickbooks_manual")}
            disabled={activeSourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL}
            isBusy={
              isSwitchingSource &&
              switchingTargetKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL
            }
          />
        </div>

        <div className="rounded-2xl border border-border bg-bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[16px] font-semibold text-text-primary">
              {selectedView === "manual"
                ? "Manual GL Upload"
                : selectedView === "manual_upload"
                  ? "Manual Upload (Excel/PDF)"
                  : selectedView === "quickbooks_manual"
                    ? "QuickBooks Manual"
                    : "QuickBooks Connection"}
            </h2>
            <span className="text-[12px] text-text-muted">
              Last source switch: {formatTimestamp(sourceState.lastSourceSwitchAt)}
            </span>
          </div>

          {selectedView === "manual" ? (
            <ManualGLUpload
              key="manual"
              companyId={clientId}
              isLocked={false}
              lockMessage={manualLockMessage}
              onStageComplete={refreshSourceState}
            />
          ) : selectedView === "manual_upload" ? (
            <ManualFolderReportsUpload
              key="manual_upload"
              companyId={clientId}
            />
          ) : selectedView === "quickbooks_manual" ? (
            <QuickBooksManualUpload companyId={clientId} />
          ) : (
            <QuickBooksConnection
              key="quickbooks"
              company={company}
              isSourceActive={activeSourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS}
              onConnectionStateChange={refreshSourceState}
              onRequireSourceSwitch={requestQuickBooksSwitch}
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

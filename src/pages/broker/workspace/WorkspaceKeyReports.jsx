import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
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
  ListTree,
  Sparkles,
  Upload,
  BarChart3,
  ClipboardCheck,
  ArrowRight,
  ArrowLeft,
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
import ChartOfAccountsTreeGrid from "../../../components/key-reports/ChartOfAccountsTreeGrid";
import KeyReportSyncDashboard from "../../../components/key-reports/KeyReportSyncDashboard";

const CATEGORIES = [
  { key: "profit_loss", label: "Profit & Loss", required: true },
  { key: "balance_sheet", label: "Balance Sheet", required: true },
  { key: "general_ledger", label: "General Ledger", required: false },
  { key: "bank_statement", label: "Bank Statements", required: false },
  { key: "tax_return", label: "Tax Returns", required: false },
];

// The COA-centric workflow. Steps 4 & 5 share the tree grid (it is both the
// view and the adjust surface); edits persist immediately.
const STEPS = [
  { key: "details", label: "Key Report Details", icon: FileText },
  { key: "upload", label: "Upload Statements", icon: Upload },
  { key: "ai", label: "AI Processing", icon: Sparkles },
  { key: "coa", label: "Chart of Accounts", icon: ListTree },
  { key: "review", label: "Review & Adjust", icon: ClipboardCheck },
  { key: "save", label: "Save Hierarchy", icon: CheckCircle2 },
  { key: "reports", label: "Financial Reports", icon: BarChart3 },
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
  const navigate = useNavigate();
  const toast = useToast();

  const [versions, setVersions] = useState([]);
  const [selectedVersionId, setSelectedVersionId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncState, setSyncState] = useState(() => createInitialSyncState());
  const [pickerCategory, setPickerCategory] = useState(null);
  const [showPopup, setShowPopup] = useState(false);
  const [activeStep, setActiveStep] = useState("details");

  const notify = useCallback(
    (msg, type = "info") => {
      toast?.showToast?.({ type, title: msg });
    },
    [toast]
  );

  useEffect(() => {
    let cancelled = false;
    getKeyReportPopupPreference()
      .then((res) => {
        if (!cancelled && res && !res.dismissed) setShowPopup(true);
      })
      .catch(() => {});
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

  // Land on the Chart of Accounts once a version has been synced.
  useEffect(() => {
    if (detail?.version?.lastSyncedAt) setActiveStep("coa");
    else setActiveStep("details");
  }, [detail?.version?.id, detail?.version?.lastSyncedAt]);

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
      await Promise.all([loadDetail(selectedVersionId), loadVersions()]);
      const warnCount = res?.warnings?.length || 0;
      notify(`AI analysis complete${warnCount ? ` (${warnCount} warning${warnCount === 1 ? "" : "s"})` : ""}.`, "success");
      setActiveStep("coa");
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
      notify("Link at least one financial statement before running AI Processing.", "error");
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
    setKeyReportPopupPreference(true).catch(() => {});
  };

  const version = detail?.version;
  const mappingsByCategory = detail?.mappingsByCategory || {};
  const lastSync = detail?.syncLogs?.[0];
  const hasSyncedData = Boolean(version?.lastSyncedAt) && !syncing;
  const persistedValidationResults = Array.isArray(detail?.validationResults) ? detail.validationResults : [];
  const displaySyncState = {
    ...syncState,
    status: syncState.status === "idle" && persistedValidationResults.length > 0 ? "validation" : syncState.status,
    validationResults:
      Array.isArray(syncState.validationResults) && syncState.validationResults.length > 0
        ? syncState.validationResults
        : persistedValidationResults,
  };

  const stepIndex = STEPS.findIndex((s) => s.key === activeStep);
  const goTo = (key) => setActiveStep(key);
  const goNext = () => stepIndex < STEPS.length - 1 && setActiveStep(STEPS[stepIndex + 1].key);
  const goPrev = () => stepIndex > 0 && setActiveStep(STEPS[stepIndex - 1].key);

  const reportLinks = [
    { label: "Profit & Loss", to: `/broker/client/${clientId}/reports` },
    { label: "Balance Sheet", to: `/broker/client/${clientId}/reports` },
    { label: "Normalized Earnings / EBITDA", to: `/broker/client/${clientId}/ebitda` },
    { label: "Bank Reconciliation", to: `/broker/client/${clientId}/reconciliation` },
    { label: "Tax Reconciliation", to: `/broker/client/${clientId}/tax-reconciliation` },
  ];

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
            Upload financial statements, build an AI-classified Chart of Accounts, and power every financial report from it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          <p className="mt-1 text-sm text-secondary">Create your first version to start uploading financial statements.</p>
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
          {/* Stepper nav */}
          <div className="mb-5 overflow-x-auto">
            <div className="flex min-w-max items-center gap-1">
              {STEPS.map((step, i) => {
                const Icon = step.icon;
                const isActive = step.key === activeStep;
                const isDone = i < stepIndex;
                return (
                  <div key={step.key} className="flex items-center">
                    <button
                      onClick={() => goTo(step.key)}
                      className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition ${
                        isActive
                          ? "bg-primary text-white"
                          : isDone
                          ? "bg-[#EEF6E0] text-primary"
                          : "bg-white text-text-muted hover:bg-bg-page"
                      }`}
                    >
                      <span
                        className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                          isActive ? "bg-white/20" : isDone ? "bg-primary/10" : "bg-bg-page"
                        }`}
                      >
                        {i + 1}
                      </span>
                      <Icon size={15} />
                      <span className="hidden lg:inline">{step.label}</span>
                    </button>
                    {i < STEPS.length - 1 && <ArrowRight size={14} className="mx-0.5 text-text-muted" />}
                  </div>
                );
              })}
            </div>
          </div>

          {lastSync?.sync_status === "failed" && (
            <div className="mb-4 rounded-xl bg-red-50 px-4 py-2 text-sm text-negative">
              Last sync failed: {lastSync.error_message}
            </div>
          )}

          {/* Step content */}
          {activeStep === "details" && (
            <div className="rounded-2xl border border-border bg-white p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
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
                {!version?.isActive && (
                  <button
                    onClick={handleActivate}
                    disabled={busy || syncing}
                    className="flex items-center gap-1.5 rounded-xl border border-primary px-3 py-2 text-sm font-semibold text-primary hover:bg-[#F0F7E6] disabled:opacity-50"
                  >
                    <CheckCircle2 size={15} /> Set as official
                  </button>
                )}
              </div>
              <p className="mt-4 text-sm text-secondary">
                This Key Report version is a container for the official financial statements that drive the Chart of
                Accounts and every downstream report. Set it as the official source once its Chart of Accounts is reviewed.
              </p>
            </div>
          )}

          {activeStep === "upload" && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {CATEGORIES.map((cat) => {
                const items = mappingsByCategory[cat.key] || [];
                return (
                  <div key={cat.key} className="rounded-2xl border border-border bg-white p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="flex items-center gap-2 text-sm font-bold text-text-primary">
                        {cat.label}
                        {cat.required ? (
                          <span className="rounded-full bg-[#EEF6E0] px-2 py-0.5 text-[10px] font-semibold text-primary">required</span>
                        ) : (
                          <span className="rounded-full bg-bg-page px-2 py-0.5 text-[10px] text-text-muted">optional</span>
                        )}
                      </h3>
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
                          <li key={m.id} className="flex items-center gap-2 rounded-lg bg-bg-page px-2.5 py-1.5 text-sm">
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
          )}

          {activeStep === "ai" && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-white px-5 py-4">
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-bold text-text-primary">
                    <Sparkles size={16} className="text-primary" /> AI Financial Analysis
                  </h3>
                  <p className="mt-1 text-sm text-secondary">
                    Reads every linked statement, extracts all accounts, and builds the Chart of Accounts hierarchy.
                    {linkedDocumentCount === 0 && " Link at least one statement first."}
                  </p>
                </div>
                <button
                  onClick={handleSyncClick}
                  disabled={!selectedVersionId || syncing}
                  className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
                >
                  {syncing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                  {syncing ? "Processing..." : "Run AI Processing"}
                </button>
              </div>
              <KeyReportSyncDashboard
                version={version}
                syncState={displaySyncState}
                hasLinkedDocuments={linkedDocumentCount > 0}
              />
            </div>
          )}

          {(activeStep === "coa" || activeStep === "review") && (
            <ChartOfAccountsTreeGrid versionId={selectedVersionId} hasSyncedData={hasSyncedData} notify={notify} />
          )}

          {activeStep === "save" && (
            <div className="rounded-2xl border border-border bg-white p-6 text-center">
              <CheckCircle2 size={28} className="mx-auto text-primary" />
              <p className="mt-3 text-sm font-semibold text-text-primary">Your Chart of Accounts is saved</p>
              <p className="mx-auto mt-1 max-w-lg text-sm text-secondary">
                Every edit you make in the Chart of Accounts is persisted automatically, with the original AI
                classification kept so you can always restore it. Activate this version to make it the official source
                of truth for all financial reports.
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                {!version?.isActive && (
                  <button
                    onClick={handleActivate}
                    disabled={busy || syncing}
                    className="flex items-center gap-1.5 rounded-xl border border-primary px-3 py-2 text-sm font-semibold text-primary hover:bg-[#F0F7E6] disabled:opacity-50"
                  >
                    <Star size={15} /> Set as official source
                  </button>
                )}
                <button
                  onClick={() => goTo("reports")}
                  className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
                >
                  Go to Financial Reports <ArrowRight size={15} />
                </button>
              </div>
            </div>
          )}

          {activeStep === "reports" && (
            <div className="rounded-2xl border border-border bg-white p-5">
              <h3 className="flex items-center gap-2 text-sm font-bold text-text-primary">
                <BarChart3 size={16} className="text-primary" /> Financial Reports
              </h3>
              <p className="mt-1 text-sm text-secondary">
                These reports are powered by this version's Chart of Accounts.
              </p>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {reportLinks.map((r) => (
                  <button
                    key={r.label}
                    onClick={() => navigate(r.to)}
                    className="flex items-center justify-between rounded-xl border border-border px-4 py-3 text-left text-sm font-semibold text-text-primary hover:bg-bg-page"
                  >
                    {r.label}
                    <ArrowRight size={15} className="text-text-muted" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step nav buttons */}
          <div className="mt-5 flex items-center justify-between">
            <button
              onClick={goPrev}
              disabled={stepIndex === 0}
              className="flex items-center gap-1.5 rounded-xl border border-border bg-white px-3 py-2 text-sm font-semibold text-text-primary hover:bg-bg-page disabled:opacity-40"
            >
              <ArrowLeft size={15} /> Back
            </button>
            <button
              onClick={goNext}
              disabled={stepIndex === STEPS.length - 1}
              className="flex items-center gap-1.5 rounded-xl border border-border bg-white px-3 py-2 text-sm font-semibold text-text-primary hover:bg-bg-page disabled:opacity-40"
            >
              Next <ArrowRight size={15} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

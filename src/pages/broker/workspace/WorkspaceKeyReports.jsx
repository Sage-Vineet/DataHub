/**
 * WorkspaceKeyReports — redesigned 2-stage Generate workflow.
 *
 * Stage 1  Link Documents
 *   • GL, Bank Statements, Tax Returns connection cards
 *   • Link / Unlink files per category
 *
 * Stage 2  Generate
 *   • Single "Generate" button
 *   • GenerateProgressPanel while in-flight
 *   • KeyReportSyncDashboard (Validation Dashboard) once done
 *   • Collapsible COA editor below the Validation Dashboard
 *   • "Open Reports" button
 *
 * All existing business logic, API calls, and backend services are preserved.
 * The old /sync endpoint is superseded by /generate in the UI only; both
 * remain fully functional in the backend.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Plus,
  Copy,
  CheckCircle2,
  Link2,
  Trash2,
  FileText,
  Loader2,
  Zap,
  ArrowRight,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  BookOpen,
  LayoutDashboard,
} from "lucide-react";
import {
  getKeyReportVersions,
  createKeyReportVersion,
  getKeyReportVersion,
  duplicateKeyReportVersion,
  addKeyReportMapping,
  removeKeyReportMapping,
  getKeyReportPopupPreference,
  setKeyReportPopupPreference,
  setSelectedReportSource,
  exportKeyReportData,
} from "../../../lib/api";
import {
  subscribeGeneration,
  getGenerationState,
  startGeneration,
  clearGeneration,
  reconcileGeneration,
} from "../../../lib/keyReportGeneration";
import { useToast } from "../../../context/ToastContext";
import { emitWorkspaceDataSourceUpdated } from "../../../lib/dataSourceEvents";
import { REPORT_SOURCE_KEYS } from "../../../lib/report-source";
import DataRoomFilePicker from "../../../components/key-reports/DataRoomFilePicker";
import KeyReportsEducationPopup from "../../../components/key-reports/KeyReportsEducationPopup";
import KeyReportSyncDashboard from "../../../components/key-reports/KeyReportSyncDashboard";
import ChartOfAccountsGrid from "../../../components/key-reports/ChartOfAccountsGrid";
import GenerateProgressPanel from "../../../components/key-reports/GenerateProgressPanel";
import { cn } from "../../../lib/utils";

// ── Document category definitions ────────────────────────────────────────────
const CATEGORIES = [
  { key: "profit_loss", label: "Profit & Loss", required: true, icon: BookOpen },
  { key: "balance_sheet", label: "Balance Sheet", required: true, icon: LayoutDashboard },
  { key: "general_ledger", label: "General Ledger", required: true, icon: FileText },
  { key: "chart_of_accounts", label: "Chart of Accounts (Optional)", required: false, icon: FileText },
  { key: "bank_statement", label: "Bank Statements", required: false, icon: FileText },
  { key: "tax_return", label: "Tax Returns", required: false, icon: FileText },
];

// ── Selected-version persistence (per client, survives navigation) ────────────
const SELECTED_VERSION_STORAGE_PREFIX = "keyReports.selectedVersionId";

function selectedVersionStorageKey(clientId) {
  return `${SELECTED_VERSION_STORAGE_PREFIX}:${clientId || "default"}`;
}

function readStoredVersionId(clientId) {
  try {
    return sessionStorage.getItem(selectedVersionStorageKey(clientId)) || null;
  } catch {
    return null;
  }
}

function writeStoredVersionId(clientId, versionId) {
  try {
    const key = selectedVersionStorageKey(clientId);
    if (versionId) sessionStorage.setItem(key, versionId);
    else sessionStorage.removeItem(key);
  } catch {
    /* sessionStorage unavailable — non-fatal */
  }
}

// ── Generate state factory ────────────────────────────────────────────────────
function createInitialGenerateState() {
  return {
    status: "idle",        // "idle" | "generating" | "done" | "error"
    startedAt: null,
    finishedAt: null,
    summary: null,
    warnings: [],
    validationResults: [],
    error: null,
    errorStage: null,      // stage key where failure occurred
  };
}

// ── Small helpers ─────────────────────────────────────────────────────────────
function CategoryCard({ cat, items, generating, onLinkClick, onUnlink }) {
  const Icon = cat.icon;
  const count = items.length;
  const isLinked = count > 0;

  return (
    <div
      className={cn(
        "rounded-2xl border bg-white p-4 transition-all",
        isLinked ? "border-primary/30 shadow-sm" : "border-border"
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold text-text-primary">
          <Icon size={14} className={isLinked ? "text-primary" : "text-text-muted"} />
          {cat.label}
          {cat.required ? (
            <span className="rounded-full bg-[#EEF6E0] px-2 py-0.5 text-[10px] font-semibold text-primary">
              required
            </span>
          ) : (
            <span className="rounded-full bg-bg-page px-2 py-0.5 text-[10px] text-text-muted">
              optional
            </span>
          )}
        </h3>

        <div className="flex items-center gap-1.5">
          {isLinked && (
            <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
              <CheckCircle2 size={11} /> {count} linked
            </span>
          )}
          <button
            onClick={() => onLinkClick(cat.key)}
            disabled={generating}
            className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
          >
            <Link2 size={12} />
            {isLinked ? "Add More" : "Link Files"}
          </button>
        </div>
      </div>

      {count === 0 ? (
        <p className="py-2 text-center text-xs text-text-muted">No files linked yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((m) => (
            <li
              key={m.id}
              className="flex items-center gap-2 rounded-lg bg-bg-page px-2.5 py-1.5 text-sm"
            >
              <CheckCircle2 size={13} className="shrink-0 text-primary" />
              <span className="truncate text-text-primary" title={m.fileName}>
                {m.fileName || "Untitled file"}
              </span>
              <button
                onClick={() => onUnlink(m.id)}
                disabled={generating}
                className="ml-auto rounded p-1 text-text-muted hover:bg-white hover:text-negative disabled:opacity-50"
                title="Unlink"
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Main page component ───────────────────────────────────────────────────────
export default function WorkspaceKeyReports() {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  // ── Version / detail state ────────────────────────────────────────────────
  const [versions, setVersions] = useState([]);
  const [selectedVersionId, setSelectedVersionId] = useState(() => readStoredVersionId(clientId));
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // ── Generate workflow state ───────────────────────────────────────────────
  // Generation state is owned by the module-level manager (survives navigation
  // and persists per version in sessionStorage). We re-render on its updates via
  // a tick and read the selected version's state each render.
  const [, setGenTick] = useState(0);
  useEffect(() => subscribeGeneration(() => setGenTick((t) => t + 1)), []);

  const generateState =
    getGenerationState(clientId, selectedVersionId) || createInitialGenerateState();
  const generating = generateState.status === "generating";

  // ── File-picker state ─────────────────────────────────────────────────────
  const [pickerCategory, setPickerCategory] = useState(null);

  // ── Education popup ───────────────────────────────────────────────────────
  const [showPopup, setShowPopup] = useState(false);

  // ── COA editor visibility (collapsible below Validation Dashboard) ────────
  const [showCoa, setShowCoa] = useState(false);

  // ── Export data state ─────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);

  // ── Notification helper ───────────────────────────────────────────────────
  const notify = useCallback(
    (msg, type = "info") => {
      toast?.showToast?.({ type, title: msg });
    },
    [toast]
  );

  // ── Education popup preference ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    getKeyReportPopupPreference()
      .then((res) => { if (!cancelled && res && !res.dismissed) setShowPopup(true); })
      .catch(() => { });
    return () => { cancelled = true; };
  }, []);

  // ── Version loading ───────────────────────────────────────────────────────
  const loadVersions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getKeyReportVersions();
      const list = res?.versions || [];
      const filtered = list.filter((v) => !v.versionName?.includes("PERF-TEST"));
      setVersions(filtered);
      setSelectedVersionId((prev) => {
        if (prev && filtered.some((v) => v.id === prev)) return prev;
        // Restore the user's last selection (persisted across navigation) if valid.
        const stored = readStoredVersionId(clientId);
        if (stored && filtered.some((v) => v.id === stored)) return stored;
        const active = filtered.find((v) => v.isActive);
        return active?.id || filtered[0]?.id || null;
      });
    } catch (e) {
      notify(e.message || "Failed to load Key Reports.", "error");
    } finally {
      setLoading(false);
    }
  }, [notify, clientId]);

  useEffect(() => {
    void Promise.resolve().then(() => loadVersions());
  }, [loadVersions]);

  // Persist the selected version so it is restored when the user navigates away
  // and returns to this page within the same session.
  useEffect(() => {
    writeStoredVersionId(clientId, selectedVersionId);
  }, [clientId, selectedVersionId]);

  // ── Version detail loading ────────────────────────────────────────────────
  const loadDetail = useCallback(async (versionId) => {
    if (!versionId) { setDetail(null); return; }
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

  // After the version detail loads, reconcile any orphaned "generating" state
  // left by a hard page reload (the in-memory request was lost). Uses the
  // server's lastSyncedAt + persisted validation results to promote to done or
  // reset to idle, so the user never sees a permanent spinner.
  useEffect(() => {
    if (!selectedVersionId || !detail?.version) return;
    reconcileGeneration(clientId, selectedVersionId, {
      lastSyncedAt: detail.version.lastSyncedAt,
      validationResults: detail.validationResults,
    });
  }, [clientId, selectedVersionId, detail]);

  // ── Derived data ──────────────────────────────────────────────────────────
  const version = detail?.version;
  const mappingsByCategory = detail?.mappingsByCategory || {};
  const hasSyncedData = Boolean(version?.lastSyncedAt) && !generating;

  const linkedDocumentIds = useMemo(() => {
    if (!detail?.mappingsByCategory) return [];
    return Object.values(detail.mappingsByCategory)
      .flat()
      .map((m) => m.documentId)
      .filter(Boolean);
  }, [detail]);

  const linkedDocumentCount = linkedDocumentIds.length;

  // Merge in-flight generate results with persisted validation results so the
  // Validation Dashboard shows data after a full-page reload too.
  const persistedValidationResults = useMemo(() => {
    return Array.isArray(detail?.validationResults) ? detail.validationResults : [];
  }, [detail]);

  const displaySyncState = useMemo(() => {
    const base = {
      status: generateState.status === "generating" ? "processing"
        : generateState.status === "done" ? "validation"
          : generateState.status === "error" ? "error"
            : generateState.validationResults?.length > 0 ||
              persistedValidationResults.length > 0 ? "validation"
              : "idle",
      startedAt: generateState.startedAt,
      finishedAt: generateState.finishedAt,
      summary: generateState.summary,
      warnings: generateState.warnings,
      error: generateState.error,
    };
    return {
      ...base,
      validationResults:
        generateState.validationResults?.length > 0
          ? generateState.validationResults
          : persistedValidationResults,
    };
  }, [generateState, persistedValidationResults]);

  // ── Active data source switch (best-effort, never blocks generate) ────────
  const switchToKeyReportsSource = useCallback(async () => {
    if (!clientId) return;
    try {
      await setSelectedReportSource(REPORT_SOURCE_KEYS.KEY_REPORTS, {
        clientId,
        confirmSwitch: true,
      });
      emitWorkspaceDataSourceUpdated({
        clientId,
        sourceKey: REPORT_SOURCE_KEYS.KEY_REPORTS,
      });
    } catch (switchErr) {
      console.warn(
        "[KeyReports] Failed to switch active source to Key Reports:",
        switchErr?.message
      );
    }
  }, [clientId]);

  // ── Version management ────────────────────────────────────────────────────
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

  // ── File linking ──────────────────────────────────────────────────────────
  const handleLinkFiles = async (docs) => {
    if (!selectedVersionId || !pickerCategory || !docs?.length) return;
    try {
      await addKeyReportMapping(selectedVersionId, {
        reportCategory: pickerCategory,
        documentIds: docs.map((d) => d.id),
      });
      clearGeneration(clientId, selectedVersionId);
      await loadDetail(selectedVersionId);
      notify(`Linked ${docs.length} file${docs.length === 1 ? "" : "s"}.`, "success");
    } catch (e) {
      notify(e.message || "Failed to link files.", "error");
    }
  };

  const handleUnlink = async (mappingId) => {
    try {
      await removeKeyReportMapping(mappingId);
      clearGeneration(clientId, selectedVersionId);
      await loadDetail(selectedVersionId);
      notify("File unlinked.", "success");
    } catch (e) {
      notify(e.message || "Failed to unlink file.", "error");
    }
  };

  // ── Generate workflow ─────────────────────────────────────────────────────
  // The actual generation runs in the module-level manager (survives navigation
  // and persists per-version state). We kick it off, then — if still mounted —
  // refresh the version detail and switch the active source once it finishes.
  // The completion toast is emitted by the notify effect above, so it fires even
  // if the user leaves the page mid-sync and returns later.
  const runGenerate = async () => {
    if (!selectedVersionId) return;
    if (linkedDocumentCount === 0) {
      notify(
        "Link at least one financial statement before generating.",
        "error"
      );
      return;
    }

    const versionId = selectedVersionId;
    const versionMeta = versions.find((v) => v.id === versionId);
    const versionLabel =
      versionMeta?.versionName || `Version ${versionMeta?.versionNumber ?? ""}`.trim();
    setShowCoa(false); // collapse COA editor during generation

    const result = await startGeneration(clientId, versionId, versionLabel);

    if (result?.ok) {
      await Promise.all([loadDetail(versionId), loadVersions()]);
      // Switch the active data source to Key Reports so Reports pages
      // immediately serve from the newly generated data.
      await switchToKeyReportsSource();
    }
  };

  const handleGenerateClick = () => void runGenerate();
  const handleRetry = () => void runGenerate();

  // ── Education popup ───────────────────────────────────────────────────────
  const dismissPopupForever = () => {
    setKeyReportPopupPreference(true).catch(() => { });
  };

  // ── Export data ────────────────────────────────────────────────────────────
  const handleExportData = async () => {
    if (!selectedVersionId) return;
    setExporting(true);
    try {
      await exportKeyReportData(selectedVersionId);
      notify("Data exported successfully.", "success");
    } catch (e) {
      notify(e.message || "Failed to export data.", "error");
    } finally {
      setExporting(false);
    }
  };

  // ── Render states ─────────────────────────────────────────────────────────
  const isDone = generateState.status === "done";
  const isError = generateState.status === "error";

  // Show the validation dashboard if:
  //   (a) generate just completed this session, OR
  //   (b) the version has previously been synced (persisted results exist)
  const showValidationDashboard =
    isDone ||
    isError ||
    persistedValidationResults.length > 0 ||
    Boolean(version?.lastSyncedAt);

  // ── JSX ───────────────────────────────────────────────────────────────────
  return (
    <div className="p-6">
      {/* Education popup */}
      {showPopup && (
        <KeyReportsEducationPopup
          onClose={() => setShowPopup(false)}
          onDismissForever={dismissPopupForever}
        />
      )}

      {/* File picker modal */}
      <DataRoomFilePicker
        isOpen={!!pickerCategory}
        companyId={clientId}
        title={`Link files — ${CATEGORIES.find((c) => c.key === pickerCategory)?.label || ""}`}
        alreadyLinkedIds={linkedDocumentIds}
        onClose={() => setPickerCategory(null)}
        onSelect={handleLinkFiles}
      />

      {/* ── Page header ────────────────────────────────────────────────── */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Key Reports</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Link your financial documents and click <strong>Generate</strong> to
            build AI-powered financial reports.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Version selector */}
          <select
            value={selectedVersionId || ""}
            onChange={(e) => setSelectedVersionId(e.target.value)}
            disabled={generating}
            className="rounded-xl border border-border bg-white px-3 py-2 text-sm text-text-primary disabled:opacity-50"
          >
            {versions.length === 0 && <option value="">No versions</option>}
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.versionName || `Version ${v.versionNumber}`}
                {v.isActive ? " ✦ (official)" : ""}
              </option>
            ))}
          </select>

          <button
            onClick={handleCreateVersion}
            disabled={busy || generating}
            className="flex items-center gap-1.5 rounded-xl border border-border bg-white px-3 py-2 text-sm font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
          >
            <Plus size={15} /> New
          </button>

          <button
            onClick={handleDuplicate}
            disabled={busy || generating || !selectedVersionId}
            className="flex items-center gap-1.5 rounded-xl border border-border bg-white px-3 py-2 text-sm font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
          >
            <Copy size={15} /> Duplicate
          </button>
        </div>
      </div>

      {/* ── Loading state ──────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center gap-2 py-16 text-sm text-text-muted">
          <Loader2 size={16} className="animate-spin" /> Loading…
        </div>

      ) : versions.length === 0 ? (
        /* ── Empty state ──────────────────────────────────────────────── */
        <div className="rounded-2xl border border-dashed border-border bg-white p-10 text-center">
          <FileText size={28} className="mx-auto text-text-muted" />
          <p className="mt-3 text-sm font-medium text-text-primary">No Key Report versions yet</p>
          <p className="mt-1 text-sm text-text-secondary">
            Create your first version to start linking financial documents.
          </p>
          <button
            onClick={handleCreateVersion}
            disabled={busy}
            className="mx-auto mt-4 flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            <Plus size={15} /> Create Version 1
          </button>
        </div>

      ) : (
        <div className="space-y-6">

          {/* ══ STAGE 1: Link Documents ════════════════════════════════════ */}
          <section>
            <div className="mb-4 flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-white">
                1
              </span>
              <h2 className="text-base font-bold text-text-primary">Link Documents</h2>
              {linkedDocumentCount > 0 && (
                <span className="ml-auto flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                  <CheckCircle2 size={12} />
                  {linkedDocumentCount} document{linkedDocumentCount !== 1 ? "s" : ""} linked
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {CATEGORIES.map((cat) => (
                <CategoryCard
                  key={cat.key}
                  cat={cat}
                  items={mappingsByCategory[cat.key] || []}
                  generating={generating}
                  onLinkClick={(key) => setPickerCategory(key)}
                  onUnlink={handleUnlink}
                />
              ))}
            </div>
          </section>

          {/* ══ STAGE 2: Generate ══════════════════════════════════════════ */}
          <section>
            <div className="mb-4 flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-white">
                2
              </span>
              <h2 className="text-base font-bold text-text-primary">Generate</h2>
              {isDone && (
                <span className="ml-auto flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                  <CheckCircle2 size={12} /> Reports ready
                </span>
              )}
              {isError && (
                <span className="ml-auto flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-700">
                  <AlertCircle size={12} /> Generation failed
                </span>
              )}
            </div>

            {/* ── Generate button row (only shown when not actively running) ── */}
            {!generating && (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-white px-5 py-4">
                <div>
                  <p className="text-sm font-bold text-text-primary">
                    {isDone
                      ? "Re-Generate"
                      : hasSyncedData
                        ? "Re-Generate Reports"
                        : "Generate Reports"}
                  </p>
                  <p className="mt-0.5 text-sm text-text-secondary">
                    {isDone || hasSyncedData
                      ? "Re-run AI Processing, COA, and all Financial Reports with the latest linked documents."
                      : "Run AI Processing, build Chart of Accounts, and generate all Financial Reports in one step."}
                    {linkedDocumentCount === 0 && (
                      <span className="ml-1 font-medium text-amber-600">
                        Link at least one document first.
                      </span>
                    )}
                  </p>
                </div>

                <button
                  id="btn-generate-key-reports"
                  onClick={handleGenerateClick}
                  disabled={!selectedVersionId || linkedDocumentCount === 0}
                  className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-40"
                >
                  <Zap size={15} />
                  {isDone || hasSyncedData ? "Re-Generate" : "Generate"}
                </button>
              </div>
            )}

            {/* ── Progress panel (during / after generation) ─────────────── */}
            {generateState.status !== "idle" && (
              <GenerateProgressPanel
                key={generateState.startedAt || "idle"}
                status={generateState.status}
                versionId={selectedVersionId}
                startedAt={generateState.startedAt}
                finishedAt={generateState.finishedAt}
                errorStage={generateState.errorStage}
                errorMessage={generateState.error}
                onRetry={handleRetry}
              />
            )}

            {/* ── Validation Dashboard (after done OR from persisted data) ── */}
            {showValidationDashboard && !generating && (
              <div className={cn(generateState.status !== "idle" && "mt-4")}>
                <KeyReportSyncDashboard
                  version={version}
                  syncState={displaySyncState}
                  hasLinkedDocuments={linkedDocumentCount > 0}
                />
              </div>
            )}

            {/* ── Open Reports button ────────────────────────────────────── */}
            {(isDone || hasSyncedData) && !generating && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/60 px-5 py-4">
                <div>
                  <p className="text-sm font-bold text-emerald-800">
                    Reports are ready
                  </p>
                  <p className="mt-0.5 text-sm text-emerald-700">
                    P&L, Balance Sheet, Cash Flow and EBITDA are all populated
                    from the generated data.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    id="btn-export-data"
                    onClick={handleExportData}
                    disabled={exporting}
                    className="flex items-center gap-2 rounded-xl border border-emerald-600 bg-white px-4 py-2.5 text-sm font-semibold text-emerald-600 hover:bg-emerald-50 disabled:opacity-50"
                  >
                    {exporting ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        Exporting…
                      </>
                    ) : (
                      <>
                        <FileText size={14} />
                        Export Data
                      </>
                    )}
                  </button>
                  <button
                    id="btn-open-reports"
                    onClick={() =>
                      navigate(`/broker/client/${clientId}/reports`)
                    }
                    className="flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
                  >
                    Open Reports <ExternalLink size={14} />
                  </button>
                </div>
              </div>
            )}

            {/* ── Collapsible COA editor ─────────────────────────────────── */}
            {hasSyncedData && !generating && (
              <div className="mt-4">
                <button
                  onClick={() => setShowCoa((v) => !v)}
                  className="flex w-full items-center justify-between rounded-2xl border border-border bg-white px-5 py-3.5 text-left transition hover:bg-bg-page"
                >
                  <div className="flex items-center gap-2">
                    <ArrowRight size={14} className="text-primary" />
                    <span className="text-sm font-semibold text-text-primary">
                      Edit Chart of Accounts
                    </span>
                    <span className="text-xs text-text-muted">
                      — optional: review and adjust account classifications
                    </span>
                  </div>
                  {showCoa ? (
                    <ChevronUp size={16} className="text-text-muted" />
                  ) : (
                    <ChevronDown size={16} className="text-text-muted" />
                  )}
                </button>

                {showCoa && (
                  <div className="mt-2">
                    <ChartOfAccountsGrid
                      versionId={selectedVersionId}
                      hasSyncedData={hasSyncedData}
                      notify={notify}
                    />
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

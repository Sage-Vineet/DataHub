// Shared Key Reports "consumption context" for the report consumer pages
// (Reports, Bank Reconciliation, Tax Reconciliation).
//
// The Key Reports module is the single source of truth: the SELECTED Key Report
// Version — not the Connections-page active data source — drives which documents
// and dataset a report is generated from. This store holds that selection once
// so all three pages stay in sync, and derives:
//   - effectiveSource: the report-source key implied by the version's flow
//     (manual_gl vs manual_upload), so the pages render the right mode WITHOUT
//     reading DataSourceContext.activeSource.
//   - resolvedDatasetVersion: the Manual GL dataset version the active version is
//     pinned to (used to scope batch-based reports: P&L / Balance Sheet / Cashflow).
//   - availability: which reports/recons are enabled, auto-detected purely from
//     the version's linked document categories (Phase 3 consumes this).
//
// When a company has NO Key Report versions, `krActive` is false and the pages
// fall back to their existing DataSourceContext-driven behavior unchanged — the
// Connections workflow is never affected.

import { create } from "zustand";
import { getKeyReportVersions, getKeyReportVersion } from "../lib/api";
import { REPORT_SOURCE_KEYS } from "../lib/report-source";

// Derive the flow type for a Key Reports version:
//   "manual_gl"    — old-style: version has a resolvedBatchId pointing at a Manual GL
//                    batch; reports still read from manual_gl_staged_transactions.
//   "manual_upload"— new-style: version syncs directly into the accounting tables
//                    (GL, COA, generated Balance Sheets, etc.); reports read
//                    ONLY from those tables via the /key-reports/versions/:id/reports/*
//                    endpoints. The presence of GL documents does NOT imply a batch —
//                    removing glCount from this check stops the report page from
//                    treating new-style KR as Manual GL (which caused spurious
//                    /manual-gl/staging/filter-options + /reports/balance-sheet/monthly-detail calls).
export function deriveFlowType(version) {
  if (version?.resolvedBatchId) return "manual_gl";
  return "manual_upload";
}

export function flowToReportSource(flowType) {
  return flowType === "manual_gl"
    ? REPORT_SOURCE_KEYS.MANUAL_GL
    : REPORT_SOURCE_KEYS.MANUAL_UPLOAD;
}

// Auto-detect which reports/recons a version can produce, from its linked
// document categories (per spec):
//   GL (or P&L doc)            → Profit & Loss
//   Balance Sheet (start+end)  → Balance Sheet reports
//   GL + Tax Return            → Tax Reconciliation
//   GL + Bank Statement        → Bank Reconciliation
// In the manual_upload flow a linked P&L document substitutes for GL as the
// "books" source, so it also satisfies the P&L / recon prerequisites.
let lastMappings = null;
let lastAvailability = null;

export function deriveAvailability(mappingsByCategory) {
  if (mappingsByCategory === lastMappings && lastAvailability) {
    return lastAvailability;
  }

  const m = mappingsByCategory || {};
  const count = (k) => (m[k] || []).length;
  const hasGL = count("general_ledger") > 0;
  const hasPL = count("profit_loss") > 0;
  const hasBS = count("balance_sheet") > 0;
  const hasBank = count("bank_statement") > 0;
  const hasTax = count("tax_return") > 0;

  lastMappings = mappingsByCategory;
  lastAvailability = {
    // Profit & Loss is supported by either GL or a standalone P&L document.
    profitLoss: hasGL || hasPL,
    // Balance Sheet is supported by either GL or a standalone BS document.
    balanceSheet: hasGL || hasBS,
    // Bank reports are supported by a Bank Statement document.
    bank: hasBank,
    // Tax reports are supported by a Tax Return document.
    tax: hasTax,
    // raw counts for building "link X in Key Reports" guidance
    counts: {
      general_ledger: count("general_ledger"),
      profit_loss: count("profit_loss"),
      balance_sheet: count("balance_sheet"),
      bank_statement: count("bank_statement"),
      tax_return: count("tax_return"),
    },
    // Sync is allowed if at least one supported document is linked.
    isSyncable: hasGL || hasPL || hasBS || hasBank || hasTax,
  };
  return lastAvailability;
}

export const useKeyReportContextStore = create((set, get) => ({
  companyId: null,
  versions: [],
  selectedVersionId: null,
  detail: null, // { version, mappingsByCategory, syncLogs }
  loading: false,
  loadingDetail: false,
  error: null,
  loadedCompanyId: null,

  // Load the version list for a company and default the selection to the active
  // version (falling back to the newest). Skips refetch for the same company
  // unless forced.
  fetchVersions: async (companyId, force = false) => {
    if (!companyId) return;
    if (!force && get().loadedCompanyId === companyId && get().versions.length) return;
    set({ loading: true, error: null, companyId });
    try {
      const res = await getKeyReportVersions();
      const list = res?.versions || [];
      set({ versions: list, loadedCompanyId: companyId, loading: false });
      // Default / reconcile the selection.
      const prev = get().selectedVersionId;
      const stillValid = prev && list.some((v) => v.id === prev);
      const next = stillValid
        ? prev
        : list.find((v) => v.isActive)?.id || list[0]?.id || null;
      if (next !== prev || !get().detail) {
        await get().selectVersion(next);
      }
    } catch (e) {
      set({ error: e?.message || "Failed to load Key Reports versions.", loading: false });
    }
  },

  // Select a version and load its linked-document detail.
  selectVersion: async (versionId) => {
    set({ selectedVersionId: versionId || null });
    if (!versionId) {
      set({ detail: null });
      return;
    }
    set({ loadingDetail: true });
    try {
      const detail = await getKeyReportVersion(versionId);
      // Guard against an out-of-order response after another selectVersion.
      if (get().selectedVersionId === versionId) set({ detail, loadingDetail: false });
    } catch {
      if (get().selectedVersionId === versionId) set({ detail: null, loadingDetail: false });
    }
  },

  clear: () =>
    set({
      companyId: null,
      versions: [],
      selectedVersionId: null,
      detail: null,
      loading: false,
      loadingDetail: false,
      error: null,
      loadedCompanyId: null,
    }),
}));

// Convenience selector hook: returns the resolved consumption context for the
// report pages. `krActive` is true only when a usable version is selected; when
// false, callers should fall back to their DataSourceContext behavior.
const INACTIVE_CONTEXT = {
  krActive: false,
  versions: [],
  selectedVersionId: null,
  version: null,
  flowType: null,
  effectiveSource: null,
  resolvedDatasetVersion: null,
  mappingsByCategory: null,
  availability: deriveAvailability(null),
  loading: false,
  loadingDetail: false,
};

export function selectKeyReportContext(state) {
  const { versions, selectedVersionId, detail } = state;
  const version = detail?.version || null;
  const mappingsByCategory = detail?.mappingsByCategory || null;
  const hasVersions = versions.length > 0;

  if (!hasVersions || !version) {
    return {
      ...INACTIVE_CONTEXT,
      versions,
      selectedVersionId,
      loadedCompanyId: state.loadedCompanyId,
      loading: state.loading,
      loadingDetail: state.loadingDetail,
      error: state.error,
    };
  }

  const flowType = deriveFlowType(version);
  const availability = deriveAvailability(mappingsByCategory);

  return {
    krActive: true,
    versions,
    selectedVersionId,
    loadedCompanyId: state.loadedCompanyId,
    version,
    flowType,
    effectiveSource: flowToReportSource(flowType),
    resolvedDatasetVersion: version.resolvedDatasetVersion ?? null,
    mappingsByCategory,
    availability,
    // Add raw mappings for document-driven pages (e.g. resolve which PDF to render)
    documents: mappingsByCategory || {},
    loading: state.loading,
    loadingDetail: state.loadingDetail,
    error: state.error,
  };
}

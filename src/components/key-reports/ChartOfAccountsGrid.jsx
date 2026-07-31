import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import {
  RefreshCw, Loader2, Table2, Check, X, Pencil, RotateCcw, Search, Undo2, Redo2, Download,
  FolderInput, GitMerge, Sparkles, Save, AlertTriangle,
} from "lucide-react";
import {
  getChartOfAccounts, regenerateChartOfAccounts, resetChartOfAccount,
  resetChartOfAccounts, saveChartOfAccounts,
} from "../../lib/api";
import {
  collapsePath, computeDescendantRelabel, collectCategoryOptions,
  validateDraftTree, MAX_HIERARCHY_LEVELS,
} from "../../lib/coaTree";
import { clearCachedFinancials } from "../../lib/keyReportFinancials";
import { useHierarchyRecommendations } from "../../hooks/useHierarchyRecommendations";

const STATEMENT_LABELS = { balance_sheet: "Balance Sheet", profit_loss: "P&L" };
const METHOD_LABELS = {
  rule: "Rule", gemini: "AI", hybrid: "AI+Rules", manual: "Manual",
  ai_hierarchy: "AI (full hierarchy)",
  // Legacy values a previously-generated row can still carry until its next
  // regenerate — kept so old rows still render a readable label instead of
  // falling back to the raw method string.
  gemini_category: "AI (category match)", existing_working_coa: "Existing COA",
  bs_section: "Balance Sheet section", pl_section: "P&L section",
};
const MAX_LEVELS = MAX_HIERARCHY_LEVELS;
const LEVEL_INDEXES = Array.from({ length: MAX_LEVELS }, (_, i) => i);

// ── Financial section / sub-section structure (mirrors the client's Excel) ───
// Order: P&L → Balance Sheet; within P&L: Income → Expenses; within BS: Assets → Liabilities → Equity
const SECTION_DEFS = [
  {
    key: "pl",
    label: "PROFIT & LOSS ACCOUNTS",
    subGroups: [
      { key: "income",    label: "Income",      types: new Set(["income"]) },
      { key: "expenses",  label: "Expenses",    types: new Set(["expense", "cogs"]) },
    ],
  },
  {
    key: "bs",
    label: "BALANCE SHEET ACCOUNTS",
    subGroups: [
      { key: "assets",      label: "Assets",      types: new Set(["asset"]) },
      { key: "liabilities", label: "Liabilities", types: new Set(["liability"]) },
      { key: "equity",      label: "Equity",      types: new Set(["equity"]) },
    ],
  },
];

// Map accountType → { sectionKey, subGroupKey }
const TYPE_MAP = {};
for (const sec of SECTION_DEFS) {
  for (const sg of sec.subGroups) {
    for (const t of sg.types) TYPE_MAP[t] = { sectionKey: sec.key, subGroupKey: sg.key };
  }
}

// An account with no recognized accountType (needs_mapping — Gemini returned
// nothing and no chart_of_accounts match was found; never guessed/defaulted)
// must still surface here rather than silently vanish from TYPE_MAP lookups —
// this section is exactly the "Chart of Accounts Review" queue.
const NEEDS_MAPPING_KEY = "needs_mapping";
const NEEDS_MAPPING_SECTION = {
  key: NEEDS_MAPPING_KEY,
  label: "NEEDS MAPPING",
  subGroups: [{ key: NEEDS_MAPPING_KEY, label: "Unclassified / Awaiting Review", types: new Set() }],
};

// Total column count (must stay in sync with the <thead> below)
// systemId + acctNum + acctName + acctIdName + stmt + 15 levels + path + method + adjustedName + actions
const TOTAL_COLS = 5 + MAX_LEVELS + 4;

function parsePathInput(value) {
  return String(value || "").split(">").map((s) => s.trim()).filter(Boolean);
}

export default function ChartOfAccountsGrid({ clientId, versionId, hasSyncedData, notify }) {
  const [serverFlat, setServerFlat] = useState([]);
  const [patches, setPatches] = useState(new Map()); // accountId -> { levels?, adjustedName? }
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);
  const [loading, setLoading]         = useState(false);
  const [saving, setSaving]           = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [resettingAll, setResettingAll] = useState(false);
  const [editingId, setEditingId]     = useState(null);
  const [editName, setEditName]       = useState("");
  const [editLevels, setEditLevels]   = useState([]); // array of MAX_LEVELS strings, source of truth while editing
  const [search, setSearch]           = useState("");
  const [mappingId, setMappingId]           = useState(null);
  const [mappingCategoryKey, setMappingCategoryKey] = useState("");
  const [mappingBaseName, setMappingBaseName]       = useState("");
  const [mergeEditor, setMergeEditor] = useState(null); // { id, categoryPrefixArr, value }
  const [saveErrors, setSaveErrors] = useState(null);

  const rec = useHierarchyRecommendations(clientId, versionId, notify);

  // ── Data loading ─────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!versionId) { setServerFlat([]); return; }
    setLoading(true);
    try {
      const res = await getChartOfAccounts(versionId);
      setServerFlat(res?.flat || []);
      setPatches(new Map());
      setHistory([]);
      setFuture([]);
      setSaveErrors(null);
    } catch (e) {
      notify?.(e.message || "Failed to load Chart of Accounts.", "error");
      setServerFlat([]);
    } finally {
      setLoading(false);
    }
  }, [versionId, notify]);

  useEffect(() => { load(); }, [load]);

  // ── Draft: serverFlat + in-memory patches overlay ────────────────────────
  // Edits (rename / edit hierarchy path / move / merge) stage here until
  // Save — nothing is written to the server until then, and Undo/Redo step
  // through this history.
  const flat = useMemo(() => {
    if (!patches.size) return serverFlat;
    return serverFlat.map((row) => {
      const patch = patches.get(row.id);
      if (!patch) return row;
      const levels = patch.levels || row.levels;
      const hierarchyPath = patch.levels ? collapsePath(patch.levels).join(" > ") : row.hierarchyPath;
      const adjustedName = patch.adjustedName !== undefined ? patch.adjustedName : row.adjustedName;
      return {
        ...row,
        levels,
        hierarchyPath,
        adjustedName,
        accountName: adjustedName || row.sourceName,
        pendingEdit: true,
      };
    });
  }, [serverFlat, patches]);

  const categoryOptions = useMemo(() => collectCategoryOptions(flat), [flat]);
  const draftValidation = useMemo(
    () => validateDraftTree(flat.filter((r) => !r.metadata?.needs_mapping)),
    [flat],
  );

  const pendingCount = patches.size;
  const modifiedCount = useMemo(() => flat.filter((r) => r.modified || r.pendingEdit).length, [flat]);
  const needsMappingCount = useMemo(() => flat.filter((r) => r.metadata?.needs_mapping).length, [flat]);

  // ── History-aware patch application (undo/redo) ─────────────────────────
  const commitPatches = useCallback((updater) => {
    setHistory((h) => [...h, patches]);
    setFuture([]);
    setPatches(updater(patches));
    setSaveErrors(null);
  }, [patches]);

  // Single primitive every edit action goes through: [{accountId, patch}, ...]
  // applied together as ONE undo step, so a row edit that changes both name
  // and hierarchy path (or a merge affecting many accounts) undoes in one go.
  const applyRowEdits = useCallback((pairs) => {
    if (!pairs.length) { notify?.("Nothing to change — already there.", "error"); return; }
    commitPatches((prev) => {
      const next = new Map(prev);
      for (const { accountId, patch } of pairs) {
        next.set(accountId, { ...next.get(accountId), ...patch });
      }
      return next;
    });
  }, [commitPatches, notify]);

  const applyPatch = useCallback((accountId, patchUpdate) => {
    applyRowEdits([{ accountId, patch: patchUpdate }]);
  }, [applyRowEdits]);

  const applyBatchRelabel = useCallback((pairs) => {
    applyRowEdits(pairs.map((p) => ({ accountId: p.accountId, patch: { levels: p.levels } })));
  }, [applyRowEdits]);

  const undo = () => {
    if (!history.length) return;
    const prevSnapshot = history[history.length - 1];
    setFuture((f) => [patches, ...f]);
    setHistory((h) => h.slice(0, -1));
    setPatches(prevSnapshot);
    setSaveErrors(null);
  };
  const redo = () => {
    if (!future.length) return;
    const nextSnapshot = future[0];
    setHistory((h) => [...h, patches]);
    setFuture((f) => f.slice(1));
    setPatches(nextSnapshot);
    setSaveErrors(null);
  };
  const discardDraft = () => {
    setPatches(new Map());
    setHistory([]);
    setFuture([]);
    setSaveErrors(null);
  };

  // ── Save / Regenerate / Reset all ────────────────────────────────────────
  const handleSave = async () => {
    if (!patches.size) return;
    const nodes = Array.from(patches.entries()).map(([accountId, patch]) => ({
      accountId,
      ...(patch.levels ? { levels: patch.levels, movedParent: true } : {}),
      ...(patch.adjustedName !== undefined ? { adjustedName: patch.adjustedName } : {}),
    }));
    setSaving(true);
    try {
      const res = await saveChartOfAccounts(versionId, nodes);
      setServerFlat(res?.flat || []);
      setPatches(new Map());
      setHistory([]);
      setFuture([]);
      setSaveErrors(null);
      // A hierarchy edit changes chart_of_accounts.updated_at, which is one of
      // the two signals the backend financial-statements cache keys on — but
      // the frontend's own sessionStorage copy has no such key and would keep
      // serving the pre-edit tree/numbers for the rest of the browser session
      // otherwise (see WorkspaceReconciliation.jsx, which reads it before the
      // network).
      clearCachedFinancials(clientId, versionId);
      notify?.(`Saved ${nodes.length} account${nodes.length === 1 ? "" : "s"}.`, "success");
    } catch (e) {
      const violations = e.payload?.violations;
      if (Array.isArray(violations) && violations.length) {
        setSaveErrors(violations);
        notify?.("Some changes couldn't be saved — see the details below.", "error");
      } else {
        notify?.(e.message || "Failed to save Chart of Accounts.", "error");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleRegenerate = async () => {
    if (!versionId) return;
    setRegenerating(true);
    try {
      const res = await regenerateChartOfAccounts(versionId);
      setServerFlat(res?.flat || []);
      discardDraft();
      clearCachedFinancials(clientId, versionId);
      // Reuse the counts the backend already computed (summary.sourceCounts)
      // instead of a generic "regenerated" message — accurately reflects how
      // many accounts came from the uploaded documents/Chart of Accounts vs.
      // needed AI classification vs. still need manual mapping, rather than
      // implying AI classified everything.
      const total = res?.summary?.accountCount ?? res?.flat?.length ?? 0;
      const aiClassified = res?.summary?.sourceCounts?.aiHierarchy ?? 0;
      const needsMapping = res?.summary?.sourceCounts?.needsMapping ?? 0;
      const documentMatched = Math.max(0, total - aiClassified - needsMapping);
      const parts = [`${total} account${total === 1 ? "" : "s"} generated.`];
      if (documentMatched) parts.push(`${documentMatched} resolved from uploaded documents.`);
      if (aiClassified) parts.push(`${aiClassified} required AI classification.`);
      if (needsMapping) parts.push(`${needsMapping} require${needsMapping === 1 ? "s" : ""} manual mapping.`);
      notify?.(`Chart of Accounts generated successfully. ${parts.join(" ")}`, "success");
    } catch (e) {
      notify?.(e.message || "Failed to regenerate Chart of Accounts.", "error");
    } finally { setRegenerating(false); }
  };

  const handleResetAll = async () => {
    if (!versionId) return;
    setResettingAll(true);
    try {
      const res = await resetChartOfAccounts(versionId);
      setServerFlat(res?.flat || []);
      discardDraft();
      clearCachedFinancials(clientId, versionId);
      notify?.("Restored all accounts to the original AI classification.", "success");
    } catch (e) {
      notify?.(e.message || "Failed to reset hierarchy.", "error");
    } finally { setResettingAll(false); }
  };

  // ── Edit — the WHOLE row becomes editable at once: Adjusted Name AND every
  // Level 1..15 cell (with the Hierarchy Path field as a synced, two-way
  // free-text view of the same levels — edit either and the other follows),
  // committed together as one undo step. ────────────────────────────────────
  const startEdit = (row) => {
    setEditingId(row.id);
    setEditName(row.adjustedName || row.accountName || "");
    const levels = new Array(MAX_LEVELS).fill("");
    (row.levels || []).forEach((v, i) => { if (i < MAX_LEVELS) levels[i] = v || ""; });
    setEditLevels(levels);
  };
  const cancelEdit = () => { setEditingId(null); setEditName(""); setEditLevels([]); };
  const setEditLevelAt = (i, value) => {
    setEditLevels((prev) => {
      const next = [...prev];
      next[i] = value;
      return next;
    });
  };
  // The Hierarchy Path field edits the same editLevels array as one string —
  // re-parsing it on every keystroke and padding/truncating back to MAX_LEVELS.
  const editPathValue = collapsePath(editLevels).join(" > ");
  const setEditPathValue = (value) => {
    const parsed = parsePathInput(value);
    const next = new Array(MAX_LEVELS).fill("");
    parsed.slice(0, MAX_LEVELS).forEach((v, i) => { next[i] = v; });
    setEditLevels(next);
  };
  const saveEdit = (row) => {
    const trimmedName = editName.trim();
    const trimmedPathArr = editLevels.map((v) => (v || "").trim()).filter(Boolean);
    const oldPath = (row.levels || []).filter(Boolean);
    const nameChanged = trimmedName && trimmedName !== (row.adjustedName || row.accountName);
    const pathChanged = trimmedPathArr.length && trimmedPathArr.join(" > ") !== oldPath.join(" > ");
    if (!nameChanged && !pathChanged) { cancelEdit(); return; }

    const pairs = [];
    if (pathChanged) {
      for (const p of computeDescendantRelabel(flat, oldPath, trimmedPathArr)) {
        pairs.push({ accountId: p.accountId, patch: { levels: p.levels } });
      }
    }
    if (nameChanged) pairs.push({ accountId: row.id, patch: { adjustedName: trimmedName } });
    applyRowEdits(pairs);
    cancelEdit();
  };
  const resetRow = async (row) => {
    try {
      await resetChartOfAccount(row.id);
      await load();
      clearCachedFinancials(clientId, versionId);
      notify?.("Account restored to original.", "success");
    } catch (e) { notify?.(e.message || "Failed to reset account.", "error"); }
  };

  // ── Merge this account's category into another existing category ────────
  // Repoints every OTHER account sharing this row's exact ancestor path
  // (not just this one row) to the chosen target — the fix for two grouping
  // nodes that ended up meaning the same thing (e.g. a name collision between
  // a real posting account and an AI-derived category label).
  const openMergeEditor = (row) => {
    cancelEdit();
    const categoryPrefixArr = collapsePath(row.levels).slice(0, -1);
    setMergeEditor({ id: row.id, categoryPrefixArr, value: "" });
  };
  const closeMergeEditor = () => setMergeEditor(null);
  const submitMergeEditor = () => {
    if (!mergeEditor) return;
    const targetArr = parsePathInput(mergeEditor.value);
    if (!targetArr.length) { notify?.("Pick a category to merge into.", "error"); return; }
    applyBatchRelabel(computeDescendantRelabel(flat, mergeEditor.categoryPrefixArr, targetArr));
    closeMergeEditor();
  };

  // ── Manual mapping for a needs_mapping account ────────────────────────────
  const startMapping = (row) => {
    setMappingId(row.id);
    setMappingCategoryKey(categoryOptions[0]?.path || "");
    setMappingBaseName(row.adjustedName || row.sourceName || "");
  };
  const cancelMapping = () => { setMappingId(null); setMappingCategoryKey(""); setMappingBaseName(""); };
  const saveMapping = (row) => {
    const category = categoryOptions.find((c) => c.path === mappingCategoryKey);
    const baseName = mappingBaseName.trim();
    if (!category || !baseName) { notify?.("Pick a category and a name first.", "error"); return; }
    applyPatch(row.id, { levels: [...category.levels, baseName] });
    cancelMapping();
  };

  // ── Excel export — always exports ALL accounts regardless of current search ─
  const handleExport = () => {
    if (!flat.length) return;

    const allGrouped = {};
    for (const sec of SECTION_DEFS)
      for (const sg of sec.subGroups)
        allGrouped[sg.key] = [];
    allGrouped[NEEDS_MAPPING_KEY] = [];
    for (const row of flat) {
      const sgKey = TYPE_MAP[row.accountType]?.subGroupKey || NEEDS_MAPPING_KEY;
      allGrouped[sgKey].push(row);
    }

    const sheetRows = [];
    sheetRows.push([
      "System ID", "Account Number", "Account Name", "Account ID and Name",
      "Statement Type",
      ...LEVEL_INDEXES.map((i) => `Level ${i + 1}`),
      "Hierarchy Path", "Method", "Adjusted Name",
    ]);

    for (const section of [...SECTION_DEFS, NEEDS_MAPPING_SECTION]) {
      sheetRows.push([section.label]);
      for (const sg of section.subGroups) {
        sheetRows.push([sg.label]);
        for (const row of allGrouped[sg.key] || []) {
          const lvls = row.levels || [];
          sheetRows.push([
            row.systemId || "",
            row.accountNumber || "",
            row.sourceName || "",
            row.accountIdName || row.sourceName || "",
            STATEMENT_LABELS[row.statementType] || row.statementType || "",
            ...LEVEL_INDEXES.map((i) => lvls[i] || ""),
            row.hierarchyPath || "",
            METHOD_LABELS[row.classificationMethod] || row.classificationMethod || "",
            row.adjustedName || "",
          ]);
        }
      }
    }

    const ws = XLSX.utils.aoa_to_sheet(sheetRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Chart of Accounts");
    XLSX.writeFile(wb, "chart_of_accounts.xlsx");
  };

  // ── Search filter ─────────────────────────────────────────────────────────
  const filteredFlat = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return flat;
    return flat.filter((r) => {
      const hay = [r.systemId, r.accountNumber, r.sourceName, r.adjustedName, r.hierarchyPath]
        .filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [flat, search]);

  // ── Group filtered accounts into the section/sub-group structure ──────────
  const groupedData = useMemo(() => {
    const out = {};
    for (const sec of SECTION_DEFS)
      for (const sg of sec.subGroups)
        out[sg.key] = [];
    out[NEEDS_MAPPING_KEY] = [];

    for (const row of filteredFlat) {
      const mapping = TYPE_MAP[row.accountType];
      const sgKey = mapping?.subGroupKey || NEEDS_MAPPING_KEY;
      out[sgKey].push(row);
    }
    return out;
  }, [filteredFlat]);

  // ── Build a flat list of row descriptors for the table body ───────────────
  const tableRows = useMemo(() => {
    const items = [];
    for (const section of [...SECTION_DEFS, NEEDS_MAPPING_SECTION]) {
      const sectionCount = section.subGroups.reduce(
        (n, sg) => n + (groupedData[sg.key] || []).length, 0,
      );
      if (search && sectionCount === 0) continue;
      if (section.key === NEEDS_MAPPING_KEY && sectionCount === 0) continue;

      items.push({ kind: "section", section, count: sectionCount });

      for (const sg of section.subGroups) {
        const rows = groupedData[sg.key] || [];
        if (search && rows.length === 0) continue;

        items.push({ kind: "subGroup", section, sg, count: rows.length });

        for (const row of rows) {
          items.push({ kind: "account", section, sg, row });
        }
        if (rows.length === 0) {
          items.push({ kind: "empty", section, sg });
        }
      }
    }
    return items;
  }, [groupedData, search]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="rounded-2xl border border-border bg-white">
      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Table2 size={18} className="text-primary" />
          <h3 className="text-base font-bold text-text-primary">Chart of Accounts</h3>
          <span className="rounded-full bg-bg-page px-2 py-0.5 text-xs text-text-muted">
            {flat.length} account{flat.length === 1 ? "" : "s"}
          </span>
          {modifiedCount > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
              {modifiedCount} modified
            </span>
          )}
          {needsMappingCount > 0 && (
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
              {needsMappingCount} need{needsMappingCount === 1 ? "s" : ""} mapping
            </span>
          )}
          {pendingCount > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
              {pendingCount} unsaved change{pendingCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search accounts…"
              className="w-56 rounded-lg border border-border py-1.5 pl-8 pr-2 text-sm"
            />
          </div>
          <button
            onClick={undo}
            disabled={!history.length}
            title="Undo"
            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-40"
          >
            <Undo2 size={13} /> Undo
          </button>
          <button
            onClick={redo}
            disabled={!future.length}
            title="Redo"
            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-40"
          >
            <Redo2 size={13} /> Redo
          </button>
          {pendingCount > 0 && (
            <button
              onClick={discardDraft}
              title="Discard unsaved changes"
              className="flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs font-semibold text-text-muted hover:bg-bg-page"
            >
              <X size={13} /> Discard
            </button>
          )}
          <button
            onClick={handleResetAll}
            disabled={resettingAll}
            className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
            title="Restore all accounts to the original AI classification"
          >
            {resettingAll ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
            Reset all
          </button>
          <button
            onClick={handleExport}
            disabled={flat.length === 0}
            title="Download the full Chart of Accounts as an Excel file"
            className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
          >
            <Download size={13} />
            Export
          </button>
          <button
            onClick={handleRegenerate}
            disabled={regenerating || !hasSyncedData}
            title={hasSyncedData ? "Re-run the analysis from this version's data" : "Run Sync first to generate the Chart of Accounts"}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
          >
            {regenerating ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Regenerate
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !pendingCount || !draftValidation.hierarchyValid}
            title={!draftValidation.hierarchyValid ? "Fix the issues below before saving" : "Save changes"}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Save{pendingCount ? ` (${pendingCount})` : ""}
          </button>
        </div>
      </div>

      {/* ── Live validation banner ────────────────────────────────────────── */}
      {pendingCount > 0 && !draftValidation.hierarchyValid && (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" />
          <div className="text-xs text-amber-800">
            <p className="font-semibold">This draft can't be saved yet:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {draftValidation.violations.slice(0, 5).map((v, i) => <li key={i}>{v}</li>)}
            </ul>
          </div>
        </div>
      )}
      {saveErrors && (
        <div className="flex items-start gap-2 border-b border-red-200 bg-red-50 px-4 py-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-red-600" />
          <div className="text-xs text-red-800">
            <p className="font-semibold">Save rejected — the server found these problems:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {saveErrors.map((v, i) => <li key={i}>{v}</li>)}
            </ul>
          </div>
        </div>
      )}

      {/* ── Loading ──────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center gap-2 px-4 py-10 text-sm text-text-muted">
          <Loader2 size={15} className="animate-spin" /> Loading…
        </div>
      ) : flat.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-text-muted">
          {hasSyncedData
            ? "No accounts found. Click Regenerate to build the Chart of Accounts."
            : "Upload financial statements and run Sync to build the Chart of Accounts."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-max w-full border-collapse text-sm">
            {/* ── Column headers — dark teal matching the Excel ─────────────── */}
            <thead>
              <tr className="text-left text-[11px] font-bold uppercase tracking-wider text-white"
                  style={{ backgroundColor: "#1B3A5C" }}>
                <th className="whitespace-nowrap px-3 py-2.5 border-r border-white/10">System ID</th>
                <th className="whitespace-nowrap px-3 py-2.5 border-r border-white/10">Account Number</th>
                <th className="whitespace-nowrap px-3 py-2.5 border-r border-white/10 min-w-[180px]">Account Name</th>
                <th className="whitespace-nowrap px-3 py-2.5 border-r border-white/10 min-w-[200px]">Account ID and Name</th>
                <th className="whitespace-nowrap px-3 py-2.5 border-r border-white/10">Statement Type</th>
                {LEVEL_INDEXES.map((i) => (
                  <th key={i} className="whitespace-nowrap px-2 py-2.5 border-r border-white/10 min-w-[90px]">
                    Level {i + 1}
                  </th>
                ))}
                <th className="whitespace-nowrap px-3 py-2.5 border-r border-white/10 min-w-[200px]">Hierarchy Path</th>
                <th className="whitespace-nowrap px-3 py-2.5 border-r border-white/10">Method</th>
                <th className="whitespace-nowrap px-3 py-2.5 border-r border-white/10 min-w-[160px]">Adjusted Name</th>
                <th className="whitespace-nowrap px-3 py-2.5 text-right">Actions</th>
              </tr>
            </thead>

            <tbody>
              {tableRows.map((item) => {
                if (item.kind === "section") {
                  return (
                    <tr key={`sec-${item.section.key}`} style={{ backgroundColor: "#1B3A5C" }}>
                      <td colSpan={TOTAL_COLS} className="px-4 py-2.5 text-xs font-extrabold uppercase tracking-widest text-white">
                        {item.section.label}
                        {search && (
                          <span className="ml-3 text-white/50 font-normal normal-case tracking-normal">
                            {item.count} result{item.count !== 1 ? "s" : ""}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                }

                if (item.kind === "subGroup") {
                  return (
                    <tr key={`sg-${item.sg.key}`} style={{ backgroundColor: "#2C4D7A" }}>
                      <td colSpan={TOTAL_COLS} className="px-6 py-2 text-xs font-bold text-white">
                        {item.sg.label}
                        <span className="ml-2 text-white/40 font-normal">({item.count})</span>
                      </td>
                    </tr>
                  );
                }

                if (item.kind === "empty") {
                  return (
                    <tr key={`empty-${item.sg.key}`} className="bg-white">
                      <td colSpan={TOTAL_COLS} className="px-8 py-2 text-xs text-text-muted italic">
                        No {item.sg.label.toLowerCase()} accounts found.
                      </td>
                    </tr>
                  );
                }

                const { row } = item;
                const isEditing = editingId === row.id;
                const isMerging = mergeEditor?.id === row.id;
                const levels    = row.levels || [];
                const rowRec    = rec.byAccountId.get(row.id);

                return (
                  <Fragment key={row.id}>
                  <tr
                    className={`border-b border-border/40 bg-white transition-colors hover:bg-gray-50 ${row.isActive === false ? "opacity-50" : ""} ${row.pendingEdit ? "bg-primary/5" : ""}`}
                  >
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs font-semibold text-text-muted border-r border-border/30">
                      {row.systemId || "—"}
                    </td>

                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs text-text-muted border-r border-border/30">
                      {row.accountNumber || ""}
                    </td>

                    <td className="whitespace-nowrap px-3 py-1.5 border-r border-border/30">
                      <span className="text-text-primary text-[13px]" title={row.sourceName}>
                        {row.sourceName}
                      </span>
                      {(row.modified || row.pendingEdit) && (
                        <span className="ml-1.5 rounded-full bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                          modified
                        </span>
                      )}
                      {rowRec && <RecommendationBadge rec={rowRec} accept={rec.accept} ignore={rec.ignore} deciding={rec.decidingId === rowRec.id} />}
                    </td>

                    <td className="whitespace-nowrap px-3 py-1.5 text-xs text-text-secondary border-r border-border/30">
                      {row.accountIdName || row.sourceName || "—"}
                    </td>

                    <td className="whitespace-nowrap px-3 py-1.5 border-r border-border/30">
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          row.statementType === "profit_loss"
                            ? "bg-amber-200 text-amber-900"
                            : "bg-blue-200 text-blue-900"
                        }`}
                      >
                        {STATEMENT_LABELS[row.statementType] || row.statementType || "—"}
                      </span>
                    </td>

                    {LEVEL_INDEXES.map((i) => (
                      <td
                        key={i}
                        className="px-2 py-1.5 text-xs text-text-secondary border-r border-border/30 max-w-[110px]"
                        title={isEditing ? "" : (levels[i] || "")}
                      >
                        {isEditing ? (
                          <input
                            value={editLevels[i] || ""}
                            onChange={(e) => setEditLevelAt(i, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter")  saveEdit(row);
                              if (e.key === "Escape") cancelEdit();
                            }}
                            className="w-full min-w-[80px] rounded border border-primary px-1 py-0.5 text-xs"
                          />
                        ) : (
                          <span className="block truncate">{levels[i] || ""}</span>
                        )}
                      </td>
                    ))}

                    <td className="px-3 py-1.5 text-xs text-text-muted border-r border-border/30">
                      {isEditing ? (
                        <>
                          <input
                            list={`coa-path-options-${row.id}`}
                            value={editPathValue}
                            onChange={(e) => setEditPathValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter")  saveEdit(row);
                              if (e.key === "Escape") cancelEdit();
                            }}
                            placeholder='Separate levels with ">" (e.g. Pretax Income > Interest Income)'
                            className="w-[260px] rounded border border-primary px-2 py-0.5 text-xs"
                          />
                          <datalist id={`coa-path-options-${row.id}`}>
                            {categoryOptions.map((c) => (
                              <option key={c.path} value={`${c.path} > ${editName || row.sourceName}`} />
                            ))}
                          </datalist>
                        </>
                      ) : (
                        <span className="block max-w-[220px] truncate" title={row.hierarchyPath}>{row.hierarchyPath || "—"}</span>
                      )}
                    </td>

                    <td className="whitespace-nowrap px-3 py-1.5 border-r border-border/30">
                      <span className="rounded bg-white/70 border border-border/40 px-1.5 py-0.5 text-[10px] text-text-muted">
                        {METHOD_LABELS[row.classificationMethod] || row.classificationMethod || "—"}
                      </span>
                    </td>

                    <td className="whitespace-nowrap px-3 py-1.5 border-r border-border/30">
                      {isEditing ? (
                        <div className="flex items-center gap-1">
                          <input
                            autoFocus
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter")  saveEdit(row);
                              if (e.key === "Escape") cancelEdit();
                            }}
                            className="w-40 rounded border border-primary px-2 py-0.5 text-xs"
                          />
                          <button onClick={() => saveEdit(row)} title="Save" className="rounded p-1 text-primary hover:bg-white/60">
                            <Check size={12} />
                          </button>
                          <button onClick={cancelEdit} title="Cancel" className="rounded p-1 text-text-muted hover:bg-white/60">
                            <X size={12} />
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-text-primary" title={row.adjustedName}>
                          {row.adjustedName || "—"}
                        </span>
                      )}
                    </td>

                    <td className="whitespace-nowrap px-3 py-1.5">
                      {!isEditing && (
                        <div className="flex items-center justify-end gap-1">
                          {row.metadata?.needs_mapping && (
                            <button
                              onClick={() => (mappingId === row.id ? cancelMapping() : startMapping(row))}
                              title="Map to an existing category"
                              className="rounded p-1 text-red-600 hover:bg-white/60"
                            >
                              <FolderInput size={12} />
                            </button>
                          )}
                          <button onClick={() => startEdit(row)} title="Edit this account (name, hierarchy path, parent)" className="rounded p-1 text-text-muted hover:bg-white/60 hover:text-text-primary">
                            <Pencil size={12} />
                          </button>
                          <button
                            onClick={() => (isMerging ? closeMergeEditor() : openMergeEditor(row))}
                            title="Merge this account's category into another"
                            className="rounded p-1 text-text-muted hover:bg-white/60 hover:text-primary"
                          >
                            <GitMerge size={12} />
                          </button>
                          {(row.modified || row.pendingEdit) && (
                            <button onClick={() => resetRow(row)} title="Restore original AI classification" className="rounded p-1 text-text-muted hover:bg-white/60 hover:text-amber-600">
                              <RotateCcw size={12} />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>

                  {mappingId === row.id && (
                    <tr key={`map-${row.id}`} className="bg-red-50/60 border-b border-border/40">
                      <td colSpan={TOTAL_COLS} className="px-4 py-3">
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                              Place under existing category
                            </label>
                            <select
                              value={mappingCategoryKey}
                              onChange={(e) => setMappingCategoryKey(e.target.value)}
                              className="w-[420px] rounded border border-border px-2 py-1.5 text-xs"
                            >
                              {categoryOptions.length === 0 && <option value="">No existing categories yet</option>}
                              {categoryOptions.map((c) => <option key={c.path} value={c.path}>{c.path}</option>)}
                            </select>
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                              Account name (final level)
                            </label>
                            <input
                              value={mappingBaseName}
                              onChange={(e) => setMappingBaseName(e.target.value)}
                              className="w-56 rounded border border-border px-2 py-1.5 text-xs"
                            />
                          </div>
                          <button
                            onClick={() => saveMapping(row)}
                            disabled={!categoryOptions.length}
                            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                          >
                            <Check size={13} /> Stage mapping
                          </button>
                          <button onClick={cancelMapping} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-white">
                            <X size={13} /> Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}

                  {isMerging && (
                    <tr key={`merge-${row.id}`} className="bg-primary/5 border-b border-border/40">
                      <td colSpan={TOTAL_COLS} className="px-4 py-3">
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                              Merge "{mergeEditor.categoryPrefixArr.join(" > ") || "(root)"}" into
                            </label>
                            <input
                              autoFocus
                              list={`coa-merge-options-${row.id}`}
                              value={mergeEditor.value}
                              onChange={(e) => setMergeEditor((m) => ({ ...m, value: e.target.value }))}
                              placeholder="Existing category this should merge into"
                              className="w-[420px] rounded border border-primary px-2 py-1.5 text-xs"
                            />
                            <datalist id={`coa-merge-options-${row.id}`}>
                              {categoryOptions.map((c) => <option key={c.path} value={c.path} />)}
                            </datalist>
                          </div>
                          <button onClick={submitMergeEditor} className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
                            <Check size={13} /> Stage merge
                          </button>
                          <button onClick={closeMergeEditor} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-white">
                            <X size={13} /> Cancel
                          </button>
                        </div>
                        <p className="mt-2 text-[11px] text-text-muted">
                          Moves every account under this same category (not just this one) to the target category.
                        </p>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RecommendationBadge({ rec, accept, ignore, deciding }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative ml-1.5 inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        title="AI hierarchy suggestion available"
        className="flex items-center gap-1 rounded-full border border-dashed border-primary bg-primary/5 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10"
      >
        <Sparkles size={10} /> Suggestion
      </button>
      {open && (
        <div className="absolute left-0 top-6 z-10 w-80 rounded-xl border border-border bg-white p-3 text-left shadow-lg">
          <p className="text-xs text-text-muted">
            Suggested roll-up: <span className="font-semibold text-text-primary">{rec.recommendedRollup}</span>
            {rec.recommendedParent ? <> under <span className="font-semibold">{rec.recommendedParent}</span></> : null}
          </p>
          {rec.reason && <p className="mt-1 text-[11px] text-text-muted">{rec.reason}</p>}
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={async () => { const ok = await accept(rec.id); if (ok) setOpen(false); }}
              disabled={deciding}
              className="flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
            >
              <Check size={11} /> Accept
            </button>
            <button
              onClick={async () => { await ignore(rec.id); setOpen(false); }}
              disabled={deciding}
              className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-semibold text-text-muted disabled:opacity-50"
            >
              <X size={11} /> Ignore
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

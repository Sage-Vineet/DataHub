import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  RefreshCw, Loader2, Table2, Check, X, Pencil, RotateCcw, Search, Undo2, Redo2, Download,
  FolderInput, GitMerge, Sparkles, Save, AlertTriangle,
} from "lucide-react";
import {
  getChartOfAccounts, regenerateChartOfAccounts, resetChartOfAccount, resetChartOfAccounts,
} from "../../lib/api";
import { approveCoa } from "../../lib/keyReportGeneration";
import {
  buildIndexes, getLevelsArray, getHierarchyPathLabel, listCategoryNodes,
  applyAccountEdit, mergeCategory, validateTree, summarizeClassification,
  CLASSIFICATION_SOURCE_LABELS, MAX_HIERARCHY_LEVELS, displayName,
} from "../../lib/coaTree";
import { clearCachedFinancials } from "../../lib/keyReportFinancials";
import { useHierarchyRecommendations } from "../../hooks/useHierarchyRecommendations";

const STATEMENT_LABELS = { balance_sheet: "Balance Sheet", profit_loss: "P&L" };
const METHOD_LABELS = {
  rule: "Rule", gemini: "AI", hybrid: "AI+Rules", manual: "Manual", manual_review: "Manual",
  ai_hierarchy: "AI (full hierarchy)", document_hierarchy: "Document",
  client_workbook: "Uploaded COA",
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

// An account with no recognized accountType (needs_mapping — nothing in the
// uploaded documents resolved it and AI didn't confidently either; never
// guessed/defaulted) must still surface here rather than silently vanish from
// TYPE_MAP lookups — this section is exactly the "Chart of Accounts Review" queue.
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

/**
 * ChartOfAccountsGrid — the grouped-table Chart of Accounts editor (the
 * original visual layout: PROFIT & LOSS / BALANCE SHEET section headers,
 * Income/Expenses/Assets/Liabilities/Equity sub-groups, a Level 1..15 column
 * per row), now driven entirely by the tree-native node-list wire shape
 * ({ key, parentKey, nodeType, ... } — see chartOfAccountsService.
 * serializeProposedTree / serializePersistedTree) instead of the old flat
 * `levels` array + patches-diff model. Level/Hierarchy-Path columns are
 * DERIVED fresh from each account's parentKey chain on every render (lib/
 * coaTree.js's getLevelsArray/getHierarchyPathLabel) rather than being a
 * static field that could go stale after a move/rename — parentKey remains
 * the single source of truth, exactly as it is on the backend.
 *
 * Two data sources, one component:
 *   - `mode === "proposal"` — reviewing a just-generated (or just-regenerated)
 *     proposal that has never been persisted. `proposalNodes` (from the
 *     /sync or /generate response, or /chart-of-accounts/regenerate) seeds
 *     the working tree. Nothing exists in chart_of_accounts yet.
 *   - `mode === "approved"` — `version.coaApprovedAt` is set, so the tree is
 *     fetched from GET /chart-of-accounts (the real persisted hierarchy).
 *
 * Save always calls the SAME endpoint (chart-of-accounts/save) regardless of
 * mode — the backend re-validates, persists, and (only on success) runs
 * Trial Balance/Reconciliation/Monthly Balance Sheets/report snapshots. This
 * component routes Save through keyReportGeneration.approveCoa so the
 * module-level generation-state manager (survives navigation, gates the
 * page's "Open Reports" action) reflects the outcome.
 */
export default function ChartOfAccountsGrid({
  clientId, versionId, version, hasSyncedData, notify,
  proposalNodes, proposalMatchSummary, proposalToken,
  onApproved,
}) {
  const [nodes, setNodes] = useState([]);
  const [mode, setMode] = useState("proposal"); // "proposal" | "approved"
  const [matchSummary, setMatchSummary] = useState(null); // only set from a proposal/regenerate response
  const [history, setHistory] = useState([]); // array of node-array snapshots
  const [future, setFuture] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [resettingAll, setResettingAll] = useState(false);
  const [search, setSearch] = useState("");
  const [saveErrors, setSaveErrors] = useState(null);

  const [editingKey, setEditingKey] = useState(null);
  const [editName, setEditName] = useState("");
  const [editLevels, setEditLevels] = useState([]); // MAX_LEVELS strings; source of truth while editing
  const [mappingKey, setMappingKey] = useState(null);
  const [mappingCategoryPath, setMappingCategoryPath] = useState("");
  const [mappingBaseName, setMappingBaseName] = useState("");
  const [mergeEditor, setMergeEditor] = useState(null); // { categoryKey, categoryPathArr, value }

  const loadedNodesRef = useRef([]);
  // Read via a ref so the load effect can depend on a stable `proposalToken`
  // (e.g. the generation run's startedAt) instead of the proposal object
  // identity, which would otherwise re-trigger on every parent re-render and
  // wipe the user's in-progress edits.
  const proposalRef = useRef({ nodes: proposalNodes, matchSummary: proposalMatchSummary });
  useEffect(() => {
    proposalRef.current = { nodes: proposalNodes, matchSummary: proposalMatchSummary };
  });

  const rec = useHierarchyRecommendations(clientId, versionId, notify);
  const coaApprovedAt = version?.coaApprovedAt || null;

  // ── Data loading ─────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!versionId) { setNodes([]); loadedNodesRef.current = []; return; }

    if (!coaApprovedAt) {
      // Nothing persisted yet — a pending proposal (from the /generate
      // response, or a /regenerate call) is the only thing to review.
      const proposal = proposalRef.current;
      const list = proposal?.nodes?.length ? proposal.nodes : [];
      setNodes(list);
      setMatchSummary(list.length ? proposal.matchSummary || null : null);
      setMode("proposal");
      loadedNodesRef.current = list;
      setHistory([]); setFuture([]); setSaveErrors(null);
      return;
    }

    setLoading(true);
    try {
      const res = await getChartOfAccounts(versionId);
      const list = res?.tree?.nodes || [];
      setNodes(list);
      setMatchSummary(null);
      setMode("approved");
      loadedNodesRef.current = list;
      setHistory([]); setFuture([]); setSaveErrors(null);
    } catch (e) {
      notify?.(e.message || "Failed to load Chart of Accounts.", "error");
      setNodes([]);
      loadedNodesRef.current = [];
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId, coaApprovedAt, proposalToken, notify]);

  useEffect(() => { void Promise.resolve().then(() => load()); }, [load]);

  // ── Derived data ─────────────────────────────────────────────────────────
  const { nodesByKey } = useMemo(() => buildIndexes(nodes), [nodes]);
  const accountRows = useMemo(
    () => nodes
      .filter((n) => n.nodeType === "ACCOUNT")
      .map((n) => ({
        ...n,
        name: displayName(n),
        levels: getLevelsArray(nodesByKey, n.key),
        hierarchyPath: getHierarchyPathLabel(nodesByKey, n.key),
      })),
    [nodes, nodesByKey],
  );
  const categoryOptions = useMemo(() => listCategoryNodes(nodes), [nodes]);
  const counts = useMemo(() => summarizeClassification(nodes, matchSummary), [nodes, matchSummary]);
  const pendingCount = useMemo(() => nodes.filter((n) => n.userEdited).length, [nodes]);
  const draftValidation = useMemo(() => validateTree(nodes), [nodes]);
  const accountCount = accountRows.length;

  // ── History-aware edits (undo/redo over WHOLE-TREE snapshots) ───────────
  const commit = useCallback((newNodes) => {
    setHistory((h) => [...h, nodes]);
    setFuture([]);
    setNodes(newNodes);
    setSaveErrors(null);
  }, [nodes]);

  const undo = () => {
    if (!history.length) return;
    const prev = history[history.length - 1];
    setFuture((f) => [nodes, ...f]);
    setHistory((h) => h.slice(0, -1));
    setNodes(prev);
    setSaveErrors(null);
  };
  const redo = () => {
    if (!future.length) return;
    const next = future[0];
    setHistory((h) => [...h, nodes]);
    setFuture((f) => f.slice(1));
    setNodes(next);
    setSaveErrors(null);
  };
  const discardDraft = () => {
    setNodes(loadedNodesRef.current);
    setHistory([]); setFuture([]); setSaveErrors(null);
  };

  // ── Save / Approve — always submits the COMPLETE tree ───────────────────
  const handleSave = async () => {
    if (!nodes.length) return;
    setSaving(true);
    try {
      const outcome = await approveCoa(clientId, versionId, nodes);
      if (!outcome.ok) {
        if (Array.isArray(outcome.violations) && outcome.violations.length) {
          setSaveErrors(outcome.violations);
          notify?.("Some changes couldn't be saved — see the details below.", "error");
        } else {
          notify?.(outcome.error || "Failed to save Chart of Accounts.", "error");
        }
        return;
      }
      const tree = outcome.res?.tree?.nodes || [];
      setNodes(tree);
      loadedNodesRef.current = tree;
      setMode("approved");
      setMatchSummary(null);
      setHistory([]); setFuture([]); setSaveErrors(null);
      clearCachedFinancials(clientId, versionId);
      const savedCounts = summarizeClassification(tree, null);
      notify?.(
        `Chart of Accounts approved — ${savedCounts.totalCount} account${savedCounts.totalCount === 1 ? "" : "s"} saved. ` +
        "Trial Balance, Reconciliation, Monthly Balance Sheets and report snapshots have been regenerated.",
        "success",
      );
      onApproved?.(outcome.res);
    } finally {
      setSaving(false);
    }
  };

  // ── Regenerate the PROPOSAL only (no persistence) ───────────────────────
  const handleRegenerate = async () => {
    if (!versionId) return;
    setRegenerating(true);
    try {
      const res = await regenerateChartOfAccounts(versionId);
      const list = res?.proposedTree?.nodes || [];
      setNodes(list);
      loadedNodesRef.current = list;
      setMatchSummary(res?.matchSummary || null);
      setMode("proposal");
      setHistory([]); setFuture([]); setSaveErrors(null);
      clearCachedFinancials(clientId, versionId);
      // Accurate, two-number messaging — never a single blended "N accounts
      // required AI classification" figure that overclaims for document-
      // matched accounts.
      const c = summarizeClassification(list, res?.matchSummary);
      const parts = [`${c.totalCount} account${c.totalCount === 1 ? "" : "s"} proposed.`];
      if (c.documentMatchedCount) parts.push(`${c.documentMatchedCount} resolved from uploaded documents.`);
      if (c.aiFallbackCount) parts.push(`${c.aiFallbackCount} required AI classification.`);
      if (c.needsMappingCount) parts.push(`${c.needsMappingCount} need${c.needsMappingCount === 1 ? "s" : ""} manual mapping.`);
      notify?.(`Chart of Accounts proposal regenerated. ${parts.join(" ")} Review and Approve to persist.`, "success");
    } catch (e) {
      notify?.(e.message || "Failed to regenerate Chart of Accounts.", "error");
    } finally { setRegenerating(false); }
  };

  // ── Reset (approved accounts only — meaningless against an unpersisted
  //    proposal, since there is no "original" persisted row to restore) ────
  const handleResetAll = async () => {
    if (!versionId) return;
    setResettingAll(true);
    try {
      const res = await resetChartOfAccounts(versionId);
      const list = res?.tree?.nodes || [];
      setNodes(list);
      loadedNodesRef.current = list;
      setHistory([]); setFuture([]); setSaveErrors(null);
      clearCachedFinancials(clientId, versionId);
      notify?.("Restored all accounts to their original classification.", "success");
    } catch (e) {
      notify?.(e.message || "Failed to reset hierarchy.", "error");
    } finally { setResettingAll(false); }
  };

  const resetRow = async (row) => {
    if (!row?.accountId) return;
    try {
      await resetChartOfAccount(row.accountId);
      await load();
      clearCachedFinancials(clientId, versionId);
      notify?.("Account restored to its original classification.", "success");
    } catch (e) { notify?.(e.message || "Failed to reset account.", "error"); }
  };

  // ── Inline edit — the whole row: Adjusted Name AND every Level 1..15 cell
  // (synced two-way with the Hierarchy Path field), committed as one step.
  // In the new tree model this only ever touches the ONE edited account —
  // its descendants (there are none; a posting account can't have children)
  // and the rest of the tree are untouched, unlike the old flat-array
  // editor's computeDescendantRelabel. ────────────────────────────────────
  const startEdit = (row) => {
    setEditingKey(row.key);
    setEditName(row.adjustedName || row.accountName || "");
    const levels = new Array(MAX_LEVELS).fill("");
    (row.levels || []).forEach((v, i) => { if (i < MAX_LEVELS) levels[i] = v || ""; });
    setEditLevels(levels);
  };
  const cancelEdit = () => { setEditingKey(null); setEditName(""); setEditLevels([]); };
  const setEditLevelAt = (i, value) => {
    setEditLevels((prev) => {
      const next = [...prev];
      next[i] = value;
      return next;
    });
  };
  // The Hierarchy Path field edits the same editLevels array as one string.
  const editPathValue = editLevels.filter(Boolean).join(" > ");
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

    // The path field's own last segment doubles as the account's name
    // (mirrors the old editor) unless the dedicated Adjusted Name field was
    // ALSO changed, in which case that explicit rename wins.
    const categoryPathArr = trimmedPathArr.length ? trimmedPathArr.slice(0, -1) : [];
    const finalName = nameChanged ? trimmedName : (trimmedPathArr[trimmedPathArr.length - 1] || row.name);
    commit(applyAccountEdit(nodes, row.key, {
      newName: finalName,
      categoryPathArr: categoryPathArr.length ? categoryPathArr : oldPath.slice(0, -1),
      accountType: row.accountType,
      statementType: row.statementType,
    }));
    cancelEdit();
  };

  // ── Merge this account's category into another existing (or new) category ──
  const openMergeEditor = (row) => {
    cancelEdit();
    setMergeEditor({ categoryKey: row.parentKey || null, categoryPathArr: row.levels.filter(Boolean).slice(0, -1), value: "", __forKey: row.key });
  };
  const closeMergeEditor = () => setMergeEditor(null);
  const submitMergeEditor = () => {
    if (!mergeEditor) return;
    const targetArr = parsePathInput(mergeEditor.value);
    if (!targetArr.length) { notify?.("Pick a category to merge into.", "error"); return; }
    if (!mergeEditor.categoryKey) { notify?.("This account has no category to merge.", "error"); return; }
    commit(mergeCategory(nodes, mergeEditor.categoryKey, targetArr));
    closeMergeEditor();
  };

  // ── Manual mapping for a needs_mapping account ────────────────────────────
  const startMapping = (row) => {
    setMappingKey(row.key);
    setMappingCategoryPath(categoryOptions[0]?.path || "");
    setMappingBaseName(row.adjustedName || row.name || "");
  };
  const cancelMapping = () => { setMappingKey(null); setMappingCategoryPath(""); setMappingBaseName(""); };
  const saveMapping = (row) => {
    const baseName = mappingBaseName.trim();
    if (!mappingCategoryPath || !baseName) { notify?.("Pick a category and a name first.", "error"); return; }
    commit(applyAccountEdit(nodes, row.key, {
      newName: baseName,
      categoryPathArr: parsePathInput(mappingCategoryPath),
      accountType: row.accountType,
      statementType: row.statementType,
      clearNeedsMapping: true,
    }));
    cancelMapping();
  };

  // ── Excel export — always exports ALL accounts regardless of current search ─
  const handleExport = () => {
    if (!accountRows.length) return;

    const allGrouped = {};
    for (const sec of SECTION_DEFS)
      for (const sg of sec.subGroups)
        allGrouped[sg.key] = [];
    allGrouped[NEEDS_MAPPING_KEY] = [];
    for (const row of accountRows) {
      const sgKey = TYPE_MAP[row.accountType]?.subGroupKey || NEEDS_MAPPING_KEY;
      allGrouped[sgKey].push(row);
    }

    const sheetRows = [];
    sheetRows.push([
      "System ID", "Account Number", "Account Name", "Statement Type",
      ...LEVEL_INDEXES.map((i) => `Level ${i + 1}`),
      "Hierarchy Path", "Method", "Adjusted Name", "Classification",
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
            row.accountName || "",
            STATEMENT_LABELS[row.statementType] || row.statementType || "",
            ...LEVEL_INDEXES.map((i) => lvls[i] || ""),
            row.hierarchyPath || "",
            METHOD_LABELS[row.classificationMethod] || row.classificationMethod || "",
            row.adjustedName || "",
            CLASSIFICATION_SOURCE_LABELS[row.classificationSource] || row.classificationSource || "",
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
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return accountRows;
    return accountRows.filter((r) => {
      const hay = [r.systemId, r.accountNumber, r.accountName, r.adjustedName, r.hierarchyPath]
        .filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [accountRows, search]);

  // ── Group filtered accounts into the section/sub-group structure ──────────
  const groupedData = useMemo(() => {
    const out = {};
    for (const sec of SECTION_DEFS)
      for (const sg of sec.subGroups)
        out[sg.key] = [];
    out[NEEDS_MAPPING_KEY] = [];

    for (const row of filteredRows) {
      const mapping = TYPE_MAP[row.accountType];
      const sgKey = row.needsMapping ? NEEDS_MAPPING_KEY : (mapping?.subGroupKey || NEEDS_MAPPING_KEY);
      out[sgKey].push(row);
    }
    return out;
  }, [filteredRows]);

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

  const saveLabel = mode === "proposal" ? "Approve & Generate Reports" : "Save Changes";
  const isEmpty = !loading && accountRows.length === 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="rounded-2xl border border-border bg-white">
      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Table2 size={18} className="text-primary" />
          <h3 className="text-base font-bold text-text-primary">Chart of Accounts</h3>
          <span className="rounded-full bg-bg-page px-2 py-0.5 text-xs text-text-muted">
            {accountCount} account{accountCount === 1 ? "" : "s"}
          </span>
          {mode === "proposal" && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
              pending review — not yet saved
            </span>
          )}
          {counts.documentMatchedCount > 0 && (
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
              {counts.documentMatchedCount} from documents
            </span>
          )}
          {counts.aiFallbackCount > 0 && (
            <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
              {counts.aiFallbackCount} AI classified
            </span>
          )}
          {counts.needsMappingCount > 0 && (
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
              {counts.needsMappingCount} need{counts.needsMappingCount === 1 ? "s" : ""} mapping
            </span>
          )}
          {pendingCount > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
              {pendingCount} unsaved edit{pendingCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          {(history.length > 0 || pendingCount > 0) && (
            <button
              onClick={discardDraft}
              title="Discard unsaved changes"
              className="flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs font-semibold text-text-muted hover:bg-bg-page"
            >
              <X size={13} /> Discard
            </button>
          )}
          {mode === "approved" && (
            <button
              onClick={handleResetAll}
              disabled={resettingAll}
              className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
              title="Restore all accounts to their original classification"
            >
              {resettingAll ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
              Reset all
            </button>
          )}
          <button
            onClick={handleExport}
            disabled={!accountCount}
            title="Download the full Chart of Accounts as an Excel file"
            className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
          >
            <Download size={13} />
            Export
          </button>
          <button
            onClick={handleRegenerate}
            disabled={regenerating || !hasSyncedData}
            title={hasSyncedData ? "Rebuild the proposal from this version's extracted data" : "Run Generate first"}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
          >
            {regenerating ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Regenerate
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !accountCount || !draftValidation.valid}
            title={!draftValidation.valid ? "Fix the issues below before saving" : saveLabel}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {saveLabel}
          </button>
        </div>
      </div>

      {/* ── Proposal-review banner ───────────────────────────────────────── */}
      {mode === "proposal" && !isEmpty && (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" />
          <p className="text-xs text-amber-800">
            This is a proposed Chart of Accounts — nothing has been saved yet, and no reports have been
            generated. Review the hierarchy below, make any adjustments, then click
            <strong> {saveLabel}</strong> to persist it and generate Trial Balance / Reconciliation /
            Balance Sheet / P&amp;L / Cash Flow.
          </p>
        </div>
      )}

      {/* ── Live validation banner ────────────────────────────────────────── */}
      {!draftValidation.valid && accountCount > 0 && (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" />
          <div className="text-xs text-amber-800">
            <p className="font-semibold">This tree can't be saved yet:</p>
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

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center gap-2 px-4 py-10 text-sm text-text-muted">
          <Loader2 size={15} className="animate-spin" /> Loading…
        </div>
      ) : isEmpty ? (
        <p className="px-4 py-10 text-center text-sm text-text-muted">
          {hasSyncedData
            ? "No pending Chart of Accounts proposal to review. Click Regenerate to build one."
            : "Upload financial statements and run Generate to build the Chart of Accounts."}
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
                const isEditing = editingKey === row.key;
                const levels = row.levels || [];
                const rowRec = row.accountId ? rec.byAccountId.get(row.accountId) : null;

                return (
                  <Fragment key={row.key}>
                  <tr
                    className={`border-b border-border/40 bg-white transition-colors hover:bg-gray-50 ${row.userEdited ? "bg-primary/5" : ""}`}
                  >
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs font-semibold text-text-muted border-r border-border/30">
                      {row.systemId || "—"}
                    </td>

                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs text-text-muted border-r border-border/30">
                      {row.accountNumber || ""}
                    </td>

                    <td className="whitespace-nowrap px-3 py-1.5 border-r border-border/30">
                      <span className="text-text-primary text-[13px]" title={row.accountName}>
                        {row.accountName}
                      </span>
                      {row.userEdited && (
                        <span className="ml-1.5 rounded-full bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                          modified
                        </span>
                      )}
                      {row.classificationSource && (
                        <span
                          className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                            row.classificationSource === "AI_FALLBACK"
                              ? "bg-purple-100 text-purple-800"
                              : row.classificationSource === "USER_EDITED"
                                ? "bg-emerald-100 text-emerald-800"
                                : "bg-blue-100 text-blue-800"
                          }`}
                        >
                          {CLASSIFICATION_SOURCE_LABELS[row.classificationSource] || row.classificationSource}
                        </span>
                      )}
                      {rowRec && <RecommendationBadge rec={rowRec} accept={rec.accept} ignore={rec.ignore} deciding={rec.decidingId === rowRec.id} />}
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
                            list={`coa-path-options-${row.key}`}
                            value={editPathValue}
                            onChange={(e) => setEditPathValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter")  saveEdit(row);
                              if (e.key === "Escape") cancelEdit();
                            }}
                            placeholder='Separate levels with ">" (e.g. Total Assets > Current Assets > Bank Accounts > Chase Bank)'
                            className="w-[260px] rounded border border-primary px-2 py-0.5 text-xs"
                          />
                          <datalist id={`coa-path-options-${row.key}`}>
                            {categoryOptions.map((c) => (
                              <option key={c.node.key} value={`${c.path} > ${editName || row.name}`} />
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
                          {row.needsMapping && (
                            <button
                              onClick={() => (mappingKey === row.key ? cancelMapping() : startMapping(row))}
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
                            onClick={() => (mergeEditor?.__forKey === row.key ? closeMergeEditor() : openMergeEditor(row))}
                            title="Merge this account's category into another"
                            className="rounded p-1 text-text-muted hover:bg-white/60 hover:text-primary"
                          >
                            <GitMerge size={12} />
                          </button>
                          {mode === "approved" && row.userEdited && (
                            <button onClick={() => resetRow(row)} title="Restore original classification" className="rounded p-1 text-text-muted hover:bg-white/60 hover:text-amber-600">
                              <RotateCcw size={12} />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>

                  {mappingKey === row.key && (
                    <tr key={`map-${row.key}`} className="bg-red-50/60 border-b border-border/40">
                      <td colSpan={TOTAL_COLS} className="px-4 py-3">
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                              Place under existing (or new) category
                            </label>
                            <input
                              list={`coa-map-category-options-${row.key}`}
                              value={mappingCategoryPath}
                              onChange={(e) => setMappingCategoryPath(e.target.value)}
                              placeholder="Existing category, or type a new one"
                              className="w-[420px] rounded border border-border px-2 py-1.5 text-xs"
                            />
                            <datalist id={`coa-map-category-options-${row.key}`}>
                              {categoryOptions.map((c) => <option key={c.node.key} value={c.path} />)}
                            </datalist>
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

                  {mergeEditor?.__forKey === row.key && (
                    <tr key={`merge-${row.key}`} className="bg-primary/5 border-b border-border/40">
                      <td colSpan={TOTAL_COLS} className="px-4 py-3">
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                              Merge "{mergeEditor.categoryPathArr.join(" > ") || "(root)"}" into
                            </label>
                            <input
                              autoFocus
                              list={`coa-merge-options-${row.key}`}
                              value={mergeEditor.value}
                              onChange={(e) => setMergeEditor((m) => ({ ...m, value: e.target.value }))}
                              placeholder="Existing category (or a new one) this should merge into"
                              className="w-[420px] rounded border border-primary px-2 py-1.5 text-xs"
                            />
                            <datalist id={`coa-merge-options-${row.key}`}>
                              {categoryOptions.map((c) => <option key={c.node.key} value={c.path} />)}
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

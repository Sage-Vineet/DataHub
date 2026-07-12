import { useCallback, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import {
  RefreshCw, Loader2, Table2, Check, X, Pencil, RotateCcw, Search, Undo2, Download,
  Save, GripVertical,
} from "lucide-react";
import {
  getChartOfAccounts,
  regenerateChartOfAccounts,
  saveChartOfAccounts,
  resetChartOfAccount,
  resetChartOfAccounts,
} from "../../lib/api";

const STATEMENT_LABELS = { balance_sheet: "Balance Sheet", profit_loss: "P&L" };
const METHOD_LABELS = { rule: "Rule", gemini: "AI", hybrid: "AI+Rules", manual: "Manual" };
const MAX_LEVELS = 15;
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

// Canonical accountType a row takes when dropped INTO a sub-group (drag-to-move).
const SUBGROUP_PRIMARY_TYPE = {
  income: "income", expenses: "expense",
  assets: "asset", liabilities: "liability", equity: "equity",
};

// Total column count (must stay in sync with the <thead> below)
// systemId + acctNum + acctName + acctIdName + stmt + 15 levels + path + method + adjustedName + actions
const TOTAL_COLS = 5 + MAX_LEVELS + 4;

// ── Draft-vs-baseline diff helpers ────────────────────────────────────────────
const levelsEqual = (a = [], b = []) => {
  const max = Math.max(a.length, b.length, MAX_LEVELS);
  for (let i = 0; i < max; i += 1) {
    if ((a[i] || "") !== (b[i] || "")) return false;
  }
  return true;
};
const isRowChanged = (row, base) => {
  if (!base) return false;
  return (row.adjustedName || "") !== (base.adjustedName || "")
    || (row.accountType || "") !== (base.accountType || "")
    || (row.statementType || "") !== (base.statementType || "")
    || !levelsEqual(row.levels || [], base.levels || []);
};
// A 15-slot copy of a row's levels (null-padded) for immutable edits.
const levelsOf = (row) => Array.from({ length: MAX_LEVELS }, (_, i) => (row.levels?.[i] ?? null));

export default function ChartOfAccountsGrid({ versionId, hasSyncedData, notify }) {
  const [flat, setFlat]               = useState([]);   // server baseline
  const [edits, setEdits]             = useState({});   // rowId → { adjustedName?, accountType?, statementType?, levels? }
  const [reusedLeaves, setReusedLeaves] = useState([]);
  const [loading, setLoading]         = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [resettingAll, setResettingAll] = useState(false);
  const [saving, setSaving]           = useState(false);
  const [editingId, setEditingId]     = useState(null); // row whose adjusted-name is being edited
  const [editName, setEditName]       = useState("");
  const [editingCell, setEditingCell] = useState(null); // { rowId, levelIdx } for level editing
  const [cellValue, setCellValue]     = useState("");
  const [dragId, setDragId]           = useState(null);  // row being dragged
  const [dragOverSg, setDragOverSg]   = useState(null);  // sub-group key currently hovered
  const [search, setSearch]           = useState("");

  // ── Data loading ─────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!versionId) { setFlat([]); setReusedLeaves([]); return; }
    setLoading(true);
    try {
      const res = await getChartOfAccounts(versionId);
      setFlat(res?.flat || []);
      setReusedLeaves(res?.reusedLeaves || []);
    } catch (e) {
      notify?.(e.message || "Failed to load Chart of Accounts.", "error");
      setFlat([]);
      setReusedLeaves([]);
    } finally {
      setLoading(false);
    }
  }, [versionId, notify]);

  useEffect(() => { load(); }, [load]);

  // ── Editable draft (derived): server baseline + the local `edits` overlay ──
  // Keeping the draft derived (not synced via an effect) means it automatically
  // resets whenever the baseline reloads, and clearing `edits` discards changes.
  const baseById = useMemo(() => {
    const m = new Map();
    for (const r of flat) m.set(r.id, r);
    return m;
  }, [flat]);

  const draftRows = useMemo(() => {
    if (!Object.keys(edits).length) return flat;
    return flat.map((r) => {
      const patch = edits[r.id];
      if (!patch) return r;
      const merged = { ...r, ...patch };
      if (patch.levels) merged.hierarchyPath = patch.levels.filter(Boolean).join(" > ");
      return merged;
    });
  }, [flat, edits]);

  // ── Dirty tracking (derived) ──────────────────────────────────────────────
  const dirtyIds = useMemo(() => {
    const s = new Set();
    for (const r of draftRows) {
      if (isRowChanged(r, baseById.get(r.id))) s.add(r.id);
    }
    return s;
  }, [draftRows, baseById]);

  const unsavedCount = dirtyIds.size;

  const confirmDiscard = useCallback((message) => {
    if (unsavedCount === 0) return true;
    return window.confirm(message);
  }, [unsavedCount]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const handleRegenerate = async () => {
    if (!versionId) return;
    if (!confirmDiscard("Regenerating discards your unsaved changes. Continue?")) return;
    setRegenerating(true);
    try {
      const res = await regenerateChartOfAccounts(versionId);
      setEdits({});
      setFlat(res?.flat || []);
      setReusedLeaves(res?.reusedLeaves || []);
      notify?.("Chart of Accounts regenerated from the latest data.", "success");
    } catch (e) {
      notify?.(e.message || "Failed to regenerate Chart of Accounts.", "error");
    } finally { setRegenerating(false); }
  };

  const handleResetAll = async () => {
    if (!versionId) return;
    if (!confirmDiscard("Resetting discards your unsaved changes. Continue?")) return;
    setResettingAll(true);
    try {
      const res = await resetChartOfAccounts(versionId);
      setEdits({});
      setFlat(res?.flat || []);
      notify?.("Restored all accounts to the original AI classification.", "success");
    } catch (e) {
      notify?.(e.message || "Failed to reset hierarchy.", "error");
    } finally { setResettingAll(false); }
  };

  // ── Save / discard the batch of local edits ───────────────────────────────
  const handleSave = async () => {
    if (!versionId || unsavedCount === 0) return;
    const nodes = draftRows
      .filter((r) => dirtyIds.has(r.id))
      .map((r) => {
        const base = baseById.get(r.id);
        return {
          accountId: r.id,
          adjustedName: r.adjustedName,
          levels: levelsOf(r),
          accountType: r.accountType,
          statementType: r.statementType,
          movedParent: Boolean(base && r.accountType !== base.accountType),
        };
      });
    setSaving(true);
    try {
      const res = await saveChartOfAccounts(versionId, nodes);
      setEdits({});
      setFlat(res?.flat || []);
      setReusedLeaves(res?.reusedLeaves || []);
      notify?.(`Saved ${nodes.length} change${nodes.length === 1 ? "" : "s"}.`, "success");
    } catch (e) {
      notify?.(e.message || "Failed to save changes.", "error");
    } finally { setSaving(false); }
  };

  const handleDiscard = () => {
    if (unsavedCount === 0) return;
    if (!confirmDiscard("Discard all unsaved changes?")) return;
    setEdits({});
    setEditingId(null); setEditingCell(null);
    notify?.("Unsaved changes discarded.", "info");
  };

  // ── Adjusted-name inline edit (batched into the `edits` overlay) ──────────
  const startEdit  = (row) => { setEditingCell(null); setEditingId(row.id); setEditName(row.adjustedName || row.accountName || ""); };
  const cancelEdit = ()    => { setEditingId(null); setEditName(""); };
  const saveEdit   = (row) => {
    const name = editName.trim() || row.accountName;
    setEdits((prev) => ({ ...prev, [row.id]: { ...prev[row.id], adjustedName: name } }));
    cancelEdit();
  };

  // ── Level cell inline edit (batched into the `edits` overlay) ─────────────
  const startCellEdit = (row, idx) => {
    setEditingId(null);
    setEditingCell({ rowId: row.id, levelIdx: idx });
    setCellValue(row.levels?.[idx] || "");
  };
  const cancelCell = () => { setEditingCell(null); setCellValue(""); };
  const commitCell = (rowId, idx) => {
    const v = cellValue.trim();
    setEdits((prev) => {
      const current = prev[rowId] || {};
      const levels = current.levels ? [...current.levels] : levelsOf(baseById.get(rowId) || {});
      if ((levels[idx] || "") === v) return prev; // no change
      levels[idx] = v || null;
      return { ...prev, [rowId]: { ...current, levels } };
    });
    cancelCell();
  };

  // ── Drag-and-drop: move a row into another section/sub-group ───────────────
  const moveRowToSubGroup = (rowId, sg, section) => {
    if (!rowId || !sg) return;
    const primaryType = SUBGROUP_PRIMARY_TYPE[sg.key];
    if (!primaryType) return;
    const statementType = section.key === "pl" ? "profit_loss" : "balance_sheet";
    setEdits((prev) => {
      const base = baseById.get(rowId);
      const current = prev[rowId] || {};
      const curType = current.accountType ?? base?.accountType;
      const curStmt = current.statementType ?? base?.statementType;
      if (curType === primaryType && curStmt === statementType) return prev; // no change
      return { ...prev, [rowId]: { ...current, accountType: primaryType, statementType } };
    });
  };
  const handleRowDragStart = (e, rowId) => {
    setDragId(rowId);
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", String(rowId)); } catch { /* noop */ }
  };
  const handleSgDragOver = (e, sgKey) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverSg !== sgKey) setDragOverSg(sgKey);
  };
  const handleSgDrop = (e, sg, section) => {
    e.preventDefault();
    moveRowToSubGroup(dragId, sg, section);
    setDragId(null); setDragOverSg(null);
  };
  const handleDragEnd = () => { setDragId(null); setDragOverSg(null); };

  const resetRow = async (row) => {
    if (!confirmDiscard("Resetting this account discards your other unsaved changes. Continue?")) return;
    try {
      await resetChartOfAccount(row.id);
      setEdits({});
      await load();
      notify?.("Account restored to original.", "success");
    } catch (e) { notify?.(e.message || "Failed to reset account.", "error"); }
  };

  const modifiedCount = useMemo(() => draftRows.filter((r) => r.modified).length, [draftRows]);

  // ── Excel export — always exports ALL accounts regardless of current search ─
  const handleExport = () => {
    if (!draftRows.length) return;

    // Build a full grouped map from `draftRows` (not filtered) so export is complete.
    const allGrouped = {};
    for (const sec of SECTION_DEFS)
      for (const sg of sec.subGroups)
        allGrouped[sg.key] = [];
    for (const row of draftRows) {
      const sgKey = TYPE_MAP[row.accountType]?.subGroupKey;
      if (sgKey && allGrouped[sgKey]) allGrouped[sgKey].push(row);
    }

    const sheetRows = [];

    // Column header row
    sheetRows.push([
      "System ID", "Account Number", "Account Name", "Account ID and Name",
      "Statement Type",
      ...LEVEL_INDEXES.map((i) => `Level ${i + 1}`),
      "Hierarchy Path", "Method", "Adjusted Name",
    ]);

    // Section → sub-section → account rows
    for (const section of SECTION_DEFS) {
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
    if (!q) return draftRows;
    return draftRows.filter((r) => {
      const hay = [r.systemId, r.accountNumber, r.sourceName, r.adjustedName, r.hierarchyPath]
        .filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [draftRows, search]);

  // ── Group filtered accounts into the section/sub-group structure ──────────
  const groupedData = useMemo(() => {
    const out = {};
    for (const sec of SECTION_DEFS)
      for (const sg of sec.subGroups)
        out[sg.key] = [];

    for (const row of filteredFlat) {
      const mapping = TYPE_MAP[row.accountType];
      const sgKey   = mapping?.subGroupKey || "other";
      if (out[sgKey]) out[sgKey].push(row);
    }
    return out;
  }, [filteredFlat]);

  // ── Build a flat list of row descriptors for the table body ───────────────
  // (avoids React Fragment key issues when mapping over nested structures)
  const tableRows = useMemo(() => {
    const items = [];
    for (const section of SECTION_DEFS) {
      const sectionCount = section.subGroups.reduce(
        (n, sg) => n + (groupedData[sg.key] || []).length, 0,
      );
      if (search && sectionCount === 0) continue;

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
        <div className="flex items-center gap-2">
          <Table2 size={18} className="text-primary" />
          <h3 className="text-base font-bold text-text-primary">Chart of Accounts</h3>
          <span className="rounded-full bg-bg-page px-2 py-0.5 text-xs text-text-muted">
            {draftRows.length} account{draftRows.length === 1 ? "" : "s"}
          </span>
          {modifiedCount > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
              {modifiedCount} modified
            </span>
          )}
          {unsavedCount > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
              {unsavedCount} unsaved
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
          {unsavedCount > 0 && (
            <button
              onClick={handleDiscard}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
              title="Discard all unsaved changes"
            >
              <X size={13} />
              Discard
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saving || unsavedCount === 0}
            title={unsavedCount === 0 ? "No changes to save" : "Save your edits"}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Save{unsavedCount > 0 ? ` (${unsavedCount})` : ""}
          </button>
          <button
            onClick={handleResetAll}
            disabled={resettingAll || modifiedCount === 0}
            className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
            title="Restore all accounts to the original AI classification"
          >
            {resettingAll ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}
            Reset all
          </button>
          <button
            onClick={handleExport}
            disabled={draftRows.length === 0}
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
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {regenerating ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Regenerate
          </button>
        </div>
      </div>

      {/* ── Hint ─────────────────────────────────────────────────────────────── */}
      {draftRows.length > 0 && (
        <div className="border-b border-border/60 bg-bg-page/50 px-4 py-1.5 text-[11px] text-text-muted">
          Tip: click any <span className="font-semibold">Level</span> cell to edit it, and drag a row
          (using the <GripVertical size={11} className="inline -mt-0.5" /> handle) onto another section to reclassify it.
          Remember to <span className="font-semibold text-primary">Save</span>.
        </div>
      )}

      {/* ── Loading ──────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center gap-2 px-4 py-10 text-sm text-text-muted">
          <Loader2 size={15} className="animate-spin" /> Loading…
        </div>
      ) : draftRows.length === 0 ? (
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
                // ── Main section header (PROFIT & LOSS ACCOUNTS / BALANCE SHEET ACCOUNTS) ──
                if (item.kind === "section") {
                  return (
                    <tr key={`sec-${item.section.key}`} style={{ backgroundColor: "#1B3A5C" }}>
                      <td
                        colSpan={TOTAL_COLS}
                        className="px-4 py-2.5 text-xs font-extrabold uppercase tracking-widest text-white"
                      >
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

                // ── Sub-section header (Income / Expenses / Assets / Liabilities / Equity) ──
                // Also a drop target for drag-to-move.
                if (item.kind === "subGroup") {
                  const isDropTarget = dragOverSg === item.sg.key;
                  return (
                    <tr
                      key={`sg-${item.sg.key}`}
                      style={{ backgroundColor: isDropTarget ? "#3E6BA8" : "#2C4D7A" }}
                      onDragOver={(e) => handleSgDragOver(e, item.sg.key)}
                      onDrop={(e) => handleSgDrop(e, item.sg, item.section)}
                    >
                      <td
                        colSpan={TOTAL_COLS}
                        className={`px-6 py-2 text-xs font-bold text-white ${isDropTarget ? "ring-2 ring-inset ring-white/70" : ""}`}
                      >
                        {item.sg.label}
                        <span className="ml-2 text-white/40 font-normal">
                          ({item.count})
                        </span>
                        {isDropTarget && (
                          <span className="ml-3 font-normal text-white/80">Drop to move here</span>
                        )}
                      </td>
                    </tr>
                  );
                }

                // ── Empty placeholder (also a drop target) ──
                if (item.kind === "empty") {
                  const isDropTarget = dragOverSg === item.sg.key;
                  return (
                    <tr
                      key={`empty-${item.sg.key}`}
                      className={isDropTarget ? "bg-primary/10" : "bg-white"}
                      onDragOver={(e) => handleSgDragOver(e, item.sg.key)}
                      onDrop={(e) => handleSgDrop(e, item.sg, item.section)}
                    >
                      <td colSpan={TOTAL_COLS} className="px-8 py-2 text-xs text-text-muted italic">
                        {isDropTarget ? "Drop to move here" : `No ${item.sg.label.toLowerCase()} accounts found.`}
                      </td>
                    </tr>
                  );
                }

                // ── Account row ──
                const { row } = item;
                const isEditing = editingId === row.id;
                const rowEditing = isEditing || (editingCell && editingCell.rowId === row.id);
                const levels    = row.levels || [];
                const isDirty   = dirtyIds.has(row.id);
                const isDropTarget = dragOverSg === item.sg.key;

                return (
                  <tr
                    key={row.id}
                    draggable={!rowEditing}
                    onDragStart={(e) => handleRowDragStart(e, row.id)}
                    onDragEnd={handleDragEnd}
                    onDragOver={(e) => handleSgDragOver(e, item.sg.key)}
                    onDrop={(e) => handleSgDrop(e, item.sg, item.section)}
                    className={`border-b border-border/40 transition-colors hover:bg-gray-50
                      ${row.isActive === false ? "opacity-50" : ""}
                      ${dragId === row.id ? "opacity-40" : ""}
                      ${isDropTarget ? "bg-primary/5" : isDirty ? "bg-primary/5" : "bg-white"}`}
                  >
                    {/* System ID */}
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs font-semibold text-text-muted border-r border-border/30">
                      {row.systemId || "—"}
                    </td>

                    {/* Account Number */}
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs text-text-muted border-r border-border/30">
                      {row.accountNumber || ""}
                    </td>

                    {/* Account Name (with drag handle) */}
                    <td className="whitespace-nowrap px-3 py-1.5 border-r border-border/30">
                      <span className="flex items-center gap-1.5">
                        <GripVertical
                          size={13}
                          className={`shrink-0 text-text-muted/50 ${rowEditing ? "opacity-30" : "cursor-grab active:cursor-grabbing"}`}
                          title="Drag to move this account to another section"
                        />
                        <span className="text-text-primary text-[13px]" title={row.sourceName}>
                          {row.sourceName}
                        </span>
                        {row.modified && (
                          <span className="ml-1 rounded-full bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                            modified
                          </span>
                        )}
                        {isDirty && (
                          <span className="ml-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                            edited
                          </span>
                        )}
                      </span>
                    </td>

                    {/* Account ID and Name */}
                    <td className="whitespace-nowrap px-3 py-1.5 text-xs text-text-secondary border-r border-border/30">
                      {row.accountIdName || row.sourceName || "—"}
                    </td>

                    {/* Statement Type */}
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

                    {/* Level 1 – Level 15 (click to edit) */}
                    {LEVEL_INDEXES.map((i) => {
                      const cellEditing = editingCell && editingCell.rowId === row.id && editingCell.levelIdx === i;
                      return (
                        <td
                          key={i}
                          className="px-2 py-1.5 text-xs text-text-secondary border-r border-border/30 max-w-[110px] cursor-text hover:bg-primary/5"
                          title={levels[i] || "Click to edit"}
                          onClick={() => { if (!cellEditing) startCellEdit(row, i); }}
                        >
                          {cellEditing ? (
                            <input
                              autoFocus
                              value={cellValue}
                              onChange={(e) => setCellValue(e.target.value)}
                              onBlur={() => commitCell(row.id, i)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter")  { e.preventDefault(); commitCell(row.id, i); }
                                if (e.key === "Escape") { e.preventDefault(); cancelCell(); }
                              }}
                              className="w-full min-w-[80px] rounded border border-primary px-1 py-0.5 text-xs"
                            />
                          ) : (
                            <span className="block truncate min-h-[16px]">
                              {levels[i] || <span className="text-text-muted/40">—</span>}
                            </span>
                          )}
                        </td>
                      );
                    })}

                    {/* Hierarchy Path */}
                    <td
                      className="px-3 py-1.5 text-xs text-text-muted border-r border-border/30"
                      title={row.hierarchyPath}
                    >
                      <span className="block max-w-[220px] truncate">{row.hierarchyPath || "—"}</span>
                    </td>

                    {/* Method */}
                    <td className="whitespace-nowrap px-3 py-1.5 border-r border-border/30">
                      <span className="rounded bg-white/70 border border-border/40 px-1.5 py-0.5 text-[10px] text-text-muted">
                        {METHOD_LABELS[row.classificationMethod] || row.classificationMethod || "—"}
                      </span>
                    </td>

                    {/* Adjusted Name (inline edit) */}
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
                          <button onClick={() => saveEdit(row)} title="Apply"
                            className="rounded p-1 text-primary hover:bg-white/60">
                            <Check size={12} />
                          </button>
                          <button onClick={cancelEdit} title="Cancel"
                            className="rounded p-1 text-text-muted hover:bg-white/60">
                            <X size={12} />
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-text-primary" title={row.adjustedName}>
                          {row.adjustedName || "—"}
                        </span>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="whitespace-nowrap px-3 py-1.5">
                      {!isEditing && (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => startEdit(row)}
                            title="Rename (adjusted name)"
                            className="rounded p-1 text-text-muted hover:bg-white/60 hover:text-text-primary"
                          >
                            <Pencil size={12} />
                          </button>
                          {row.modified && (
                            <button
                              onClick={() => resetRow(row)}
                              title="Restore original AI classification"
                              className="rounded p-1 text-text-muted hover:bg-white/60 hover:text-amber-600"
                            >
                              <RotateCcw size={12} />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Reused Leaves ─────────────────────────────────────────────────────
          Accounts whose hierarchy was reused verbatim from a prior Chart of
          Accounts (classification_source === "reused_from_coa"). */}
      <div className="border-t border-border px-4 py-4">
        <div className="mb-2 flex items-center gap-2">
          <Table2 size={16} className="text-primary" />
          <h3 className="text-sm font-bold text-text-primary">Reused Leaves</h3>
          <span className="rounded-full bg-bg-page px-2 py-0.5 text-xs text-text-muted">
            {reusedLeaves.length} account{reusedLeaves.length === 1 ? "" : "s"}
          </span>
        </div>
        {reusedLeaves.length === 0 ? (
          <p className="py-4 text-center text-xs text-text-muted">
            No reused accounts — every account was freshly classified this run.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="min-w-max w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-[11px] font-bold uppercase tracking-wider text-white"
                    style={{ backgroundColor: "#1B3A5C" }}>
                  <th className="whitespace-nowrap px-3 py-2.5 border-r border-white/10">Account Number</th>
                  <th className="whitespace-nowrap px-3 py-2.5 border-r border-white/10 min-w-[180px]">Account Name</th>
                  <th className="whitespace-nowrap px-3 py-2.5 border-r border-white/10">Type</th>
                  <th className="whitespace-nowrap px-3 py-2.5 border-r border-white/10">Statement</th>
                  <th className="whitespace-nowrap px-3 py-2.5 border-r border-white/10 min-w-[240px]">Hierarchy Path</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Method</th>
                </tr>
              </thead>
              <tbody>
                {reusedLeaves.map((acct) => (
                  <tr key={acct.id} className="border-b border-border/40 bg-white hover:bg-gray-50">
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs text-text-muted border-r border-border/30">
                      {acct.accountNumber || "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-[13px] text-text-primary border-r border-border/30">
                      {acct.accountName}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-xs capitalize text-text-muted border-r border-border/30">
                      {acct.accountType || "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 border-r border-border/30">
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          acct.statementType === "profit_loss"
                            ? "bg-amber-200 text-amber-900"
                            : "bg-blue-200 text-blue-900"
                        }`}
                      >
                        {STATEMENT_LABELS[acct.statementType] || acct.statementType || "—"}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-xs text-text-muted border-r border-border/30" title={acct.hierarchyPath}>
                      <span className="block max-w-[320px] truncate">{acct.hierarchyPath || "—"}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5">
                      <span className="rounded border border-border/40 bg-white/70 px-1.5 py-0.5 text-[10px] text-text-muted">
                        {METHOD_LABELS[acct.classificationMethod] || acct.classificationMethod || "reused"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshCw,
  Loader2,
  ListTree,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  Pencil,
  RotateCcw,
  Search,
  ChevronsDownUp,
  ChevronsUpDown,
  Undo2,
} from "lucide-react";
import {
  getChartOfAccounts,
  regenerateChartOfAccounts,
  updateChartOfAccount,
  resetChartOfAccount,
  resetChartOfAccounts,
} from "../../lib/api";

const STATEMENT_LABELS = {
  balance_sheet: "Balance Sheet",
  profit_loss: "Income Statement",
};

const METHOD_LABELS = {
  rule: "Rules",
  gemini: "AI",
  hybrid: "AI + Rules",
  manual: "Manual",
};

// Flatten the tree into ordered visible rows, honoring collapse state + filters.
function flattenTree(nodes, { collapsed, depth = 0, out = [], visiblePredicate }) {
  for (const node of nodes) {
    const children = node.children || [];
    const hasChildren = children.length > 0;
    // A group is visible if any descendant leaf passes the predicate.
    const childRows = [];
    if (hasChildren) {
      flattenTree(children, { collapsed, depth: depth + 1, out: childRows, visiblePredicate });
    }
    if (node.isGroup) {
      if (!childRows.length) continue; // hide empty categories after filtering
      out.push({ ...node, depth, hasChildren: true });
      if (!collapsed[node.id]) out.push(...childRows);
    } else if (!visiblePredicate || visiblePredicate(node)) {
      out.push({ ...node, depth, hasChildren: false });
    }
  }
  return out;
}

function collectGroupIds(nodes, acc = {}) {
  for (const n of nodes) {
    if (n.isGroup) {
      acc[n.id] = true;
      collectGroupIds(n.children || [], acc);
    }
  }
  return acc;
}

/**
 * Central Chart of Accounts screen — a tree grid over the 15-level hierarchy.
 * Supports expand/collapse, search, statement-type + modified filters, inline
 * rename, per-row & bulk reset to the original AI classification, and save.
 *
 * The original AI hierarchy is never overwritten server-side; "Reset" restores
 * the adjusted view from it.
 */
export default function ChartOfAccountsTreeGrid({ versionId, hasSyncedData, notify }) {
  const [flat, setFlat] = useState([]);
  const [tree, setTree] = useState([]);
  const [loading, setLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [collapsed, setCollapsed] = useState({});
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [search, setSearch] = useState("");
  const [statementFilter, setStatementFilter] = useState("all"); // all | balance_sheet | profit_loss
  const [modifiedFilter, setModifiedFilter] = useState("all"); // all | modified | unmodified

  const load = useCallback(async () => {
    if (!versionId) {
      setFlat([]);
      setTree([]);
      return;
    }
    setLoading(true);
    try {
      const res = await getChartOfAccounts(versionId);
      setTree(res?.tree || []);
      setFlat(res?.flat || []);
    } catch (e) {
      notify?.(e.message || "Failed to load Chart of Accounts.", "error");
      setTree([]);
      setFlat([]);
    } finally {
      setLoading(false);
    }
  }, [versionId, notify]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRegenerate = async () => {
    if (!versionId) return;
    setRegenerating(true);
    try {
      const res = await regenerateChartOfAccounts(versionId);
      setTree(res?.tree || []);
      setFlat(res?.flat || []);
      notify?.("Chart of Accounts regenerated from the latest data.", "success");
    } catch (e) {
      notify?.(e.message || "Failed to regenerate Chart of Accounts.", "error");
    } finally {
      setRegenerating(false);
    }
  };

  const handleResetAll = async () => {
    if (!versionId) return;
    setSavingAll(true);
    try {
      const res = await resetChartOfAccounts(versionId);
      setTree(res?.tree || []);
      setFlat(res?.flat || []);
      notify?.("Restored all accounts to the original AI classification.", "success");
    } catch (e) {
      notify?.(e.message || "Failed to reset hierarchy.", "error");
    } finally {
      setSavingAll(false);
    }
  };

  const startEdit = (node) => {
    setEditingId(node.accountId);
    setEditName(node.name);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditName("");
  };
  const saveEdit = async (node) => {
    const name = editName.trim();
    if (!name || name === node.name) {
      cancelEdit();
      return;
    }
    try {
      await updateChartOfAccount(node.accountId, { adjustedName: name });
      cancelEdit();
      await load();
      notify?.("Account renamed.", "success");
    } catch (e) {
      notify?.(e.message || "Failed to rename account.", "error");
    }
  };

  const resetRow = async (node) => {
    try {
      await resetChartOfAccount(node.accountId);
      await load();
      notify?.("Account restored to original.", "success");
    } catch (e) {
      notify?.(e.message || "Failed to reset account.", "error");
    }
  };

  const toggleRow = (id) => setCollapsed((p) => ({ ...p, [id]: !p[id] }));
  const expandAll = () => setCollapsed({});
  const collapseAll = () => setCollapsed(collectGroupIds(tree));

  const modifiedCount = useMemo(() => flat.filter((r) => r.modified).length, [flat]);

  const visiblePredicate = useCallback(
    (node) => {
      if (statementFilter !== "all" && node.statementType !== statementFilter) return false;
      if (modifiedFilter === "modified" && !node.modified) return false;
      if (modifiedFilter === "unmodified" && node.modified) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hay = `${node.name} ${node.accountNumber || ""} ${node.hierarchyPath || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    },
    [statementFilter, modifiedFilter, search],
  );

  const rows = useMemo(
    () => flattenTree(tree, { collapsed, visiblePredicate }),
    [tree, collapsed, visiblePredicate],
  );

  return (
    <div className="rounded-2xl border border-border bg-white">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <ListTree size={18} className="text-primary" />
          <h3 className="text-base font-bold text-text-primary">Chart of Accounts</h3>
          <span className="rounded-full bg-bg-page px-2 py-0.5 text-xs text-text-muted">
            {flat.length} account{flat.length === 1 ? "" : "s"}
          </span>
          {modifiedCount > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
              {modifiedCount} modified
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={expandAll} className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page" title="Expand all">
            <ChevronsUpDown size={13} /> Expand
          </button>
          <button onClick={collapseAll} className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page" title="Collapse all">
            <ChevronsDownUp size={13} /> Collapse
          </button>
          <button
            onClick={handleResetAll}
            disabled={savingAll || modifiedCount === 0}
            className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
            title="Restore all accounts to the original AI classification"
          >
            {savingAll ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />} Reset all
          </button>
          <button
            onClick={handleRegenerate}
            disabled={regenerating || !hasSyncedData}
            title={hasSyncedData ? "Re-run the AI analysis from this version's data" : "Run Sync first to generate the Chart of Accounts"}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {regenerating ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Regenerate
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search accounts…"
            className="w-56 rounded-lg border border-border py-1.5 pl-8 pr-2 text-sm"
          />
        </div>
        <select
          value={statementFilter}
          onChange={(e) => setStatementFilter(e.target.value)}
          className="rounded-lg border border-border px-2.5 py-1.5 text-sm text-text-primary"
        >
          <option value="all">All statements</option>
          <option value="balance_sheet">Balance Sheet</option>
          <option value="profit_loss">Income Statement</option>
        </select>
        <select
          value={modifiedFilter}
          onChange={(e) => setModifiedFilter(e.target.value)}
          className="rounded-lg border border-border px-2.5 py-1.5 text-sm text-text-primary"
        >
          <option value="all">All accounts</option>
          <option value="modified">Modified only</option>
          <option value="unmodified">Unmodified only</option>
        </select>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="flex items-center gap-2 px-4 py-10 text-sm text-text-muted">
          <Loader2 size={15} className="animate-spin" /> Loading…
        </div>
      ) : flat.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-text-muted">
          {hasSyncedData
            ? "No accounts found. Try Regenerate."
            : "Upload financial statements and run AI Processing to build the Chart of Accounts."}
        </p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-text-muted">No accounts match the current filters.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-text-muted">
                <th className="px-4 py-2">Account</th>
                <th className="px-3 py-2 w-24">Number</th>
                <th className="px-3 py-2">Hierarchy Path</th>
                <th className="px-3 py-2 w-32">Statement</th>
                <th className="px-3 py-2 w-28">Method</th>
                <th className="px-3 py-2 w-28 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((node) => {
                const indent = 8 + node.depth * 16;
                if (node.isGroup) {
                  const isCollapsed = collapsed[node.id];
                  return (
                    <tr key={node.id} className="border-b border-border bg-bg-page/60">
                      <td className="px-4 py-1.5" colSpan={6}>
                        <button
                          onClick={() => toggleRow(node.id)}
                          className="flex items-center gap-1.5 text-left font-semibold text-text-primary"
                          style={{ paddingLeft: indent }}
                        >
                          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                          {node.name}
                        </button>
                      </td>
                    </tr>
                  );
                }
                const isEditing = editingId === node.accountId;
                return (
                  <tr key={node.accountId} className={`border-b border-border ${node.isActive ? "" : "opacity-50"}`}>
                    <td className="px-4 py-1.5">
                      <div className="flex items-center gap-2" style={{ paddingLeft: indent }}>
                        {isEditing ? (
                          <>
                            <input
                              autoFocus
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveEdit(node);
                                if (e.key === "Escape") cancelEdit();
                              }}
                              className="flex-1 rounded border border-primary px-2 py-0.5 text-sm"
                            />
                            <button onClick={() => saveEdit(node)} className="rounded p-1 text-primary hover:bg-bg-page" title="Save">
                              <Check size={14} />
                            </button>
                            <button onClick={cancelEdit} className="rounded p-1 text-text-muted hover:bg-bg-page" title="Cancel">
                              <X size={14} />
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="truncate text-text-primary" title={node.name}>{node.name}</span>
                            {node.modified && (
                              <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">modified</span>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs text-text-muted">{node.accountNumber || ""}</td>
                    <td className="px-3 py-1.5 text-xs text-text-muted" title={node.hierarchyPath}>
                      <span className="line-clamp-1">{node.hierarchyPath}</span>
                    </td>
                    <td className="px-3 py-1.5 text-xs text-text-muted">{STATEMENT_LABELS[node.statementType] || node.statementType || ""}</td>
                    <td className="px-3 py-1.5">
                      <span className="rounded bg-bg-page px-1.5 py-0.5 text-[11px] capitalize text-text-muted">
                        {METHOD_LABELS[node.classificationMethod] || node.classificationMethod || ""}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      {!isEditing && (
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => startEdit(node)} className="rounded p-1 text-text-muted hover:bg-bg-page hover:text-text-primary" title="Rename">
                            <Pencil size={13} />
                          </button>
                          {node.modified && (
                            <button onClick={() => resetRow(node)} className="rounded p-1 text-text-muted hover:bg-bg-page hover:text-text-primary" title="Restore original AI classification">
                              <RotateCcw size={13} />
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
    </div>
  );
}

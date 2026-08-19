import { useCallback, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import {
  RefreshCw, Loader2, Table2, Check, X, Pencil, RotateCcw, Search, Undo2, Download,
} from "lucide-react";
import {
  getChartOfAccounts,
  regenerateChartOfAccounts,
  updateChartOfAccount,
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

/**
 * The classifications an account can be reassigned to.
 *
 * UAT #2, Critical: "I can't edit the Chart of Accounts classification, only
 * the name." The backend has always supported this — `updateAccountHierarchy`
 * takes `accountType` and derives `statementType` from it, writing the change
 * to `coa_account_adjustments` and `coa_classification_history`. Only the grid
 * never offered it.
 */
const ACCOUNT_TYPE_OPTIONS = [
  { value: "asset", label: "Asset", statement: "balance_sheet" },
  { value: "liability", label: "Liability", statement: "balance_sheet" },
  { value: "equity", label: "Equity", statement: "balance_sheet" },
  { value: "income", label: "Income", statement: "profit_loss" },
  { value: "cogs", label: "COGS", statement: "profit_loss" },
  { value: "expense", label: "Expense", statement: "profit_loss" },
];

// Total column count (must stay in sync with the <thead> below)
// systemId + acctNum + acctName + acctIdName + stmt + 15 levels + path + method + adjustedName + actions
const TOTAL_COLS = 5 + MAX_LEVELS + 4;

export default function ChartOfAccountsGrid({ versionId, hasSyncedData, notify }) {
  const [flat, setFlat]               = useState([]);
  const [loading, setLoading]         = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [resettingAll, setResettingAll] = useState(false);
  const [editingId, setEditingId]     = useState(null);
  const [editName, setEditName]       = useState("");
  const [search, setSearch]           = useState("");

  // ── Data loading ─────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!versionId) { setFlat([]); return; }
    setLoading(true);
    try {
      const res = await getChartOfAccounts(versionId);
      setFlat(res?.flat || []);
    } catch (e) {
      notify?.(e.message || "Failed to load Chart of Accounts.", "error");
      setFlat([]);
    } finally {
      setLoading(false);
    }
  }, [versionId, notify]);

  useEffect(() => { load(); }, [load]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const handleRegenerate = async () => {
    if (!versionId) return;
    setRegenerating(true);
    try {
      const res = await regenerateChartOfAccounts(versionId);
      setFlat(res?.flat || []);
      notify?.("Chart of Accounts regenerated from the latest data.", "success");
    } catch (e) {
      notify?.(e.message || "Failed to regenerate Chart of Accounts.", "error");
    } finally { setRegenerating(false); }
  };

  const handleResetAll = async () => {
    if (!versionId) return;
    setResettingAll(true);
    try {
      const res = await resetChartOfAccounts(versionId);
      setFlat(res?.flat || []);
      notify?.("Restored all accounts to the original AI classification.", "success");
    } catch (e) {
      notify?.(e.message || "Failed to reset hierarchy.", "error");
    } finally { setResettingAll(false); }
  };

  const startEdit  = (row) => { setEditingId(row.id); setEditName(row.adjustedName || row.accountName || ""); };
  const cancelEdit = ()    => { setEditingId(null); setEditName(""); };
  const saveEdit   = async (row) => {
    const name = editName.trim();
    if (!name || name === (row.adjustedName || row.accountName)) { cancelEdit(); return; }
    try {
      await updateChartOfAccount(row.id, { adjustedName: name });
      cancelEdit();
      await load();
      notify?.("Account renamed.", "success");
    } catch (e) { notify?.(e.message || "Failed to rename account.", "error"); }
  };
  /**
   * Reclassify an account. The backend recomputes `statementType`, the
   * hierarchy path and the base account from the new type, and logs the change
   * with its previous value — so this is reversible per account.
   */
  const [savingTypeId, setSavingTypeId] = useState(null);
  const changeAccountType = async (row, accountType) => {
    if (!accountType || accountType === row.accountType) return;
    setSavingTypeId(row.id);
    try {
      await updateChartOfAccount(row.id, { accountType });
      await load();
      notify?.(
        `Reclassified "${row.sourceName}" as ${
          ACCOUNT_TYPE_OPTIONS.find((o) => o.value === accountType)?.label ?? accountType
        }.`,
        "success",
      );
    } catch (e) {
      notify?.(e.message || "Failed to reclassify account.", "error");
    } finally {
      setSavingTypeId(null);
    }
  };

  const resetRow = async (row) => {
    try {
      await resetChartOfAccount(row.id);
      await load();
      notify?.("Account restored to original.", "success");
    } catch (e) { notify?.(e.message || "Failed to reset account.", "error"); }
  };

  const modifiedCount = useMemo(() => flat.filter((r) => r.modified).length, [flat]);

  // ── Excel export — always exports ALL accounts regardless of current search ─
  const handleExport = () => {
    if (!flat.length) return;

    // Build a full grouped map from `flat` (not filteredFlat) so export is complete.
    const allGrouped = {};
    for (const sec of SECTION_DEFS)
      for (const sg of sec.subGroups)
        allGrouped[sg.key] = [];
    for (const row of flat) {
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
            {flat.length} account{flat.length === 1 ? "" : "s"}
          </span>
          {modifiedCount > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
              {modifiedCount} modified
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
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {regenerating ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Regenerate
          </button>
        </div>
      </div>

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
              {tableRows.map((item, idx) => {
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
                if (item.kind === "subGroup") {
                  return (
                    <tr key={`sg-${item.sg.key}`} style={{ backgroundColor: "#2C4D7A" }}>
                      <td
                        colSpan={TOTAL_COLS}
                        className="px-6 py-2 text-xs font-bold text-white"
                      >
                        {item.sg.label}
                        <span className="ml-2 text-white/40 font-normal">
                          ({item.count})
                        </span>
                      </td>
                    </tr>
                  );
                }

                // ── Empty placeholder ──
                if (item.kind === "empty") {
                  return (
                    <tr key={`empty-${item.sg.key}`} className="bg-white">
                      <td colSpan={TOTAL_COLS} className="px-8 py-2 text-xs text-text-muted italic">
                        No {item.sg.label.toLowerCase()} accounts found.
                      </td>
                    </tr>
                  );
                }

                // ── Account row ──
                const { row } = item;
                const isEditing = editingId === row.id;
                const levels    = row.levels || [];

                return (
                  <tr
                    key={row.id}
                    className={`border-b border-border/40 bg-white transition-colors hover:bg-gray-50 ${row.isActive === false ? "opacity-50" : ""}`}
                  >
                    {/* System ID */}
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs font-semibold text-text-muted border-r border-border/30">
                      {row.systemId || "—"}
                    </td>

                    {/* Account Number */}
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs text-text-muted border-r border-border/30">
                      {row.accountNumber || ""}
                    </td>

                    {/* Account Name */}
                    <td className="whitespace-nowrap px-3 py-1.5 border-r border-border/30">
                      <span className="text-text-primary text-[13px]" title={row.sourceName}>
                        {row.sourceName}
                      </span>
                      {row.modified && (
                        <span className="ml-1.5 rounded-full bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                          modified
                        </span>
                      )}
                    </td>

                    {/* Account ID and Name */}
                    <td className="whitespace-nowrap px-3 py-1.5 text-xs text-text-secondary border-r border-border/30">
                      {row.accountIdName || row.sourceName || "—"}
                    </td>

                    {/* Classification — editable (UAT #2) */}
                    <td className="whitespace-nowrap px-3 py-1.5 border-r border-border/30">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            row.statementType === "profit_loss"
                              ? "bg-amber-200 text-amber-900"
                              : "bg-blue-200 text-blue-900"
                          }`}
                          title={STATEMENT_LABELS[row.statementType] || row.statementType || ""}
                        >
                          {STATEMENT_LABELS[row.statementType] || row.statementType || "—"}
                        </span>
                        <select
                          className="rounded border border-border bg-bg-card px-1 py-0.5 text-[11px] text-text-primary disabled:opacity-50"
                          value={row.accountType || ""}
                          disabled={savingTypeId === row.id}
                          onChange={(e) => changeAccountType(row, e.target.value)}
                          aria-label={`Classification for ${row.sourceName}`}
                        >
                          {!row.accountType && <option value="">—</option>}
                          {ACCOUNT_TYPE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>

                    {/* Level 1 – Level 15 */}
                    {LEVEL_INDEXES.map((i) => (
                      <td
                        key={i}
                        className="px-2 py-1.5 text-xs text-text-secondary border-r border-border/30 max-w-[110px]"
                        title={levels[i] || ""}
                      >
                        <span className="block truncate">{levels[i] || ""}</span>
                      </td>
                    ))}

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
                          <button onClick={() => saveEdit(row)} title="Save"
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
    </div>
  );
}

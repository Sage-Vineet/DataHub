// Financial Statements View — P&L, Balance Sheet, Cash Flow
// Monthly and Yearly views, COA-mapped, all zero-value accounts shown.

import React, { useState, useCallback } from "react";
import * as XLSX from "xlsx";
import {
  RefreshCw, Download, ChevronDown, ChevronRight,
  CheckCircle, AlertTriangle, TrendingUp, DollarSign, Activity,
} from "lucide-react";
import { getFinancialStatements } from "../../lib/api";

// ─── QB-style formatters ──────────────────────────────────────────────────────
const fmt = (v, showDollar = false) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const str = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signed = n < 0 ? `(${str})` : str;
  return showDollar ? `$${signed}` : signed;
};

const numCls = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "text-gray-500";
  return n < 0 ? "text-red-600" : "text-gray-900";
};

// ─── QB PDF-style row primitives ──────────────────────────────────────────────
function QBSectionHeader({ label }) {
  return (
    <tr className="bg-gray-100">
      <td colSpan={2} className="py-1.5 px-4 text-xs font-semibold text-gray-700 tracking-wide">
        {label}
      </td>
    </tr>
  );
}

function QBGroupRow({ label, indent = 1 }) {
  return (
    <tr>
      <td className="py-0.5 px-4 text-xs text-gray-700" style={{ paddingLeft: `${12 + indent * 16}px` }}>
        {label}
      </td>
      <td />
    </tr>
  );
}

function QBAccountRow({ name, amount, indent = 2 }) {
  return (
    <tr className="hover:bg-gray-50">
      <td className="py-0.5 px-4 text-xs text-gray-700" style={{ paddingLeft: `${12 + indent * 16}px` }}>
        {name}
      </td>
      <td className={`py-0.5 px-4 text-right text-xs tabular-nums ${numCls(amount)}`}>
        {fmt(amount)}
      </td>
    </tr>
  );
}

function QBTotalRow({ label, amount, indent = 1, strong = false }) {
  return (
    <tr className="border-t border-gray-300">
      <td className={`py-1 px-4 text-xs ${strong ? "font-bold" : "font-semibold"} text-gray-900`}
          style={{ paddingLeft: `${12 + indent * 16}px` }}>
        {label}
      </td>
      <td className={`py-1 px-4 text-right text-xs tabular-nums ${strong ? "font-bold" : "font-semibold"} ${numCls(amount)}`}>
        {fmt(amount, true)}
      </td>
    </tr>
  );
}

function QBReportTable({ children }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-gray-200">
          <th className="pb-2 px-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider w-full" />
          <th className="pb-2 px-4 text-right text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap min-w-[120px]">
            Total
          </th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

// ─── P&L Table ────────────────────────────────────────────────────────────────
function ProfitLossTable({ statement: s }) {
  if (!s) return <EmptyState message="No Profit & Loss data for this period." />;
  return (
    <QBReportTable>
      {/* Income */}
      <QBGroupRow label="Income" indent={0} />
      {(s.revenue?.accounts || []).map((a, i) => (
        <QBAccountRow key={i} name={a.name} amount={a.amount} indent={1} />
      ))}
      <QBTotalRow label="Total Income" amount={s.revenue?.total} indent={0} />

      {/* Cost of Goods Sold */}
      {s.costOfSales?.accounts?.length > 0 && (
        <>
          <tr><td colSpan={2} className="py-1" /></tr>
          <QBGroupRow label="Cost of Goods Sold" indent={0} />
          {s.costOfSales.accounts.map((a, i) => (
            <QBAccountRow key={i} name={a.name} amount={a.amount} indent={1} />
          ))}
          <QBTotalRow label="Total Cost of Goods Sold" amount={s.costOfSales.total} indent={0} />
        </>
      )}

      {/* Gross Profit */}
      <tr><td colSpan={2} className="py-0.5" /></tr>
      <QBTotalRow label="Gross Profit" amount={s.grossProfit} indent={0} strong />

      {/* Expenses */}
      <tr><td colSpan={2} className="py-1" /></tr>
      <QBGroupRow label="Expenses" indent={0} />
      {Object.entries(s.operatingExpenses?.groups || {}).map(([group, g]) => (
        <React.Fragment key={group}>
          <QBGroupRow label={group} indent={1} />
          {(g.accounts || []).map((a, i) => (
            <QBAccountRow key={i} name={a.name} amount={a.amount} indent={2} />
          ))}
          <QBTotalRow label={`Total for ${group}`} amount={g.total} indent={1} />
        </React.Fragment>
      ))}
      <QBTotalRow label="Total Expenses" amount={s.operatingExpenses?.total} indent={0} />

      {/* Net Income */}
      <tr><td colSpan={2} className="py-0.5" /></tr>
      <QBTotalRow label="Net Income" amount={s.netIncome} indent={0} strong />
    </QBReportTable>
  );
}

// ─── BS Table ─────────────────────────────────────────────────────────────────
function BalanceSheetTable({ statement: s }) {
  if (!s) return <EmptyState message="No Balance Sheet data for this period." />;

  const renderGroups = (section, indent = 2) =>
    Object.entries(section?.groups || {}).map(([group, g]) => (
      <React.Fragment key={group}>
        <QBGroupRow label={group} indent={indent} />
        {(g.accounts || []).map((a, i) => (
          <QBAccountRow key={i} name={a.name} amount={a.amount} indent={indent + 1} />
        ))}
        <QBTotalRow label={`Total for ${group}`} amount={g.total} indent={indent} />
      </React.Fragment>
    ));

  const hasFixedAssets = Object.keys(s.assets?.fixedAssets?.groups || {}).length > 0;
  const hasOtherAssets = Object.keys(s.assets?.otherAssets?.groups || {}).length > 0;
  const hasLongTerm = Object.keys(s.liabilities?.longTermLiabilities?.groups || {}).length > 0
    || Math.abs(Number(s.liabilities?.longTermLiabilities?.total)) > 0;

  return (
    <QBReportTable>
      {/* ASSETS */}
      <QBSectionHeader label="Assets" />
      <QBGroupRow label="Current Assets" indent={1} />
      {renderGroups(s.assets?.currentAssets, 2)}
      <QBTotalRow label="Total for Current Assets" amount={s.assets?.currentAssets?.total} indent={1} />

      {hasFixedAssets && (
        <>
          <tr><td colSpan={2} className="py-0.5" /></tr>
          <QBGroupRow label="Fixed Assets" indent={1} />
          {renderGroups(s.assets?.fixedAssets, 2)}
          <QBTotalRow label="Total for Fixed Assets" amount={s.assets?.fixedAssets?.total} indent={1} />
        </>
      )}

      {hasOtherAssets && (
        <>
          <tr><td colSpan={2} className="py-0.5" /></tr>
          <QBGroupRow label="Other Assets" indent={1} />
          {renderGroups(s.assets?.otherAssets, 2)}
          <QBTotalRow label="Total for Other Assets" amount={s.assets?.otherAssets?.total} indent={1} />
        </>
      )}

      <tr><td colSpan={2} className="py-0.5" /></tr>
      <QBTotalRow label="Total for Assets" amount={s.totalAssets} indent={0} strong />

      {/* LIABILITIES AND EQUITY */}
      <tr><td colSpan={2} className="py-2" /></tr>
      <QBSectionHeader label="Liabilities and Equity" />

      <QBGroupRow label="Liabilities" indent={1} />
      <QBGroupRow label="Current Liabilities" indent={2} />
      {renderGroups(s.liabilities?.currentLiabilities, 3)}
      <QBTotalRow label="Total for Current Liabilities" amount={s.liabilities?.currentLiabilities?.total} indent={2} />

      {hasLongTerm && (
        <>
          <tr><td colSpan={2} className="py-0.5" /></tr>
          <QBGroupRow label="Long-term Liabilities" indent={2} />
          {renderGroups(s.liabilities?.longTermLiabilities, 3)}
          <QBTotalRow label="Total for Long-term Liabilities" amount={s.liabilities?.longTermLiabilities?.total} indent={2} />
        </>
      )}

      <tr><td colSpan={2} className="py-0.5" /></tr>
      <QBTotalRow label="Total for Liabilities" amount={s.totalLiabilities} indent={1} />

      <tr><td colSpan={2} className="py-0.5" /></tr>
      <QBGroupRow label="Equity" indent={1} />
      {(s.equity?.accounts || []).map((a, i) => (
        <QBAccountRow key={i} name={a.name} amount={a.amount} indent={2} />
      ))}
      <QBTotalRow label="Total for Equity" amount={s.totalEquity} indent={1} />

      <tr><td colSpan={2} className="py-0.5" /></tr>
      <QBTotalRow label="Total for Liabilities and Equity" amount={s.totalLiabilitiesAndEquity} indent={0} strong />

      {!s.balanced && (
        <tr className="bg-red-50">
          <td colSpan={2} className="px-4 py-1 text-xs text-red-700">
            Out of balance by {fmt(s.difference)}. Check for missing accounts or mapping errors.
          </td>
        </tr>
      )}
    </QBReportTable>
  );
}

// ─── Cash Flow Table ──────────────────────────────────────────────────────────
function CashFlowTable({ statement: s }) {
  if (!s) return <EmptyState message="No Cash Flow data for this period." />;

  const CFSection = ({ section }) => {
    if (!section) return null;
    return (
      <React.Fragment>
        <QBGroupRow label={section.label} indent={1} />
        {(section.items || []).map((item, i) => (
          <QBAccountRow key={i} name={item.name} amount={item.amount} indent={2} />
        ))}
        <QBTotalRow label={`Net ${section.label}`} amount={section.total} indent={1} />
      </React.Fragment>
    );
  };

  return (
    <QBReportTable>
      <QBSectionHeader label="Cash Flow" />
      <CFSection section={s.operatingActivities} />
      <tr><td colSpan={2} className="py-0.5" /></tr>
      <CFSection section={s.investingActivities} />
      <tr><td colSpan={2} className="py-0.5" /></tr>
      <CFSection section={s.financingActivities} />
      <tr><td colSpan={2} className="py-1" /></tr>
      <QBTotalRow label="Net Increase / (Decrease) in Cash" amount={s.netCashIncrease} indent={0} />
      <QBAccountRow name="Opening Cash Balance" amount={s.openingCash} indent={1} />
      <tr><td colSpan={2} className="py-0.5" /></tr>
      <QBTotalRow label="Ending Cash Balance" amount={s.endingCash} indent={0} strong />
    </QBReportTable>
  );
}

// ─── Shared multi-column grid helpers ─────────────────────────────────────────

function buildPlRowDefs(datasets) {
  // Union of all account names across every dataset (month or year).
  const allRevAccounts = [...new Map(
    datasets.flatMap(d => (d.statement?.revenue?.accounts || []).map(a => [a.name, a.name]))
  ).values()];

  const hasCos = datasets.some(d => (d.statement?.costOfSales?.accounts?.length || 0) > 0);
  const allCosAccounts = hasCos ? [...new Map(
    datasets.flatMap(d => (d.statement?.costOfSales?.accounts || []).map(a => [a.name, a.name]))
  ).values()] : [];

  const expGroupMap = new Map();
  for (const d of datasets) {
    for (const [g, gv] of Object.entries(d.statement?.operatingExpenses?.groups || {})) {
      if (!expGroupMap.has(g)) expGroupMap.set(g, new Set());
      for (const a of (gv.accounts || [])) expGroupMap.get(g).add(a.name);
    }
  }

  return [
    { label: "REVENUE",               type: "header" },
    ...allRevAccounts.map(n => ({ label: n, type: "account", section: "revenue",  accountName: n })),
    { label: "Total Revenue",         type: "subtotal", key: "revenue.total" },
    ...(hasCos ? [
      { label: "COST OF SALES",       type: "header" },
      ...allCosAccounts.map(n => ({ label: n, type: "account", section: "cos", accountName: n })),
      { label: "Total Cost of Sales", type: "subtotal", key: "costOfSales.total" },
    ] : []),
    { label: "Gross Profit",          type: "total",   key: "grossProfit" },
    { label: "OPERATING EXPENSES",    type: "header" },
    ...Array.from(expGroupMap.entries()).flatMap(([g, names]) => [
      { label: g, type: "group" },
      ...Array.from(names).map(n => ({ label: n, type: "account", group: g, accountName: n, indent: 1 })),
    ]),
    { label: "Total Expenses",        type: "subtotal", key: "operatingExpenses.total" },
    { label: "Operating Income",      type: "total",   key: "operatingIncome" },
    { label: "Net Income",            type: "grand",   key: "netIncome" },
  ];
}

function getPlVal(stmt, row) {
  if (!stmt) return null;
  if (row.section === "revenue" && row.accountName)
    return (stmt.revenue?.accounts || []).find(a => a.name === row.accountName)?.amount ?? null;
  if (row.section === "cos" && row.accountName)
    return (stmt.costOfSales?.accounts || []).find(a => a.name === row.accountName)?.amount ?? null;
  if (row.group && row.accountName)
    return (stmt.operatingExpenses?.groups?.[row.group]?.accounts || []).find(a => a.name === row.accountName)?.amount ?? null;
  if (row.key) {
    return row.key.split(".").reduce((o, k) => (o?.[k] !== undefined ? o[k] : null), stmt);
  }
  return null;
}

const PL_ROW_CLS = {
  header:  "bg-gray-200 font-bold uppercase text-gray-700",
  group:   "bg-gray-50 font-semibold text-gray-700",
  account: "hover:bg-gray-50 text-gray-600",
  subtotal:"bg-gray-100 font-semibold border-t border-gray-300 text-gray-700",
  total:   "bg-gray-100 font-bold border-t-2 border-gray-300 text-gray-900",
  grand:   "bg-blue-50 font-bold text-blue-900 border-t-2 border-blue-300",
};

// ─── Monthly P&L Grid ─────────────────────────────────────────────────────────
function MonthlyPLGrid({ data }) {
  if (!data?.length) return <EmptyState message="No monthly Profit & Loss data. Upload a General Ledger file with transaction dates to enable monthly breakdown." />;

  const [expandedAccounts, setExpandedAccounts] = useState(new Set());
  const toggleAccount = (key) => setExpandedAccounts(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const months  = data.map(d => ({ key: `${d.monthNumber}-${d.year}`, label: `${d.month.slice(0, 3)} ${d.year}`, stmt: d.statement, vendors: d.vendorsByAccount || {} }));
  const rowDefs = buildPlRowDefs(data);
  const rowCls  = (type) => PL_ROW_CLS[type] || "";

  // Collect all vendor names for an account across all months, sorted by total absolute amount.
  const getVendorsForAccount = (accountName) => {
    const totals = new Map();
    for (const m of months) {
      for (const v of (m.vendors[accountName] || [])) {
        totals.set(v.name, (totals.get(v.name) || 0) + Math.abs(v.amount));
      }
    }
    return Array.from(totals.keys()).sort((a, b) => totals.get(b) - totals.get(a));
  };

  const rows = [];
  for (let ri = 0; ri < rowDefs.length; ri++) {
    const row = rowDefs[ri];
    const expandKey = row.accountName ? `${row.section || row.group || ""}-${row.accountName}` : null;
    const vendorNames = row.type === "account" ? getVendorsForAccount(row.accountName) : [];
    const isExpanded  = expandKey && expandedAccounts.has(expandKey);

    rows.push(
      <tr key={ri} className={`border-b border-gray-100 ${rowCls(row.type)}`}>
        <td
          className={`sticky left-0 px-3 py-1 border-r border-gray-300 z-10 ${rowCls(row.type) || "bg-white"}`}
          style={{ paddingLeft: row.indent ? `${row.indent * 20 + 12}px` : undefined }}
        >
          {vendorNames.length > 0 ? (
            <button
              onClick={() => toggleAccount(expandKey)}
              className="flex items-center gap-1 text-left hover:text-blue-600 w-full"
            >
              {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {row.label}
            </button>
          ) : row.label}
        </td>
        {months.map(m => {
          const val = getPlVal(m.stmt, row);
          return (
            <td key={m.key} className={`px-3 py-1 text-right tabular-nums ${val !== null ? numCls(val) : "text-gray-300"}`}>
              {val !== null ? fmt(val) : "—"}
            </td>
          );
        })}
      </tr>,
    );

    // Vendor sub-rows (shown when account is expanded)
    if (isExpanded && vendorNames.length > 0) {
      for (const vName of vendorNames) {
        rows.push(
          <tr key={`${ri}-v-${vName}`} className="border-b border-gray-50 bg-blue-50/30">
            <td
              className="sticky left-0 bg-blue-50/30 px-3 py-0.5 border-r border-gray-200 z-10 text-gray-500 italic"
              style={{ paddingLeft: `${(row.indent || 0) * 20 + 32}px` }}
            >
              {vName}
            </td>
            {months.map(m => {
              const vEntry = (m.vendors[row.accountName] || []).find(v => v.name === vName);
              const vAmt   = vEntry?.amount ?? null;
              return (
                <td key={m.key} className={`px-3 py-0.5 text-right tabular-nums text-xs ${vAmt !== null ? numCls(vAmt) + " opacity-80" : "text-gray-200"}`}>
                  {vAmt !== null ? fmt(vAmt) : "—"}
                </td>
              );
            })}
          </tr>,
        );
      }
    }
  }

  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full border-collapse min-w-max">
        <thead>
          <tr className="bg-gray-100 border-b-2 border-gray-300">
            <th className="sticky left-0 bg-gray-100 text-left px-3 py-2 w-48 font-semibold border-r border-gray-300 z-10">Account</th>
            {months.map(m => (
              <th key={m.key} className="px-3 py-2 text-right font-semibold min-w-24">{m.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

// ─── All-Years P&L Grid ────────────────────────────────────────────────────────
function AllYearsPLGrid({ yearly }) {
  if (!yearly?.length) return <EmptyState message="No P&L data." />;

  const sorted  = [...yearly].sort((a, b) => Number(a.year) - Number(b.year));
  const rowDefs = buildPlRowDefs(sorted);
  const rowCls  = (type) => PL_ROW_CLS[type] || "";

  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full border-collapse min-w-max">
        <thead>
          <tr className="bg-gray-100 border-b-2 border-gray-300">
            <th className="sticky left-0 bg-gray-100 text-left px-3 py-2 w-48 font-semibold border-r border-gray-300 z-10">Account</th>
            {sorted.map(e => (
              <th key={e.year} className="px-3 py-2 text-right font-semibold min-w-28">FY {e.year}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowDefs.map((row, ri) => (
            <tr key={ri} className={`border-b border-gray-100 ${rowCls(row.type)}`}>
              <td
                className={`sticky left-0 px-3 py-1 border-r border-gray-300 z-10 ${rowCls(row.type) || "bg-white"}`}
                style={{ paddingLeft: row.indent ? `${row.indent * 20 + 12}px` : undefined }}
              >
                {row.label}
              </td>
              {sorted.map(e => {
                const val = getPlVal(e.statement, row);
                return (
                  <td key={e.year} className={`px-3 py-1 text-right tabular-nums ${val !== null ? numCls(val) : "text-gray-300"}`}>
                    {val !== null ? fmt(val) : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Shared Balance Sheet columnar grid helpers ───────────────────────────────

function bsBuildGroupMap(datasets, secPath) {
  const groupMap = new Map();
  for (const d of datasets) {
    const sec = secPath.split(".").reduce((o, k) => o?.[k], d.statement);
    for (const [g, gv] of Object.entries(sec?.groups || {})) {
      if (!groupMap.has(g)) groupMap.set(g, new Set());
      for (const a of (gv.accounts || [])) groupMap.get(g).add(a.name);
    }
  }
  return groupMap;
}

function bsBuildRowDefs(datasets) {
  const currentAssetsGrps = bsBuildGroupMap(datasets, "assets.currentAssets");
  const fixedAssetsGrps   = bsBuildGroupMap(datasets, "assets.fixedAssets");
  const otherAssetsGrps   = bsBuildGroupMap(datasets, "assets.otherAssets");
  const currLiabGrps      = bsBuildGroupMap(datasets, "liabilities.currentLiabilities");
  const longTermLiabGrps  = bsBuildGroupMap(datasets, "liabilities.longTermLiabilities");
  const equityAccounts    = [...new Map(
    datasets.flatMap(d => (d.statement?.equity?.accounts || []).map(a => [a.name, a.name]))
  ).values()];

  const hasFixed    = fixedAssetsGrps.size > 0   || datasets.some(d => Math.abs(Number(d.statement?.assets?.fixedAssets?.total))              > 0.005);
  const hasOther    = otherAssetsGrps.size > 0    || datasets.some(d => Math.abs(Number(d.statement?.assets?.otherAssets?.total))              > 0.005);
  const hasLongTerm = longTermLiabGrps.size > 0   || datasets.some(d => Math.abs(Number(d.statement?.liabilities?.longTermLiabilities?.total)) > 0.005);

  const buildSectionRows = (sp, label, groupMap, indent = 1) => {
    if (groupMap.size === 0) return [];
    const rows = [{ label, type: "group", indent }];
    for (const [g, names] of groupMap) {
      rows.push({ label: g,              type: "sub-group", indent: indent + 1 });
      for (const name of names)
        rows.push({ label: name, type: "account", indent: indent + 2, vk: "acct", sp, grp: g, name });
      rows.push({ label: `Total ${g}`,   type: "subtotal",  indent: indent + 1, vk: "grpTotal", sp, grp: g });
    }
    rows.push({ label: `Total ${label}`, type: "total",     indent,             vk: "secTotal", sp });
    return rows;
  };

  return [
    { label: "ASSETS",                   type: "section-header" },
    ...buildSectionRows("assets.currentAssets",              "Current Assets",        currentAssetsGrps),
    ...(hasFixed    ? buildSectionRows("assets.fixedAssets",              "Fixed Assets",          fixedAssetsGrps)   : []),
    ...(hasOther    ? buildSectionRows("assets.otherAssets",              "Other Assets",          otherAssetsGrps)   : []),
    { label: "Total Assets",             type: "grand",  vk: "totalAssets" },
    { label: "",                         type: "spacer" },
    { label: "LIABILITIES AND EQUITY",  type: "section-header" },
    ...buildSectionRows("liabilities.currentLiabilities",    "Current Liabilities",   currLiabGrps),
    ...(hasLongTerm ? buildSectionRows("liabilities.longTermLiabilities", "Long-term Liabilities", longTermLiabGrps)  : []),
    { label: "Total Liabilities",        type: "total",  vk: "totalLiab" },
    { label: "Equity",                   type: "group",  indent: 1 },
    ...equityAccounts.map(name => ({ label: name, type: "account", indent: 2, vk: "acct", sp: "equity", name })),
    { label: "Total Equity",             type: "total",  vk: "totalEq" },
    { label: "Total Liabilities & Equity", type: "grand", vk: "totalLiabEq" },
  ];
}

function bsGetVal(stmt, row) {
  if (!stmt) return null;
  switch (row.vk) {
    case "totalAssets":  return stmt.totalAssets  ?? null;
    case "totalLiab":    return stmt.totalLiabilities ?? null;
    case "totalEq":      return stmt.totalEquity  ?? null;
    case "totalLiabEq":  return stmt.totalLiabilitiesAndEquity ?? null;
    case "secTotal": { const s = row.sp.split(".").reduce((o, k) => o?.[k], stmt); return s?.total ?? null; }
    case "grpTotal": { const s = row.sp.split(".").reduce((o, k) => o?.[k], stmt); return s?.groups?.[row.grp]?.total ?? null; }
    case "acct": {
      if (row.sp === "equity") return (stmt.equity?.accounts || []).find(a => a.name === row.name)?.amount ?? null;
      const s = row.sp.split(".").reduce((o, k) => o?.[k], stmt);
      return (s?.groups?.[row.grp]?.accounts || []).find(a => a.name === row.name)?.amount ?? null;
    }
    default: return null;
  }
}

const BS_ROW_CLS = {
  "section-header": "bg-gray-300 font-bold uppercase text-gray-800",
  group:            "bg-gray-100 font-semibold text-gray-700",
  "sub-group":      "bg-gray-50 font-medium text-gray-600",
  account:          "hover:bg-gray-50 text-gray-600",
  subtotal:         "bg-gray-100 font-semibold border-t border-gray-300 text-gray-700",
  total:            "bg-gray-100 font-bold border-t-2 border-gray-300 text-gray-900",
  grand:            "bg-blue-50 font-bold text-blue-900 border-t-2 border-blue-300",
};

// Generic columnar BS table — columns = [{key, label, statement}]
function BSColumnarGrid({ columns }) {
  const rowDefs = bsBuildRowDefs(columns.map(c => ({ statement: c.statement })));
  const rowCls  = (type) => BS_ROW_CLS[type] || "";
  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full border-collapse min-w-max">
        <thead>
          <tr className="bg-gray-100 border-b-2 border-gray-300">
            <th className="sticky left-0 bg-gray-100 text-left px-3 py-2 w-48 font-semibold border-r border-gray-300 z-10">Account</th>
            {columns.map(c => (
              <th key={c.key} className="px-3 py-2 text-right font-semibold min-w-28 whitespace-nowrap">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowDefs.map((row, ri) => {
            if (row.type === "spacer")
              return <tr key={ri}><td colSpan={columns.length + 1} className="h-3" /></tr>;
            return (
              <tr key={ri} className={`border-b border-gray-100 ${rowCls(row.type)}`}>
                <td
                  className={`sticky left-0 px-3 py-1 border-r border-gray-300 z-10 ${rowCls(row.type) || "bg-white"}`}
                  style={{ paddingLeft: row.indent ? `${row.indent * 16 + 12}px` : undefined }}
                >
                  {row.label}
                </td>
                {columns.map(c => {
                  const val = bsGetVal(c.statement, row);
                  return (
                    <td key={c.key} className={`px-3 py-1 text-right tabular-nums ${val !== null ? numCls(val) : "text-gray-300"}`}>
                      {val !== null ? fmt(val) : "—"}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// All-Years Balance Sheet Grid (year columns)
function AllYearsBSGrid({ yearly }) {
  if (!yearly?.length) return <EmptyState message="No Balance Sheet data." />;
  const sorted  = [...yearly].sort((a, b) => Number(a.year) - Number(b.year));
  const columns = sorted.map(e => ({ key: e.year, label: `FY ${e.year}`, statement: e.statement }));
  return <BSColumnarGrid columns={columns} />;
}

// Monthly Balance Sheet Grid (month columns)
function MonthlyBSGrid({ data }) {
  if (!data?.length) return <EmptyState message="No monthly Balance Sheet data. Upload a General Ledger file with transaction dates to enable monthly breakdown." />;
  const columns = data.map(d => ({ key: `${d.monthNumber}-${d.year}`, label: `${d.month.slice(0, 3)} ${d.year}`, statement: d.statement }));
  return <BSColumnarGrid columns={columns} />;
}

// ─── Shared Cash Flow columnar grid helpers ───────────────────────────────────

const CF_SECTIONS = ["operatingActivities", "investingActivities", "financingActivities"];
const CF_LABELS   = { operatingActivities: "Operating Activities", investingActivities: "Investing Activities", financingActivities: "Financing Activities" };

function cfBuildRowDefs(datasets) {
  const sectionItems = Object.fromEntries(
    CF_SECTIONS.map(sec => [
      sec,
      [...new Map(datasets.flatMap(d => (d.statement?.[sec]?.items || []).map(a => [a.name, a.name]))).values()],
    ])
  );
  return [
    ...CF_SECTIONS.flatMap(sec => [
      { label: CF_LABELS[sec],           type: "group",   indent: 0 },
      ...sectionItems[sec].map(name => ({ label: name, type: "account", indent: 1, vk: "item", sec, name })),
      { label: `Net ${CF_LABELS[sec]}`,  type: "subtotal",indent: 0,   vk: "secTotal", sec },
      { label: "",                        type: "spacer" },
    ]),
    { label: "Net Increase / (Decrease) in Cash", type: "total",   vk: "netCash"  },
    { label: "Opening Cash Balance",              type: "account", vk: "openCash", indent: 1 },
    { label: "Ending Cash Balance",               type: "grand",   vk: "endCash"  },
  ];
}

function cfGetVal(stmt, row) {
  if (!stmt) return null;
  switch (row.vk) {
    case "item":     return (stmt[row.sec]?.items || []).find(a => a.name === row.name)?.amount ?? null;
    case "secTotal": return stmt[row.sec]?.total ?? null;
    case "netCash":  return stmt.netCashIncrease ?? null;
    case "openCash": return stmt.openingCash     ?? null;
    case "endCash":  return stmt.endingCash      ?? null;
    default:         return null;
  }
}

const CF_ROW_CLS = {
  group:   "bg-gray-100 font-semibold text-gray-700",
  account: "hover:bg-gray-50 text-gray-600",
  subtotal:"bg-gray-100 font-semibold border-t border-gray-300 text-gray-700",
  total:   "bg-gray-100 font-bold border-t-2 border-gray-300 text-gray-900",
  grand:   "bg-blue-50 font-bold text-blue-900 border-t-2 border-blue-300",
};

// Generic columnar CF table — columns = [{key, label, statement}]
function CFColumnarGrid({ columns }) {
  const rowDefs = cfBuildRowDefs(columns.map(c => ({ statement: c.statement })));
  const rowCls  = (type) => CF_ROW_CLS[type] || "";
  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full border-collapse min-w-max">
        <thead>
          <tr className="bg-gray-100 border-b-2 border-gray-300">
            <th className="sticky left-0 bg-gray-100 text-left px-3 py-2 w-48 font-semibold border-r border-gray-300 z-10">Account</th>
            {columns.map(c => (
              <th key={c.key} className="px-3 py-2 text-right font-semibold min-w-28 whitespace-nowrap">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowDefs.map((row, ri) => {
            if (row.type === "spacer")
              return <tr key={ri}><td colSpan={columns.length + 1} className="h-3" /></tr>;
            return (
              <tr key={ri} className={`border-b border-gray-100 ${rowCls(row.type)}`}>
                <td
                  className={`sticky left-0 px-3 py-1 border-r border-gray-300 z-10 ${rowCls(row.type) || "bg-white"}`}
                  style={{ paddingLeft: row.indent ? `${row.indent * 20 + 12}px` : undefined }}
                >
                  {row.label}
                </td>
                {columns.map(c => {
                  const val = cfGetVal(c.statement, row);
                  return (
                    <td key={c.key} className={`px-3 py-1 text-right tabular-nums ${val !== null ? numCls(val) : "text-gray-300"}`}>
                      {val !== null ? fmt(val) : "—"}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// All-Years Cash Flow Grid (year columns)
function AllYearsCFGrid({ yearly }) {
  if (!yearly?.length) return <EmptyState message="No Cash Flow data." />;
  const sorted  = [...yearly].sort((a, b) => Number(a.year) - Number(b.year));
  const columns = sorted.map(e => ({ key: e.year, label: `FY ${e.year}`, statement: e.statement }));
  return <CFColumnarGrid columns={columns} />;
}

// Monthly Cash Flow Grid (month columns)
function MonthlyCFGrid({ data }) {
  if (!data?.length) return <EmptyState message="No monthly Cash Flow data available for this period." />;
  const columns = data.map(d => ({ key: `${d.monthNumber}-${d.year}`, label: `${d.month.slice(0, 3)} ${d.year}`, statement: d.statement }));
  return <CFColumnarGrid columns={columns} />;
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptyState({ message }) {
  return (
    <div className="py-12 text-center text-gray-400">
      <p className="text-sm">{message || "No data available."}</p>
    </div>
  );
}

// ─── Validation Panel ─────────────────────────────────────────────────────────
function ValidationPanel({ validation, missingData }) {
  const issues = [...(missingData || []), ...(validation || [])];
  if (!issues.length) return null;

  return (
    <div className="mb-4 space-y-2">
      {issues.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded p-3 flex gap-2">
          <AlertTriangle size={16} className="text-amber-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-amber-800 mb-1">Validation Warnings</p>
            {issues.map((msg, i) => <p key={i} className="text-xs text-amber-700">{msg}</p>)}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Export to Excel ──────────────────────────────────────────────────────────
function exportToExcel(data) {
  const wb = XLSX.utils.book_new();

  const addSheet = (rows, name) => {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name.slice(0, 31));
  };

  for (const entry of (data?.reports?.profitAndLoss?.yearly || [])) {
    const s = entry.statement;
    addSheet([
      [`Profit & Loss — ${entry.periodLabel}`], [],
      ["REVENUE"], ["Account", "Amount"],
      ...(s.revenue?.accounts || []).map(a => [a.name, a.amount]),
      ["Total Revenue", s.revenue?.total], [],
      ...(s.costOfSales?.accounts?.length ? [
        ["COST OF SALES"],
        ...(s.costOfSales.accounts.map(a => [a.name, a.amount])),
        ["Total CoS", s.costOfSales.total], [],
      ] : []),
      ["Gross Profit", s.grossProfit], [],
      ["OPERATING EXPENSES"],
      ...Object.entries(s.operatingExpenses?.groups || {}).flatMap(([g, gv]) => [
        [g],
        ...(gv.accounts || []).map(a => [`  ${a.name}`, a.amount]),
        [`Total ${g}`, gv.total],
      ]),
      [], ["Total Operating Expenses", s.operatingExpenses?.total],
      ["Operating Income", s.operatingIncome],
      ["Net Income", s.netIncome],
    ], `P&L ${entry.year}`);
  }

  for (const entry of (data?.reports?.balanceSheet?.yearly || [])) {
    const s = entry.statement;
    addSheet([
      [`Balance Sheet — ${entry.periodLabel}`], [],
      ["ASSETS"],
      ...(["currentAssets","fixedAssets","otherAssets"]).flatMap(k => [
        [s.assets?.[k]?.label],
        ...Object.entries(s.assets?.[k]?.groups || {}).flatMap(([g, gv]) => [
          [` ${g}`],
          ...(gv.accounts || []).map(a => [`   ${a.name}`, a.amount]),
          [`Total ${g}`, gv.total],
        ]),
        [`Total ${s.assets?.[k]?.label}`, s.assets?.[k]?.total],
      ]),
      ["TOTAL ASSETS", s.totalAssets], [],
      ["LIABILITIES"],
      ...(["currentLiabilities","longTermLiabilities"]).flatMap(k => [
        [s.liabilities?.[k]?.label],
        ...Object.entries(s.liabilities?.[k]?.groups || {}).flatMap(([g, gv]) => [
          [` ${g}`],
          ...(gv.accounts || []).map(a => [`   ${a.name}`, a.amount]),
        ]),
        [`Total ${s.liabilities?.[k]?.label}`, s.liabilities?.[k]?.total],
      ]),
      ["TOTAL LIABILITIES", s.totalLiabilities], [],
      ["EQUITY"],
      ...(s.equity?.accounts || []).map(a => [a.name, a.amount]),
      ["TOTAL EQUITY", s.totalEquity], [],
      ["TOTAL LIABILITIES & EQUITY", s.totalLiabilitiesAndEquity],
      ["Balanced", s.balanced ? "YES" : `NO (diff: ${s.difference})`],
    ], `BS ${entry.year}`);
  }

  for (const entry of (data?.reports?.cashFlow?.yearly || [])) {
    const s = entry.statement;
    addSheet([
      [`Cash Flow — ${entry.periodLabel}`], [],
      ["OPERATING ACTIVITIES"],
      ...(s.operatingActivities?.items || []).map(a => [a.name, a.amount]),
      ["Net Operating Activities", s.operatingActivities?.total], [],
      ["INVESTING ACTIVITIES"],
      ...(s.investingActivities?.items || []).map(a => [a.name, a.amount]),
      ["Net Investing Activities", s.investingActivities?.total], [],
      ["FINANCING ACTIVITIES"],
      ...(s.financingActivities?.items || []).map(a => [a.name, a.amount]),
      ["Net Financing Activities", s.financingActivities?.total], [],
      ["Net Increase in Cash", s.netCashIncrease],
      ["Opening Cash", s.openingCash],
      ["Ending Cash Balance", s.endingCash],
    ], `CF ${entry.year}`);
  }

  XLSX.writeFile(wb, "financial_statements.xlsx");
}

// ─── Main Component ───────────────────────────────────────────────────────────

const REPORT_TABS = [
  { key: "pl",  label: "Profit & Loss",   Icon: TrendingUp },
  { key: "bs",  label: "Balance Sheet",   Icon: DollarSign },
  { key: "cf",  label: "Cash Flow",       Icon: Activity },
];

export default function FinancialStatementsView({
  versionId,
  hasSyncedData,
  notify,
  // Optional controlled props — let a parent (e.g. WorkspaceReports) drive
  // the active report tab so the outer tab navigation stays in sync.
  activeReport: activeReportProp,
  onActiveReportChange,
}) {
  const [data,          setData]          = useState(null);
  const [loading,       setLoading]       = useState(false);
  const [internalReport,setInternalReport]= useState("pl");
  const [period,        setPeriod]        = useState("yearly");
  const [yearFilter,    setYearFilter]    = useState(null);
  const [monthFrom,     setMonthFrom]     = useState("");
  const [monthTo,       setMonthTo]       = useState("");

  // When a controlled prop is given, use it; otherwise use local state.
  const report    = activeReportProp ?? internalReport;
  const setReport = (r) => {
    setInternalReport(r);
    onActiveReportChange?.(r);
  };

  const generate = useCallback(async () => {
    if (!versionId || !hasSyncedData) return;
    setLoading(true);
    try {
      const res = await getFinancialStatements(versionId, {
        year: yearFilter ? Number(yearFilter) : undefined,
      });
      if (res.success === false) throw new Error(res.error || "Generation failed");
      setData(res);
      const warnCount = (res.missingData?.length || 0) + (res.validation?.length || 0);
      if (warnCount && notify) notify(`Generated with ${warnCount} warning(s)`, "warning");
    } catch (err) {
      if (notify) notify(err.message, "error");
    } finally {
      setLoading(false);
    }
  }, [versionId, hasSyncedData, yearFilter, notify]);

  // Auto-fetch report when component mounts or when versionId/hasSyncedData changes
  React.useEffect(() => {
    if (versionId && hasSyncedData && !data && !loading) {
      void generate();
    }
  }, [versionId, hasSyncedData, generate, data, loading]);

  const plYearly  = data?.reports?.profitAndLoss?.yearly  || [];
  const plMonthly = data?.reports?.profitAndLoss?.monthly || [];
  const bsYearly  = data?.reports?.balanceSheet?.yearly   || [];
  const bsMonthly = data?.reports?.balanceSheet?.monthly  || [];
  const cfYearly  = data?.reports?.cashFlow?.yearly       || [];
  const cfMonthly = data?.reports?.cashFlow?.monthly      || [];

  const allYears = [...new Set([
    ...plYearly.map(e => e.year),
    ...bsYearly.map(e => e.year),
    ...cfYearly.map(e => e.year),
  ])].sort();

  const filterYear       = (arr) => yearFilter ? arr.filter(e => String(e.year) === String(yearFilter)) : arr;
  const filterMonthRange = (arr) => {
    if (!monthFrom && !monthTo) return arr;
    return arr.filter(e => {
      const ym = `${e.year}-${String(e.monthNumber).padStart(2, "0")}`;
      if (monthFrom && ym < monthFrom) return false;
      if (monthTo   && ym > monthTo)   return false;
      return true;
    });
  };

  const plYearFiltered = filterYear(plYearly);
  const bsYearFiltered = filterYear(bsYearly);
  const cfYearFiltered = filterYear(cfYearly);

  // Single-year view (when a specific year is selected, or only one year exists).
  const showAllYears = !yearFilter && allYears.length > 1;
  const plYear   = showAllYears ? null : plYearFiltered[0];
  const bsYear   = showAllYears ? null : bsYearFiltered[0];
  const cfYear   = showAllYears ? null : cfYearFiltered[0];

  const plMonths = filterMonthRange(filterYear(plMonthly));
  const bsMonths = filterMonthRange(filterYear(bsMonthly));
  const cfMonths = filterMonthRange(filterYear(cfMonthly));


  return (
    <div className="space-y-4">
      {/* Toolbar */}
      {data && (
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => exportToExcel(data)}
            className="flex items-center gap-2 px-3 py-2 border border-gray-300 bg-white text-gray-700 rounded text-sm hover:bg-gray-50"
          >
            <Download size={14} /> Export Excel
          </button>
        </div>
      )}

      {loading && (
        <div className="py-16 text-center text-gray-400">
          <RefreshCw size={24} className="animate-spin mx-auto mb-3 text-blue-500" />
          <p className="text-sm">Generating financial statements…</p>
        </div>
      )}

      {data && !loading && (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
            <div>
              {data.companyName && <p className="font-semibold text-gray-900">{data.companyName}</p>}
              <p className="text-xs text-gray-500">Currency: {data.currency || "USD"}</p>
            </div>
            <div className="flex items-center gap-2">
              {(data.validation?.length || 0) + (data.missingData?.length || 0) === 0
                ? <span className="flex items-center gap-1 text-xs text-green-600"><CheckCircle size={12} /> All checks passed</span>
                : <span className="flex items-center gap-1 text-xs text-amber-600"><AlertTriangle size={12} /> {(data.validation?.length || 0) + (data.missingData?.length || 0)} warning(s)</span>
              }
            </div>
          </div>

          {/* Validation */}
          <div className="px-4 pt-3">
            <ValidationPanel
              validation={data.validation}
              missingData={data.missingData}
            />
          </div>

          {/* Year filter — only shown in yearly mode, populated from returned data */}
          {period === "yearly" && allYears.length > 0 && (
            <div className="px-4 pt-2 pb-1 flex items-center gap-2">
              <label htmlFor="fy-select" className="text-xs text-gray-500 font-medium whitespace-nowrap">
                Fiscal Year
              </label>
              <select
                id="fy-select"
                value={yearFilter ?? ""}
                onChange={e => setYearFilter(e.target.value ? Number(e.target.value) : null)}
                className="text-xs border border-gray-300 rounded px-2 py-1 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-400 cursor-pointer"
              >
                <option value="">All Years</option>
                {allYears.map(y => (
                  <option key={y} value={y}>FY {y}</option>
                ))}
              </select>
            </div>
          )}

          {/* Report tabs */}
          <div className="flex border-b border-gray-200">
            {REPORT_TABS.map(({ key, label, Icon }) => (
              <button
                key={key}
                onClick={() => setReport(key)}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm border-b-2 transition-colors ${
                  report === key
                    ? "border-blue-500 text-blue-700 font-semibold bg-blue-50"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50"
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}

            {/* Period toggle + month range filter */}
            <div className="ml-auto flex items-center gap-2 px-4 flex-wrap">
              {period === "monthly" && (
                <>
                  <label className="text-xs text-gray-500">From</label>
                  <input
                    type="month"
                    value={monthFrom}
                    onChange={e => setMonthFrom(e.target.value)}
                    className="text-xs border border-gray-300 rounded px-1 py-0.5"
                  />
                  <label className="text-xs text-gray-500">To</label>
                  <input
                    type="month"
                    value={monthTo}
                    onChange={e => setMonthTo(e.target.value)}
                    className="text-xs border border-gray-300 rounded px-1 py-0.5"
                  />
                </>
              )}
              {["yearly","monthly"].map(p => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`px-3 py-1 text-xs rounded ${period === p ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                >
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Statement content */}
          <div>
            {report === "pl" && (
              period === "yearly"
                ? (showAllYears
                    ? <AllYearsPLGrid yearly={plYearly} />
                    : plYear
                      ? <ProfitLossTable statement={plYear.statement} />
                      : <EmptyState message={`No P&L data for ${yearFilter ? `FY ${yearFilter}` : "any year"}.`} />)
                : <MonthlyPLGrid data={plMonths} />
            )}

            {report === "bs" && (
              period === "yearly"
                ? (showAllYears
                    ? <AllYearsBSGrid yearly={bsYearly} />
                    : bsYear
                      ? <BalanceSheetTable statement={bsYear.statement} />
                      : <EmptyState message={`No Balance Sheet data for FY ${yearFilter}.`} />)
                : <MonthlyBSGrid data={bsMonths} />
            )}

            {report === "cf" && (
              period === "yearly"
                ? (showAllYears
                    ? <AllYearsCFGrid yearly={cfYearly} />
                    : cfYear
                      ? <CashFlowTable statement={cfYear.statement} />
                      : <EmptyState message={`No Cash Flow data for FY ${yearFilter}.`} />)
                : <MonthlyCFGrid data={cfMonths} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

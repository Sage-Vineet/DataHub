// Financial Statements View — P&L, Balance Sheet, Cash Flow
// Monthly and Yearly views, COA-mapped, all zero-value accounts shown.

import React, { useState, useCallback } from "react";
import * as XLSX from "xlsx";
import {
  RefreshCw, Download, ChevronDown, ChevronRight,
  CheckCircle, AlertTriangle, TrendingUp, DollarSign, Activity,
} from "lucide-react";
import { getFinancialStatements } from "../../lib/api";

// ─── Currency formatter ───────────────────────────────────────────────────────
const fmt = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const str = abs.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return n < 0 ? `(${str})` : str;
};

const numCls = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "text-gray-400";
  return n < 0 ? "text-red-600" : "text-gray-900";
};

// ─── Collapsible Section ──────────────────────────────────────────────────────
function CollapseSection({ label, total, defaultOpen = true, children, labelClass = "" }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1 px-4 py-1.5 bg-gray-100 hover:bg-gray-200 text-left"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className={`text-sm font-semibold flex-1 ${labelClass}`}>{label}</span>
        <span className={`text-sm font-semibold tabular-nums ${numCls(total)}`}>{fmt(total)}</span>
      </button>
      {open && children}
    </div>
  );
}

// ─── Account Row ─────────────────────────────────────────────────────────────
function AccountRow({ name, amount, indent = 1 }) {
  return (
    <div className="flex items-center px-4 py-0.5 hover:bg-gray-50 border-b border-gray-50">
      <span className="text-xs text-gray-600 flex-1" style={{ paddingLeft: `${indent * 16}px` }}>{name}</span>
      <span className={`text-xs tabular-nums ${numCls(amount)}`}>{fmt(amount)}</span>
    </div>
  );
}

// ─── Subtotal Row ─────────────────────────────────────────────────────────────
function SubtotalRow({ label, amount, indent = 0, bold = false }) {
  return (
    <div className={`flex items-center px-4 py-1 bg-gray-50 border-t border-gray-200 ${bold ? "border-t-2 border-gray-300" : ""}`}>
      <span className={`text-xs flex-1 ${bold ? "font-bold" : "font-semibold"} text-gray-700`} style={{ paddingLeft: `${indent * 16}px` }}>{label}</span>
      <span className={`text-xs tabular-nums font-semibold ${numCls(amount)}`}>{fmt(amount)}</span>
    </div>
  );
}

// ─── P&L Table ────────────────────────────────────────────────────────────────
function ProfitLossTable({ statement: s }) {
  if (!s) return <EmptyState message="No Profit & Loss data for this period." />;

  return (
    <div className="text-sm">
      {/* Revenue */}
      <CollapseSection label="Revenue" total={s.revenue?.total}>
        {(s.revenue?.accounts || []).map((a, i) => (
          <AccountRow key={i} name={a.name} amount={a.amount} />
        ))}
      </CollapseSection>
      <SubtotalRow label="Total Revenue" amount={s.revenue?.total} />

      {/* Cost of Sales */}
      {(s.costOfSales?.accounts?.length > 0) && (
        <>
          <CollapseSection label="Cost of Sales" total={s.costOfSales?.total}>
            {(s.costOfSales?.accounts || []).map((a, i) => (
              <AccountRow key={i} name={a.name} amount={a.amount} />
            ))}
          </CollapseSection>
          <SubtotalRow label="Total Cost of Sales" amount={s.costOfSales?.total} />
        </>
      )}

      {/* Gross Profit */}
      <SubtotalRow label="Gross Profit" amount={s.grossProfit} bold />

      {/* Operating Expenses */}
      <CollapseSection label="Operating Expenses" total={s.operatingExpenses?.total} labelClass="text-gray-800">
        {Object.entries(s.operatingExpenses?.groups || {}).map(([group, g]) => (
          <CollapseSection key={group} label={group} total={g.total} defaultOpen={false}>
            {(g.accounts || []).map((a, i) => (
              <AccountRow key={i} name={a.name} amount={a.amount} indent={2} />
            ))}
          </CollapseSection>
        ))}
      </CollapseSection>
      <SubtotalRow label="Total Operating Expenses" amount={s.operatingExpenses?.total} />

      {/* Operating Income */}
      <SubtotalRow label="Operating Income" amount={s.operatingIncome} bold />

      {/* Net Income */}
      <div className="flex items-center px-4 py-2 bg-blue-50 border-t-2 border-blue-300">
        <span className="text-sm font-bold text-blue-900 flex-1">Net Income</span>
        <span className={`text-sm font-bold tabular-nums ${numCls(s.netIncome)}`}>{fmt(s.netIncome)}</span>
      </div>
    </div>
  );
}

// ─── BS Table ─────────────────────────────────────────────────────────────────
function BalanceSheetTable({ statement: s }) {
  if (!s) return <EmptyState message="No Balance Sheet data for this period." />;

  const renderAssetGroups = (section) =>
    Object.entries(section?.groups || {}).map(([group, g]) => (
      <CollapseSection key={group} label={group} total={g.total} defaultOpen={false}>
        {(g.accounts || []).map((a, i) => (
          <AccountRow key={i} name={a.name} amount={a.amount} indent={2} />
        ))}
      </CollapseSection>
    ));

  return (
    <div className="text-sm">
      {/* Assets */}
      <div className="px-4 py-1.5 bg-blue-800 text-white">
        <span className="font-semibold">ASSETS</span>
      </div>

      <CollapseSection label="Current Assets" total={s.assets?.currentAssets?.total}>
        {renderAssetGroups(s.assets?.currentAssets)}
      </CollapseSection>
      <SubtotalRow label="Total Current Assets" amount={s.assets?.currentAssets?.total} />

      <CollapseSection label="Fixed Assets" total={s.assets?.fixedAssets?.total} defaultOpen={false}>
        {renderAssetGroups(s.assets?.fixedAssets)}
      </CollapseSection>
      <SubtotalRow label="Total Fixed Assets" amount={s.assets?.fixedAssets?.total} />

      {Object.keys(s.assets?.otherAssets?.groups || {}).length > 0 && (
        <>
          <CollapseSection label="Other Assets" total={s.assets?.otherAssets?.total} defaultOpen={false}>
            {renderAssetGroups(s.assets?.otherAssets)}
          </CollapseSection>
          <SubtotalRow label="Total Other Assets" amount={s.assets?.otherAssets?.total} />
        </>
      )}

      <div className="flex items-center px-4 py-2 bg-blue-100 border-t-2 border-blue-400">
        <span className="text-sm font-bold text-blue-900 flex-1">TOTAL ASSETS</span>
        <span className={`text-sm font-bold tabular-nums ${numCls(s.totalAssets)}`}>{fmt(s.totalAssets)}</span>
      </div>

      {/* Liabilities */}
      <div className="px-4 py-1.5 bg-orange-700 text-white mt-2">
        <span className="font-semibold">LIABILITIES</span>
      </div>

      <CollapseSection label="Current Liabilities" total={s.liabilities?.currentLiabilities?.total}>
        {Object.entries(s.liabilities?.currentLiabilities?.groups || {}).map(([group, g]) => (
          <CollapseSection key={group} label={group} total={g.total} defaultOpen={false}>
            {(g.accounts || []).map((a, i) => (
              <AccountRow key={i} name={a.name} amount={a.amount} indent={2} />
            ))}
          </CollapseSection>
        ))}
      </CollapseSection>
      <SubtotalRow label="Total Current Liabilities" amount={s.liabilities?.currentLiabilities?.total} />

      <CollapseSection label="Long-Term Liabilities" total={s.liabilities?.longTermLiabilities?.total} defaultOpen={false}>
        {Object.entries(s.liabilities?.longTermLiabilities?.groups || {}).map(([group, g]) => (
          <CollapseSection key={group} label={group} total={g.total} defaultOpen={false}>
            {(g.accounts || []).map((a, i) => (
              <AccountRow key={i} name={a.name} amount={a.amount} indent={2} />
            ))}
          </CollapseSection>
        ))}
      </CollapseSection>
      <SubtotalRow label="Total Long-Term Liabilities" amount={s.liabilities?.longTermLiabilities?.total} />

      <div className="flex items-center px-4 py-2 bg-orange-100 border-t-2 border-orange-400">
        <span className="text-sm font-bold text-orange-900 flex-1">TOTAL LIABILITIES</span>
        <span className={`text-sm font-bold tabular-nums ${numCls(s.totalLiabilities)}`}>{fmt(s.totalLiabilities)}</span>
      </div>

      {/* Equity */}
      <div className="px-4 py-1.5 bg-green-700 text-white mt-2">
        <span className="font-semibold">EQUITY</span>
      </div>
      <CollapseSection label="Equity Accounts" total={s.equity?.total}>
        {(s.equity?.accounts || []).map((a, i) => (
          <AccountRow key={i} name={a.name} amount={a.amount} />
        ))}
      </CollapseSection>
      <div className="flex items-center px-4 py-2 bg-green-100 border-t-2 border-green-400">
        <span className="text-sm font-bold text-green-900 flex-1">TOTAL EQUITY</span>
        <span className={`text-sm font-bold tabular-nums ${numCls(s.totalEquity)}`}>{fmt(s.totalEquity)}</span>
      </div>

      {/* Balance check */}
      <div className={`flex items-center px-4 py-2 border-t-2 ${s.balanced ? "bg-green-50 border-green-500" : "bg-red-50 border-red-500"}`}>
        <span className="text-sm font-bold flex-1 text-gray-900">TOTAL LIABILITIES & EQUITY</span>
        <span className={`text-sm font-bold tabular-nums mr-4 ${numCls(s.totalLiabilitiesAndEquity)}`}>{fmt(s.totalLiabilitiesAndEquity)}</span>
        {s.balanced
          ? <CheckCircle size={14} className="text-green-600" />
          : <AlertTriangle size={14} className="text-red-500" />}
      </div>

      {!s.balanced && (
        <div className="px-4 py-1 bg-red-50 text-xs text-red-700 border-b border-red-200">
          Out of balance by {fmt(s.difference)}. Check for missing accounts or mapping errors.
        </div>
      )}
    </div>
  );
}

// ─── Cash Flow Table ──────────────────────────────────────────────────────────
function CashFlowTable({ statement: s }) {
  if (!s) return <EmptyState message="No Cash Flow data for this period." />;

  const Section = ({ section, color }) => {
    if (!section) return null;
    const colorMap = {
      blue:   { header: "bg-blue-800 text-white",   sub: "bg-blue-100 border-blue-400 text-blue-900" },
      orange: { header: "bg-orange-700 text-white",  sub: "bg-orange-100 border-orange-400 text-orange-900" },
      green:  { header: "bg-green-700 text-white",   sub: "bg-green-100 border-green-400 text-green-900" },
    };
    const c = colorMap[color] || colorMap.blue;

    return (
      <div>
        <div className={`px-4 py-1.5 ${c.header}`}>
          <span className="font-semibold">{section.label?.toUpperCase()}</span>
        </div>
        {(section.items || []).map((item, i) => (
          <div key={i} className="flex items-center px-4 py-0.5 hover:bg-gray-50 border-b border-gray-50">
            <span className="text-xs text-gray-600 flex-1 pl-4">{item.name}</span>
            <span className={`text-xs tabular-nums ${numCls(item.amount)}`}>{fmt(item.amount)}</span>
          </div>
        ))}
        <div className={`flex items-center px-4 py-2 ${c.sub} border-t-2`}>
          <span className="text-sm font-bold flex-1">Net {section.label}</span>
          <span className={`text-sm font-bold tabular-nums ${numCls(section.total)}`}>{fmt(section.total)}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="text-sm">
      <Section section={s.operatingActivities}  color="blue" />
      <Section section={s.investingActivities}  color="orange" />
      <Section section={s.financingActivities}  color="green" />

      <div className="mt-2 border-t-2 border-gray-400">
        <div className="flex items-center px-4 py-1.5 bg-gray-50">
          <span className="text-sm font-semibold flex-1 text-gray-700">Net Increase / (Decrease) in Cash</span>
          <span className={`text-sm font-semibold tabular-nums ${numCls(s.netCashIncrease)}`}>{fmt(s.netCashIncrease)}</span>
        </div>
        <div className="flex items-center px-4 py-1.5 bg-gray-50 border-t border-gray-200">
          <span className="text-sm font-semibold flex-1 text-gray-700">Opening Cash Balance</span>
          <span className={`text-sm font-semibold tabular-nums ${numCls(s.openingCash)}`}>{fmt(s.openingCash)}</span>
        </div>
        <div className="flex items-center px-4 py-2 bg-blue-50 border-t-2 border-blue-300">
          <span className="text-sm font-bold text-blue-900 flex-1">Ending Cash Balance</span>
          <span className={`text-sm font-bold tabular-nums ${numCls(s.endingCash)}`}>{fmt(s.endingCash)}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Monthly P&L Grid ─────────────────────────────────────────────────────────
function MonthlyPLGrid({ data }) {
  if (!data?.length) return <EmptyState message="No monthly Profit & Loss data. Upload a General Ledger file with transaction dates to enable monthly breakdown." />;

  const months = data.map(d => ({ key: `${d.monthNumber}-${d.year}`, label: d.month.slice(0, 3), stmt: d.statement }));

  const getVal = (stmt, path) => {
    if (!path || !stmt) return null;
    return path.split(".").reduce((o, k) => (o != null && o[k] !== undefined ? o[k] : null), stmt);
  };

  const rowDefs = [
    { label: "REVENUE",                 key: null,                          type: "header" },
    ...((data[0]?.statement?.revenue?.accounts || []).map((a, i) => ({
      label: a.name, key: `revenue.accounts.${i}.amount`, type: "account",
    }))),
    { label: "Total Revenue",           key: "revenue.total",               type: "subtotal" },
    ...((data[0]?.statement?.costOfSales?.accounts?.length
      ? [
          { label: "COST OF SALES",     key: null,                          type: "header" },
          ...(data[0].statement.costOfSales.accounts.map((a, i) => ({ label: a.name, key: `costOfSales.accounts.${i}.amount`, type: "account" }))),
          { label: "Total Cost of Sales", key: "costOfSales.total",         type: "subtotal" },
        ] : []
    )),
    { label: "Gross Profit",            key: "grossProfit",                  type: "total" },
    { label: "OPERATING EXPENSES",      key: null,                           type: "header" },
    ...Object.entries(data[0]?.statement?.operatingExpenses?.groups || {}).flatMap(([g, gv]) => [
      { label: g,         key: null,                                          type: "group" },
      ...(gv.accounts || []).map((a, i) => ({ label: a.name, key: `operatingExpenses.groups.${g}.accounts.${i}.amount`, type: "account", indent: 1 })),
    ]),
    { label: "Total Operating Expenses",key: "operatingExpenses.total",      type: "subtotal" },
    { label: "Operating Income",        key: "operatingIncome",              type: "total" },
    { label: "Net Income",              key: "netIncome",                    type: "grand" },
  ];

  const rowCls = (type) => ({
    header:  "bg-gray-200 font-bold uppercase text-gray-700",
    group:   "bg-gray-50 font-semibold text-gray-700",
    account: "hover:bg-gray-50 text-gray-600",
    subtotal:"bg-gray-100 font-semibold border-t border-gray-300 text-gray-700",
    total:   "bg-gray-100 font-bold border-t-2 border-gray-300 text-gray-900",
    grand:   "bg-blue-50 font-bold text-blue-900 border-t-2 border-blue-300",
  }[type] || "");

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
        <tbody>
          {rowDefs.map((row, ri) => (
            <tr key={ri} className={`border-b border-gray-100 ${rowCls(row.type)}`}>
              <td
                className={`sticky left-0 px-3 py-1 border-r border-gray-300 z-10 ${rowCls(row.type) || "bg-white"}`}
                style={{ paddingLeft: row.indent ? `${row.indent * 20 + 12}px` : undefined }}
              >
                {row.label}
              </td>
              {months.map(m => {
                const val = getVal(m.stmt, row.key);
                return (
                  <td key={m.key} className={`px-3 py-1 text-right tabular-nums ${val !== null ? numCls(val) : "text-gray-300"}`}>
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

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptyState({ message }) {
  return (
    <div className="py-12 text-center text-gray-400">
      <p className="text-sm">{message || "No data available."}</p>
    </div>
  );
}

// ─── Validation Panel ─────────────────────────────────────────────────────────
function ValidationPanel({ validation, unmappedAccounts, missingData }) {
  const issues = [...(missingData || []), ...(validation || [])];
  if (!issues.length && !unmappedAccounts?.length) return null;

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
      {unmappedAccounts?.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded p-3 flex gap-2">
          <AlertTriangle size={16} className="text-blue-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-blue-800 mb-1">{unmappedAccounts.length} accounts not mapped to COA</p>
            <p className="text-xs text-blue-700 font-mono">{unmappedAccounts.slice(0, 5).join(", ")}{unmappedAccounts.length > 5 ? ` +${unmappedAccounts.length - 5} more` : ""}</p>
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

  const filterYear = (arr) => yearFilter ? arr.filter(e => e.year === yearFilter) : arr;

  const plYear   = filterYear(plYearly)[0];
  const bsYear   = filterYear(bsYearly)[0];
  const cfYear   = filterYear(cfYearly)[0];
  const plMonths = filterYear(plMonthly);
  const bsMonths = filterYear(bsMonthly);
  const cfMonths = filterYear(cfMonthly);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={generate}
          disabled={loading || !hasSyncedData}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          {data ? "Regenerate" : "Generate"} Reports
        </button>

        {data && (
          <button
            onClick={() => exportToExcel(data)}
            className="flex items-center gap-2 px-3 py-2 border border-gray-300 bg-white text-gray-700 rounded text-sm hover:bg-gray-50"
          >
            <Download size={14} /> Export Excel
          </button>
        )}

        {!hasSyncedData && (
          <p className="text-xs text-amber-600">Sync data first before generating reports.</p>
        )}
      </div>

      {!data && !loading && (
        <div className="py-16 text-center text-gray-400">
          <p className="text-sm">Click "Generate Reports" to build P&L, Balance Sheet, and Cash Flow from your uploaded data.</p>
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
              unmappedAccounts={data.unmappedAccounts}
              missingData={data.missingData}
            />
          </div>

          {/* Year filter */}
          {allYears.length > 1 && (
            <div className="px-4 flex gap-1 pt-1">
              {[null, ...allYears].map(y => (
                <button
                  key={y || "all"}
                  onClick={() => setYearFilter(y)}
                  className={`px-3 py-1 text-xs rounded-t border-b-2 transition-colors ${yearFilter === y ? "border-blue-500 text-blue-700 font-semibold bg-blue-50" : "border-transparent text-gray-500 hover:text-gray-700"}`}
                >
                  {y ? `FY ${y}` : "All Years"}
                </button>
              ))}
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

            {/* Period toggle */}
            <div className="ml-auto flex items-center gap-1 px-4">
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
          <div className="overflow-auto max-h-[70vh]">
            {report === "pl" && (
              period === "yearly"
                ? (plYear
                    ? <ProfitLossTable statement={plYear.statement} />
                    : <EmptyState message={`No P&L data for ${yearFilter ? `FY ${yearFilter}` : "any year"}.`} />)
                : <MonthlyPLGrid data={plMonths} />
            )}

            {report === "bs" && (
              period === "yearly"
                ? (bsYear
                    ? <BalanceSheetTable statement={bsYear.statement} />
                    : <EmptyState message={`No Balance Sheet data for ${yearFilter ? `FY ${yearFilter}` : "any year"}.`} />)
                : (bsMonths.length
                    ? bsMonths.map((e, i) => (
                        <div key={i}>
                          <div className="px-4 py-2 bg-gray-100 font-semibold text-sm border-b">{e.periodLabel}</div>
                          <BalanceSheetTable statement={e.statement} />
                        </div>
                      ))
                    : <EmptyState message="Monthly Balance Sheets require multiple BS files with different as-of dates." />)
            )}

            {report === "cf" && (
              period === "yearly"
                ? (cfYear
                    ? <CashFlowTable statement={cfYear.statement} />
                    : <EmptyState message={`No Cash Flow data for ${yearFilter ? `FY ${yearFilter}` : "any year"}.`} />)
                : (cfMonths.length
                    ? cfMonths.map((e, i) => (
                        <div key={i}>
                          <div className="px-4 py-2 bg-gray-100 font-semibold text-sm border-b">{e.periodLabel}</div>
                          <CashFlowTable statement={e.statement} />
                        </div>
                      ))
                    : <EmptyState message="Monthly Cash Flow is not available for this period." />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

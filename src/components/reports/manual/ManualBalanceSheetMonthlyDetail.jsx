import { useState, useMemo, useLayoutEffect, useRef } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatCurrency } from "../../../lib/utils";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabel(monthNum, year) {
  return `${MONTH_NAMES[monthNum - 1]}${year ? ` ${year}` : ""}`;
}

function colClass(value) {
  return `px-3 py-1.5 text-right text-[12px] tabular-nums ${Number(value) < 0 ? "text-status-error" : "text-text-secondary"}`;
}

function AccountRow({ account, months, partyLabel = "Vendor / Customer" }) {
  const [isOpen, setIsOpen] = useState(false);

  const vendorGroups = useMemo(() => {
    if (!account.transactions || account.transactions.length === 0) return [];

    const map = new Map();
    account.transactions.forEach((tx) => {
      const name = tx.vendorName || "Unknown";
      if (!map.has(name)) {
        map.set(name, { vendorName: name, monthly: {}, total: 0 });
      }
      const g = map.get(name);
      const amt = Number(tx.amount || 0);
      const m = tx.fiscalMonth;

      g.total += amt;
      if (m >= 1 && m <= 12) {
        g.monthly[m] = (g.monthly[m] || 0) + amt;
      }
    });

    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [account.transactions]);

  const hasTransactions = vendorGroups.length > 0;

  return (
    <>
      <tr
        className={`border-b border-border-light hover:bg-bg-page/30 transition-colors ${hasTransactions ? 'cursor-pointer' : ''}`}
        onClick={() => hasTransactions && setIsOpen(!isOpen)}
      >
        <td className="px-3 py-1.5 pl-6 flex items-center gap-2 text-[12px] text-text-secondary">
          <div className="w-4 h-4 flex items-center justify-center">
            {hasTransactions && (
              isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />
            )}
          </div>
          <span className="truncate max-w-[300px]" title={account.name}>{account.name}</span>
        </td>
        {months.map((m) => {
          const v = Number(account.monthly?.[m] || 0);
          return <td key={m} className={colClass(v)}>{formatCurrency(v)}</td>;
        })}
        <td className={`px-3 py-1.5 text-right text-[12px] tabular-nums font-medium ${Number(account.monthly?.[months[months.length-1]] ?? account.total ?? 0) < 0 ? "text-status-error" : "text-text-secondary"}`}>
          {formatCurrency(Number(account.monthly?.[months[months.length-1]] ?? account.total ?? 0))}
        </td>
      </tr>

      {isOpen && hasTransactions && (
        <>
          <tr className="bg-bg-page/5 border-b border-border-light">
            <td className="px-3 py-1 pl-14 text-[10px] font-bold text-text-muted uppercase tracking-wider bg-bg-page/10">
              {partyLabel}
            </td>
            {months.map(m => <td key={m} className="px-3 py-1 bg-bg-page/10" />)}
            <td className="px-3 py-1 bg-bg-page/10" />
          </tr>
          {vendorGroups.map((vg) => (
            <tr key={vg.vendorName} className="border-b border-border-light/50 bg-bg-page/5 hover:bg-bg-page/10">
              <td className="px-3 py-1.5 pl-14 text-[11px] text-text-muted italic">
                {vg.vendorName}
              </td>
              {months.map((m) => {
                const v = Number(vg.monthly[m] || 0);
                return (
                  <td key={m} className={`px-3 py-1.5 text-right text-[11px] tabular-nums ${v < 0 ? 'text-status-error/80' : 'text-text-muted/80'}`}>
                    {v !== 0 ? formatCurrency(v) : "-"}
                  </td>
                );
              })}
              <td className={`px-3 py-1.5 text-right text-[11px] tabular-nums font-medium ${vg.total < 0 ? 'text-status-error/80' : 'text-text-muted/80'}`}>
                {formatCurrency(vg.total)}
              </td>
            </tr>
          ))}
        </>
      )}
    </>
  );
}

function CategoryBlock({ category, months, partyLabel }) {
  return (
    <>
      <tr className="border-b border-border-light bg-bg-page/20">
        <td className="px-3 py-1.5 pl-6 text-[12px] font-semibold text-text-secondary italic">
          {category.label}
        </td>
        {months.map((m) => (
          <td key={m} className="px-3 py-1.5" />
        ))}
        <td className="px-3 py-1.5" />
      </tr>
      {(category.accounts || []).map((acc) => (
        <AccountRow key={`${acc.number}::${acc.name}`} account={acc} months={months} partyLabel={partyLabel} />
      ))}
      <tr className="border-b border-border bg-bg-page/30">
        <td className="px-3 py-1.5 pl-8 text-[12px] font-semibold text-text-primary italic">
          Total {category.label}
        </td>
        {months.map((m) => {
          const v = Number(category.monthlyTotals?.[m] || 0);
          return (
            <td key={m} className={`px-3 py-1.5 text-right text-[12px] tabular-nums font-semibold ${v < 0 ? "text-status-error" : "text-text-primary"}`}>
              {formatCurrency(v)}
            </td>
          );
        })}
        <td className={`px-3 py-1.5 text-right text-[12px] tabular-nums font-semibold ${Number(category.monthlyTotals?.[months[months.length-1]] ?? category.total ?? 0) < 0 ? "text-status-error" : "text-text-primary"}`}>
          {formatCurrency(Number(category.monthlyTotals?.[months[months.length-1]] ?? category.total ?? 0))}
        </td>
      </tr>
    </>
  );
}

function SectionBlock({ sectionKey, section, months }) {
  const totalLabel = sectionKey === "Assets" ? "Total Assets"
    : sectionKey === "Liabilities" ? "Total Liabilities"
      : "Total Equity";
  const partyLabel = sectionKey === "Assets" ? "Customer / Vendor" : "Vendor";

  return (
    <>
      <tr className="bg-bg-page/70 border-b border-border">
        <td className="px-3 py-2 text-[13px] font-bold text-text-primary" colSpan={months.length + 2}>
          {section.label}
        </td>
      </tr>
      {(section.categories || []).map((cat) => (
        <CategoryBlock key={cat.label} category={cat} months={months} partyLabel={partyLabel} />
      ))}
      <tr className="border-b-2 border-text-primary bg-bg-page/50">
        <td className="px-3 py-2 text-[13px] font-bold text-text-primary">{totalLabel}</td>
        {months.map((m) => {
          const v = Number(section.monthlyTotals?.[m] || 0);
          return (
            <td key={m} className={`px-3 py-2 text-right text-[12px] tabular-nums font-bold ${v < 0 ? "text-status-error" : "text-text-primary"}`}>
              {formatCurrency(v)}
            </td>
          );
        })}
        <td className={`px-3 py-2 text-right text-[12px] tabular-nums font-bold ${Number(section.monthlyTotals?.[months[months.length-1]] ?? section.total ?? 0) < 0 ? "text-status-error" : "text-text-primary"}`}>
          {formatCurrency(Number(section.monthlyTotals?.[months[months.length-1]] ?? section.total ?? 0))}
        </td>
      </tr>
    </>
  );
}

export default function ManualBalanceSheetMonthlyDetail({
  data,
  title = "Balance Sheet",
  subtitle = "",
  entityName = "Company",
  selectedMonths = [],
}) {
  const tableWrapRef = useRef(null);
  const [tableHeight, setTableHeight] = useState(null);

  useLayoutEffect(() => {
    if (!tableWrapRef.current) return;
    const rect = tableWrapRef.current.getBoundingClientRect();
    const h = Math.floor(window.innerHeight - rect.top - 8);
    if (h > 200) setTableHeight(h);
  });

  const year = data?.year || null;
  const allMonths = Array.isArray(data?.months) ? data.months : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const months = selectedMonths && selectedMonths.length > 0
    ? allMonths.filter((m) => selectedMonths.includes(m))
    : allMonths;
  const sections = data?.sections || {};
  const hasSections = Object.keys(sections).length > 0;

  const lastMonth = months.length > 0 ? months[months.length - 1] : 12;
  const monthNames = data?.monthNames || ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const lastMonthName = monthNames[lastMonth - 1] || "Dec";
  const lastDayOfMonth = year ? new Date(year, lastMonth, 0).getDate() : 31;
  const fallbackSubtitle = year
    ? `As of ${lastMonthName} ${lastDayOfMonth}, ${year}`
    : "All Dates";
  const displaySubtitle = subtitle === null ? null : (subtitle || fallbackSubtitle);

  if (!hasSections) {
    return (
      <div className="flex-1 bg-bg-page/50 p-10 font-inter">
        <div className="max-w-[1400px] mx-auto card-base p-10 min-h-[400px] flex items-center justify-center rounded-sm shadow-xl">
          <p className="text-text-muted italic text-[14px]">
            No Balance Sheet data found. Select a fiscal year filter and re-generate.
          </p>
        </div>
      </div>
    );
  }

  // Calculate total liabilities + equity by month
  const liabSection = sections.Liabilities || { monthlyTotals: {}, total: 0 };
  const eqSection = sections.Equity || { monthlyTotals: {}, total: 0 };
  const totalLEByMonth = {};
  months.forEach((m) => {
    totalLEByMonth[m] = (liabSection.monthlyTotals?.[m] || 0) + (eqSection.monthlyTotals?.[m] || 0);
  });
  const lastVisibleMonth = months[months.length - 1];
  const totalLETotal = lastVisibleMonth != null
    ? (totalLEByMonth[lastVisibleMonth] || 0)
    : (liabSection.total || 0) + (eqSection.total || 0);

  return (
    <div className="flex-1 bg-bg-page/50 p-6 lg:p-10 font-inter">
      <div className="max-w-[1600px] mx-auto card-base p-6 flex flex-col rounded-sm shadow-xl">

        {/* Report Header */}
        <div className="flex flex-col items-center mb-10 relative">
          <div className="w-12 h-1 bg-primary rounded-full mb-6" />
          <h1 className="text-[22px] font-bold text-text-primary tracking-tight leading-none mb-2">
            {entityName}
          </h1>
          <h2 className="text-[18px] font-medium text-text-secondary mb-4">{title}</h2>
          {displaySubtitle && (
            <div className="flex items-center gap-3 text-[12px] text-text-muted bg-bg-page px-4 py-1.5 rounded-full border border-border">
              <span>{displaySubtitle}</span>
            </div>
          )}
        </div>

        <div
          ref={tableWrapRef}
          className="overflow-auto rounded-md border border-border"
          style={tableHeight ? { height: `${tableHeight}px` } : {}}
        >
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-bg-page">
                <th className="sticky top-0 z-20 bg-bg-page px-3 pt-2.5 pb-3 text-left text-[12px] font-semibold text-text-primary min-w-[300px] border-b-2 border-text-primary" />
                {months.map((m) => (
                  <th key={m} className="sticky top-0 z-20 bg-bg-page px-3 pt-2.5 pb-3 text-right text-[12px] font-semibold text-text-primary whitespace-nowrap min-w-[100px] border-b-2 border-text-primary">
                    {monthLabel(m, year)}
                  </th>
                ))}
                <th className="sticky top-0 z-20 bg-bg-page px-3 pt-2.5 pb-3 text-right text-[12px] font-semibold text-text-primary min-w-[110px] border-b-2 border-text-primary">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {["Assets", "Liabilities", "Equity"].map((key) =>
                sections[key] ? (
                  <SectionBlock key={key} sectionKey={key} section={sections[key]} months={months} />
                ) : null
              )}

              {/* Total Liabilities & Equity */}
              <tr className="border-t-2 border-text-primary bg-bg-page/60">
                <td className="px-3 py-2 text-[13px] font-bold text-text-primary">
                  Total Liabilities &amp; Equity
                </td>
                {months.map((m) => {
                  const v = Number(totalLEByMonth[m] || 0);
                  return (
                    <td key={m} className={`px-3 py-2 text-right text-[12px] tabular-nums font-bold ${v < 0 ? "text-status-error" : "text-text-primary"}`}>
                      {formatCurrency(v)}
                    </td>
                  );
                })}
                <td className={`px-3 py-2 text-right text-[12px] tabular-nums font-bold ${totalLETotal < 0 ? "text-status-error" : "text-text-primary"}`}>
                  {formatCurrency(totalLETotal)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

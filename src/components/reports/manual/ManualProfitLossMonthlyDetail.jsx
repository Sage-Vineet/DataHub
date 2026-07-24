import { useMemo, useState, useRef, useCallback } from "react";
import { formatCurrency } from "../../../lib/utils";
import { ChevronRight, ChevronDown } from "lucide-react";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function colClass(value) {
  return `px-3 py-1.5 text-right text-[12px] tabular-nums ${Number(value) < 0 ? "text-status-error" : "text-text-secondary"}`;
}

function monthLabel(col, year) {
  if (col > 12) return String(col); // yearly mode: col IS the year number
  return `${MONTH_NAMES[col - 1] || ""}${year ? ` ${year}` : ""}`;
}

// Shared class for the frozen first-column cell in every body row.
// bg-bg-page gives a solid background so scrolling data doesn't show through.
// border-r separates the frozen column from the scrolling data columns.
const STICKY_FIRST_COL = "sticky left-0 z-10 bg-bg-page border-r border-border";

// Single account row.
function AccountRow({ account, months, partyLabel = "Vendor" }) {
  const [isOpen, setIsOpen] = useState(false);
  const hasTransactions = Array.isArray(account.transactions) && account.transactions.length > 0;
  const isYearMode = months.length > 0 && months[0] > 12;

  const vendorGroups = useMemo(() => {
    const map = new Map();
    const emptyName = `No ${partyLabel.toLowerCase()} / —`;
    (account.transactions || []).forEach((tx) => {
      const name = String(tx.vendorName || "").trim() || emptyName;
      const amt = Number(tx.amount || 0);
      if (!map.has(name)) map.set(name, { vendorName: name, monthly: {}, total: 0 });
      const g = map.get(name);
      g.total += amt;
      if (isYearMode) {
        // In yearly mode key by fiscalYear so vendor columns align with year columns
        const yr = tx.fiscalYear || tx.year;
        if (yr) g.monthly[yr] = (g.monthly[yr] || 0) + amt;
      } else {
        const month = Number(String(tx.date || "").slice(5, 7));
        if (month >= 1 && month <= 12) g.monthly[month] = (g.monthly[month] || 0) + amt;
      }
    });
    return Array.from(map.values()).sort(
      (a, b) => Math.abs(b.total) - Math.abs(a.total),
    );
  }, [account.transactions, partyLabel, isYearMode]);

  return (
    <>
      <tr
        className={`border-b border-border-light hover:bg-bg-page/30 cursor-pointer transition-colors ${isOpen ? "bg-bg-page/20" : ""}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        {/* Frozen first column */}
        <td className={`${STICKY_FIRST_COL} px-3 py-1.5 pl-8 text-[12px] text-text-secondary`}>
          <div className="flex items-center gap-1.5">
            {hasTransactions && (
              isOpen ? <ChevronDown size={12} className="text-text-muted" /> : <ChevronRight size={12} className="text-text-muted" />
            )}
            {account.accountName}
          </div>
        </td>
        {months.map((m) => {
          const v = Number(account.monthly?.[m] || 0);
          return (
            <td key={m} className={colClass(v)}>{formatCurrency(v)}</td>
          );
        })}
      </tr>

      {isOpen && hasTransactions && (
        <>
          {/* Sub-header marking the vendor/customer breakdown */}
          <tr className="border-b border-border/40 bg-bg-page/40">
            <td className={`${STICKY_FIRST_COL} px-3 py-1 pl-12 text-[10px] font-semibold uppercase tracking-wider text-text-muted`}>
              {partyLabel}
            </td>
            {months.map((m) => (
              <td key={m} className="px-3 py-1" />
            ))}
          </tr>
          {/* One row per vendor/customer */}
          {vendorGroups.map((g, idx) => (
            <tr
              key={g.vendorName || idx}
              className="border-b border-border/30 bg-bg-page/10 hover:bg-bg-page/30 transition-colors"
            >
              <td className={`${STICKY_FIRST_COL} px-3 py-1 pl-12 text-[11px] text-text-secondary`}>{g.vendorName}</td>
              {months.map((m) => {
                const v = Number(g.monthly?.[m] || 0);
                return (
                  <td
                    key={m}
                    className={`px-3 py-1 text-right text-[11px] tabular-nums ${v < 0 ? "text-status-error" : "text-text-muted"}`}
                  >
                    {formatCurrency(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </>
      )}
    </>
  );
}

// Section with accounts + subtotal row
function SectionBlock({ section, months }) {
  const hasAccounts = Array.isArray(section.accounts) && section.accounts.length > 0;
  const partyLabel = section.key === "income" ? "Customer" : "Vendor";

  return (
    <>
      {/* Section header — first cell is sticky, remaining cells fill the row */}
      <tr className="bg-bg-page/60 border-b border-border">
        <td className={`${STICKY_FIRST_COL} bg-bg-page/60 px-3 py-2 text-[13px] font-semibold text-text-primary`}>
          {section.label}
        </td>
        {months.map((m) => (
          <td key={m} className="bg-bg-page/60" />
        ))}
        <td className="bg-bg-page/60" />
      </tr>

      {/* Account rows */}
      {hasAccounts && section.accounts.map((acc) => (
        <AccountRow key={`${acc.accountNumber}::${acc.accountName}`} account={acc} months={months} partyLabel={partyLabel} />
      ))}

      {/* Section subtotal */}
      {hasAccounts && (
        <tr className="border-b border-border bg-bg-page/30">
          <td className={`${STICKY_FIRST_COL} bg-bg-page/30 px-3 py-1.5 pl-6 text-[12px] font-semibold text-text-primary italic`}>
            {section.totalLabel || `Total For ${section.label}`}
          </td>
          {months.map((m) => {
            const v = Number(section.monthlyTotals?.[m] || 0);
            return (
              <td key={m} className={`px-3 py-1.5 text-right text-[12px] tabular-nums font-semibold ${v < 0 ? "text-status-error" : "text-text-primary"}`}>
                {formatCurrency(v)}
              </td>
            );
          })}
        </tr>
      )}
    </>
  );
}

// Calculated summary row (Gross Profit, Net Operating Income, Net Income)
function CalculatedRow({ section, months }) {
  const isNetIncome = section.key === "net_income";
  const rowBg = isNetIncome ? "bg-bg-page/80" : "bg-bg-page/40";
  const rowClass = isNetIncome
    ? "border-t-2 border-text-primary bg-bg-page/80"
    : "border-b border-border bg-bg-page/40";

  return (
    <tr className={rowClass}>
      <td className={`${STICKY_FIRST_COL} ${rowBg} px-3 py-2 text-[13px] font-bold text-text-primary${isNetIncome ? " text-[14px]" : ""}`}>
        {section.label}
      </td>
      {months.map((m) => {
        const v = Number(section.monthlyTotals?.[m] || 0);
        return (
          <td key={m} className={`px-3 py-2 text-right text-[12px] tabular-nums font-bold ${v < 0 ? "text-status-error" : "text-text-primary"}`}>
            {formatCurrency(v)}
          </td>
        );
      })}
    </tr>
  );
}

export default function ManualProfitLossMonthlyDetail({
  data,
  title = "Profit and Loss",
  subtitle = "",
  entityName = "Company",
  isPreview = false,
  selectedMonths = [],
}) {
  const year = data?.year || null;
  const allMonths = Array.isArray(data?.months) ? data.months : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  // In yearly mode columns are year numbers (>12); selectedMonths contains month numbers (1-12)
  // so the filter would incorrectly remove all columns — skip it in yearly mode.
  const isYearMode = allMonths.some((m) => m > 12);
  const months = (!isYearMode && selectedMonths && selectedMonths.length > 0)
    ? allMonths.filter((m) => selectedMonths.includes(m))
    : allMonths;
  const sections = Array.isArray(data?.sections) ? data.sections : [];
  const monthNames = data?.monthNames || ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const firstMonth = months.length > 0 ? months[0] : 1;
  const lastMonth = months.length > 0 ? months[months.length - 1] : 12;

  let fallbackSubtitle;
  if (isYearMode) {
    fallbackSubtitle = firstMonth === lastMonth
      ? `FY ${firstMonth}`
      : `FY ${firstMonth} – FY ${lastMonth}`;
  } else {
    fallbackSubtitle = year
      ? `${monthNames[firstMonth - 1] || ""} 1–${monthNames[lastMonth - 1] || ""} ${new Date(year, lastMonth, 0).getDate()}, ${year}`
      : "All Dates";
  }
  const displaySubtitle = subtitle === null ? null : (subtitle || fallbackSubtitle);

  const headScrollRef = useRef(null);
  const onBodyScroll = useCallback((e) => {
    if (headScrollRef.current) headScrollRef.current.scrollLeft = e.currentTarget.scrollLeft;
  }, []);

  if (!sections.length) {
    return (
      <div className={isPreview ? "py-8" : "bg-bg-page/50 p-10 font-inter"}>
        <div className="max-w-[1400px] mx-auto card-base p-10 min-h-[400px] flex items-center justify-center rounded-sm shadow-xl">
          <p className="text-text-muted italic text-[14px]">
            No Profit &amp; Loss data found. Select a fiscal year filter and re-generate.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={isPreview ? "" : "flex-1 bg-bg-page/50 p-6 lg:p-10 font-inter"}>
      <div className={isPreview ? "" : "max-w-[1600px] mx-auto card-base p-6 flex flex-col rounded-sm shadow-xl"}>

        {/* Report Header */}
        {!isPreview && (
          <div className="flex flex-col items-center mb-8 relative shrink-0">
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
        )}

        <div className="rounded-md border border-border">
          {/* Sticky header div — sticks to page top on vertical scroll; scroll synced from body via JS */}
          <div className="sticky top-0 z-20 bg-bg-page">
            <div ref={headScrollRef} className="overflow-x-hidden">
              <table className="w-full table-fixed border-collapse text-sm">
                <colgroup>
                  <col style={{ width: 220, minWidth: 220 }} />
                  {months.map((m) => <col key={m} style={{ width: 90, minWidth: 90 }} />)}
                  <col style={{ width: 100, minWidth: 100 }} />
                </colgroup>
                <thead>
                  <tr className="bg-bg-page">
                    <th className="bg-bg-page px-3 pt-2.5 pb-3 text-left text-[12px] font-semibold text-text-primary border-b-2 border-text-primary border-r border-border" />
                    {months.map((m) => (
                      <th key={m} className="bg-bg-page px-3 pt-2.5 pb-3 text-right text-[12px] font-semibold text-text-primary whitespace-nowrap border-b-2 border-text-primary">
                        {monthLabel(m, year)}
                      </th>
                    ))}
                    <th className="bg-bg-page px-3 pt-2.5 pb-3 text-right text-[12px] font-semibold text-text-primary border-b-2 border-text-primary">
                      Total
                    </th>
                  </tr>
                </thead>
              </table>
            </div>
          </div>
          {/* Body div — horizontal scroll synced to sticky header above */}
          <div className="overflow-x-auto" onScroll={onBodyScroll}>
            <table className="w-full table-fixed border-collapse text-sm">
              <colgroup>
                <col style={{ width: 220, minWidth: 220 }} />
                {months.map((m) => <col key={m} style={{ width: 90, minWidth: 90 }} />)}
                <col style={{ width: 100, minWidth: 100 }} />
              </colgroup>
              <tbody>
                {sections.map((section) =>
                  section.isCalculated ? (
                    <CalculatedRow key={section.key} section={section} months={months} />
                  ) : (
                    <SectionBlock key={section.key} section={section} months={months} />
                  )
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

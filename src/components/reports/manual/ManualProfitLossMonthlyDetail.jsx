import { useMemo, useState } from "react";
import { formatCurrency } from "../../../lib/utils";
import { ChevronRight, ChevronDown } from "lucide-react";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function colClass(value) {
  return `px-3 py-1.5 text-right text-[12px] tabular-nums ${Number(value) < 0 ? "text-status-error" : "text-text-secondary"}`;
}

function monthLabel(monthNum, year) {
  return `${MONTH_NAMES[monthNum - 1]}${year ? ` ${year}` : ""}`;
}

// Single account row
function AccountRow({ account, months, year }) {
  const [isOpen, setIsOpen] = useState(false);
  const hasTransactions = Array.isArray(account.transactions) && account.transactions.length > 0;

  // Group the account's transactions into per-vendor subtotals (vendor-level
  // total dollar amount), replacing the per-transaction detail. Sorted by the
  // largest absolute amount first.
  const vendorGroups = useMemo(() => {
    const map = new Map();
    (account.transactions || []).forEach((tx) => {
      const name = String(tx.vendorName || "").trim() || "No vendor / —";
      if (!map.has(name)) {
        map.set(name, { vendorName: name, amount: 0 });
      }
      const g = map.get(name);
      g.amount += Number(tx.amount || 0);
    });
    return Array.from(map.values()).sort(
      (a, b) => Math.abs(b.amount) - Math.abs(a.amount),
    );
  }, [account.transactions]);

  return (
    <>
      <tr
        className={`border-b border-border-light hover:bg-bg-page/30 cursor-pointer transition-colors ${isOpen ? "bg-bg-page/20" : ""}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <td className="px-3 py-1.5 pl-8 text-[12px] text-text-secondary">
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
        <td className={`px-3 py-1.5 text-right text-[12px] tabular-nums font-medium ${Number(account.total) < 0 ? "text-status-error" : "text-text-secondary"}`}>
          {formatCurrency(Number(account.total || 0))}
        </td>
      </tr>

      {isOpen && hasTransactions && (
        <tr>
          <td colSpan={months.length + 2} className="p-0">
            <div className="bg-bg-page/40 px-3 py-2 animate-in fade-in slide-in-from-top-1 duration-200">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border text-left text-[10px] text-text-muted uppercase tracking-wider">
                    <th className="px-2 py-1 font-semibold pl-12">Vendor / Payee</th>
                    <th className="px-2 py-1 font-semibold text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {vendorGroups.map((g, idx) => (
                    <tr key={g.vendorName || idx} className="border-b border-border/50 hover:bg-bg-card/50 transition-colors">
                      <td className="px-2 py-1 text-[11px] text-text-primary font-medium pl-12">{g.vendorName}</td>
                      <td className={`px-2 py-1 text-[11px] text-right font-medium ${g.amount < 0 ? "text-status-error" : "text-text-primary"}`}>
                        {formatCurrency(g.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// Section with accounts + subtotal row
function SectionBlock({ section, months, year }) {
  const hasAccounts = Array.isArray(section.accounts) && section.accounts.length > 0;

  return (
    <>
      {/* Section header */}
      <tr className="bg-bg-page/60 border-b border-border">
        <td className="px-3 py-2 text-[13px] font-semibold text-text-primary" colSpan={months.length + 2}>
          {section.label}
        </td>
      </tr>

      {/* Account rows */}
      {hasAccounts && section.accounts.map((acc) => (
        <AccountRow key={`${acc.accountNumber}::${acc.accountName}`} account={acc} months={months} year={year} />
      ))}

      {/* Section subtotal */}
      {hasAccounts && (
        <tr className="border-b border-border bg-bg-page/30">
          <td className="px-3 py-1.5 pl-6 text-[12px] font-semibold text-text-primary italic">
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
          <td className={`px-3 py-1.5 text-right text-[12px] tabular-nums font-semibold ${Number(section.total) < 0 ? "text-status-error" : "text-text-primary"}`}>
            {formatCurrency(Number(section.total || 0))}
          </td>
        </tr>
      )}
    </>
  );
}

// Calculated summary row (Gross Profit, Net Operating Income, Net Income)
function CalculatedRow({ section, months }) {
  const isNetIncome = section.key === "net_income";
  const rowClass = isNetIncome
    ? "border-t-2 border-text-primary bg-bg-page/80"
    : "border-b border-border bg-bg-page/40";

  return (
    <tr className={rowClass}>
      <td className={`px-3 py-2 text-[13px] font-bold text-text-primary${isNetIncome ? " text-[14px]" : ""}`}>
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
      <td className={`px-3 py-2 text-right text-[12px] tabular-nums font-bold ${Number(section.total) < 0 ? "text-status-error" : "text-text-primary"}`}>
        {formatCurrency(Number(section.total || 0))}
      </td>
    </tr>
  );
}

export default function ManualProfitLossMonthlyDetail({
  data,
  title = "Profit and Loss",
  subtitle = "",
  entityName = "Company",
  selectedMonths = [],
}) {
  const year = data?.year || null;
  // The backend already filters to the selected months; just use data.months directly.
  const months = Array.isArray(data?.months) ? data.months : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const sections = Array.isArray(data?.sections) ? data.sections : [];
  const monthNames = data?.monthNames || ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const firstMonth = months.length > 0 ? months[0] : 1;
  const lastMonth = months.length > 0 ? months[months.length - 1] : 12;
  const fallbackSubtitle = year
    ? `${monthNames[firstMonth - 1]} 1–${monthNames[lastMonth - 1]} ${new Date(year, lastMonth, 0).getDate()}, ${year}`
    : "All Dates";
  const displaySubtitle = subtitle || fallbackSubtitle;

  if (!sections.length) {
    return (
      <div className="flex-1 overflow-y-auto bg-bg-page/50 p-10 font-inter">
        <div className="max-w-[1400px] mx-auto card-base p-10 min-h-[400px] flex items-center justify-center rounded-sm shadow-xl">
          <p className="text-text-muted italic text-[14px]">
            No Profit &amp; Loss data found. Select a fiscal year filter and re-generate.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-bg-page/50 p-6 lg:p-10 font-inter">
      <div className="max-w-[1600px] mx-auto card-base p-6 min-h-[900px] flex flex-col rounded-sm shadow-xl">

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

        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              {/* Heavy divider lives on the cells (not the <tr>): a border-b on a
                  sticky row with border-collapse renders through/over the labels,
                  which made the dates overlap the line. */}
              <tr className="bg-bg-page sticky top-0 z-10">
                <th className="px-3 pt-2.5 pb-3 text-left text-[12px] font-semibold text-text-primary min-w-[220px] border-b-2 border-text-primary" />
                {months.map((m) => (
                  <th key={m} className="px-3 pt-2.5 pb-3 text-right text-[12px] font-semibold text-text-primary whitespace-nowrap min-w-[90px] border-b-2 border-text-primary">
                    {monthLabel(m, year)}
                  </th>
                ))}
                <th className="px-3 pt-2.5 pb-3 text-right text-[12px] font-semibold text-text-primary min-w-[100px] border-b-2 border-text-primary">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {sections.map((section) =>
                section.isCalculated ? (
                  <CalculatedRow key={section.key} section={section} months={months} />
                ) : (
                  <SectionBlock key={section.key} section={section} months={months} year={year} />
                )
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

import { formatCurrency } from "../../../lib/utils";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function colClass(value) {
  return `px-3 py-1.5 text-right text-[12px] tabular-nums ${Number(value) < 0 ? "text-status-error" : "text-text-secondary"}`;
}

function monthLabel(monthNum, year) {
  return `${MONTH_NAMES[monthNum - 1]}${year ? ` ${year}` : ""}`;
}

// Single account row
function AccountRow({ account, months, year }) {
  return (
    <tr className="border-b border-border-light hover:bg-bg-page/30">
      <td className="px-3 py-1.5 pl-8 text-[12px] text-text-secondary">{account.accountName}</td>
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
  entityName = "Company",
}) {
  const year = data?.year || null;
  const months = Array.isArray(data?.months) ? data.months : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const sections = Array.isArray(data?.sections) ? data.sections : [];

  const subtitle = year
    ? `January 1–December 31, ${year}`
    : "All Dates";

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
        <div className="flex flex-col items-center mb-8">
          <h1 className="text-[20px] font-bold text-text-primary tracking-tight">{entityName}</h1>
          <h2 className="text-[17px] font-semibold text-text-secondary mt-1">{title}</h2>
          <p className="text-[13px] text-text-muted mt-1">{subtitle}</p>
        </div>

        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b-2 border-text-primary bg-bg-page sticky top-0 z-10">
                <th className="px-3 py-2.5 text-left text-[12px] font-semibold text-text-primary min-w-[220px]" />
                {months.map((m) => (
                  <th key={m} className="px-3 py-2.5 text-right text-[12px] font-semibold text-text-primary whitespace-nowrap min-w-[90px]">
                    {monthLabel(m, year)}
                  </th>
                ))}
                <th className="px-3 py-2.5 text-right text-[12px] font-semibold text-text-primary min-w-[100px]">
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

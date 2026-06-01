import { formatCurrency } from "../../../lib/utils";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabel(monthNum, year) {
  return `${MONTH_NAMES[monthNum - 1]}${year ? ` ${year}` : ""}`;
}

function colClass(value) {
  return `px-3 py-1.5 text-right text-[12px] tabular-nums ${Number(value) < 0 ? "text-status-error" : "text-text-secondary"}`;
}

function AccountRow({ account, months }) {
  return (
    <tr className="border-b border-border-light hover:bg-bg-page/30">
      <td className="px-3 py-1.5 pl-10 text-[12px] text-text-secondary">{account.name}</td>
      {months.map((m) => {
        const v = Number(account.monthly?.[m] || 0);
        return <td key={m} className={colClass(v)}>{formatCurrency(v)}</td>;
      })}
      <td className={`px-3 py-1.5 text-right text-[12px] tabular-nums font-medium ${Number(account.total) < 0 ? "text-status-error" : "text-text-secondary"}`}>
        {formatCurrency(Number(account.total || 0))}
      </td>
    </tr>
  );
}

function CategoryBlock({ category, months }) {
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
        <AccountRow key={`${acc.number}::${acc.name}`} account={acc} months={months} />
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
        <td className={`px-3 py-1.5 text-right text-[12px] tabular-nums font-semibold ${Number(category.total) < 0 ? "text-status-error" : "text-text-primary"}`}>
          {formatCurrency(Number(category.total || 0))}
        </td>
      </tr>
    </>
  );
}

function SectionBlock({ sectionKey, section, months }) {
  const totalLabel = sectionKey === "Assets" ? "Total Assets"
    : sectionKey === "Liabilities" ? "Total Liabilities"
      : "Total Equity";

  return (
    <>
      <tr className="bg-bg-page/70 border-b border-border">
        <td className="px-3 py-2 text-[13px] font-bold text-text-primary" colSpan={months.length + 2}>
          {section.label}
        </td>
      </tr>
      {(section.categories || []).map((cat) => (
        <CategoryBlock key={cat.label} category={cat} months={months} />
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
        <td className={`px-3 py-2 text-right text-[12px] tabular-nums font-bold ${Number(section.total) < 0 ? "text-status-error" : "text-text-primary"}`}>
          {formatCurrency(Number(section.total || 0))}
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
}) {
  const year = data?.year || null;
  const months = Array.isArray(data?.months) ? data.months : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const sections = data?.sections || {};
  const hasSections = Object.keys(sections).length > 0;

  const lastMonth = months.length > 0 ? months[months.length - 1] : 12;
  const monthNames = data?.monthNames || ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const lastMonthName = monthNames[lastMonth - 1] || "Dec";
  const lastDayOfMonth = year ? new Date(year, lastMonth, 0).getDate() : 31;
  const fallbackSubtitle = year
    ? `As of ${lastMonthName} ${lastDayOfMonth}, ${year}`
    : "All Dates";
  const displaySubtitle = subtitle || fallbackSubtitle;

  if (!hasSections) {
    return (
      <div className="flex-1 overflow-y-auto bg-bg-page/50 p-10 font-inter">
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
  const totalLETotal = (liabSection.total || 0) + (eqSection.total || 0);

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

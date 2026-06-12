import { formatCurrency, formatNumber } from "../../../lib/utils";

function formatMetric(metric) {
  return String(metric || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function ManualProfitLossSummary({
  data,
  title = "Profit & Loss",
  subtitle = "",
  entityName = "Company",
}) {
  const years = Array.isArray(data?.years) ? data.years : [];
  const lines = Array.isArray(data?.lines) ? data.lines : [];
  const monthlyBreakdown = Array.isArray(data?.monthlyBreakdown)
    ? data.monthlyBreakdown
    : [];
  const yearComparison = Array.isArray(data?.yearComparison)
    ? data.yearComparison
    : [];

  return (
    <div className="flex-1 overflow-y-auto bg-bg-page/50 p-10 lg:p-16 font-inter">
      <div className="max-w-[1200px] mx-auto card-base p-10 min-h-[900px] flex flex-col rounded-sm shadow-xl">
        <div className="flex flex-col items-center mb-10 relative">
          <div className="w-12 h-1 bg-primary rounded-full mb-6" />
          <h1 className="text-[22px] font-bold text-text-primary tracking-tight leading-none mb-2">
            {entityName}
          </h1>
          <h2 className="text-[18px] font-medium text-text-secondary mb-4">{title}</h2>
          {subtitle ? (
            <div className="flex items-center gap-3 text-[12px] text-text-muted bg-bg-page px-4 py-1.5 rounded-full border border-border">
              <span>{subtitle}</span>
            </div>
          ) : null}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-bg-page sticky top-0 z-10">
                <th className="pt-2.5 pb-4 px-4 text-left text-[12px] font-medium text-text-muted uppercase tracking-wider border-b-2 border-text-primary">
                  Metric
                </th>
                {years.map((year) => (
                  <th
                    key={`year-${year}`}
                    className="pt-2.5 pb-4 px-4 text-right text-[12px] font-medium text-text-muted uppercase tracking-wider border-b-2 border-text-primary"
                  >
                    FY {year}
                  </th>
                ))}
                <th className="pt-2.5 pb-4 px-4 text-right text-[12px] font-semibold text-text-primary uppercase tracking-wider border-b-2 border-text-primary">
                  Consolidated
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.key} className="border-b border-border-light">
                  <td className="px-4 py-3 text-[14px] font-medium text-text-primary">
                    {line.label || formatMetric(line.key)}
                  </td>
                  {years.map((year) => {
                    const value = Number(line?.valuesByYear?.[year] || 0);
                    return (
                      <td
                        key={`${line.key}-${year}`}
                        className={`px-4 py-3 text-right text-[14px] tabular-nums ${value < 0 ? "text-status-error font-semibold" : "text-text-secondary"}`}
                      >
                        {formatCurrency(value)}
                      </td>
                    );
                  })}
                  <td className="px-4 py-3 text-right text-[14px] font-semibold text-text-primary tabular-nums">
                    {formatCurrency(Number(line?.consolidated || 0))}
                  </td>
                </tr>
              ))}
              {!lines.length ? (
                <tr>
                  <td
                    colSpan={Math.max(2, years.length + 2)}
                    className="py-16 text-center text-text-muted italic"
                  >
                    No staged Profit & Loss data found for the selected filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {yearComparison.length ? (
          <div className="mt-10">
            <h3 className="text-[14px] font-semibold text-text-primary mb-3">
              Year Comparison
            </h3>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-bg-page border-b border-border">
                    <th className="px-3 py-2 text-left text-[12px] font-medium text-text-muted">Year</th>
                    <th className="px-3 py-2 text-right text-[12px] font-medium text-text-muted">Revenue</th>
                    <th className="px-3 py-2 text-right text-[12px] font-medium text-text-muted">Net Profit</th>
                    <th className="px-3 py-2 text-right text-[12px] font-medium text-text-muted">YoY Delta</th>
                    <th className="px-3 py-2 text-right text-[12px] font-medium text-text-muted">YoY %</th>
                  </tr>
                </thead>
                <tbody>
                  {yearComparison.map((row) => (
                    <tr key={`cmp-${row.fiscalYear}`} className="border-b border-border-light">
                      <td className="px-3 py-2 text-[13px] text-text-primary font-medium">FY {row.fiscalYear}</td>
                      <td className="px-3 py-2 text-right text-[13px] text-text-secondary tabular-nums">
                        {formatCurrency(Number(row.revenue || 0))}
                      </td>
                      <td className="px-3 py-2 text-right text-[13px] text-text-secondary tabular-nums">
                        {formatCurrency(Number(row.netProfit || 0))}
                      </td>
                      <td className={`px-3 py-2 text-right text-[13px] tabular-nums ${Number(row.netProfitDeltaVsPreviousYear || 0) < 0 ? "text-status-error" : "text-text-secondary"}`}>
                        {formatCurrency(Number(row.netProfitDeltaVsPreviousYear || 0))}
                      </td>
                      <td className="px-3 py-2 text-right text-[13px] text-text-secondary tabular-nums">
                        {row.netProfitDeltaPctVsPreviousYear === null || row.netProfitDeltaPctVsPreviousYear === undefined
                          ? "-"
                          : `${formatNumber(row.netProfitDeltaPctVsPreviousYear, 2)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {monthlyBreakdown.length ? (
          <div className="mt-10">
            <h3 className="text-[14px] font-semibold text-text-primary mb-3">
              Monthly Breakdown
            </h3>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-bg-page border-b border-border">
                    <th className="px-3 py-2 text-left text-[12px] font-medium text-text-muted">Month</th>
                    <th className="px-3 py-2 text-right text-[12px] font-medium text-text-muted">Revenue</th>
                    <th className="px-3 py-2 text-right text-[12px] font-medium text-text-muted">COGS</th>
                    <th className="px-3 py-2 text-right text-[12px] font-medium text-text-muted">Gross Profit</th>
                    <th className="px-3 py-2 text-right text-[12px] font-medium text-text-muted">Operating Expenses</th>
                    <th className="px-3 py-2 text-right text-[12px] font-medium text-text-muted">Other Expenses</th>
                    <th className="px-3 py-2 text-right text-[12px] font-medium text-text-muted">Net Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyBreakdown.map((row) => (
                    <tr key={`month-${row.month}`} className="border-b border-border-light">
                      <td className="px-3 py-2 text-[13px] text-text-primary font-medium">{row.month}</td>
                      <td className="px-3 py-2 text-right text-[13px] text-text-secondary tabular-nums">{formatCurrency(Number(row.Revenue || 0))}</td>
                      <td className="px-3 py-2 text-right text-[13px] text-text-secondary tabular-nums">{formatCurrency(Number(row.COGS || 0))}</td>
                      <td className="px-3 py-2 text-right text-[13px] text-text-secondary tabular-nums">{formatCurrency(Number(row["Gross Profit"] || 0))}</td>
                      <td className="px-3 py-2 text-right text-[13px] text-text-secondary tabular-nums">{formatCurrency(Number(row["Operating Expenses"] || 0))}</td>
                      <td className="px-3 py-2 text-right text-[13px] text-text-secondary tabular-nums">{formatCurrency(Number(row["Other Expenses"] || 0))}</td>
                      <td className={`px-3 py-2 text-right text-[13px] tabular-nums ${Number(row["Net Profit"] || 0) < 0 ? "text-status-error font-semibold" : "text-text-secondary"}`}>
                        {formatCurrency(Number(row["Net Profit"] || 0))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

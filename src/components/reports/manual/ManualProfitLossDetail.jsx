import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatCurrency } from "../../../lib/utils";

function AccountRow({ account, years, onToggle, isOpen }) {
  return (
    <>
      <tr
        onClick={() => onToggle(account.accountNumber, account.accountName)}
        className="cursor-pointer border-b border-border-light hover:bg-bg-page/40"
      >
        <td className="px-3 py-2 text-[13px] text-text-primary font-medium">
          <div className="flex items-center gap-1">
            {isOpen ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
            <span>{account.accountName}</span>
          </div>
        </td>
        <td className="px-3 py-2 text-[12px] text-text-muted">{account.accountNumber || "-"}</td>
        <td className="px-3 py-2 text-[12px] text-text-muted">{account.subCategory || "-"}</td>
        {years.map((year) => (
          <td key={`${account.accountName}-${year}`} className="px-3 py-2 text-right text-[13px] tabular-nums text-text-secondary">
            {formatCurrency(Number(account.yearlyTotals?.[year] || 0))}
          </td>
        ))}
        <td className={`px-3 py-2 text-right text-[13px] tabular-nums font-semibold ${Number(account.totalNet || 0) < 0 ? "text-status-error" : "text-text-primary"}`}>
          {formatCurrency(Number(account.totalNet || 0))}
        </td>
      </tr>
      {isOpen ? (
        <tr className="bg-bg-page/30">
          <td colSpan={years.length + 4} className="px-4 py-3">
            <div className="overflow-x-auto rounded-md border border-border bg-white">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border bg-bg-page">
                    <th className="px-2 py-2 text-left text-[11px] text-text-muted">Date</th>
                    <th className="px-2 py-2 text-left text-[11px] text-text-muted">Journal Type</th>
                    <th className="px-2 py-2 text-left text-[11px] text-text-muted">Reference</th>
                    <th className="px-2 py-2 text-left text-[11px] text-text-muted">Description</th>
                    <th className="px-2 py-2 text-left text-[11px] text-text-muted">Department</th>
                    <th className="px-2 py-2 text-left text-[11px] text-text-muted">Class</th>
                    <th className="px-2 py-2 text-left text-[11px] text-text-muted">Location</th>
                    <th className="px-2 py-2 text-right text-[11px] text-text-muted">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {(account.transactions || []).map((tx) => (
                    <tr key={tx.transactionId} className="border-b border-border-light">
                      <td className="px-2 py-1.5 text-[12px] text-text-secondary">{tx.date || "-"}</td>
                      <td className="px-2 py-1.5 text-[12px] text-text-secondary">{tx.journalType || tx.transactionType || "-"}</td>
                      <td className="px-2 py-1.5 text-[12px] text-text-secondary">{tx.reference || "-"}</td>
                      <td className="px-2 py-1.5 text-[12px] text-text-secondary">{tx.description || "-"}</td>
                      <td className="px-2 py-1.5 text-[12px] text-text-secondary">{tx.department || "-"}</td>
                      <td className="px-2 py-1.5 text-[12px] text-text-secondary">{tx.class || "-"}</td>
                      <td className="px-2 py-1.5 text-[12px] text-text-secondary">{tx.location || "-"}</td>
                      <td className={`px-2 py-1.5 text-right text-[12px] tabular-nums ${Number(tx.signedAmount || 0) < 0 ? "text-status-error" : "text-text-secondary"}`}>
                        {formatCurrency(Number(tx.signedAmount || 0))}
                      </td>
                    </tr>
                  ))}
                  {!(account.transactions || []).length ? (
                    <tr>
                      <td colSpan={8} className="px-2 py-4 text-center text-[12px] text-text-muted italic">
                        No transactions available.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export default function ManualProfitLossDetail({
  data,
  title = "Profit & Loss Detail",
  subtitle = "",
  entityName = "Company",
}) {
  const years = useMemo(
    () => (Array.isArray(data?.years) ? data.years : []),
    [data?.years],
  );
  const categories = Array.isArray(data?.categories) ? data.categories : [];
  const monthlyBreakdown = Array.isArray(data?.monthlyBreakdown)
    ? data.monthlyBreakdown
    : [];

  const [openAccounts, setOpenAccounts] = useState(() => new Set());

  const toggleAccount = (accountNumber, accountName) => {
    const key = `${accountNumber || ""}::${accountName || ""}`;
    setOpenAccounts((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="flex-1 overflow-y-auto bg-bg-page/50 p-10 lg:p-16 font-inter">
      <div className="max-w-[1300px] mx-auto card-base p-10 min-h-[900px] flex flex-col rounded-sm shadow-xl">
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

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-bg-page border-b border-border">
                <th className="px-3 py-2 text-left text-[12px] font-medium text-text-muted">Account</th>
                <th className="px-3 py-2 text-left text-[12px] font-medium text-text-muted">Account #</th>
                <th className="px-3 py-2 text-left text-[12px] font-medium text-text-muted">Subcategory</th>
                {years.map((year) => (
                  <th key={`year-${year}`} className="px-3 py-2 text-right text-[12px] font-medium text-text-muted">
                    FY {year}
                  </th>
                ))}
                <th className="px-3 py-2 text-right text-[12px] font-semibold text-text-primary">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {categories.map((category) => (
                <Fragment key={`cat-${category.category}`}>
                  <tr className="bg-bg-page/50 border-b border-border">
                    <td className="px-3 py-2 text-[13px] font-semibold text-text-primary" colSpan={3}>
                      {category.category}
                    </td>
                    {years.map((year) => (
                      <td key={`cat-${category.category}-${year}`} className="px-3 py-2 text-right text-[13px] font-semibold text-text-secondary tabular-nums">
                        {formatCurrency(Number(category.totalsByYear?.[year] || 0))}
                      </td>
                    ))}
                    <td className={`px-3 py-2 text-right text-[13px] font-semibold tabular-nums ${Number(category.total || 0) < 0 ? "text-status-error" : "text-text-primary"}`}>
                      {formatCurrency(Number(category.total || 0))}
                    </td>
                  </tr>
                  {(category.accounts || []).map((account) => {
                    const key = `${account.accountNumber || ""}::${account.accountName || ""}`;
                    return (
                      <AccountRow
                        key={key}
                        account={account}
                        years={years}
                        isOpen={openAccounts.has(key)}
                        onToggle={toggleAccount}
                      />
                    );
                  })}
                </Fragment>
              ))}
              {!categories.length ? (
                <tr>
                  <td colSpan={Math.max(5, years.length + 4)} className="px-3 py-16 text-center text-text-muted italic">
                    No staged detailed Profit & Loss data found for the selected filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {monthlyBreakdown.length ? (
          <div className="mt-8">
            <h3 className="text-[14px] font-semibold text-text-primary mb-2">Monthly Totals</h3>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-bg-page border-b border-border">
                    <th className="px-3 py-2 text-left text-[12px] text-text-muted">Month</th>
                    <th className="px-3 py-2 text-right text-[12px] text-text-muted">Revenue</th>
                    <th className="px-3 py-2 text-right text-[12px] text-text-muted">COGS</th>
                    <th className="px-3 py-2 text-right text-[12px] text-text-muted">Operating Expenses</th>
                    <th className="px-3 py-2 text-right text-[12px] text-text-muted">Other Expenses</th>
                    <th className="px-3 py-2 text-right text-[12px] text-text-muted">Net Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyBreakdown.map((row) => (
                    <tr key={row.month} className="border-b border-border-light">
                      <td className="px-3 py-2 text-[12px] text-text-primary">{row.month}</td>
                      <td className="px-3 py-2 text-right text-[12px] text-text-secondary tabular-nums">{formatCurrency(Number(row.Revenue || 0))}</td>
                      <td className="px-3 py-2 text-right text-[12px] text-text-secondary tabular-nums">{formatCurrency(Number(row.COGS || 0))}</td>
                      <td className="px-3 py-2 text-right text-[12px] text-text-secondary tabular-nums">{formatCurrency(Number(row["Operating Expenses"] || 0))}</td>
                      <td className="px-3 py-2 text-right text-[12px] text-text-secondary tabular-nums">{formatCurrency(Number(row["Other Expenses"] || 0))}</td>
                      <td className={`px-3 py-2 text-right text-[12px] tabular-nums ${Number(row["Net Profit"] || 0) < 0 ? "text-status-error" : "text-text-secondary"}`}>
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

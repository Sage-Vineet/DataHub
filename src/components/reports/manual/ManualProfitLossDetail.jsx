import { Fragment, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
} from "lucide-react";
import { cn } from "../../../lib/utils";

function formatCurrency(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount || 0);
}

function AccountRow({ account, years, isOpen, onToggle }) {
  const accountKey = `${account.accountNumber || ""}::${account.accountName || ""}`;

  return (
    <Fragment>
      <tr
        className={cn(
          "border-b border-border hover:bg-bg-card/50 transition-colors cursor-pointer group",
          isOpen && "bg-bg-card/30"
        )}
        onClick={() => onToggle(account.accountNumber, account.accountName)}
      >
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            {isOpen ? (
              <ChevronDown size={14} className="text-text-muted group-hover:text-primary transition-colors" />
            ) : (
              <ChevronRight size={14} className="text-text-muted group-hover:text-primary transition-colors" />
            )}
            <span className="text-[13px] font-medium text-text-primary">
              {account.accountName || "Unnamed Account"}
            </span>
          </div>
        </td>
        <td className="px-3 py-2.5 text-[12px] text-text-muted font-mono">
          {account.accountNumber || "-"}
        </td>
        <td className="px-3 py-2.5 text-[12px] text-text-muted">
          {account.subcategory || "-"}
        </td>
        {years.map((year) => (
          <td key={`val-${year}`} className="px-3 py-2.5 text-right text-[12px] text-text-secondary tabular-nums">
            {formatCurrency(Number(account.yearlyTotals?.[year] || 0))}
          </td>
        ))}
        <td className={cn(
          "px-3 py-2.5 text-right text-[13px] font-semibold tabular-nums",
          Number(account.totalAmount || 0) < 0 ? "text-status-error" : "text-text-primary"
        )}>
          {formatCurrency(Number(account.totalAmount || 0))}
        </td>
      </tr>

      {isOpen && (
        <tr>
          <td colSpan={years.length + 4} className="px-0 py-0 bg-bg-page/50">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border text-left text-[10px] text-text-muted uppercase tracking-wider">
                    <th className="px-3 py-2 font-semibold pl-12">Date</th>
                    <th className="px-3 py-2 font-semibold">Vendor / Payee</th>
                    <th className="px-3 py-2 font-semibold">Description</th>
                    <th className="px-3 py-2 font-semibold text-right">Debit</th>
                    <th className="px-3 py-2 font-semibold text-right">Credit</th>
                    <th className="px-3 py-2 font-semibold text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {(account.transactions || []).map((tx, idx) => (
                    <tr key={tx.id || idx} className="border-b border-border/50 hover:bg-bg-card/50 transition-colors">
                      <td className="px-3 py-2 text-[12px] text-text-secondary pl-12">
                        {tx.date || tx.transactionDate || "-"}
                      </td>
                      <td className="px-3 py-2 text-[12px] text-text-primary font-medium">
                        {tx.vendorName || "-"}
                      </td>
                      <td className="px-3 py-2 text-[12px] text-text-muted max-w-[300px] truncate" title={tx.description}>
                        {tx.description || "-"}
                      </td>
                      <td className="px-3 py-2 text-[12px] text-text-secondary text-right">
                        {tx.debit ? formatCurrency(tx.debit) : ""}
                      </td>
                      <td className="px-3 py-2 text-[12px] text-text-secondary text-right">
                        {tx.credit ? formatCurrency(tx.credit) : ""}
                      </td>
                      <td className={cn(
                        "px-3 py-2 text-[12px] text-right font-medium",
                        Number(tx.amount || 0) < 0 ? "text-status-error" : "text-text-primary"
                      )}>
                        {formatCurrency(Number(tx.amount || 0))}
                      </td>
                    </tr>
                  ))}
                  {(!account.transactions || account.transactions.length === 0) && (
                    <tr>
                      <td colSpan={6} className="px-3 py-4 text-center text-text-muted italic text-[12px]">
                        No transactions found for this account.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export default function ManualProfitLossDetail({
  data,
  title = "Profit & Loss Detail",
  subtitle,
  entityName = "Company",
}) {
  const years = Array.isArray(data?.years) ? data.years : [];
  const categories = Array.isArray(data?.categories) ? data.categories : [];

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
          {subtitle && (
            <div className="flex items-center gap-3 text-[12px] text-text-muted bg-bg-page px-4 py-1.5 rounded-full border border-border">
              <span>{subtitle}</span>
            </div>
          )}
        </div>

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-bg-page border-b border-border">
                <th className="px-3 py-3 text-left text-[12px] font-medium text-text-muted uppercase tracking-wider">
                  Account
                </th>
                <th className="px-3 py-3 text-left text-[12px] font-medium text-text-muted uppercase tracking-wider">Account #</th>
                <th className="px-3 py-3 text-left text-[12px] font-medium text-text-muted uppercase tracking-wider">Subcategory</th>
                {years.map((year) => (
                  <th key={`year-${year}`} className="px-3 py-3 text-right text-[12px] font-medium text-text-muted uppercase tracking-wider">
                    FY {year}
                  </th>
                ))}
                <th className="px-3 py-3 text-right text-[12px] font-semibold text-text-primary uppercase tracking-wider">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {categories.map((category) => {
                const sectionKey = category.category;
                const sectionTotal = Number(
                  category.total ??
                  category.totalAmount ??
                  years.reduce((sum, year) => sum + Number(category.totalsByYear?.[year] || 0), 0),
                );

                return (
                  <Fragment key={`sec-${sectionKey}`}>
                    <tr className="bg-bg-page/50 border-b border-border">
                      <td className="px-3 py-3 text-[14px] font-bold text-primary italic" colSpan={3}>
                        {sectionKey}
                      </td>
                      {years.map((year) => (
                        <td key={`sec-${sectionKey}-${year}`} className="px-3 py-3 text-right text-[13px] font-bold text-text-secondary tabular-nums">
                          {formatCurrency(Number(category.totalsByYear?.[year] || 0))}
                        </td>
                      ))}
                      <td className={cn(
                        "px-3 py-3 text-right text-[13px] font-bold tabular-nums",
                        sectionTotal < 0 ? "text-status-error" : "text-text-primary"
                      )}>
                        {formatCurrency(sectionTotal)}
                      </td>
                    </tr>
                    {(category.accounts || []).map((account) => (
                      <AccountRow
                        key={`${account.accountNumber || ""}::${account.accountName || ""}`}
                        account={account}
                        years={years}
                        isOpen={openAccounts.has(`${account.accountNumber || ""}::${account.accountName || ""}`)}
                        onToggle={toggleAccount}
                      />
                    ))}
                  </Fragment>
                );
              })}
              {categories.length === 0 && (
                <tr>
                  <td colSpan={years.length + 4} className="px-3 py-20 text-center text-text-muted italic">
                    <div className="flex flex-col items-center gap-2">
                      <FileText size={40} className="text-border mb-2" />
                      <span>No detailed report data found for the selected filters.</span>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { buildDetailPreview } from "../../../lib/detail-preview";
import { cn, formatCurrency } from "../../../lib/utils";

function TransactionRow({ transaction }) {
  return (
    <tr className="border-b border-border-light transition-colors hover:bg-bg-page/50">
      <td className="min-w-[100px] px-4 py-2.5 text-[13px] text-text-secondary">{transaction.date}</td>
      <td className="px-4 py-2.5 text-[13px] font-medium text-text-secondary">{transaction.type}</td>
      <td className="px-4 py-2.5 text-[13px] text-text-secondary">{transaction.num}</td>
      <td className="px-4 py-2.5 text-[13px] font-semibold text-text-primary">{transaction.name}</td>
      <td className="max-w-[200px] truncate px-4 py-2.5 text-[13px] text-text-muted">{transaction.memo}</td>
      <td className="px-4 py-2.5 text-[13px] text-text-muted">{transaction.split}</td>
      <td
        className={cn(
          "min-w-[110px] px-4 py-2.5 text-right text-[14px] font-semibold tabular-nums",
          Number(transaction.amount) < 0 ? "text-status-error" : "text-text-primary",
        )}
      >
        {formatCurrency(transaction.amount)}
      </td>
      <td
        className={cn(
          "min-w-[110px] px-4 py-2.5 text-right text-[14px] font-medium tabular-nums",
          Number(transaction.balance) < 0 ? "text-status-error" : "text-text-primary",
        )}
      >
        {formatCurrency(transaction.balance)}
      </td>
    </tr>
  );
}

function AccountSection({ account }) {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <>
      <tr
        onClick={() => setIsOpen((previous) => !previous)}
        className="cursor-pointer border-b border-border-light bg-bg-page/30 transition-colors hover:bg-bg-page/50"
      >
        <td colSpan={6} className="px-4 py-3">
          <div className="ml-4 flex items-center gap-2">
            {isOpen ? (
              <ChevronDown size={14} className="text-text-muted" />
            ) : (
              <ChevronRight size={14} className="text-text-muted" />
            )}
            <span className="text-[14px] font-semibold text-text-primary">{account.name}</span>
          </div>
        </td>
        <td colSpan={2} />
      </tr>

      {isOpen
        ? account.transactions.map((transaction) => (
            <TransactionRow key={transaction.id} transaction={transaction} />
          ))
        : null}

      {isOpen ? (
        <tr className="border-b border-border-light bg-bg-page/10">
          <td colSpan={6} className="px-4 py-3 text-right">
            <span className="text-[12px] font-medium italic text-text-muted">
              Total for {account.name}
            </span>
          </td>
          <td
            className={cn(
              "border-t border-border px-4 py-3 text-right text-[14px] font-semibold tabular-nums",
              Number(account.total) < 0 ? "text-status-error" : "text-text-primary",
            )}
          >
            {formatCurrency(account.total)}
          </td>
          <td />
        </tr>
      ) : null}
    </>
  );
}

export default function ReportDetailView({ data, title, subtitle, sourceLabel }) {
  const { previewData, totalRecords, visibleRecords, isTruncated } =
    buildDetailPreview(data);

  return (
    <div className="flex-1 overflow-y-auto bg-bg-page/50 p-6 lg:p-10">
      <div className="mx-auto flex min-h-[1000px] max-w-6xl flex-col rounded-sm border border-border bg-bg-card shadow-card-hover transition-all">
        <div className="relative mb-8 flex flex-col items-center overflow-hidden border-b border-border/60 py-12">
          <div className="absolute left-0 top-0 h-1 w-full bg-primary" />
          <h1 className="mb-1 text-[20px] font-bold text-text-primary">Sage Healthy RCM, LLC</h1>
          <h2 className="mb-4 text-[18px] font-medium text-text-secondary">{title} Detail</h2>
          <div className="flex items-center gap-3 rounded-full border border-border bg-bg-page px-4 py-1.5 text-[12px] text-text-muted">
            <span>{subtitle}</span>
            <div className="h-1 w-1 rounded-full bg-border" />
            <span>Detailed Basis</span>
          </div>
        </div>

        <div className="flex items-center justify-between px-8 pb-6">
          <div className="flex items-center gap-3">
            <span className="text-[13px] font-medium text-text-muted">Transactions:</span>
            <span className="rounded-md border border-border bg-bg-page px-2 py-0.5 text-[13px] font-semibold text-text-primary">
              {isTruncated ? `${visibleRecords} of ${totalRecords}` : totalRecords}
            </span>
          </div>
          <button className="text-[13px] font-medium text-primary transition-colors hover:text-primary-dark">
            Expand All Groups
          </button>
        </div>

        <div className="flex-1 overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10 bg-text-primary text-white">
              <tr>
                <th className="px-4 py-3.5 text-left text-[12px] font-medium uppercase tracking-wider">Date</th>
                <th className="px-4 py-3.5 text-left text-[12px] font-medium uppercase tracking-wider">Type</th>
                <th className="px-4 py-3.5 text-left text-[12px] font-medium uppercase tracking-wider">Num</th>
                <th className="px-4 py-3.5 text-left text-[12px] font-medium uppercase tracking-wider">Name</th>
                <th className="px-4 py-3.5 text-left text-[12px] font-medium uppercase tracking-wider">Memo</th>
                <th className="px-4 py-3.5 text-left text-[12px] font-medium uppercase tracking-wider">Split</th>
                <th className="px-4 py-3.5 text-right text-[12px] font-medium uppercase tracking-wider">Amount</th>
                <th className="px-4 py-3.5 text-right text-[12px] font-medium uppercase tracking-wider">Balance</th>
              </tr>
            </thead>
            <tbody className="bg-bg-card">
              {previewData.groups.map((group) => (
                <Fragment key={group.id}>
                  <tr className="border-b border-border bg-bg-page/40">
                    <td colSpan={8} className="px-6 py-4">
                      <span className="text-[15px] font-bold text-text-primary">{group.name}</span>
                    </td>
                  </tr>
                  {group.accounts.map((account) => (
                    <AccountSection key={account.id} account={account} />
                  ))}
                  <tr className="border-b-2 border-text-primary bg-bg-page/60">
                    <td colSpan={6} className="px-6 py-4 text-right">
                      <span className="text-[14px] font-semibold text-text-primary">
                        Total for {group.name}
                      </span>
                    </td>
                    <td
                      className={cn(
                        "px-4 py-4 text-right text-[15px] font-bold tabular-nums",
                        Number(group.total) < 0 ? "text-status-error" : "text-text-primary",
                      )}
                    >
                      {formatCurrency(group.total)}
                    </td>
                    <td />
                  </tr>
                </Fragment>
              ))}
              {isTruncated ? (
                <tr className="border-t-2 border-amber-200 bg-amber-50">
                  <td colSpan={8} className="px-6 py-4 text-center text-[13px] font-medium text-amber-800">
                    report is too loong please download pdf
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="mt-auto border-t border-border bg-bg-page p-10 text-center">
          <p className="mb-4 text-[12px] font-medium text-text-muted">AccountHub Financial Intelligence Engine</p>
          <div className="flex items-center justify-center gap-8">
            <div className="flex flex-col items-center">
              <span className="text-[10px] uppercase tracking-wider text-text-muted">Audit Trail Status</span>
              <span className="text-[11px] font-semibold text-primary">Verified & Consolidated</span>
            </div>
            <div className="flex flex-col items-center">
              <span className="text-[10px] uppercase tracking-wider text-text-muted">Data Source</span>
              <span className="text-[11px] font-semibold text-text-primary">{sourceLabel}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import { buildDetailPreview } from "@/lib/detail-preview";
import {
  DetailedFinancialData,
  AccountDetail,
  Transaction,
} from "@/types/financial-details";

interface BalanceSheetDetailProps {
  data: DetailedFinancialData;
  title: string;
  subtitle: string;
}

function TransactionRow({ tx }: { tx: Transaction }) {
  return (
    <tr className="hover:bg-bg-page/50 border-b border-border-light transition-colors">
      <td className="py-2.5 px-4 text-[13px] text-text-secondary min-w-[100px]">{tx.date}</td>
      <td className="py-2.5 px-4 text-[13px] text-text-secondary font-medium">{tx.type}</td>
      <td className="py-2.5 px-4 text-[13px] text-text-secondary">{tx.num}</td>
      <td className="py-2.5 px-4 text-[13px] text-text-primary font-semibold">{tx.name}</td>
      <td className="py-2.5 px-4 text-[13px] text-text-muted max-w-[200px] truncate">{tx.memo}</td>
      <td className="py-2.5 px-4 text-[13px] text-text-muted">{tx.split}</td>
      <td className={cn(
        "py-2.5 px-4 text-[14px] text-right font-semibold tabular-nums min-w-[110px]",
        tx.amount < 0 ? "text-status-error" : "text-text-primary"
      )}>
        {formatCurrency(tx.amount)}
      </td>
      <td className={cn(
        "py-2.5 px-4 text-[14px] text-right font-medium tabular-nums min-w-[110px]",
        tx.balance < 0 ? "text-status-error" : "text-text-primary"
      )}>
        {formatCurrency(tx.balance)}
      </td>
    </tr>
  );
}

function AccountSection({ account }: { account: AccountDetail }) {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <>
      <tr
        onClick={() => setIsOpen((prev) => !prev)}
        className="cursor-pointer bg-bg-page/30 hover:bg-bg-page/50 transition-colors border-b border-border-light"
      >
        <td colSpan={6} className="py-3 px-4">
          <div className="flex items-center gap-2 ml-4">
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
        ? account.transactions.map((tx) => <TransactionRow key={tx.id} tx={tx} />)
        : null}

      {isOpen ? (
        <tr className="bg-bg-page/10 border-b border-border-light">
          <td colSpan={6} className="py-3 px-4 text-right">
            <span className="text-[12px] font-medium text-text-muted italic">Total for {account.name}</span>
          </td>
          <td className={cn(
            "py-3 px-4 text-right font-semibold text-[14px] tabular-nums border-t border-border",
            account.total < 0 ? "text-status-error" : "text-text-primary"
          )}>
            {formatCurrency(account.total)}
          </td>
          <td />
        </tr>
      ) : null}
    </>
  );
}

export default function BalanceSheetDetail({
  data,
  title,
  subtitle,
}: BalanceSheetDetailProps) {
  const { previewData, totalRecords, visibleRecords, isTruncated } = buildDetailPreview(data);

  return (
    <div className="flex-1 overflow-y-auto bg-bg-page/50 p-6 lg:p-10">
      <div className="max-w-6xl mx-auto bg-bg-card border border-border min-h-[1000px] flex flex-col rounded-sm shadow-card-hover transition-all">
        <div className="flex flex-col items-center py-12 border-b border-border/60 mb-8 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-primary" />
          <h1 className="text-[20px] font-bold text-text-primary mb-1">Sage Healthy RCM, LLC</h1>
          <h2 className="text-[18px] font-medium text-text-secondary mb-4">{title} Detail</h2>
          <div className="flex items-center gap-3 text-[12px] text-text-muted bg-bg-page px-4 py-1.5 rounded-full border border-border">
            <span>{subtitle}</span>
            <div className="w-1 h-1 rounded-full bg-border" />
            <span>Detailed Basis</span>
          </div>
        </div>

        <div className="px-8 pb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-text-muted font-medium">Transactions:</span>
            <span className="text-[13px] font-semibold text-text-primary bg-bg-page px-2 py-0.5 rounded-md border border-border">
              {isTruncated ? `${visibleRecords} of ${totalRecords}` : totalRecords}
            </span>
          </div>
          <button className="text-[13px] font-medium text-primary hover:text-primary-dark transition-colors">
            Expand All Groups
          </button>
        </div>

        <div className="flex-1 overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="bg-text-primary text-white sticky top-0 z-10">
              <tr>
                <th className="py-3.5 px-4 text-left text-[12px] font-medium uppercase tracking-wider">Date</th>
                <th className="py-3.5 px-4 text-left text-[12px] font-medium uppercase tracking-wider">Type</th>
                <th className="py-3.5 px-4 text-left text-[12px] font-medium uppercase tracking-wider">Num</th>
                <th className="py-3.5 px-4 text-left text-[12px] font-medium uppercase tracking-wider">Name</th>
                <th className="py-3.5 px-4 text-left text-[12px] font-medium uppercase tracking-wider">Memo</th>
                <th className="py-3.5 px-4 text-left text-[12px] font-medium uppercase tracking-wider">Split</th>
                <th className="py-3.5 px-4 text-right text-[12px] font-medium uppercase tracking-wider">Amount</th>
                <th className="py-3.5 px-4 text-right text-[12px] font-medium uppercase tracking-wider">Balance</th>
              </tr>
            </thead>
            <tbody className="bg-bg-card">
              {previewData.groups.map((group) => (
                <Fragment key={group.id}>
                  <tr className="bg-bg-page/40 border-b border-border">
                    <td colSpan={8} className="py-4 px-6">
                      <span className="text-[15px] font-bold text-text-primary">{group.name}</span>
                    </td>
                  </tr>
                  {group.accounts.map((account) => (
                    <AccountSection key={account.id} account={account} />
                  ))}
                  <tr className="bg-bg-page/60 border-b-2 border-text-primary">
                    <td colSpan={6} className="py-4 px-6 text-right">
                      <span className="text-[14px] font-semibold text-text-primary">Total for {group.name}</span>
                    </td>
                    <td className="py-4 px-4 text-right font-bold text-text-primary text-[15px] tabular-nums">
                      {formatCurrency(group.total)}
                    </td>
                    <td />
                  </tr>
                </Fragment>
              ))}
              {isTruncated ? (
                <tr className="bg-amber-50 border-t-2 border-amber-200">
                  <td colSpan={8} className="px-6 py-4 text-center text-[13px] font-medium text-amber-800">
                    report is too long please download pdf or excel sheet
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="p-10 text-center bg-bg-page border-t border-border mt-auto">
          <p className="text-[12px] text-text-muted font-medium mb-4">AccountHub Financial Intelligence Engine</p>
          <div className="flex items-center justify-center gap-8">
            <div className="flex flex-col items-center">
              <span className="text-[10px] text-text-muted uppercase tracking-wider">Audit Trail Status</span>
              <span className="text-[11px] font-semibold text-primary">Verified & Consolidated</span>
            </div>
            <div className="flex flex-col items-center">
              <span className="text-[10px] text-text-muted uppercase tracking-wider">Data Source</span>
              <span className="text-[11px] font-semibold text-text-primary">QuickBooks API Pipeline</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

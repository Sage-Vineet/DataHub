"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import { FinancialLine } from "@/types/balance-sheet";

interface CashflowSummaryProps {
  data: FinancialLine[];
  title: string;
  subtitle?: string;
}

function CashflowRow({
  line,
  depth = 0,
}: {
  line: FinancialLine;
  depth?: number;
}) {
  const [isOpen, setIsOpen] = useState(true);
  const hasChildren = Boolean(line.children?.length);
  const isCategory = line.type === "header";
  const isTotal = line.type === "total";

  const toggle = (e: React.MouseEvent) => {
    if (!hasChildren) return;
    e.stopPropagation();
    setIsOpen((prev) => !prev);
  };

  return (
    <div className="flex flex-col">
      <div
        onClick={toggle}
        className={cn(
          "group flex items-center justify-between py-2.5 px-4 transition-colors border-b border-border-light",
          hasChildren && "cursor-pointer hover:bg-bg-page/50",
          !hasChildren && "hover:bg-bg-page/30",
          isTotal && "bg-bg-page/60 font-semibold border-b-2 border-text-primary mt-1 mb-2",
          isCategory && depth === 0 && "bg-bg-page/30 border-t border-border mt-4"
        )}
      >
        <div className="flex items-center gap-1 flex-1">
          <div className="flex shrink-0">
            {Array.from({ length: depth }).map((_, index) => (
              <div key={index} className="w-6 h-5 border-r border-border-light mr-[-1px]" />
            ))}
          </div>

          <div className="w-5 flex items-center justify-center">
            {hasChildren ? (
              isOpen ? (
                <ChevronDown size={14} className="text-text-muted group-hover:text-text-primary" />
              ) : (
                <ChevronRight size={14} className="text-text-muted group-hover:text-text-primary" />
              )
            ) : null}
          </div>

          <span
            className={cn(
              "text-[14px]",
              isCategory ? "font-semibold text-text-primary" : "text-text-secondary",
              isTotal && "text-text-primary font-semibold",
              depth > 1 && !isTotal && "text-text-muted"
            )}
          >
            {line.name}
          </span>
        </div>

        <div
          className={cn(
            "text-[14px] text-right min-w-[140px] tabular-nums",
            isTotal ? "font-semibold border-t border-text-muted pt-0.5" : "font-medium text-text-primary",
            line.amount < 0 ? "text-status-error font-semibold" : "text-text-primary"
          )}
        >
          {formatCurrency(line.amount)}
        </div>
      </div>

      {hasChildren && isOpen ? (
        <div className="flex flex-col">
          {line.children?.map((child, index) => (
            <CashflowRow key={child.id || `cashflow-${depth}-${index}`} line={child} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function CashflowSummary({
  data,
  title,
  subtitle,
}: CashflowSummaryProps) {
  return (
    <div className="flex-1 overflow-y-auto bg-bg-page/50 p-10 lg:p-16">
      <div className="max-w-4xl mx-auto card-base p-10 min-h-[1000px] flex flex-col rounded-sm">
        <div className="flex flex-col items-center mb-12 relative">
          <div className="w-12 h-1 bg-primary rounded-full mb-6" />
          <h1 className="text-[22px] font-bold text-text-primary tracking-tight leading-none mb-2">
            Sage Healthy RCM, LLC
          </h1>
          <h2 className="text-[18px] font-medium text-text-secondary mb-4">{title}</h2>
          <div className="flex items-center gap-3 text-[12px] text-text-muted bg-bg-page px-4 py-1.5 rounded-full border border-border">
            <span>{subtitle}</span>
          </div>
        </div>

        <div className="flex items-center justify-between pb-3 px-4 border-b-2 border-text-primary sticky top-0 bg-bg-card z-10 pt-2">
          <span className="text-[12px] font-medium text-text-muted">Cash Flow Classification</span>
          <span className="text-[12px] font-medium text-text-muted">Amount (USD)</span>
        </div>

        <div className="flex-1 py-4">
          {Array.isArray(data) && data.length > 0 ? (
            data.map((category, index) => (
              <CashflowRow key={category.id || `cashflow-category-${index}`} line={category} depth={0} />
            ))
          ) : (
            <div className="py-20 text-center text-text-muted italic">
              No report data found for this period.
            </div>
          )}
        </div>

        <div className="mt-16 pt-8 border-t border-border flex flex-col items-center gap-4">
          <div className="flex items-center gap-8">
            <div className="flex flex-col items-center">
              <span className="text-[11px] text-text-muted mb-1">Created on</span>
              <span className="text-[12px] font-medium text-text-primary">March 26, 2026</span>
            </div>
            <div className="w-px h-6 bg-border" />
            <div className="flex flex-col items-center">
              <span className="text-[11px] text-text-muted mb-1">Status</span>
              <span className="text-[12px] font-medium text-primary">Consolidated & Verified</span>
            </div>
          </div>
          <p className="text-[11px] text-text-muted text-center max-w-sm leading-relaxed">
            This report provides a structured view of operating, investing, and financing cash movement.
          </p>
        </div>
      </div>
    </div>
  );
}

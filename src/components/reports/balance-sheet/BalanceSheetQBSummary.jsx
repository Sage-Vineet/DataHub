import React, { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../../../lib/utils";

const formatBalanceSheetValue = (value) => {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  const numeric = typeof value === "string"
    ? Number(value.replace(/,/g, "").replace(/[^\d.-]/g, ""))
    : Number(value);

  if (!Number.isFinite(numeric)) {
    return "";
  }

  const formatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const formatted = formatter.format(Math.abs(numeric));
  return numeric < 0 ? `(${formatted})` : formatted;
};

const QBRow = ({ line, depth = 0 }) => {
  const [isOpen, setIsOpen] = useState(true);
  const hasChildren = Boolean(line.children?.length);
  const isHeader = line.type === "header";
  const isTotal = line.type === "total" || line.name.toLowerCase().startsWith("total");
  const amountText = isHeader ? "" : formatBalanceSheetValue(line.amount);

  const toggle = (e) => {
    if (!hasChildren) return;
    e.stopPropagation();
    setIsOpen((prev) => !prev);
  };

  return (
    <>
      <tr
        onClick={toggle}
        className={cn(
          "group transition-colors border-b border-border-light",
          hasChildren && "cursor-pointer hover:bg-bg-page/50",
          !hasChildren && "hover:bg-bg-page/30",
          (isTotal || (isHeader && depth === 0)) && "bg-bg-page/60 font-semibold border-b-2 border-text-primary",
        )}
      >
        <td className="py-2.5 px-4 text-left bg-inherit z-10 min-w-[400px]">
          <div className="flex items-center">
            <div className="flex shrink-0">
              {Array.from({ length: depth }).map((_, index) => (
                <div key={index} className="w-6 h-5 border-r border-border-light mr-[-1px]" />
              ))}
            </div>

            <div className="flex items-center gap-1">
              <div className="w-5 flex items-center justify-center shrink-0">
                {hasChildren ? (
                  isOpen ? (
                    <ChevronDown size={14} className="text-text-muted" />
                  ) : (
                    <ChevronRight size={14} className="text-text-muted" />
                  )
                ) : null}
              </div>
              <span className={cn(
                "text-[14px] whitespace-nowrap",
                (isHeader || isTotal) ? "font-semibold text-text-primary" : "text-text-secondary",
              )}>
                {line.name}
              </span>
            </div>
          </div>
        </td>
        <td
          className={cn(
            "py-2.5 px-4 text-right tabular-nums text-[14px] font-medium",
            !isHeader && Number(line.amount) < 0 ? "text-status-error" : "text-text-primary",
            isHeader && "text-transparent",
          )}
        >
          {amountText}
        </td>
      </tr>

      {hasChildren && isOpen && (
        line.children.map((child, index) => (
          <QBRow key={child.id || `row-${depth}-${index}`} line={child} depth={depth + 1} />
        ))
      )}
    </>
  );
};

export default function BalanceSheetQBSummary({
  data = [],
  title = "Balance Sheet",
  subtitle,
  entityName = "Company",
  source = null,
  sourceLabel = null,
  noDataText = "No data available for the selected period.",
}) {
  const resolvedSourceLabel =
    sourceLabel ||
    (source === "MANUAL_UPLOAD"
      ? "Manual Balance Sheet"
      : source === "GENERATED_FROM_GL"
        ? "Generated from GL"
        : source === "GENERATED_FROM_QB"
          ? "Generated from QuickBooks"
          : null);

  return (
    <div className="flex-1 overflow-y-auto bg-bg-page/50 p-10 lg:p-16 font-inter">
      <div className="max-w-[1000px] mx-auto card-base p-10 min-h-[800px] flex flex-col rounded-sm shadow-xl">
        <div className="flex flex-col items-center mb-12 relative">
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
          {resolvedSourceLabel ? (
            <div
              className={cn(
                "mt-3 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide",
                source === "MANUAL_UPLOAD"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-border bg-bg-page text-text-muted",
              )}
            >
              {resolvedSourceLabel}
            </div>
          ) : null}
        </div>

        <div className="overflow-x-auto flex-1">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-text-primary sticky top-0 bg-bg-card z-20">
                <th className="pb-3 pt-2 px-4 text-left text-[12px] font-medium text-text-muted whitespace-nowrap uppercase tracking-wider">
                  Account
                </th>
                <th className="pb-3 pt-2 px-4 text-right text-[12px] font-medium text-text-muted whitespace-nowrap uppercase tracking-wider">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((row, index) => (
                <QBRow key={row.id || index} line={row} depth={0} />
              ))}
              {data.length === 0 && (
                <tr>
                  <td colSpan={2} className="py-20 text-center text-text-muted italic">
                    {noDataText}
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

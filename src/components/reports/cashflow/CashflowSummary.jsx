import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn, formatCurrency } from "../../../lib/utils";

function CashflowRow({
  line,
  depth = 0,
  columns,
}) {
  const [isOpen, setIsOpen] = useState(depth < 1);
  const hasChildren = Boolean(line.children?.length);
  const isCategory = line.type === "header";
  const isTotal = line.type === "total";

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
          isTotal && "bg-bg-page/60 font-semibold border-b-2 border-text-primary",
          isCategory && depth === 0 && "bg-bg-page/30 border-t border-border"
        )}
      >
        <td className="py-2.5 px-4 text-left bg-inherit z-10 min-w-[320px]">
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
                (isCategory || isTotal) ? "font-semibold text-text-primary" : "text-text-secondary",
              )}>
                {line.name}
              </span>
            </div>
          </div>
        </td>

        {columns?.yearCols ? (
          columns.yearCols.map((col) => (
            <td key={col.key} className={cn(
              "py-2.5 px-3 text-right tabular-nums text-[14px] font-medium",
              (line.amounts?.[col.key] || 0) < 0 ? "text-status-error" : "text-text-primary"
            )}>
              {formatCurrency(line.amounts?.[col.key] || 0)}
            </td>
          ))
        ) : (
          <td className={cn(
            "py-2.5 px-4 text-right tabular-nums text-[14px] font-medium",
            (line.amount || 0) < 0 ? "text-status-error" : "text-text-primary"
          )}>
            {formatCurrency(line.amount || 0)}
          </td>
        )}
      </tr>

      {hasChildren && isOpen && (
        line.children.map((child, index) => (
          <CashflowRow key={child.id || `cashflow-${depth}-${index}`} line={child} depth={depth + 1} columns={columns} />
        ))
      )}
    </>
  );
}

export default function CashflowSummary({
  data,
  columns,
  title,
  subtitle,
  entityName = "Company",
  createdOn = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }),
}) {
  const hasColumns = columns && columns.yearCols && columns.yearCols.length > 0;

  return (
    <div className="flex-1 overflow-y-auto bg-bg-page/50 p-10 lg:p-16 font-inter text-text-primary">
      <div className={cn(
        "mx-auto card-base p-10 min-h-[1000px] flex flex-col rounded-sm",
        hasColumns ? "max-w-[1200px]" : "max-w-4xl"
      )}>
        <div className="flex flex-col items-center mb-12 relative">
          <div className="w-12 h-1 bg-primary rounded-full mb-6" />
          <h1 className="text-[22px] font-bold text-text-primary tracking-tight leading-none mb-2">
            {entityName}
          </h1>
          <h2 className="text-[18px] font-medium text-text-secondary mb-4">{title}</h2>
          <div className="flex items-center gap-3 text-[12px] text-text-muted bg-bg-page px-4 py-1.5 rounded-full border border-border">
            <span>{subtitle}</span>
          </div>
        </div>

        <div className="overflow-x-auto flex-1">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-text-primary sticky top-0 bg-bg-card z-20">
                <th className="pb-3 pt-2 px-4 text-left text-[12px] font-medium text-text-muted whitespace-nowrap uppercase tracking-wider">
                  Cash Flow Classification
                </th>
                {hasColumns ? (
                  columns.yearCols.map((col) => (
                    <th key={col.key} className="pb-3 pt-2 px-3 text-right text-[12px] font-medium text-text-muted whitespace-nowrap uppercase tracking-wider">
                      {col.label}
                    </th>
                  ))
                ) : (
                  <th className="pb-3 pt-2 px-4 text-right text-[12px] font-medium text-text-muted whitespace-nowrap uppercase tracking-wider">
                    Amount (USD)
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {Array.isArray(data) && data.length > 0 ? (
                data.map((category, index) => (
                  <CashflowRow key={category.id || `cashflow-category-${index}`} line={category} depth={0} columns={columns} />
                ))
              ) : (
                <tr>
                  <td colSpan={hasColumns ? columns.yearCols.length + 1 : 2} className="py-20 text-center text-text-muted italic">
                    No report data found for this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-16 pt-8 border-t border-border flex flex-col items-center gap-4">
          <div className="flex items-center gap-8">
            <div className="flex flex-col items-center">
              <span className="text-[11px] text-text-muted mb-1">Created on</span>
              <span className="text-[12px] font-medium text-text-primary">{createdOn}</span>
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

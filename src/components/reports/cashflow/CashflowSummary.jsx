import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn, formatCurrency, isReportGroupRow } from "../../../lib/utils";
import FrozenPaneTable from "../shared/FrozenPaneTable";

const NAME_COL_WIDTH = "320px";
const AMOUNT_COL_WIDTH = "140px";
const YEAR_COL_WIDTH = "90px";

function CashflowRow({
  line,
  depth = 0,
  columns,
}) {
  const [isOpen, setIsOpen] = useState(depth < 1);
  const hasChildren = Boolean(line.children?.length);
  const isCategory = line.type === "header";
  const isTotal = line.type === "total";
  const isGroup = isReportGroupRow(line, hasChildren, isTotal);
  const stickyColBg = isTotal ? "bg-bg-page" : (isCategory && depth === 0) ? "bg-bg-page" : "bg-bg-card";

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
        <td className={cn("py-2.5 px-4 text-left z-10 sticky left-0", stickyColBg)}>
          <div className="flex items-center">
            <div className="flex shrink-0">
              {Array.from({ length: depth }).map((_, index) => (
                <div key={index} className="w-6 h-5" />
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
              "py-2.5 px-3 text-right tabular-nums text-[14px] font-medium whitespace-nowrap",
              !isGroup && (line.amounts?.[col.key] || 0) < 0 ? "text-status-error" : "text-text-primary"
            )}>
              {isGroup ? "" : formatCurrency(line.amounts?.[col.key] || 0)}
            </td>
          ))
        ) : (
          <td className={cn(
            "py-2.5 px-4 text-right tabular-nums text-[14px] font-medium whitespace-nowrap",
            !isGroup && (line.amount || 0) < 0 ? "text-status-error" : "text-text-primary"
          )}>
            {isGroup ? "" : formatCurrency(line.amount || 0)}
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
  isPreview = false,
  createdOn = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }),
}) {
  const hasColumns = columns && columns.yearCols && columns.yearCols.length > 0;
  const columnWidths = [NAME_COL_WIDTH, ...(hasColumns ? columns.yearCols.map(() => YEAR_COL_WIDTH) : [AMOUNT_COL_WIDTH])];

  const headerRow = (
    <tr className="border-b-2 border-text-primary">
      <th className="sticky left-0 z-20 bg-bg-card pb-3 pt-2 px-4 text-left text-[12px] font-medium text-text-muted whitespace-nowrap uppercase tracking-wider">
        Cash Flow Classification
      </th>
      {hasColumns ? (
        columns.yearCols.map((col) => (
          <th key={col.key} className="bg-bg-card pb-3 pt-2 px-3 text-right text-[12px] font-medium text-text-muted whitespace-nowrap uppercase tracking-wider">
            {col.label}
          </th>
        ))
      ) : (
        <th className="bg-bg-card pb-3 pt-2 px-4 text-right text-[12px] font-medium text-text-muted whitespace-nowrap uppercase tracking-wider">
          Amount (USD)
        </th>
      )}
    </tr>
  );

  const tableEl = (
    <FrozenPaneTable columnWidths={columnWidths} headerRows={headerRow}>
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
    </FrozenPaneTable>
  );

  if (isPreview) {
    return (
      <div className="font-inter text-text-primary">
        <div className="mb-4 flex flex-col items-center text-center">
          <span className="text-[15px] font-bold text-text-primary">{entityName}</span>
          <span className="text-[13px] font-medium text-text-secondary mt-0.5">{title}</span>
          {subtitle && <span className="text-[12px] text-text-muted mt-0.5">{subtitle}</span>}
        </div>
        {tableEl}
      </div>
    );
  }

  return (
    <div className="bg-bg-page/50 p-4 lg:p-8 font-inter text-text-primary">
      <div className="card-base p-6 min-h-[1000px] rounded-sm">
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
        {tableEl}
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

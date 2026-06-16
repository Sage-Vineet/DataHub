import { useRef, useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn, formatCurrency } from "../../../lib/utils";

const QBRow = ({ line, depth = 0, columns }) => {
  const [isOpen, setIsOpen] = useState(true);
  const hasChildren = Boolean(line.children?.length);
  const isHeader = line.type === "header";
  const isTotal = line.type === "total" || line.name.toLowerCase().startsWith("total");
  const yearCols = columns?.yearCols;

  // Header rows intentionally render a blank amount (the section's value lives on
  // its "Total …" child), so we never show "-" there.
  const cellText = (value) => (isHeader ? "" : formatCurrency(value));

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
        <td className={cn(
          "py-2.5 px-4 text-left z-10 min-w-[400px] sticky left-0",
          (isTotal || (isHeader && depth === 0)) ? "bg-bg-page" : "bg-bg-card",
        )}>
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
                (isHeader || isTotal) ? "font-semibold text-text-primary" : "text-text-secondary",
              )}>
                {line.name}
              </span>
            </div>
          </div>
        </td>
        {yearCols ? (
          yearCols.map((col) => {
            const value = line.amounts?.[col.key];
            return (
              <td
                key={col.key}
                className={cn(
                  "py-2.5 px-4 text-right tabular-nums text-[14px] font-medium whitespace-nowrap",
                  !isHeader && Number(value) < 0 ? "text-status-error" : "text-text-primary",
                  isHeader && "text-transparent",
                )}
              >
                {cellText(value)}
              </td>
            );
          })
        ) : (
          <td
            className={cn(
              "py-2.5 px-4 text-right tabular-nums text-[14px] font-medium",
              !isHeader && Number(line.amount) < 0 ? "text-status-error" : "text-text-primary",
              isHeader && "text-transparent",
            )}
          >
            {cellText(line.amount)}
          </td>
        )}
      </tr>

      {hasChildren && isOpen && (
        line.children.map((child, index) => (
          <QBRow key={child.id || `row-${depth}-${index}`} line={child} depth={depth + 1} columns={columns} />
        ))
      )}
    </>
  );
};

export default function BalanceSheetQBSummary({
  data = [],
  columns,
  title = "Balance Sheet",
  subtitle,
  entityName = "Company",
  source = null,
  sourceLabel = null,
  noDataText = "No data available for the selected period.",
  isPreview = false,
}) {
  const hasColumns = Array.isArray(columns?.yearCols) && columns.yearCols.length > 0;
  const totalColCount = hasColumns ? columns.yearCols.length + 1 : 2;
  const tableRef = useRef(null);
  const theadRef = useRef(null);
  useEffect(() => {
    const mainEl = document.querySelector("main");
    if (!mainEl) return;
    const onScroll = () => {
      if (!tableRef.current || !theadRef.current) return;
      const tableTop = tableRef.current.getBoundingClientRect().top;
      const mainTop = mainEl.getBoundingClientRect().top;
      if (tableTop < mainTop) {
        const offset = Math.min(mainTop - tableTop, tableRef.current.offsetHeight - theadRef.current.offsetHeight);
        theadRef.current.style.transform = `translateY(${Math.max(0, offset)}px)`;
      } else {
        theadRef.current.style.transform = "";
      }
    };
    mainEl.addEventListener("scroll", onScroll, { passive: true });
    return () => mainEl.removeEventListener("scroll", onScroll);
  }, []);
  const resolvedSourceLabel =
    sourceLabel ||
    (source === "MANUAL_UPLOAD"
      ? "Manual Balance Sheet"
      : source === "GENERATED_FROM_GL"
        ? "Generated from GL"
        : source === "GENERATED_FROM_QB"
          ? "Generated from QuickBooks"
          : null);

  const tableEl = (
    <div className="overflow-x-auto w-full">
      <table ref={tableRef} className="min-w-full border-collapse">
        <thead ref={theadRef} style={{ position: "relative", zIndex: 20 }}>
          <tr className="text-text-muted">
            <th className="sticky top-0 left-0 z-30 bg-bg-card pb-3 pt-2 px-4 text-left text-[12px] font-medium whitespace-nowrap uppercase tracking-wider min-w-[400px] border-b-2 border-text-primary">
              Account
            </th>
            {hasColumns ? (
              columns.yearCols.map((col) => (
                <th key={col.key} className="sticky top-0 z-20 bg-bg-card pb-3 pt-2 px-4 text-right text-[12px] font-medium whitespace-nowrap uppercase tracking-wider min-w-[110px] border-b-2 border-text-primary">
                  {col.label}
                </th>
              ))
            ) : (
              <th className="sticky top-0 z-20 bg-bg-card pb-3 pt-2 px-4 text-right text-[12px] font-medium whitespace-nowrap uppercase tracking-wider border-b-2 border-text-primary">
                Total
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {data.map((row, index) => (
            <QBRow key={row.id || index} line={row} depth={0} columns={hasColumns ? columns : undefined} />
          ))}
          {data.length === 0 && (
            <tr>
              <td colSpan={totalColCount} className="py-20 text-center text-text-muted italic">
                {noDataText}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  // Compact in-page view — no document wrapper, header inline
  if (isPreview) {
    return (
      <div className="font-inter">
        <div className="mb-4 flex flex-col items-center text-center">
          <span className="text-[15px] font-bold text-text-primary">{entityName}</span>
          <span className="text-[13px] font-medium text-text-secondary mt-0.5">{title}</span>
          {subtitle && <span className="text-[12px] text-text-muted mt-0.5">{subtitle}</span>}
        </div>
        {tableEl}
      </div>
    );
  }

  // Document / export view — full paper layout
  return (
    <div className="bg-bg-page/50 p-4 lg:p-8 font-inter">
      <div className="card-base p-6 min-h-[800px] rounded-sm shadow-xl">
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
            <div className={cn(
              "mt-3 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide",
              source === "MANUAL_UPLOAD"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-border bg-bg-page text-text-muted",
            )}>
              {resolvedSourceLabel}
            </div>
          ) : null}
        </div>
        {tableEl}
      </div>
    </div>
  );
}

import React, { useState, useRef, useEffect } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn, formatCurrency } from "../../../lib/utils";

const formatValue = (value) => {
  return formatCurrency(value);
};

const QBRow = ({ line, depth = 0 }) => {
  const [isOpen, setIsOpen] = useState(true);
  const hasChildren = Boolean(line.children?.length);
  const isHeader = line.type === "header";
  const isTotal = line.type === "total" || line.name.toLowerCase().startsWith("total");

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
          "py-2.5 px-4 text-left z-10 min-w-[400px] sticky left-0 border-r-2 border-border/50 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]",
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
        {!isMonthly && (
          <td
            className={cn(
              "py-2.5 px-4 text-right tabular-nums text-[14px] font-medium",
              Number(line.amount) < 0 ? "text-status-error" : "text-text-primary",
            )}
          >
            {formatValue(line.amount)}
          </td>
        )}
      </tr>

      {hasChildren && isOpen && (
        line.children.map((child, index) => (
          <QBRow key={child.id || `row-${depth}-${index}`} line={child} depth={depth + 1} />
        ))
      )}
    </>
  );
};

export default function CashflowQBSummary({
  data = [],
  title = "Cash Flow",
  subtitle,
  entityName = "Company",
  isMonthly = false,
}) {
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

        </div>

        <div className="overflow-x-auto w-full">
          <table ref={tableRef} className="w-full border-collapse">
            <thead ref={theadRef} style={{ position: "relative", zIndex: 20 }}>
              <tr className="border-b-2 border-text-primary">
                <th className="sticky top-0 left-0 z-30 bg-bg-card pb-3 pt-2 px-4 text-left text-[12px] font-medium text-text-muted whitespace-nowrap uppercase tracking-wider min-w-[400px] border-r-2 border-border/50 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]">
                  Cash Flow Classification
                </th>
                {!isMonthly && (
                  <th className="sticky top-0 z-20 bg-bg-card pb-3 pt-2 px-4 text-right text-[12px] font-medium text-text-muted whitespace-nowrap uppercase tracking-wider">
                    Total
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {data.map((row, index) => (
                <QBRow key={row.id || index} line={row} depth={0} />
              ))}
              <tr>
                <td colSpan={isMonthly ? 1 : 2} className="py-20 text-center text-text-muted italic">
                  No data available for the selected period.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

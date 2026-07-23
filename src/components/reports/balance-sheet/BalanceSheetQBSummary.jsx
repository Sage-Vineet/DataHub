import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn, formatCurrency, isReportGroupRow } from "../../../lib/utils";
import FrozenPaneTable from "../shared/FrozenPaneTable";

const NAME_COL_WIDTH = "400px";
const AMOUNT_COL_WIDTH = "130px";

const QBRow = ({ line, depth = 0, columns, isMonthly }) => {
  const [isOpen, setIsOpen] = useState(true);
  const hasChildren = Boolean(line.children?.length);
  const isHeader = line.type === "header";
  const isTotal = line.type === "total" || line.name.toLowerCase().startsWith("total");
  const isGroup = isReportGroupRow(line, hasChildren, isTotal);
  const yearCols = columns?.yearCols;

  // Group/container rows intentionally render a blank amount (the section's
  // value lives on its "Total …" child), so we never show "-" there.
  const cellText = (value) => (isGroup ? "" : formatCurrency(value));

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
          "py-2.5 px-4 text-left z-10 sticky left-0 border-r-2 border-border/50 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]",
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
            if (isMonthly && col.label.toLowerCase() === "total") return null;
            return (
              <td
                key={col.key}
                className={cn(
                  "py-2.5 px-4 text-right tabular-nums text-[14px] font-medium whitespace-nowrap",
                  !isGroup && Number(value) < 0 ? "text-status-error" : "text-text-primary",
                  isGroup && "text-transparent",
                )}
              >
                {cellText(value)}
              </td>
            );
          })
        ) : !isMonthly ? (
          <td
            className={cn(
              "py-2.5 px-4 text-right tabular-nums text-[14px] font-medium",
              !isGroup && Number(line.amount) < 0 ? "text-status-error" : "text-text-primary",
              isGroup && "text-transparent",
            )}
          >
            {cellText(line.amount)}
          </td>
        ) : null}
      </tr>

      {hasChildren && isOpen && (
        line.children.map((child, index) => (
          <QBRow key={child.id || `row-${depth}-${index}`} line={child} depth={depth + 1} columns={columns} isMonthly={isMonthly} />
        ))
      )}
    </>
  );
};

function buildColumnWidths(hasColumns, columns, amountColCount) {
  const count = hasColumns ? (columns?.yearCols?.length || 0) : amountColCount;
  return [NAME_COL_WIDTH, ...Array(count).fill(AMOUNT_COL_WIDTH)];
}

export default function BalanceSheetQBSummary({
  data = [],
  columns,
  title = "Balance Sheet",
  subtitle,
  entityName = "Company",
  source = null,
  sourceLabel = null,
  noDataText = "No data available for the selected period.",
  isMonthly = false,
  isPreview = false,
}) {
  const hasColumns = Array.isArray(columns?.yearCols) && columns.yearCols.length > 0;
  const totalColCount = hasColumns ? columns.yearCols.length + 1 : 2;
  const resolvedSourceLabel =
    sourceLabel ||
    (source === "MANUAL_UPLOAD"
      ? "Manual Balance Sheet"
      : source === "GENERATED_FROM_GL"
        ? "Generated from GL"
        : source === "GENERATED_FROM_QB"
          ? "Generated from QuickBooks"
          : null);

  const bodyRows = (
    <>
      {data.map((row, index) => (
        <QBRow key={row.id || index} line={row} depth={0} columns={hasColumns ? columns : undefined} isMonthly={isMonthly} />
      ))}
      {data.length === 0 && (
        <tr>
          <td colSpan={totalColCount} className="py-20 text-center text-text-muted italic">
            {noDataText}
          </td>
        </tr>
      )}
    </>
  );

  // Compact in-page view — no document wrapper, header inline
  if (isPreview) {
    const previewHeader = (
      <tr className="text-text-muted">
        <th className="sticky left-0 z-20 bg-bg-card pb-3 pt-2 px-4 text-left text-[12px] font-medium whitespace-nowrap uppercase tracking-wider border-b-2 border-text-primary">
          Account
        </th>
        {hasColumns ? (
          columns.yearCols.map((col) => (
            <th key={col.key} className="bg-bg-card pb-3 pt-2 px-4 text-right text-[12px] font-medium whitespace-nowrap uppercase tracking-wider border-b-2 border-text-primary">
              {col.label}
            </th>
          ))
        ) : (
          <th className="bg-bg-card pb-3 pt-2 px-4 text-right text-[12px] font-medium whitespace-nowrap uppercase tracking-wider border-b-2 border-text-primary">
            Total
          </th>
        )}
      </tr>
    );

    return (
      <div className="font-inter">
        <div className="mb-4 flex flex-col items-center text-center">
          <span className="text-[15px] font-bold text-text-primary">{entityName}</span>
          <span className="text-[13px] font-medium text-text-secondary mt-0.5">{title}</span>
          {subtitle && <span className="text-[12px] text-text-muted mt-0.5">{subtitle}</span>}
        </div>
        <FrozenPaneTable columnWidths={buildColumnWidths(hasColumns, columns, 1)} headerRows={previewHeader}>
          {bodyRows}
        </FrozenPaneTable>
      </div>
    );
  }

  // Document / export view — full paper layout
  const docYearCols = hasColumns ? columns.yearCols.filter((col) => !isMonthly || col.label.toLowerCase() !== "total") : [];
  const docHeader = (
    <tr className="text-text-muted">
      <th className="sticky left-0 z-20 bg-bg-card pb-4 pt-2.5 px-4 text-left text-[12px] font-medium whitespace-nowrap uppercase tracking-wider border-b-2 border-text-primary border-r-2 border-border/50 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]">
        Account
      </th>
      {hasColumns ? (
        docYearCols.map((col) => (
          <th key={col.key} className="bg-bg-card pb-4 pt-2.5 px-4 text-right text-[12px] font-medium whitespace-nowrap uppercase tracking-wider border-b-2 border-text-primary">
            {col.label}
          </th>
        ))
      ) : !isMonthly ? (
        <th className="bg-bg-card pb-4 pt-2.5 px-4 text-right text-[12px] font-medium whitespace-nowrap uppercase tracking-wider border-b-2 border-text-primary">
          Total
        </th>
      ) : null}
    </tr>
  );
  const docColumnWidths = [
    NAME_COL_WIDTH,
    ...(hasColumns ? docYearCols.map(() => AMOUNT_COL_WIDTH) : (!isMonthly ? [AMOUNT_COL_WIDTH] : [])),
  ];

  return (
    <div className="bg-bg-page/50 p-4 lg:p-8 font-inter">
      <div className="card-base p-6 rounded-sm shadow-xl">
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

        <FrozenPaneTable columnWidths={docColumnWidths} headerRows={docHeader}>
          {bodyRows}
        </FrozenPaneTable>
      </div>
    </div>
  );
}

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn, formatCurrency, isReportGroupRow } from "../../../lib/utils";
import FrozenPaneTable from "../shared/FrozenPaneTable";

const NAME_COL_WIDTH = "400px";
const AMOUNT_COL_WIDTH = "130px";

const QBRow = ({ line, depth = 0, columns, isMonthly }) => {
  const [isOpen, setIsOpen] = useState(true);
  const [entitiesOpen, setEntitiesOpen] = useState(false);
  const hasChildren = Boolean(line.children?.length);
  const isHeader = line.type === "header";
  const isTotal = line.type === "total" || line.name.toLowerCase().startsWith("total");
  const isGroup = isReportGroupRow(line, hasChildren, isTotal);
  const yearCols = columns?.yearCols;

  // Group/container rows intentionally render a blank amount (the section's
  // value lives on its "Total …" child), so we never show "-" there.
  const cellText = (value) => (isGroup ? "" : formatCurrency(value));

  // Counterparty breakdown groups, supplied per LEAF account row by the report
  // payload. Only a real posting row can carry them -- a header/total/container
  // row's amount is a rollup of its children, so hanging a breakdown off it
  // would double-count. A row with neither field behaves exactly as before.
  const entityGroups = [
    { label: "Vendor", items: line.vendors },
    { label: "Customer", items: line.customers },
  ].filter((g) => Array.isArray(g.items) && g.items.length > 0);
  const hasEntities = !isTotal && !isHeader && !hasChildren && entityGroups.length > 0;

  // Amount columns actually rendered, so a sub-row lines up with the row above
  // (the monthly view drops a trailing "Total" column).
  const renderedCols = yearCols
    ? yearCols.filter((col) => !(isMonthly && col.label.toLowerCase() === "total"))
    : null;

  const toggle = (e) => {
    if (hasChildren) {
      e.stopPropagation();
      setIsOpen((prev) => !prev);
      return;
    }
    if (hasEntities) {
      e.stopPropagation();
      setEntitiesOpen((prev) => !prev);
    }
  };

  return (
    <>
      <tr
        onClick={toggle}
        className={cn(
          "group transition-colors border-b border-border-light",
          (hasChildren || hasEntities) && "cursor-pointer hover:bg-bg-page/50",
          !hasChildren && !hasEntities && "hover:bg-bg-page/30",
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
                ) : hasEntities ? (
                  entitiesOpen ? (
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

      {/* Vendor / Customer breakdown rows -- same structure, indentation and
          type scale as the account rows above; no new styling introduced. */}
      {entitiesOpen && hasEntities && entityGroups.map((group) => (
        <Fragment key={group.label}>
          <tr className="bg-bg-page/20">
            <td
              colSpan={(renderedCols?.length || 1) + 1}
              style={{ paddingLeft: `${(depth + 1) * 24 + 16}px` }}
              className="py-1 text-[10px] font-bold uppercase tracking-widest text-text-muted"
            >
              {group.label}
            </td>
          </tr>
          {group.items.map((entity) => (
            <tr key={`${group.label}-${entity.name}`} className="border-b border-border-light/50 hover:bg-bg-page/20">
              <td className="py-1.5 px-4 text-left sticky left-0 z-10 bg-bg-card border-r-2 border-border/50 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]">
                <div className="flex items-center">
                  <div className="flex shrink-0">
                    {Array.from({ length: depth + 2 }).map((_, i) => (
                      <div key={i} className="w-6 h-5" />
                    ))}
                  </div>
                  <span className="text-[13px] text-text-muted whitespace-nowrap pl-1">
                    {entity.name}
                  </span>
                </div>
              </td>
              {renderedCols ? (
                renderedCols.map((col) => (
                  <td
                    key={col.key}
                    className="py-1.5 px-4 text-right tabular-nums text-[13px] text-text-muted whitespace-nowrap"
                  >
                    {formatCurrency(entity.amounts?.[col.key] || 0)}
                  </td>
                ))
              ) : !isMonthly ? (
                <td className="py-1.5 px-4 text-right tabular-nums text-[13px] text-text-muted whitespace-nowrap">
                  {formatCurrency(entity.total ?? entity.amount ?? 0)}
                </td>
              ) : null}
            </tr>
          ))}
        </Fragment>
      ))}
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

import { useState, useMemo, useCallback } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn, formatCurrency } from "../../../lib/utils";

// ─── Utility Functions ──────────────────────────────────────────────────────

// Shared US-standard formatter (comma thousands, period decimal, parens for
// negatives, "-" for zero/empty) lives in lib/utils. Alias kept for readability.
const formatBSCurrency = formatCurrency;

function calculateChange(current, previous) {
  const curr = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (curr === 0 && prev === 0) return 0;
  return curr - prev;
}

const generateDefaultColumns = (baseDate) => {
  const date = baseDate ? new Date(baseDate) : new Date();
  const resolvedDate = isNaN(date.getTime()) ? new Date() : date;

  const year = resolvedDate.getFullYear();
  const month = resolvedDate.toLocaleString('default', { month: 'short' }).toUpperCase();

  return {
    yearCols: [
      { key: "y1", label: `${month}-${String(year - 4).slice(-2)}` },
      { key: "y2", label: `${month}-${String(year - 3).slice(-2)}` },
      { key: "y3", label: `${month}-${String(year - 2).slice(-2)}` },
      { key: "y4", label: `${month}-${String(year - 1).slice(-2)}` },
      { key: "y5", label: `${month}-${String(year).slice(-2)}`, isCurrent: true },
    ],
    changeCols: [
      { key: "c1", label: `'${String(year - 3).slice(-2)} CHANGE`, from: "y1", to: "y2" },
      { key: "c2", label: `'${String(year - 2).slice(-2)} CHANGE`, from: "y2", to: "y3" },
      { key: "c3", label: `'${String(year - 1).slice(-2)} CHANGE`, from: "y3", to: "y4" },
      { key: "c4", label: `'${String(year).slice(-2)} YTD CHANGE`, from: "y4", to: "y5" },
    ],
    currentMonth: `${month}-${String(year).slice(-2)}`
  };
};

function flattenRows(items, depth = 0) {
  const result = [];
  if (!Array.isArray(items)) return result;

  for (const item of items) {
    const hasChildren = Boolean(item.children?.length);
    const isTotal = item.type === "total" || item.name.toLowerCase().startsWith("total");
    const isHeader = item.type === "header";

    result.push({
      ...item,
      depth,
      hasChildren,
      isTotal,
      isHeader,
    });

    if (hasChildren) {
      result.push(...flattenRows(item.children, depth + 1));
    }
  }

  return result;
}

// ─── Row Component ──────────────────────────────────────────────────────────

function BSRow({ row, isCollapsed, onToggle, columns }) {
  const [vendorsOpen, setVendorsOpen] = useState(false);

  const { name, amounts, depth, hasChildren, isTotal, isHeader } = row;
  const { yearCols = [], changeCols = [] } = columns || {};
  const hasVendors = !isTotal && !isHeader && Array.isArray(row.vendors) && row.vendors.length > 0;

  const nameLower = (name || "").toLowerCase();
  const isBold = [
    "total current assets", "total fixed assets", "total assets",
    "total current liabilities", "total long term liabilities", "total liabilities",
    "total equity", "total liabilities and equity", "assets", "liabilities and equity"
  ].includes(nameLower);

  // Total number of data columns (excluding the name cell) for vendor label colSpan.
  const totalDataCols = yearCols.length + changeCols.length + (changeCols.length > 0 ? 1 : 0);

  const handleRowClick = () => {
    if (hasChildren) onToggle(row.id);
    else if (hasVendors) setVendorsOpen((v) => !v);
  };

  return (
    <>
      <tr
        onClick={handleRowClick}
        className={cn(
          "group transition-colors border-b border-border-light",
          (hasChildren || hasVendors) && "cursor-pointer hover:bg-bg-page/50",
          !hasChildren && !hasVendors && "hover:bg-bg-page/30",
          (isTotal || isBold) && "bg-bg-page/60 font-semibold border-b-2 border-text-primary table-row-total",
          isHeader && depth === 0 && "bg-bg-page/30 border-t border-border"
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
                  isCollapsed ? (
                    <ChevronRight size={14} className="text-text-muted group-hover:text-text-primary" />
                  ) : (
                    <ChevronDown size={14} className="text-text-muted group-hover:text-text-primary" />
                  )
                ) : hasVendors ? (
                  vendorsOpen ? (
                    <ChevronDown size={13} className="text-text-muted group-hover:text-text-primary" />
                  ) : (
                    <ChevronRight size={13} className="text-text-muted group-hover:text-text-primary" />
                  )
                ) : null}
              </div>
              <span className={cn(
                "text-[14px] whitespace-nowrap",
                (isHeader || isTotal) ? "font-semibold text-text-primary" : "text-text-secondary",
                depth > 1 && !isTotal && !isHeader && "text-text-muted"
              )}>
                {name}
              </span>
            </div>
          </div>
        </td>

        {yearCols.map((col) => (
          <td key={col.key} className={cn(
            "py-2.5 px-3 text-right tabular-nums text-[14px] whitespace-nowrap",
            col.isCurrent ? "font-semibold text-text-primary" : "text-text-secondary",
            isTotal ? "font-semibold" : "font-medium"
          )}>
            {formatBSCurrency(amounts?.[col.key])}
          </td>
        ))}

        {changeCols.map((col) => (
          <td key={col.key} className="py-2.5 px-3 text-right tabular-nums text-[14px] text-text-muted font-medium whitespace-nowrap">
            {formatBSCurrency(calculateChange(amounts?.[col.to], amounts?.[col.from]))}
          </td>
        ))}

        {changeCols.length > 0 && (
          <td className="py-2.5 px-4 text-right tabular-nums text-[14px] font-semibold text-primary whitespace-nowrap">
            {formatBSCurrency(amounts?.monthlyChange || 0)}
          </td>
        )}
      </tr>

      {/* Vendor / Customer breakdown rows */}
      {vendorsOpen && hasVendors && (
        <>
          <tr className="bg-bg-page/20">
            <td
              colSpan={totalDataCols + 1}
              style={{ paddingLeft: `${(depth + 1) * 24 + 16}px` }}
              className="py-1 text-[10px] font-bold uppercase tracking-widest text-text-muted"
            >
              Customer / Vendor
            </td>
          </tr>
          {row.vendors.map((vendor) => (
            <tr key={vendor.name} className="border-b border-border-light/50 hover:bg-bg-page/20">
              <td className="py-1.5 px-4 text-left min-w-[320px]">
                <div className="flex items-center">
                  <div className="flex shrink-0">
                    {Array.from({ length: depth + 2 }).map((_, i) => (
                      <div key={i} className="w-6 h-5 border-r border-border-light/50 mr-[-1px]" />
                    ))}
                  </div>
                  <span className="text-[13px] text-text-muted whitespace-nowrap pl-1">
                    {vendor.name}
                  </span>
                </div>
              </td>
              {yearCols.map((col) => (
                <td key={col.key} className="py-1.5 px-3 text-right tabular-nums text-[13px] text-text-muted whitespace-nowrap">
                  {formatBSCurrency(vendor.amounts?.[col.key] || 0)}
                </td>
              ))}
              {changeCols.map((col) => (
                <td key={col.key} className="py-1.5 px-3 text-right text-[13px] text-text-muted/50 whitespace-nowrap">
                  —
                </td>
              ))}
              {changeCols.length > 0 && (
                <td className="py-1.5 px-4 text-right text-[13px] text-text-muted/50 whitespace-nowrap">—</td>
              )}
            </tr>
          ))}
        </>
      )}
    </>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function BalanceSheetSummary({
  data,
  columns: propColumns,
  endDate,
  title = "Balance Sheet",
  subtitle,
  entityName = "Dataroom",
  isPreview = false,
}) {
  const [collapsedSections, setCollapsedSections] = useState(new Set());

  const columns = useMemo(() => {
    if (propColumns && propColumns.yearCols) return propColumns;
    return generateDefaultColumns(endDate);
  }, [propColumns, endDate]);

  const flatData = useMemo(() => flattenRows(data), [data]);

  const toggleSection = useCallback((id) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const visibleRows = useMemo(() => {
    const hidden = new Set();
    flatData.forEach((row, index) => {
      let parent = null;
      for (let i = index - 1; i >= 0; i--) {
        if (flatData[i].depth < row.depth) {
          parent = flatData[i];
          break;
        }
      }

      if (parent && (collapsedSections.has(parent.id) || hidden.has(parent.id))) {
        hidden.add(row.id);
      }
    });
    return flatData.filter(r => !hidden.has(r.id));
  }, [flatData, collapsedSections]);

  if (!data || data.length === 0) {
    return (
      <div className={cn(
        "flex-1 flex flex-col items-center justify-center",
        isPreview ? "py-8" : "p-20 bg-bg-page/50 min-h-[500px]"
      )}>
        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-text-muted font-medium italic">Preparing Balance Sheet...</p>
      </div>
    );
  }

  return (
    <div className={cn("font-inter animate-in fade-in duration-700", isPreview ? "" : "flex-1 overflow-y-auto bg-bg-page/50 p-10 lg:p-16")}>
      <div className={cn("flex flex-col", isPreview ? "" : "max-w-[1400px] mx-auto card-base p-10 min-h-[1000px] rounded-sm")}>

        {/* Header Section Matches P&L Style */}
        <div className={cn("flex flex-col items-center relative", isPreview ? "mb-4" : "mb-12")}>
          <div className="w-12 h-1 bg-primary rounded-full mb-3" />
          <h1 className="text-[20px] font-bold text-text-primary tracking-tight leading-none mb-1">
            {entityName}
          </h1>
          <h2 className="text-[16px] font-medium text-text-secondary mb-2">{title}</h2>
          {!isPreview && (
            <div className="flex items-center gap-3 text-[12px] text-text-muted bg-bg-page px-4 py-1.5 rounded-full border border-border">
              <span>{subtitle}</span>
            </div>
          )}
        </div>

        <div className="overflow-x-auto flex-1">
          <table className="w-full min-w-max border-collapse">
            <thead>
              <tr className="border-b-2 border-text-primary sticky top-0 bg-bg-card z-20">
                <th className="sticky top-0 left-0 z-30 bg-bg-card pb-3 pt-2 px-4 text-left text-[12px] font-medium text-text-muted whitespace-nowrap uppercase tracking-wider min-w-[320px] border-b-2 border-text-primary border-r-2 border-border/50 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]">
                  Accounting Classification
                </th>
                {columns.yearCols.map((col) => (
                  <th key={col.key} className={cn(
                    "pb-3 pt-2 px-3 text-right text-[12px] font-medium whitespace-nowrap min-w-[90px]",
                    col.isCurrent ? "text-text-primary font-bold" : "text-text-muted"
                  )}>
                    {col.label}
                  </th>
                ))}
                {columns.changeCols && columns.changeCols.length > 0 && columns.changeCols.map((col) => (
                  <th key={col.key} className="pb-3 pt-2 px-3 text-right text-[12px] font-medium text-text-muted whitespace-nowrap">
                    {col.label}
                  </th>
                ))}
                {columns.changeCols && columns.changeCols.length > 0 && (
                  <th className="pb-3 pt-2 px-4 text-right text-[12px] font-bold text-primary whitespace-nowrap">
                    <span className="text-[10px] uppercase font-medium text-text-muted mr-1.5 align-middle">MONTHLY CHG:</span>
                    <span className="align-middle">{columns.currentMonth}</span>
                  </th>
                )}

              </tr>
            </thead>
            <tbody className="">
              {visibleRows.length > 0 ? (
                visibleRows.map((row) => (
                  <BSRow
                    key={row.id}
                    row={row}
                    isCollapsed={collapsedSections.has(row.id)}
                    onToggle={toggleSection}
                    columns={columns}
                  />
                ))
              ) : (
                <tr>
                  <td colSpan={11} className="py-20 text-center text-text-muted italic">
                    No report data found for this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Footer Matches P&L Exactly */}
        {!isPreview && <div className="mt-16 pt-8 border-t border-border flex flex-col items-center gap-4">
          <div className="flex items-center gap-8">
            <div className="flex flex-col items-center">
              <span className="text-[11px] text-text-muted mb-1">Created on</span>
              <span className="text-[12px] font-medium text-text-primary">
                {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
              </span>
            </div>
            <div className="w-px h-6 bg-border" />
            <div className="flex flex-col items-center">
              <span className="text-[11px] text-text-muted mb-1">Status</span>
              <span className="text-[12px] font-medium text-primary">Consolidated & Verified</span>
            </div>
          </div>
          <p className="text-[11px] text-text-muted text-center max-w-sm leading-relaxed">
            This balance sheet provides a comprehensive view of the company&apos;s financial position over a 5-year comparative period.
          </p>
        </div>}
      </div>

      <style>{`
        .table-row-total {
          margin-top: 4px;
          margin-bottom: 8px;
        }
        /* Custom scrollbar */
        ::-webkit-scrollbar {
          height: 6px;
          width: 6px;
        }
        ::-webkit-scrollbar-track {
          background: transparent;
        }
        ::-webkit-scrollbar-thumb {
          background: rgba(0,0,0,0.1);
          border-radius: 10px;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: rgba(0,0,0,0.2);
        }
      `}</style>
    </div >
  );
}

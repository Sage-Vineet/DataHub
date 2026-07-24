import React, { useState, useMemo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn, formatCurrency, isReportGroupRow } from "../../../lib/utils";
import FrozenPaneTable from "../shared/FrozenPaneTable";

const NAME_COL_WIDTH = "320px";
const YEAR_COL_WIDTH = "90px";
const YTD_CURRENT_COL_WIDTH = "120px";
const VAR_DOLLAR_COL_WIDTH = "90px";
const VAR_PCT_COL_WIDTH = "70px";
const YTD_PREV_COL_WIDTH = "120px";
const YTD_VAR_COL_WIDTH = "110px";
const YTD_PCT_COL_WIDTH = "90px";

// ─── Utility Functions ───────────────────────────────────────────────────────

/**
 * Formats a number using the Indian numbering system (1,23,456).
 * Negative values are shown in brackets. 
 * Note: Decimals are omitted for a cleaner summary vPiew as per requirement.
 */
const formatValue = (value) => {
  return formatCurrency(value);
};

const formatPercentage = (value) => {
  if (value === undefined || value === null || value === "" || value === 0) return "0.0%";
  const num = Number(value);
  return `${num.toFixed(1)}%`;
};

const calculateChange = (current, previous) => (current || 0) - (previous || 0);

const calculatePctChange = (current, previous) => {
  const prev = previous || 0;
  if (prev === 0) return 0;
  return (((current || 0) - prev) / Math.abs(prev)) * 100;
};

// ─── Row Component ───────────────────────────────────────────────────────────

const PNLRow = ({ line, depth = 0, columns }) => {
  const [isOpen, setIsOpen] = useState(depth < 1);
  const [vendorsOpen, setVendorsOpen] = useState(false);
  const hasChildren = Boolean(line.children?.length);
  const isHeader = line.type === "header";
  const isTotal = line.type === "total";
  const isGroup = isReportGroupRow(line, hasChildren, isTotal);
  const hasVendors = !isTotal && !isHeader && Array.isArray(line.vendors) && line.vendors.length > 0;
  const nameLower = (line.name || "").toLowerCase();

  // Bold specific rows as per requirements
  const isBold = [
    "total revenue", "gross profit", "total expenses", "net income",
    "total cost of goods sold", "total payroll expenses", "operating income"
  ].includes(nameLower);

  // Sticky cells need an explicit, opaque background (not the translucent
  // bg-*/NN the row itself uses) so scrolling content never shows through.
  const stickyColBg = (isBold || (isHeader && depth === 0)) ? "bg-bg-page" : "bg-bg-card";

  const amounts = line.amounts || {};
  const yearCols = columns?.yearCols || [];
  const ytdComp = columns?.ytdComparison || {};
  const hasYTD = !!(ytdComp?.currentKey);

  // Dynamic column mapping based on service response
  const yearValues = yearCols.map(col => amounts[col.key] || 0);
  const currentYTD = hasYTD ? (amounts[ytdComp.currentKey] || 0) : 0;
  const prevYTD = hasYTD ? (amounts[ytdComp.prevKey] || 0) : 0;

  // Variances
  const v23Var = calculateChange(yearValues[1], yearValues[0]);
  const v23Pct = calculatePctChange(yearValues[1], yearValues[0]);

  const v24Var = calculateChange(yearValues[2], yearValues[1]);
  const v24Pct = calculatePctChange(yearValues[2], yearValues[1]);

  const ytdVar = calculateChange(currentYTD, prevYTD);
  const ytdPct = calculatePctChange(currentYTD, prevYTD);

  const toggle = (e) => {
    if (hasChildren) {
      e.stopPropagation();
      setIsOpen((prev) => !prev);
    } else if (hasVendors) {
      e.stopPropagation();
      setVendorsOpen((prev) => !prev);
    }
  };

  return (
    <>
      <tr
        onClick={toggle}
        className={cn(
          "group transition-colors border-b border-border-light",
          (hasChildren || hasVendors) && "cursor-pointer hover:bg-bg-page/50",
          !hasChildren && !hasVendors && "hover:bg-bg-page/30",
          isBold && "bg-bg-page/60 font-semibold border-b-2 border-text-primary",
          isHeader && depth === 0 && "bg-bg-page/30 border-t border-border"
        )}
      >
        <td className={cn("py-2.5 px-4 text-left z-10 sticky left-0 border-r border-border-light", stickyColBg)}>
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
                    <ChevronDown size={14} className="text-text-muted group-hover:text-text-primary" />
                  ) : (
                    <ChevronRight size={14} className="text-text-muted group-hover:text-text-primary" />
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
                (isHeader || isBold) ? "font-semibold text-text-primary" : "text-text-secondary",
                depth > 1 && !isBold && !isHeader && "text-text-muted"
              )}>
                {line.name}
              </span>
            </div>
          </div>
        </td>

        {/* Dynamic Year Columns */}
        {yearValues.map((val, idx) => (
          <td
            key={idx}
            className={cn(
              "py-2.5 px-3 text-right tabular-nums text-[14px] whitespace-nowrap",
              !isGroup && val < 0 ? "text-status-error font-semibold" : "text-text-secondary",
            )}
          >
            {isGroup ? "" : formatValue(val)}
          </td>
        ))}

        {/* Current YTD Highlight — only when ytdComparison is present */}
        {hasYTD && (
          <td
            className={cn(
              "py-2.5 px-3 text-right tabular-nums text-[14px] font-semibold bg-blue-50/20",
              !isGroup && currentYTD < 0 ? "text-status-error" : "text-text-primary",
            )}
          >
            {isGroup ? "" : formatValue(currentYTD)}
          </td>
        )}

        {/* Variances — only when ytdComparison is present */}
        {yearCols.length > 1 && hasYTD && (
          <>
            <td
              className={cn(
                "py-2.5 px-3 text-right tabular-nums text-[14px]",
                !isGroup && v23Var < 0 ? "text-status-error font-semibold" : "text-text-muted",
              )}
            >
              {isGroup ? "" : formatValue(v23Var)}
            </td>
            <td
              className={cn(
                "py-2.5 px-3 text-right tabular-nums text-[13px] border-r border-border-light",
                !isGroup && v23Pct < 0 ? "text-status-error" : "text-text-muted",
              )}
            >
              {isGroup ? "" : formatPercentage(v23Pct)}
            </td>
          </>
        )}

        {yearCols.length > 2 && hasYTD && (
          <>
            <td
              className={cn(
                "py-2.5 px-3 text-right tabular-nums text-[14px]",
                !isGroup && v24Var < 0 ? "text-status-error font-semibold" : "text-text-muted",
              )}
            >
              {isGroup ? "" : formatValue(v24Var)}
            </td>
            <td
              className={cn(
                "py-2.5 px-3 text-right tabular-nums text-[13px] border-r border-border-light",
                !isGroup && v24Pct < 0 ? "text-status-error" : "text-text-muted",
              )}
            >
              {isGroup ? "" : formatPercentage(v24Pct)}
            </td>
          </>
        )}

        {/* YTD Analysis — only when ytdComparison is present */}
        {hasYTD && (
          <>
            <td
              className={cn(
                "py-2.5 px-3 text-right tabular-nums text-[14px]",
                !isGroup && prevYTD < 0 ? "text-status-error font-semibold" : "text-text-secondary",
              )}
            >
              {isGroup ? "" : formatValue(prevYTD)}
            </td>
            <td
              className={cn(
                "py-2.5 px-3 text-right tabular-nums text-[14px] font-semibold",
                !isGroup && ytdVar < 0 ? "text-status-error" : "text-primary",
              )}
            >
              {isGroup ? "" : formatValue(ytdVar)}
            </td>
            <td
              className={cn(
                "py-2.5 px-4 text-right tabular-nums text-[13px] font-bold",
                !isGroup && ytdPct < 0 ? "text-status-error" : "text-text-primary",
              )}
            >
              {isGroup ? "" : formatPercentage(ytdPct)}
            </td>
          </>
        )}
      </tr>

      {hasChildren && isOpen && (
        line.children.map((child, index) => (
          <PNLRow key={child.id || `pnl-${depth}-${index}`} line={child} depth={depth + 1} columns={columns} />
        ))
      )}

      {/* Vendor breakdown rows */}
      {vendorsOpen && hasVendors && (
        <>
          <tr className="bg-bg-page/20">
            <td
              colSpan={50}
              style={{ paddingLeft: `${(depth + 1) * 24 + 16}px` }}
              className="py-1 text-[10px] font-bold uppercase tracking-widest text-text-muted"
            >
              Vendor
            </td>
          </tr>
          {line.vendors.map((vendor) => (
            <tr key={vendor.name} className="border-b border-border-light/50 hover:bg-bg-page/20">
              <td className="py-1.5 px-4 text-left sticky left-0 z-10 bg-bg-card border-r border-border-light">
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
                  {formatValue(vendor.amounts?.[col.key] || 0)}
                </td>
              ))}
              {hasYTD && <td className="py-1.5 px-3 text-right text-[13px] text-text-muted/50 whitespace-nowrap">—</td>}
              {yearCols.length > 1 && hasYTD && <><td className="py-1.5 px-3 text-right text-[13px] text-text-muted/50 whitespace-nowrap">—</td><td className="py-1.5 px-3 text-right text-[13px] text-text-muted/50 whitespace-nowrap">—</td></>}
              {yearCols.length > 2 && hasYTD && <><td className="py-1.5 px-3 text-right text-[13px] text-text-muted/50 whitespace-nowrap">—</td><td className="py-1.5 px-3 text-right text-[13px] text-text-muted/50 whitespace-nowrap">—</td></>}
              {hasYTD && <><td className="py-1.5 px-3 text-right text-[13px] text-text-muted/50 whitespace-nowrap">—</td><td className="py-1.5 px-3 text-right text-[13px] text-text-muted/50 whitespace-nowrap">—</td><td className="py-1.5 px-4 text-right text-[13px] text-text-muted/50 whitespace-nowrap">—</td></>}
            </tr>
          ))}
        </>
      )}
    </>
  );
};

// ─── Main Component ──────────────────────────────────────────────────────────

export default function ProfitAndLossSummary({
  data: reportData,
  title = "Profit & Loss",
  subtitle,
  entityName = "Company",
  isPreview = false,
}) {
  const { rows, columns } = useMemo(() => {
    if (!reportData) return { rows: [], columns: null };
    // If it's an array, it's the old format, wrap it
    if (Array.isArray(reportData)) return { rows: reportData, columns: null };
    return reportData;
  }, [reportData]);

  const yearCols = columns?.yearCols || [];
  const ytdComp = columns?.ytdComparison || {};
  const hasYTD = !!(ytdComp?.currentKey);

  if (!columns && (!rows || rows.length === 0)) {
    return (
      <div className={cn(
        "flex-1 flex flex-col items-center justify-center",
        isPreview ? "py-8" : "p-20 bg-bg-page/50 min-h-[500px]"
      )}>
        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-text-muted font-medium">Fetching comparison data...</p>
      </div>
    );
  }

  const columnWidths = [
    NAME_COL_WIDTH,
    ...yearCols.map(() => YEAR_COL_WIDTH),
    ...(hasYTD ? [YTD_CURRENT_COL_WIDTH] : []),
    ...(yearCols.length > 1 && hasYTD ? [VAR_DOLLAR_COL_WIDTH, VAR_PCT_COL_WIDTH] : []),
    ...(yearCols.length > 2 && hasYTD ? [VAR_DOLLAR_COL_WIDTH, VAR_PCT_COL_WIDTH] : []),
    ...(hasYTD ? [YTD_PREV_COL_WIDTH, YTD_VAR_COL_WIDTH, YTD_PCT_COL_WIDTH] : []),
  ];

  const headerRows = (
    <>
      {/* Row-level border-b renders through column labels with
          border-collapse, making dates appear to sit on the divider line.
          The fix: put border-b-2 on the <th> cells in the SECOND row
          (date/year labels) and on the rowSpan=2 Description cell, so the
          thick line sits cleanly BELOW all headers. */}
      <tr className="bg-bg-card">
        <th rowSpan={2} className="sticky left-0 z-20 bg-bg-card pt-3 pb-5 px-4 text-left text-[12px] font-medium text-text-muted whitespace-nowrap uppercase tracking-wider border-b-2 border-text-primary">
          Description
        </th>
        <th colSpan={hasYTD ? yearCols.length + 1 : yearCols.length} className="bg-bg-card pb-1 text-center text-[10px] font-bold text-text-muted/60 uppercase border-b border-border-light">Actuals</th>
        {yearCols.length > 1 && hasYTD && (
          <th colSpan={2} className="bg-bg-card pb-1 text-center text-[10px] font-bold text-text-muted/60 uppercase border-b border-border-light border-l border-border-light">
            {yearCols[1]?.label?.slice(-2)} Var
          </th>
        )}
        {yearCols.length > 2 && hasYTD && (
          <th colSpan={2} className="bg-bg-card pb-1 text-center text-[10px] font-bold text-text-muted/60 uppercase border-b border-border-light border-l border-border-light">
            {yearCols[2]?.label?.slice(-2)} Var
          </th>
        )}
        {hasYTD && (
          <th colSpan={3} className="bg-bg-card pb-1 text-right text-[10px] font-bold text-primary uppercase border-b border-border-light border-l border-border-light">YTD Analysis</th>
        )}
      </tr>
      <tr className="bg-bg-page/20">
        {yearCols.map((col, idx) => (
          <th key={idx} className="bg-bg-page/20 pt-3 pb-5 px-3 text-right text-[12px] font-medium text-text-muted uppercase whitespace-nowrap border-b-2 border-text-primary">
            {col.label}
          </th>
        ))}
        {hasYTD && (
          <th className="pt-3 pb-5 px-3 text-right text-[12px] font-bold text-text-primary bg-blue-50/30 border-b-2 border-text-primary">
            {ytdComp.currentLabel || "Current YTD"}
          </th>
        )}

        {yearCols.length > 1 && hasYTD && (
          <>
            <th className="bg-bg-page/20 pt-3 pb-5 px-3 text-right text-[11px] font-medium text-text-muted border-b-2 border-text-primary">$ Δ</th>
            <th className="bg-bg-page/20 pt-3 pb-5 px-3 text-right text-[11px] font-medium text-text-muted border-r border-border-light border-b-2 border-text-primary">% Δ</th>
          </>
        )}

        {yearCols.length > 2 && hasYTD && (
          <>
            <th className="bg-bg-page/20 pt-3 pb-5 px-3 text-right text-[11px] font-medium text-text-muted border-b-2 border-text-primary">$ Δ</th>
            <th className="bg-bg-page/20 pt-3 pb-5 px-3 text-right text-[11px] font-medium text-text-muted border-r border-border-light border-b-2 border-text-primary">% Δ</th>
          </>
        )}

        {hasYTD && (
          <>
            <th className="bg-bg-page/20 pt-3 pb-5 px-3 text-right text-[12px] font-medium text-text-muted border-b-2 border-text-primary">
              {ytdComp.prevLabel || "Prev YTD"}
            </th>
            <th className="bg-bg-page/20 pt-3 pb-5 px-3 text-right text-[12px] font-bold text-primary border-b-2 border-text-primary">$ Δ</th>
            <th className="bg-bg-page/20 pt-3 pb-5 px-4 text-right text-[12px] font-bold text-text-primary border-b-2 border-text-primary">% Δ</th>
          </>
        )}
      </tr>
    </>
  );

  return (
    <div className={cn("font-inter", isPreview ? "" : "bg-bg-page/50 p-10 lg:p-16")}>
      <div className={cn("flex flex-col", isPreview ? "" : "max-w-[1500px] mx-auto card-base p-10 min-h-[1000px] rounded-sm shadow-xl")}>

        {/* Header Section */}
        <div className={cn("flex flex-col items-center relative", isPreview ? "mb-4" : "mb-12")}>
          <div className="w-12 h-1 bg-primary rounded-full mb-3" />
          <h1 className="text-[20px] font-bold text-text-primary tracking-tight leading-none mb-1">
            {entityName}
          </h1>
          <h2 className="text-[16px] font-medium text-text-secondary mb-2">{title}</h2>
          {!isPreview && subtitle && (
            <div className="flex items-center gap-3 text-[12px] text-text-muted bg-bg-page px-4 py-1.5 rounded-full border border-border">
              <span>{subtitle}</span>
            </div>
          )}
        </div>

        <FrozenPaneTable columnWidths={columnWidths} headerRows={headerRows} tableClassName="min-w-max">
          {rows.map((row, index) => (
            <PNLRow
              key={row.id || `pnl-root-${index}`}
              line={row}
              depth={0}
              columns={columns}
            />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={12} className="py-20 text-center text-text-muted italic">
                No matching records found for the selected criteria.
              </td>
            </tr>
          )}
        </FrozenPaneTable>

        {/* Footer */}
        {!isPreview && <div className="mt-16 pt-8 border-t border-border flex flex-col items-center gap-4">
          <div className="flex items-center gap-8">
            <div className="flex flex-col items-center">
              <span className="text-[11px] text-text-muted mb-1">Generated on</span>
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
            This Profit & Loss statement provides a detailed comparative analysis of the company&apos;s financial performance.
          </p>
        </div>}
      </div>

      <style>{`
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
    </div>
  );
}

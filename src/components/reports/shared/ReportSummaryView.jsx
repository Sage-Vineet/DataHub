import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn, formatCurrency } from "../../../lib/utils";

function SummaryRow({ line, depth = 0 }) {
  const [isOpen, setIsOpen] = useState(true);
  const hasChildren = Boolean(line.children?.length);
  const isCategory = line.type === "header";
  const isTotal = line.type === "total";

  const toggle = (event) => {
    if (!hasChildren) return;
    event.stopPropagation();
    setIsOpen((previous) => !previous);
  };

  return (
    <div className="flex flex-col">
      <div
        onClick={toggle}
        className={cn(
          "group flex items-center justify-between border-b border-border-light px-4 py-2.5 transition-colors",
          hasChildren && "cursor-pointer hover:bg-bg-page/50",
          !hasChildren && "hover:bg-bg-page/30",
          isTotal && "mt-1 mb-2 border-b-2 border-text-primary bg-bg-page/60 font-semibold",
          isCategory && depth === 0 && "mt-4 border-t border-border bg-bg-page/30",
        )}
      >
        <div className="flex flex-1 items-center gap-1">
          <div className="flex shrink-0">
            {Array.from({ length: depth }).map((_, index) => (
              <div
                key={index}
                className="mr-[-1px] h-5 w-6 border-r border-border-light"
              />
            ))}
          </div>

          <div className="flex w-5 items-center justify-center">
            {hasChildren ? (
              isOpen ? (
                <ChevronDown
                  size={14}
                  className="text-text-muted group-hover:text-text-primary"
                />
              ) : (
                <ChevronRight
                  size={14}
                  className="text-text-muted group-hover:text-text-primary"
                />
              )
            ) : null}
          </div>

          <span
            className={cn(
              "text-[14px]",
              isCategory ? "font-semibold text-text-primary" : "text-text-secondary",
              isTotal && "font-semibold text-text-primary",
              depth > 1 && !isTotal && "text-text-muted",
            )}
          >
            {line.name}
          </span>
        </div>

        <div
          className={cn(
            "min-w-[140px] text-right text-[14px] tabular-nums",
            isTotal
              ? "border-t border-text-muted pt-0.5 font-semibold"
              : "font-medium text-text-primary",
            Number(line.amount) < 0 ? "font-semibold text-status-error" : "text-text-primary",
          )}
        >
          {formatCurrency(line.amount)}
        </div>
      </div>

      {hasChildren && isOpen ? (
        <div className="flex flex-col">
          {line.children.map((child, index) => (
            <SummaryRow
              key={child.id || `${line.id || "summary"}-${depth}-${index}`}
              line={child}
              depth={depth + 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function ReportSummaryView({
  data,
  title,
  subtitle,
  classificationLabel = "Accounting Classification",
  footerText = "This report provides a granular financial summary.",
}) {
  return (
    <div className="flex-1 overflow-y-auto bg-bg-page/50 p-10 lg:p-16">
      <div className="card-base mx-auto flex min-h-[1000px] max-w-4xl flex-col rounded-sm p-10">
        <div className="relative mb-12 flex flex-col items-center">
          <div className="mb-6 h-1 w-12 rounded-full bg-primary" />
          <h1 className="mb-2 text-[22px] font-bold leading-none tracking-tight text-text-primary">
            Sage Healthy RCM, LLC
          </h1>
          <h2 className="mb-4 text-[18px] font-medium text-text-secondary">{title}</h2>
          <div className="flex items-center gap-3 rounded-full border border-border bg-bg-page px-4 py-1.5 text-[12px] text-text-muted">
            <span>{subtitle}</span>
          </div>
        </div>

        <div className="sticky top-0 z-10 flex items-center justify-between border-b-2 border-text-primary bg-bg-card px-4 pb-3 pt-2">
          <span className="text-[12px] font-medium text-text-muted">{classificationLabel}</span>
          <span className="text-[12px] font-medium text-text-muted">Amount (USD)</span>
        </div>

        <div className="flex-1 py-4">
          {Array.isArray(data) && data.length > 0 ? (
            data.map((category, index) => (
              <SummaryRow
                key={category.id || `summary-category-${index}`}
                line={category}
                depth={0}
              />
            ))
          ) : (
            <div className="py-20 text-center italic text-text-muted">
              No report data found for this period.
            </div>
          )}
        </div>

        <div className="mt-16 flex flex-col items-center gap-4 border-t border-border pt-8">
          <div className="flex items-center gap-8">
            <div className="flex flex-col items-center">
              <span className="mb-1 text-[11px] text-text-muted">Created on</span>
              <span className="text-[12px] font-medium text-text-primary">April 9, 2026</span>
            </div>
            <div className="h-6 w-px bg-border" />
            <div className="flex flex-col items-center">
              <span className="mb-1 text-[11px] text-text-muted">Status</span>
              <span className="text-[12px] font-medium text-primary">Consolidated & Verified</span>
            </div>
          </div>
          <p className="max-w-sm text-center text-[11px] leading-relaxed text-text-muted">
            {footerText}
          </p>
        </div>
      </div>
    </div>
  );
}

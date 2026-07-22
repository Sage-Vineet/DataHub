import { useCallback, useMemo, useRef } from "react";
import { cn } from "../../../lib/utils";

// With `table-layout: fixed`, a column's specified width is only a floor
// unless the table itself is at least that wide — otherwise the browser
// compresses every column to fit a narrower container instead of triggering
// horizontal scroll. Auto-computing the table's min-width from the column
// widths (rather than relying on every caller to remember a min-w-* class)
// is what keeps columns at their intended size and pushes overflow into the
// scrollbar, exactly like Excel's fixed column widths.
function sumPxWidths(widths) {
  let total = 0;
  for (const width of widths) {
    const match = /^(\d+(?:\.\d+)?)px$/.exec(String(width || "").trim());
    if (!match) return null;
    total += Number(match[1]);
  }
  return total;
}

/**
 * Excel-style frozen-pane table: a header that is permanently visible (stuck
 * to the actual scrolling page, not a nested scroll box) and a body that
 * scrolls horizontally on its own when columns don't fit — with zero
 * internal vertical scrollbar. Column alignment between the two is kept
 * pixel-perfect via an identical <colgroup> applied to both tables.
 *
 * WHY two <table> elements instead of one <table><thead style="position:
 * sticky"> wrapped in a single overflow-x-auto div: per the CSS Overflow
 * spec, giving an element `overflow-x: auto` forces its COMPUTED
 * `overflow-y` to `auto` too, which makes that div — not the real scrolling
 * page — the nearest ancestor "scroll container" that `position: sticky`
 * resolves against. Since the div's height always exactly fits its content,
 * it never actually scrolls internally, so a sticky header inside it would
 * never track real page scroll — it would just sit at its static position
 * and scroll away with everything else. Splitting header and body into
 * sibling tables (only the body wrapped in overflow-x-auto) removes that
 * broken intermediate scroll container entirely, so `position: sticky; top:
 * 0` on the header resolves against the actual page (<main>) and genuinely
 * stays put — this is the same technique already used successfully by
 * ManualBalanceSheetMonthlyDetail.jsx, generalized for reuse.
 *
 * The first column's sticky-left behavior is NOT handled here — each
 * consumer applies `sticky left-0` directly to its own first-column cells
 * (both in its header row and its body rows), since the exact cell markup
 * (indentation, expand icons, row-type styling) is report-specific.
 */
export default function FrozenPaneTable({
  columnWidths,
  headerRows,
  children,
  className,
  headerClassName = "bg-bg-card",
  tableClassName,
  minWidth,
}) {
  const headerScrollRef = useRef(null);

  const onBodyScroll = useCallback((e) => {
    if (headerScrollRef.current) headerScrollRef.current.scrollLeft = e.currentTarget.scrollLeft;
  }, []);

  const colGroup = Array.isArray(columnWidths) ? (
    <colgroup>
      {columnWidths.map((width, index) => (
        <col key={index} style={width ? { width, minWidth: width } : undefined} />
      ))}
    </colgroup>
  ) : null;

  const computedMinWidth = useMemo(
    () => (Array.isArray(columnWidths) ? sumPxWidths(columnWidths) : null),
    [columnWidths],
  );
  const resolvedMinWidth = minWidth ?? (computedMinWidth ? `${computedMinWidth}px` : undefined);
  const tableStyle = { minWidth: resolvedMinWidth, ...(colGroup ? { tableLayout: "fixed" } : null) };

  return (
    <div className={cn("w-full", className)}>
      <div className={cn("sticky top-0 z-30", headerClassName)}>
        <div ref={headerScrollRef} className="overflow-x-hidden">
          <table className={cn("w-full border-collapse", tableClassName)} style={tableStyle}>
            {colGroup}
            <thead>{headerRows}</thead>
          </table>
        </div>
      </div>
      <div className="overflow-x-auto" onScroll={onBodyScroll}>
        <table className={cn("w-full border-collapse", tableClassName)} style={tableStyle}>
          {colGroup}
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { fieldStatusClass } from "./customTemplateUiUtils";

function useElementWidth(ref) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function groupPlaceholdersByElement(placeholders = []) {
  const groups = new Map();
  placeholders.forEach((placeholder) => {
    const key = `${placeholder.elementType || "text"}:${placeholder.elementIndex ?? "0"}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        elementType: placeholder.elementType,
        bbox: placeholder.slideCoordinates,
        placeholders: [],
      });
    }
    groups.get(key).placeholders.push(placeholder);
  });
  return Array.from(groups.values());
}

function groupByParagraph(placeholders = []) {
  const byParagraph = new Map();
  placeholders.forEach((placeholder) => {
    const key = placeholder.paragraphIndex ?? placeholder.id;
    if (!byParagraph.has(key)) byParagraph.set(key, []);
    byParagraph.get(key).push(placeholder);
  });
  return Array.from(byParagraph.values())
    .map((items) => items.slice().sort((a, b) => (a.tokenStart || 0) - (b.tokenStart || 0)))
    .sort((a, b) => (a[0]?.paragraphIndex || 0) - (b[0]?.paragraphIndex || 0));
}

function ParagraphLine({ items, mappings, activeFieldId, onFieldFocus }) {
  const text = items[0]?.paragraphText || "";
  const segments = [];
  let cursor = 0;
  items.forEach((placeholder) => {
    const start = placeholder.tokenStart ?? 0;
    const end = (placeholder.tokenEnd ?? 0) + (placeholder.suffix?.length || 0);
    if (start > cursor) segments.push({ type: "text", text: text.slice(cursor, start), key: `t-${placeholder.id}-pre` });
    segments.push({ type: "placeholder", placeholder, key: placeholder.id });
    cursor = Math.max(cursor, end);
  });
  if (cursor < text.length) segments.push({ type: "text", text: text.slice(cursor), key: "t-end" });

  const tableRel = items[0]?.tableChartRelationships?.table;
  const rowLabel = tableRel ? (tableRel.columnHeader || tableRel.rowLabel) : "";

  return (
    <p className="mb-1 leading-snug last:mb-0">
      {rowLabel ? <span className="mr-1 text-[9px] font-bold uppercase text-[#8BC53D]">{rowLabel}:</span> : null}
      {segments.map((segment) => {
        if (segment.type === "text") return <span key={segment.key}>{segment.text}</span>;
        const mapping = mappings?.[segment.placeholder.id];
        const value = mapping?.value || segment.placeholder.placeholderText;
        const isActive = activeFieldId === segment.placeholder.id;
        return (
          <button
            key={segment.key}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onFieldFocus(segment.placeholder.id);
            }}
            className={`mx-0.5 rounded border px-1 font-semibold ${fieldStatusClass(mapping)} ${
              isActive ? "ring-2 ring-[#8BC53D]" : ""
            }`}
          >
            {value}
          </button>
        );
      })}
    </p>
  );
}

export default function CustomTemplateSlideCanvas({
  slide,
  slideWidthPx = 1280,
  slideHeightPx = 720,
  mappings = {},
  activeFieldId,
  onFieldFocus,
}) {
  const stageRef = useRef(null);
  const stageWidth = useElementWidth(stageRef);
  const scale = stageWidth > 0 ? stageWidth / slideWidthPx : 1;

  const groups = useMemo(() => groupPlaceholdersByElement(slide?.placeholders || []), [slide]);

  return (
    <div
      ref={stageRef}
      className="relative mx-auto w-full overflow-hidden rounded-md border border-dashed border-border bg-white"
      style={{ aspectRatio: `${slideWidthPx} / ${slideHeightPx}` }}
    >
      {groups.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-[#A5A5A5]">
          No [bracketed] fields detected on this slide.
        </div>
      ) : (
        groups.map((group) => {
          const [x = 40, y = 40, w = 300, h = 80] = group.bbox || [];
          const paragraphs = groupByParagraph(group.placeholders);
          return (
            <div
              key={group.key}
              className="absolute overflow-auto rounded border border-[#8BC53D]/30 bg-white/95 p-1.5 text-[11px] text-[#050505] shadow-sm"
              style={{
                left: x * scale,
                top: y * scale,
                width: Math.max(60, w * scale),
                height: Math.max(28, h * scale),
              }}
            >
              {group.elementType === "table" ? (
                <p className="mb-0.5 text-[9px] font-bold uppercase text-[#6D6E71]">Table</p>
              ) : group.elementType === "chart" ? (
                <p className="mb-0.5 text-[9px] font-bold uppercase text-[#6D6E71]">Chart</p>
              ) : null}
              {paragraphs.map((items) => (
                <ParagraphLine
                  key={items[0]?.id}
                  items={items}
                  mappings={mappings}
                  activeFieldId={activeFieldId}
                  onFieldFocus={onFieldFocus}
                />
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}

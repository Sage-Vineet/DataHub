import { useMemo } from "react";
import { ChevronRight, PanelLeft } from "lucide-react";
import { countMappingsWithData } from "./customTemplateUiUtils";

export default function CustomTemplateSectionDrawer({
  sections = [],
  activeSectionId,
  slides = [],
  mappings = {},
  onSelectSection,
}) {
  const placeholdersBySlide = useMemo(() => {
    const map = new Map();
    slides.forEach((slide) => map.set(slide.slideNumber, slide.placeholders || []));
    return map;
  }, [slides]);

  return (
    <aside className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto rounded-lg border border-border bg-white p-3 shadow-card">
      <div className="mb-3 flex items-center gap-2 px-1 text-xs font-bold uppercase tracking-[0.08em] text-[#6D6E71]">
        <PanelLeft size={14} />
        Template Sections
      </div>
      <nav className="space-y-1">
        {sections.map((section) => {
          const placeholders = section.slideNumbers.flatMap((slideNumber) => placeholdersBySlide.get(slideNumber) || []);
          const completed = countMappingsWithData(placeholders, mappings);
          const total = placeholders.length;
          const isActive = activeSectionId === section.id;

          return (
            <button
              key={section.id}
              onClick={() => onSelectSection(section.id)}
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition ${
                isActive
                  ? "bg-[#EEF6E0] text-[#476E2C]"
                  : "text-[#6D6E71] hover:bg-[#F0F7E6] hover:text-[#1A1A2E]"
              }`}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#476E2C] text-xs font-bold text-white">
                {section.number}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{section.title}</span>
                <span className="block text-[11px] text-[#A5A5A5]">
                  {section.slideNumbers.length} slide{section.slideNumbers.length === 1 ? "" : "s"} · {completed}/{total} fields
                </span>
              </span>
              <ChevronRight size={14} className={isActive ? "text-[#8BC53D]" : "text-[#A5A5A5]"} />
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

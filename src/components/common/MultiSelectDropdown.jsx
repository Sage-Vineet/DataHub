import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";

/**
 * Reusable checkbox dropdown for selecting multiple values from a list.
 *
 * Bound to an array: `values: string[]` + `onChange(nextValues: string[])`.
 * Renders its own `label` only when one is provided (callers that lay out their
 * own label — e.g. the reports toolbar — should omit it).
 *
 * Originally lived inline in ManualFiltersPanel as `MultiSelectSearch`; extracted
 * here and given an outside-click handler so it closes when used standalone.
 */
export default function MultiSelectDropdown({
  label,
  options = [],
  values = [],
  onChange,
  placeholder = "Select values",
  className = "",
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const normalizedOptions = useMemo(
    () => options.map((option) => String(option)),
    [options],
  );

  const filtered = useMemo(() => {
    const normalizedQuery = String(query || "").trim().toLowerCase();
    if (!normalizedQuery) return normalizedOptions;
    return normalizedOptions.filter((option) =>
      option.toLowerCase().includes(normalizedQuery),
    );
  }, [normalizedOptions, query]);

  const selectedLabel =
    values.length === 0
      ? placeholder
      : values.length === 1
        ? String(values[0])
        : `${values.length} selected`;

  const toggleValue = (option) => {
    const exists = values.includes(option);
    if (exists) {
      onChange(values.filter((value) => value !== option));
    } else {
      onChange([...values, option]);
    }
  };

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      {label ? (
        <label className="block text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-1">
          {label}
        </label>
      ) : null}
      <button
        type="button"
        onClick={() => setIsOpen((previous) => !previous)}
        className="h-9 w-full rounded-md border border-border-input bg-bg-card px-3 text-left text-[13px] text-text-primary flex items-center justify-between transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown size={14} className="text-text-muted shrink-0" />
      </button>

      {isOpen ? (
        <div className="absolute z-30 mt-1 w-full min-w-[160px] rounded-md border border-border bg-bg-card shadow-lg">
          <div className="p-2 border-b border-border">
            <div className="flex items-center gap-2 rounded-md border border-border-input px-2 py-1">
              <Search size={12} className="text-text-muted" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search..."
                className="w-full bg-transparent text-[12px] text-text-primary outline-none"
              />
            </div>
          </div>
          <div className="max-h-44 overflow-y-auto p-2 space-y-1">
            {filtered.map((option) => (
              <label key={option} className="flex items-center gap-2 rounded-md px-2 py-1 text-[12px] text-text-secondary hover:bg-bg-page cursor-pointer">
                <input
                  type="checkbox"
                  checked={values.includes(option)}
                  onChange={() => toggleValue(option)}
                  className="h-3.5 w-3.5"
                />
                <span className="truncate">{option}</span>
              </label>
            ))}
            {!filtered.length ? (
              <p className="px-2 py-3 text-[12px] text-text-muted italic">No values</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

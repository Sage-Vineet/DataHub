import { useMemo, useState } from "react";
import { ChevronDown, Loader2, RotateCcw, Search } from "lucide-react";

function MultiSelectSearch({
  label,
  options = [],
  values = [],
  onChange,
  placeholder = "Select values",
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const normalizedQuery = String(query || "").trim().toLowerCase();
    if (!normalizedQuery) return options;
    return options.filter((option) =>
      String(option).toLowerCase().includes(normalizedQuery),
    );
  }, [options, query]);

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
    <div className="relative">
      <label className="block text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-1">
        {label}
      </label>
      <button
        type="button"
        onClick={() => setIsOpen((previous) => !previous)}
        className="h-9 w-full rounded-md border border-border-input bg-bg-card px-3 text-left text-[13px] text-text-primary flex items-center justify-between"
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown size={14} className="text-text-muted shrink-0" />
      </button>

      {isOpen ? (
        <div className="absolute z-30 mt-1 w-full rounded-md border border-border bg-bg-card shadow-lg">
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

export default function ManualFiltersPanel({
  filters,
  options,
  onFiltersChange,
  onApply,
  onReset,
  isLoading = false,
  isApplying = false,
  validationErrors = [],
}) {
  const setArrayFilter = (key, values) => {
    onFiltersChange({
      ...filters,
      [key]: values,
    });
  };

  const setDateFilter = (key, value) => {
    onFiltersChange({
      ...filters,
      [key]: value,
    });
  };

  return (
    <div className="mb-6 rounded-lg border border-border bg-bg-page/40 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[13px] font-semibold text-text-primary">Manual Report Filters</h3>
        {isLoading ? (
          <div className="flex items-center gap-2 text-[12px] text-text-muted">
            <Loader2 size={13} className="animate-spin" />
            Loading options...
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <MultiSelectSearch
          label="Fiscal Year"
          options={options?.fiscalYear || []}
          values={filters.fiscalYear || []}
          onChange={(values) => setArrayFilter("fiscalYear", values)}
        />
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-1">
            Start Date
          </label>
          <input
            type="date"
            value={filters.startDate || ""}
            onChange={(event) => setDateFilter("startDate", event.target.value)}
            className="h-9 w-full rounded-md border border-border-input bg-bg-card px-3 text-[13px] text-text-primary"
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-1">
            End Date
          </label>
          <input
            type="date"
            value={filters.endDate || ""}
            onChange={(event) => setDateFilter("endDate", event.target.value)}
            className="h-9 w-full rounded-md border border-border-input bg-bg-card px-3 text-[13px] text-text-primary"
          />
        </div>
        <MultiSelectSearch
          label="Report Type"
          options={options?.reportType || []}
          values={filters.reportType || []}
          onChange={(values) => setArrayFilter("reportType", values)}
        />
        <MultiSelectSearch
          label="Account Name"
          options={options?.accountName || []}
          values={filters.accountName || []}
          onChange={(values) => setArrayFilter("accountName", values)}
        />
        <MultiSelectSearch
          label="Account Number"
          options={options?.accountNumber || []}
          values={filters.accountNumber || []}
          onChange={(values) => setArrayFilter("accountNumber", values)}
        />
        <MultiSelectSearch
          label="Account Type"
          options={options?.accountType || []}
          values={filters.accountType || []}
          onChange={(values) => setArrayFilter("accountType", values)}
        />
        <MultiSelectSearch
          label="Category"
          options={options?.category || []}
          values={filters.category || []}
          onChange={(values) => setArrayFilter("category", values)}
        />
        <MultiSelectSearch
          label="Subcategory"
          options={options?.subCategory || []}
          values={filters.subCategory || []}
          onChange={(values) => setArrayFilter("subCategory", values)}
        />
        <MultiSelectSearch
          label="Department"
          options={options?.department || []}
          values={filters.department || []}
          onChange={(values) => setArrayFilter("department", values)}
        />
        <MultiSelectSearch
          label="Class"
          options={options?.class || []}
          values={filters.class || []}
          onChange={(values) => setArrayFilter("class", values)}
        />
        <MultiSelectSearch
          label="Location"
          options={options?.location || []}
          values={filters.location || []}
          onChange={(values) => setArrayFilter("location", values)}
        />
        <MultiSelectSearch
          label="Source File"
          options={options?.sourceFile || []}
          values={filters.sourceFile || []}
          onChange={(values) => setArrayFilter("sourceFile", values)}
        />
        <MultiSelectSearch
          label="Transaction Type"
          options={options?.transactionType || []}
          values={filters.transactionType || []}
          onChange={(values) => setArrayFilter("transactionType", values)}
        />
      </div>

      {Array.isArray(validationErrors) && validationErrors.length > 0 ? (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2">
          <p className="text-[12px] font-semibold text-red-700 mb-1">Filter validation</p>
          <ul className="text-[12px] text-red-600 space-y-0.5">
            {validationErrors.map((error, index) => (
              <li key={`filter-error-${index}`}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={onApply}
          disabled={isApplying}
          className="btn-primary h-9 px-4 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isApplying ? <Loader2 size={14} className="animate-spin" /> : null}
          Apply Filters
        </button>
        <button
          type="button"
          onClick={onReset}
          className="btn-secondary h-9 px-3"
        >
          <RotateCcw size={14} />
          Reset
        </button>
      </div>
    </div>
  );
}

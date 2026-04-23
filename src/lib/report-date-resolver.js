/**
 * Centralized filter/date resolver for financial reports.
 *
 * Decides startDate / endDate based on:
 *   - reportType  ("Balance Sheet" | "Profit & Loss" | "Cashflow")
 *   - viewType    ("Summary" | "Detail")
 *   - user filters
 *
 * ┌───────────────┬──────────┬──────────────────────────────────────┐
 * │ Report Type   │ View     │ Behavior                             │
 * ├───────────────┼──────────┼──────────────────────────────────────┤
 * │ Balance Sheet │ Summary  │ Ignore filters (system multi-year)   │
 * │ Balance Sheet │ Detail   │ Use user filters                     │
 * │ Profit & Loss │ Summary  │ Ignore filters (system multi-year)   │
 * │ Profit & Loss │ Detail   │ Use user filters                     │
 * │ Cashflow      │ Summary  │ Use user filters                     │
 * │ Cashflow      │ Detail   │ Use user filters                     │
 * └───────────────┴──────────┴──────────────────────────────────────┘
 */

function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * @param {object}  options
 * @param {string}  options.reportType  – "Balance Sheet" | "Profit & Loss" | "Cashflow"
 * @param {string}  options.viewType    – "Summary" | "Detail"
 * @param {object}  [options.filters]   – { startDate, endDate }
 * @returns {{ mode: string, useFilters: boolean, startDate: string, endDate: string, label: string }}
 */
export function getDateRange({ reportType, viewType, filters = {} }) {
  const now = new Date();
  const todayStr = formatLocalDate(now);
  const yearStartStr = `${now.getFullYear()}-01-01`;

  const isSummary = viewType === "Summary";

  // ── Balance Sheet ─────────────────────────────────────────────
  if (reportType === "Balance Sheet") {
    if (isSummary) {
      // Summary: user-selected filters (QuickBooks-style report)
      return {
        mode: "user",
        useFilters: true,
        startDate: filters.startDate || yearStartStr,
        endDate: filters.endDate || todayStr,
        label: "User-selected date range (Summary)",
      };
    }
    // Detail: system-defined multi-year comparison (service handles internally)
    return {
      mode: "system",
      useFilters: false,
      startDate: yearStartStr,
      endDate: todayStr,
      label: "System-defined multi-year comparison (Detail)",
    };
  }

  // ── Profit & Loss ─────────────────────────────────────────────
  if (reportType === "Profit & Loss") {
    if (isSummary) {
      // Summary: user-selected filters (QuickBooks-style report)
      return {
        mode: "user",
        useFilters: true,
        startDate: filters.startDate || yearStartStr,
        endDate: filters.endDate || todayStr,
        label: "User-selected date range (Summary)",
      };
    }
    // Detail: system-defined multi-year comparison (service handles internally)
    return {
      mode: "system",
      useFilters: false,
      startDate: yearStartStr,
      endDate: todayStr,
      label: "System-defined multi-year comparison (Detail)",
    };
  }

  // ── Cashflow ──────────────────────────────────────────────────
  if (reportType === "Cashflow") {
    if (isSummary) {
      // Summary: user-selected filters
      return {
        mode: "user",
        useFilters: true,
        startDate: filters.startDate || yearStartStr,
        endDate: filters.endDate || todayStr,
        label: "User-selected date range (Summary)",
      };
    }
    // Detail: system-defined multi-year comparison
    return {
      mode: "system",
      useFilters: false,
      startDate: yearStartStr,
      endDate: todayStr,
      label: "System-defined multi-year comparison (Detail)",
    };
  }

  // ── Default ───────────────────────────────────────────────────
  return {
    mode: "user",
    useFilters: true,
    startDate: filters.startDate || yearStartStr,
    endDate: filters.endDate || todayStr,
    label: isSummary ? "Default date range" : "User-selected date range",
  };
}


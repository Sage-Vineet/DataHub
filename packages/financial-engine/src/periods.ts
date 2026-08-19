import type { Aggregation, GlEntry, Period } from "./types.js";

/** Period key used throughout the engine: `"2024"` annual, `"2024-07"` monthly. */
export function periodKey(fiscalYear: number, month: number | null): string {
  return month === null ? String(fiscalYear) : `${fiscalYear}-${String(month).padStart(2, "0")}`;
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function periodLabel(fiscalYear: number, month: number | null): string {
  return month === null ? `FY${fiscalYear}` : `${MONTH_LABELS[month - 1]} ${fiscalYear}`;
}

/**
 * Build the displayed columns.
 *
 * `QE - 0004` requires periods to be chosen individually rather than through a
 * continuous range picker, so this takes an explicit list of fiscal years and
 * never a start/end pair. Monthly aggregation expands each selected year into
 * only the months that actually carry data.
 */
export function buildPeriods(
  entries: GlEntry[],
  selectedYears: number[],
  aggregation: Aggregation,
): Period[] {
  const years = [...new Set(selectedYears)].sort((a, b) => a - b);
  if (aggregation === "annual") {
    return years.map((fiscalYear) => ({
      fiscalYear,
      month: null,
      label: periodLabel(fiscalYear, null),
    }));
  }

  const monthsByYear = new Map<number, Set<number>>();
  for (const entry of entries) {
    if (!years.includes(entry.fiscalYear) || entry.month < 1 || entry.month > 12) continue;
    let months = monthsByYear.get(entry.fiscalYear);
    if (!months) monthsByYear.set(entry.fiscalYear, (months = new Set()));
    months.add(entry.month);
  }

  return years.flatMap((fiscalYear) =>
    [...(monthsByYear.get(fiscalYear) ?? [])]
      .sort((a, b) => a - b)
      .map((month) => ({ fiscalYear, month, label: periodLabel(fiscalYear, month) })),
  );
}

/** Which displayed period a GL row belongs to. */
export function periodKeyFor(entry: GlEntry, aggregation: Aggregation): string {
  return aggregation === "annual"
    ? periodKey(entry.fiscalYear, null)
    : periodKey(entry.fiscalYear, entry.month);
}

/** Money rounding. Applied at aggregation boundaries, never mid-sum. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function emptyAmounts(periods: Period[]): Record<string, number> {
  return Object.fromEntries(periods.map((p) => [periodKey(p.fiscalYear, p.month), 0]));
}

export function roundAmounts(amounts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(amounts).map(([k, v]) => [k, round2(v)]));
}

export function sumAmounts(
  target: Record<string, number>,
  source: Record<string, number>,
  sign = 1,
): Record<string, number> {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (current !== undefined) target[key] = current + sign * value;
  }
  return target;
}

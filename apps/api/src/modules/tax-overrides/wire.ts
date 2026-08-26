import { BadRequestError } from "../../shared/errors.js";
import type { TaxOverride, TaxOverrideInput } from "./ports.js";

/**
 * The shape the page speaks, which is nested and keyed by strings.
 *
 *   { "2024": { "Meals & Entertainment": { taxReturn: 1200, pl: 900 } } }
 *
 * Kept at the edge rather than pushed inward. It is a convenient shape for a
 * screen — the page holds it as component state and indexes into it directly —
 * and a poor one for storage, where the year is an integer and each cell wants
 * its own identity. Translating in one place lets both sides be right.
 */
export type OverrideMap = Record<
  string,
  Record<string, { taxReturn?: unknown; pl?: unknown; userAdded?: unknown }>
>;

/**
 * A figure as the page sends it.
 *
 * The page sends "" for a field somebody cleared and a number for one they
 * typed. Those are different: cleared means "no correction here, use what was
 * extracted", and a zero means "this line really is nil". Coercing "" to 0
 * would turn every cleared cell into an assertion that the figure is zero.
 */
export function toAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse the page's map into rows, refusing what cannot be stored. */
export function toOverrides(map: unknown): TaxOverrideInput[] {
  if (map === null || typeof map !== "object" || Array.isArray(map)) {
    throw new BadRequestError("overrides must be an object keyed by fiscal year.");
  }

  const rows: TaxOverrideInput[] = [];
  for (const [yearKey, lines] of Object.entries(map as OverrideMap)) {
    const fiscalYear = Number.parseInt(yearKey, 10);
    // A key that is not a year cannot be matched against a return, and storing
    // it would leave a correction nothing ever reads.
    if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 2200) {
      throw new BadRequestError(`Not a fiscal year: "${yearKey}".`);
    }
    if (lines === null || typeof lines !== "object" || Array.isArray(lines)) {
      throw new BadRequestError(`The ${fiscalYear} overrides must be an object keyed by line.`);
    }

    for (const [rawLabel, cell] of Object.entries(lines)) {
      const lineLabel = String(rawLabel).trim();
      // An empty label cannot be matched against anything on the return.
      if (!lineLabel) continue;
      const value = (cell ?? {}) as { taxReturn?: unknown; pl?: unknown; userAdded?: unknown };
      rows.push({
        fiscalYear,
        lineLabel,
        taxReturnAmount: toAmount(value.taxReturn),
        bookAmount: toAmount(value.pl),
        userAdded: value.userAdded === true,
      });
    }
  }
  return rows;
}

/** Rebuild the page's map from stored rows. */
export function toOverrideMap(overrides: readonly TaxOverride[]): OverrideMap {
  const map: OverrideMap = {};
  for (const override of overrides) {
    const year = String(override.fiscalYear);
    const lines = (map[year] ??= {});
    lines[override.lineLabel] = {
      taxReturn: override.taxReturnAmount,
      pl: override.bookAmount,
      // Only when true. The page treats the flag's presence as meaningful, and
      // a `userAdded: false` on every cell is noise it has to filter.
      ...(override.userAdded ? { userAdded: true } : {}),
    };
  }
  return map;
}

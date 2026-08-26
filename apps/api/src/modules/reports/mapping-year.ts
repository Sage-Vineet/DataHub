/**
 * The year a file is about, read from its name.
 *
 * A weak signal by nature — it is a file name — so it is only ever a default a
 * user can correct, and `null` is a perfectly good answer.
 *
 * ONE BEHAVIOUR CHANGE FROM LEGACY, AND IT IS A FIX
 * ------------------------------------------------
 * `keyReportValidationService.js` builds its month-year pattern with
 * `new RegExp(monthPattern + '[\s._-]*(\d{2,4})', 'ig')`. That second argument
 * is a STRING literal, not a regex literal, so `\s` and `\d` are not escapes —
 * they collapse to the plain characters `s` and `d`. The pattern that actually
 * compiles is `[s._-]*(d{2,4})`, which hunts for literal `d`s:
 *
 *     "Financials Jan 24.pdf"  →  no match
 *
 * So the month-year branch has never fired, and only the four-digit regex
 * literal alongside it (`/(?:19|20)\d{2}/g`, correctly written) ever produced a
 * year. Written properly here, which means two-digit forms now resolve — the
 * behaviour the legacy code was reaching for and did not get.
 */

const FULL_YEAR = /(?:19|20)\d{2}/g;

const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|" +
  "jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

/** A month name, then a 2–4 digit year, with separators between. */
const MONTH_YEAR = new RegExp(`${MONTH}[\\s._-]*(\\d{2,4})`, "ig");

/**
 * A year, however it was written.
 *
 * Two digits are windowed: 70–99 read as 19xx, 00–69 as 20xx. The cut is
 * legacy's and is kept — a "70" in a file name is far likelier to be 1970 than
 * 2070, and moving the boundary would silently reinterpret existing rows.
 */
export function normalizeYear(value: unknown): number | null {
  const year = Number(value);
  if (!Number.isFinite(year) || year < 0) return null;
  if (year >= 1000 && year <= 9999) return year;
  if (year > 0 && year <= 99) return year >= 70 ? 1900 + year : 2000 + year;
  return null;
}

/** Every year mentioned in a piece of text, ascending. */
export function yearsInText(value: unknown): number[] {
  const text = String(value ?? "").trim();
  if (!text) return [];

  const years = new Set<number>();
  for (const match of text.match(FULL_YEAR) ?? []) years.add(Number(match));

  // `lastIndex` persists on a /g regex between calls, so it is reset rather
  // than trusted — otherwise the second file name scanned starts part-way in.
  MONTH_YEAR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MONTH_YEAR.exec(text)) !== null) {
    const year = normalizeYear(match[1]);
    if (year !== null) years.add(year);
  }

  return [...years].sort((a, b) => a - b);
}

/**
 * The single year to record for a mapping: the latest mentioned.
 *
 * "FY2023 vs FY2024.xlsx" is filed under 2024 — a comparative document is
 * about the later period, and the earlier one is context.
 */
export function inferMappingYear(fileName: string | null | undefined): number | null {
  const years = yearsInText(fileName);
  return years.length > 0 ? (years[years.length - 1] ?? null) : null;
}

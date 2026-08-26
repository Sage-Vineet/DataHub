/**
 * Where a stored ledger row falls, and whether it falls anywhere at all.
 *
 * Two places read `general_ledger_entries` into something a report can add up
 * — the engagement loader and the monthly drill-down — and both had their own
 * copy of this decision. Two copies of "which year is this row in?" is one
 * that can drift, and the drift would show as two reports disagreeing about a
 * company's own ledger with nothing on either page to say which was right.
 */

/** The columns the placement decision reads. */
export interface LedgerRowPlacement {
  coaId: string | null;
  fiscalYear: number | null;
  transactionDate: string | null;
}

export interface PostedAt {
  accountId: string;
  fiscalYear: number;
  /** 1–12, or 0 for a row dated to a year but not to a month. */
  month: number;
}

/**
 * Where the row posts, or null where it posts nowhere.
 *
 * Two rejections rather than a fallback. A row with no account cannot be
 * reported against anything, and a row that lands in no year lands on no
 * statement — defaulting either would put a real amount somewhere arbitrary,
 * where it adds up and is wrong.
 *
 * The year the row states wins over the year its date falls in: extractors
 * fill one or the other, and where both are present the stated one is the
 * company's own fiscal year, which need not start in January.
 */
export function postedAt(row: LedgerRowPlacement): PostedAt | null {
  if (!row.coaId) return null;

  const date = row.transactionDate ? new Date(row.transactionDate) : null;
  const dated = date !== null && !Number.isNaN(date.getTime()) ? date : null;
  const fiscalYear = row.fiscalYear ?? dated?.getUTCFullYear() ?? null;
  if (!fiscalYear) return null;

  return {
    accountId: row.coaId,
    fiscalYear,
    // Read in UTC. A date parsed as local time puts the first of a month in
    // the previous one, west of Greenwich.
    month: dated === null ? 0 : dated.getUTCMonth() + 1,
  };
}

/** A numeric column, however the driver hands it over. */
export function toLedgerNumber(value: string | number | null | undefined): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(n) ? n : 0;
}

/** An unpopulated text column arrives as "" as often as null; both mean absent. */
export function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

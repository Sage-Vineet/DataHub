/**
 * Hand corrections to a tax reconciliation.
 *
 * The Tax Reconciliation page shows, side by side, what the tax return says
 * and what the books say for each reconciling line. Where extraction got a
 * figure wrong — or where a line exists on neither and somebody knows it
 * belongs — a person types the right answer. This is where those answers live.
 *
 * They are the opposite kind of record from a statement extract. An extract is
 * what a machine READ; an override is what a person TYPED, disagreeing with
 * it. An extract can be recomputed from its document. An override cannot be
 * recovered from anything at all, which is why it gets its own table with its
 * own per-cell identity rather than a jsonb blob keyed by company.
 */

/** One corrected cell. */
export interface TaxOverride {
  fiscalYear: number;
  lineLabel: string;
  /**
   * Nullable independently: an override often corrects one side and leaves
   * the other as extracted, and a zero would read as "this line really is
   * nil" rather than "nobody said".
   */
  taxReturnAmount: number | null;
  bookAmount: number | null;
  /**
   * Whether a person added this line rather than correcting one already found.
   * A user-added line has no extracted counterpart, so its absence from the
   * return is not a discrepancy.
   */
  userAdded: boolean;
  updatedAt: string | null;
}

/** What a caller asks to be stored. */
export interface TaxOverrideInput {
  fiscalYear: number;
  lineLabel: string;
  taxReturnAmount: number | null;
  bookAmount: number | null;
  userAdded: boolean;
}

export interface TaxOverridesRepository {
  list(companyId: string): Promise<TaxOverride[]>;
  /**
   * Make the company's corrections exactly these.
   *
   * A replace rather than a merge, because the page sends the whole map and a
   * merge could never delete: a line somebody removed on screen would come
   * back on the next load, and no amount of removing it again would help.
   *
   * One transaction, so a failure halfway leaves the previous set intact
   * rather than a partial one nobody chose.
   */
  replaceAll(
    companyId: string,
    overrides: readonly TaxOverrideInput[],
    updatedBy: string | null,
  ): Promise<TaxOverride[]>;
}

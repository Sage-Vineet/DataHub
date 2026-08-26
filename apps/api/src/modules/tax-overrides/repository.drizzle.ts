import { and, asc, eq } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { TaxOverride, TaxOverrideInput, TaxOverridesRepository } from "./ports.js";

const { taxReconciliationOverrides } = schema;

type Row = typeof taxReconciliationOverrides.$inferSelect;

/**
 * `numeric` comes back as a string, because a Postgres numeric holds more
 * precision than a double and the driver refuses to lose it silently. These
 * are money to two places, well inside what a double holds exactly, so the
 * conversion is safe here — but it is done in one place rather than wherever
 * somebody happens to need a number.
 */
const toNumber = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toOverride = (row: Row): TaxOverride => ({
  fiscalYear: row.fiscalYear,
  lineLabel: row.lineLabel,
  taxReturnAmount: toNumber(row.taxReturnAmount),
  bookAmount: toNumber(row.bookAmount),
  userAdded: row.userAdded,
  updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
});

/** A number as `numeric(18,2)` wants it, or null. */
const toNumeric = (value: number | null): string | null =>
  value === null || !Number.isFinite(value) ? null : value.toFixed(2);

export class DrizzleTaxOverridesRepository implements TaxOverridesRepository {
  constructor(private readonly db: Db) {}

  async list(companyId: string): Promise<TaxOverride[]> {
    const rows = await this.db
      .select()
      .from(taxReconciliationOverrides)
      .where(eq(taxReconciliationOverrides.companyId, companyId))
      // Ordered so two reads of the same data agree. The page rebuilds a map
      // and does not care, but a test that compares lists does, and an
      // unordered read makes such a test flaky rather than wrong.
      .orderBy(asc(taxReconciliationOverrides.fiscalYear), asc(taxReconciliationOverrides.lineLabel));
    return rows.map(toOverride);
  }

  /**
   * Delete-then-insert inside one transaction.
   *
   * An upsert cannot express this: the page sends the whole map, so a cell
   * absent from it has been REMOVED, and an upsert has no way to say that. The
   * transaction is what makes it safe — without it a failed insert would leave
   * the company with no corrections at all, which is the one outcome nobody
   * asked for.
   */
  async replaceAll(
    companyId: string,
    overrides: readonly TaxOverrideInput[],
    updatedBy: string | null,
  ): Promise<TaxOverride[]> {
    return this.db.transaction(async (tx) => {
      await tx
        .delete(taxReconciliationOverrides)
        .where(eq(taxReconciliationOverrides.companyId, companyId));

      if (overrides.length > 0) {
        await tx.insert(taxReconciliationOverrides).values(
          overrides.map((override) => ({
            companyId,
            fiscalYear: override.fiscalYear,
            lineLabel: override.lineLabel,
            taxReturnAmount: toNumeric(override.taxReturnAmount),
            bookAmount: toNumeric(override.bookAmount),
            userAdded: override.userAdded,
            updatedBy,
          })),
        );
      }

      const rows = await tx
        .select()
        .from(taxReconciliationOverrides)
        .where(eq(taxReconciliationOverrides.companyId, companyId))
        .orderBy(
          asc(taxReconciliationOverrides.fiscalYear),
          asc(taxReconciliationOverrides.lineLabel),
        );
      return rows.map(toOverride);
    });
  }
}

/** Exported for the tests that check one company's corrections in isolation. */
export const overrideOf = (
  db: Db,
  companyId: string,
  fiscalYear: number,
  lineLabel: string,
) =>
  db
    .select()
    .from(taxReconciliationOverrides)
    .where(
      and(
        eq(taxReconciliationOverrides.companyId, companyId),
        eq(taxReconciliationOverrides.fiscalYear, fiscalYear),
        eq(taxReconciliationOverrides.lineLabel, lineLabel),
      ),
    );

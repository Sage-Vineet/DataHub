import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import { loadEngagement, type EngagementData } from "../../shared/engagement.drizzle.js";
import type { EngagementPort, LedgerDetailPort, LedgerTransaction } from "./ports.js";
import { HttpError } from "../../shared/errors.js";
import type { ReportSyncPort } from "./ports.js";

const { generalLedgerEntries } = schema;

/**
 * The GL sync/computation is not yet migrated (reports-domain D5): the 9,088-line
 * `manualGlMultiYearService` stays on the legacy engine and is decomposed in later
 * slices. This stub makes the seam explicit; a real engine implements the port later.
 */
export class LegacyReportSyncPort implements ReportSyncPort {
  async sync(_versionId: string): Promise<never> {
    throw new HttpError(501, "Report sync is handled by the legacy GL engine and is not yet migrated.");
  }
}

/** The engagement read model over Drizzle. */
export class DrizzleEngagementPort implements EngagementPort {
  constructor(private readonly db: Db) {}

  load(versionId: string): Promise<EngagementData | null> {
    return loadEngagement(this.db, versionId);
  }
}

/** The posted ledger at transaction grain, for the monthly-detail drill-down. */
export class DrizzleLedgerDetailPort implements LedgerDetailPort {
  constructor(private readonly db: Db) {}

  async list(versionId: string): Promise<LedgerTransaction[]> {
    const rows = await this.db
      .select({
        id: generalLedgerEntries.id,
        coaId: generalLedgerEntries.coaId,
        fiscalYear: generalLedgerEntries.fiscalYear,
        transactionDate: generalLedgerEntries.transactionDate,
        amount: generalLedgerEntries.amount,
        vendor: generalLedgerEntries.vendor,
        description: generalLedgerEntries.description,
        reference: generalLedgerEntries.reference,
        journalType: generalLedgerEntries.journalType,
        debit: generalLedgerEntries.debit,
        credit: generalLedgerEntries.credit,
      })
      .from(generalLedgerEntries)
      .where(
        and(
          eq(generalLedgerEntries.versionId, versionId),
          // Same filter the engagement uses: header, beginning-balance and
          // total rows would double-count the amounts they summarize.
          eq(generalLedgerEntries.rowType, "TRANSACTION"),
        ),
      );

    const out: LedgerTransaction[] = [];
    for (const row of rows) {
      const transaction = toLedgerTransaction(row);
      if (transaction) out.push(transaction);
    }
    return out;
  }
}

/** One ledger row as the report reads it, in the shape the DB hands it over. */
export interface LedgerRow {
  id: string | number;
  coaId: string | null;
  fiscalYear: number | null;
  transactionDate: string | null;
  amount: string | number | null;
  vendor: string | null;
  description: string | null;
  reference: string | null;
  journalType: string | null;
  debit: string | null;
  credit: string | null;
}

/**
 * A stored row as a transaction, or null where it is neither.
 *
 * Two rejections rather than one fallback. A row with no account cannot be
 * reported against anything, and a row with no year lands on no statement —
 * defaulting either would put a real amount somewhere arbitrary, where it adds
 * up and is wrong.
 */
export function toLedgerTransaction(row: LedgerRow): LedgerTransaction | null {
  if (!row.coaId) return null;

  // The year the row states, else the year its date falls in. Extractors fill
  // one or the other and rarely both.
  const date = row.transactionDate ? new Date(row.transactionDate) : null;
  const fromDate = date !== null && !Number.isNaN(date.getTime()) ? date.getUTCFullYear() : null;
  const fiscalYear = row.fiscalYear ?? fromDate;
  if (!fiscalYear) return null;

  const amount = toNumber(row.amount);
  return {
    id: String(row.id),
    accountId: row.coaId,
    fiscalYear,
    // Month 0 means "dated to a year but not to a month", which the monthly
    // views drop rather than showing under January.
    month: fromDate === null ? 0 : date!.getUTCMonth() + 1,
    date: row.transactionDate ?? null,
    vendorName: emptyToNull(row.vendor),
    description: emptyToNull(row.description),
    reference: emptyToNull(row.reference),
    journalType: emptyToNull(row.journalType),
    amount,
    ...splitOf(row.debit, row.credit, amount),
  };
}

/**
 * The debit/credit split, or nothing.
 *
 * `debit` and `credit` are `DEFAULT 0`, so an extractor that never wrote them
 * leaves 0 rather than NULL — and a row reporting a 1,000 amount with a zero on
 * both sides reads as "this transaction was zero either way" rather than as
 * "nobody recorded which side it fell on". Both zero against a non-zero amount
 * is therefore treated as absent.
 *
 * A genuinely zero-amount row keeps its zeroes: there the split really is
 * nothing on both sides, and that is a fact rather than a gap.
 */
export function splitOf(
  debit: string | null,
  credit: string | null,
  amount: number,
): { debit: number | null; credit: number | null } {
  const dr = debit === null ? null : toNumber(debit);
  const cr = credit === null ? null : toNumber(credit);
  if (amount !== 0 && (dr ?? 0) === 0 && (cr ?? 0) === 0) return { debit: null, credit: null };
  return { debit: dr, credit: cr };
}

/** An unpopulated text column arrives as "" as often as null; both mean absent. */
export function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

export function toNumber(value: string | number | null | undefined): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(n) ? n : 0;
}

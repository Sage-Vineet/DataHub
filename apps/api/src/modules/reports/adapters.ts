import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import { loadEngagement, type EngagementData } from "../../shared/engagement.drizzle.js";
import {
  emptyToNull,
  postedAt,
  toLedgerNumber as toNumber,
  type LedgerRowPlacement,
} from "../../shared/ledger-row.js";
import type { EngagementPort, LedgerDetailPort, LedgerTransaction } from "./ports.js";
import { HttpError } from "../../shared/errors.js";
import type { ReportSyncPort } from "./ports.js";

const { generalLedgerEntries } = schema;

/**
 * The sync a deployment with no document reader can offer.
 *
 * A 503 naming the configuration rather than a 501 saying "not migrated": it
 * IS migrated — `KeyReportSyncService` does it — but reading a statement needs
 * a model, and a server without one should say which of the two it is.
 */
export class UnavailableReportSyncPort implements ReportSyncPort {
  async sync(): Promise<never> {
    throw new HttpError(
      503,
      "Statement extraction is not configured on this server, so reports cannot be built.",
    );
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
export interface LedgerRow extends LedgerRowPlacement {
  id: string | number;
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
 * Where it posts is `postedAt`'s decision, shared with the engagement loader
 * so the drill-down and the statements above it cannot disagree about which
 * year a transaction falls in.
 */
export function toLedgerTransaction(row: LedgerRow): LedgerTransaction | null {
  const posted = postedAt(row);
  if (!posted) return null;

  const amount = toNumber(row.amount);
  return {
    id: String(row.id),
    ...posted,
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

export { toLedgerNumber as toNumber } from "../../shared/ledger-row.js";

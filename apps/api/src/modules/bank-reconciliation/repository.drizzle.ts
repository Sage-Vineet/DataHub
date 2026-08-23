import { and, asc, eq } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type {
  AddbackItemRecord,
  AdjustmentRecord,
  BankReconciliationRepository,
  BankTransaction,
  BookTransaction,
  BookTransactionInput,
  CreateAddbackItemInput,
  ReconciliationTransactionsRepository,
} from "./ports.js";

const {
  bankReconciliationAddbackItems,
  bankReconciliationAdjustments,
  bankTransactions,
  reconciliationTransactions,
} = schema;

/** `numeric` comes back as a string; an unparseable one is zero, not NaN. */
function toNumber(value: string | number | null | undefined): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(n) ? n : 0;
}

/** Amounts arrive as JSON, so every value is coerced rather than trusted. */
function toAmounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [month, amount] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(amount);
    if (Number.isFinite(n)) out[month] = n;
  }
  return out;
}

export class DrizzleBankReconciliationRepository implements BankReconciliationRepository {
  constructor(private readonly db: Db) {}

  async listAdjustments(companyId: string): Promise<AdjustmentRecord[]> {
    const rows = await this.db
      .select({
        month: bankReconciliationAdjustments.month,
        rowKey: bankReconciliationAdjustments.rowKey,
        amount: bankReconciliationAdjustments.amount,
      })
      .from(bankReconciliationAdjustments)
      .where(eq(bankReconciliationAdjustments.companyId, companyId))
      .orderBy(asc(bankReconciliationAdjustments.month));
    return rows.map((row) => ({
      month: row.month,
      rowKey: row.rowKey,
      amount: toNumber(row.amount),
    }));
  }

  async setAdjustment(companyId: string, input: AdjustmentRecord): Promise<void> {
    // The grid saves on blur, so the same cell is written over and over. The
    // unique index is what keeps that one row rather than a hundred.
    await this.db
      .insert(bankReconciliationAdjustments)
      .values({
        companyId,
        month: input.month,
        rowKey: input.rowKey,
        amount: String(input.amount),
      })
      .onConflictDoUpdate({
        target: [
          bankReconciliationAdjustments.companyId,
          bankReconciliationAdjustments.month,
          bankReconciliationAdjustments.rowKey,
        ],
        set: { amount: String(input.amount), updatedAt: new Date() },
      });
  }

  async listAddbackItems(
    companyId: string,
    filter: { reportSource: string; section?: string },
  ): Promise<AddbackItemRecord[]> {
    const where = filter.section
      ? and(
          eq(bankReconciliationAddbackItems.companyId, companyId),
          eq(bankReconciliationAddbackItems.reportSource, filter.reportSource),
          eq(bankReconciliationAddbackItems.section, filter.section),
        )
      : and(
          eq(bankReconciliationAddbackItems.companyId, companyId),
          eq(bankReconciliationAddbackItems.reportSource, filter.reportSource),
        );

    const rows = await this.db
      .select()
      .from(bankReconciliationAddbackItems)
      .where(where)
      // `sort_order` is user-controlled and ties are common — created_at breaks
      // them, so the order a reader sees does not shuffle between requests.
      .orderBy(
        asc(bankReconciliationAddbackItems.sortOrder),
        asc(bankReconciliationAddbackItems.createdAt),
      );
    return rows.map((row) => ({
      id: row.id,
      section: row.section,
      name: row.name,
      source: row.source,
      monthAmounts: toAmounts(row.monthAmounts),
      sortOrder: row.sortOrder,
      reportSource: row.reportSource,
    }));
  }

  async createAddbackItem(input: CreateAddbackItemInput): Promise<AddbackItemRecord> {
    const [row] = await this.db
      .insert(bankReconciliationAddbackItems)
      .values({
        companyId: input.companyId,
        section: input.section,
        name: input.name,
        source: input.source,
        monthAmounts: input.monthAmounts,
        reportSource: input.reportSource,
      })
      .returning();
    return {
      id: row!.id,
      section: row!.section,
      name: row!.name,
      source: row!.source,
      monthAmounts: toAmounts(row!.monthAmounts),
      sortOrder: row!.sortOrder,
      reportSource: row!.reportSource,
    };
  }

  async updateAddbackItemAmounts(
    companyId: string,
    id: string,
    monthAmounts: Record<string, number>,
  ): Promise<boolean> {
    // `returning` is what turns "matched nothing" into a reportable fact
    // rather than a silent success.
    const rows = await this.db
      .update(bankReconciliationAddbackItems)
      .set({ monthAmounts, updatedAt: new Date() })
      .where(
        and(
          eq(bankReconciliationAddbackItems.id, id),
          eq(bankReconciliationAddbackItems.companyId, companyId),
        ),
      )
      .returning({ id: bankReconciliationAddbackItems.id });
    return rows.length > 0;
  }

  async deleteAddbackItem(companyId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(bankReconciliationAddbackItems)
      .where(
        and(
          eq(bankReconciliationAddbackItems.id, id),
          eq(bankReconciliationAddbackItems.companyId, companyId),
        ),
      )
      .returning({ id: bankReconciliationAddbackItems.id });
    return rows.length > 0;
  }
}


/** A number as `numeric(14,2)` wants it. */
const toNumeric = (value: number): string =>
  (Number.isFinite(value) ? value : 0).toFixed(2);

/**
 * The two transaction tables `/bank-vs-books` compares.
 *
 * A repository of its own rather than more methods on the one above, because
 * the two answer different questions: that one serves the grid's editable
 * cells, this one serves the raw sides of the comparison. Nothing needs both
 * at once, and a caller holding this cannot reach the grid by accident.
 */
export class DrizzleReconciliationTransactionsRepository
  implements ReconciliationTransactionsRepository
{
  constructor(private readonly db: Db) {}

  async listBankTransactions(companyId: string): Promise<BankTransaction[]> {
    const rows = await this.db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.companyId, companyId))
      // Date order, then id: two transactions on one date have no natural
      // order, and without the tiebreak two reads of the same data can pair
      // differently against the books — a reconciliation that changes when
      // nothing changed is one nobody trusts.
      .orderBy(asc(bankTransactions.txnDate), asc(bankTransactions.id));
    return rows.map((row) => ({
      id: row.id,
      date: row.txnDate,
      narration: row.narration,
      amount: toNumber(row.amount),
    }));
  }

  async listBookTransactions(companyId: string): Promise<BookTransaction[]> {
    const rows = await this.db
      .select()
      .from(reconciliationTransactions)
      .where(eq(reconciliationTransactions.companyId, companyId))
      .orderBy(asc(reconciliationTransactions.txnDate), asc(reconciliationTransactions.id));
    return rows.map((row) => ({
      id: row.id,
      date: row.txnDate,
      name: row.name,
      transactionType: row.transactionType,
      amount: toNumber(row.amount),
    }));
  }

  async replaceBookTransactions(
    companyId: string,
    transactions: readonly BookTransactionInput[],
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx
        .delete(reconciliationTransactions)
        .where(eq(reconciliationTransactions.companyId, companyId));

      if (transactions.length === 0) return 0;

      await tx.insert(reconciliationTransactions).values(
        transactions.map((transaction) => ({
          companyId,
          txnDate: transaction.date,
          name: transaction.name,
          transactionType: transaction.transactionType,
          amount: toNumeric(transaction.amount),
        })),
      );
      return transactions.length;
    });
  }
}

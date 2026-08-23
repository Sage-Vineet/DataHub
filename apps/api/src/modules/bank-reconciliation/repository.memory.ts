import { randomUUID } from "node:crypto";
import type {
  AddbackItemRecord,
  AdjustmentRecord,
  BankReconciliationRepository,
  CreateAddbackItemInput,
} from "./ports.js";

/**
 * The same store, in memory.
 *
 * Two behaviours the real schema enforces are reproduced deliberately rather
 * than approximated: writing the same cell twice replaces it (the unique index
 * on `(company_id, month, row_key)`), and an update or delete that names
 * another company's item matches nothing (the `company_id` in the WHERE
 * clause). A fake that got either wrong would prove a safety property the
 * database does not actually provide.
 */
export class InMemoryBankReconciliationRepository implements BankReconciliationRepository {
  private readonly adjustments = new Map<string, AdjustmentRecord & { companyId: string }>();
  private readonly items = new Map<string, AddbackItemRecord & { companyId: string }>();
  private sequence = 0;

  listAdjustments(companyId: string): Promise<AdjustmentRecord[]> {
    return Promise.resolve(
      [...this.adjustments.values()]
        .filter((a) => a.companyId === companyId)
        .sort((a, b) => a.month.localeCompare(b.month))
        .map(({ month, rowKey, amount }) => ({ month, rowKey, amount })),
    );
  }

  setAdjustment(companyId: string, input: AdjustmentRecord): Promise<void> {
    this.adjustments.set(`${companyId}:${input.month}:${input.rowKey}`, {
      companyId,
      ...input,
    });
    return Promise.resolve();
  }

  listAddbackItems(
    companyId: string,
    filter: { reportSource: string; section?: string },
  ): Promise<AddbackItemRecord[]> {
    return Promise.resolve(
      [...this.items.values()]
        .filter(
          (i) =>
            i.companyId === companyId &&
            i.reportSource === filter.reportSource &&
            (filter.section === undefined || i.section === filter.section),
        )
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(({ companyId: _companyId, ...rest }) => rest),
    );
  }

  createAddbackItem(input: CreateAddbackItemInput): Promise<AddbackItemRecord> {
    const record = {
      id: randomUUID(),
      companyId: input.companyId,
      section: input.section,
      name: input.name,
      source: input.source,
      monthAmounts: input.monthAmounts,
      // Insertion order, which is what `sort_order ASC, created_at ASC` gives
      // for rows nobody has reordered.
      sortOrder: this.sequence++,
      reportSource: input.reportSource,
    };
    this.items.set(record.id, record);
    const { companyId: _companyId, ...rest } = record;
    return Promise.resolve(rest);
  }

  updateAddbackItemAmounts(
    companyId: string,
    id: string,
    monthAmounts: Record<string, number>,
  ): Promise<boolean> {
    const item = this.items.get(id);
    if (!item || item.companyId !== companyId) return Promise.resolve(false);
    item.monthAmounts = monthAmounts;
    return Promise.resolve(true);
  }

  deleteAddbackItem(companyId: string, id: string): Promise<boolean> {
    const item = this.items.get(id);
    if (!item || item.companyId !== companyId) return Promise.resolve(false);
    this.items.delete(id);
    return Promise.resolve(true);
  }
}

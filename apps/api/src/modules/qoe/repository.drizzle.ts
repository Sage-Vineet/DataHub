import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@datahub/db";
import { schema } from "@datahub/db";
import type { EbitdaRole } from "@datahub/contracts";
import type {
  AddbackRecord,
  CreateAddbackInput,
  EngagementData,
  QoeRepository,
} from "./ports.js";
import { loadEngagement } from "../../shared/engagement.drizzle.js";

const { chartOfAccounts, qoeAddbacks } = schema;

function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export class DrizzleQoeRepository implements QoeRepository {
  constructor(private readonly db: Db) {}

  /**
   * Delegates to the shared engagement read model. The queries are subtle and
   * two modules need them; one copy keeps the statements they produce
   * consistent with each other.
   */
  async loadEngagement(versionId: string): Promise<EngagementData | null> {
    return loadEngagement(this.db, versionId);
  }

  private static toRecord(row: typeof qoeAddbacks.$inferSelect): AddbackRecord {
    return {
      id: row.id,
      companyId: row.companyId,
      versionId: row.versionId,
      kind: row.kind as AddbackRecord["kind"],
      dataSource: row.dataSource as AddbackRecord["dataSource"],
      typeKey: row.typeKey,
      name: row.name,
      linkedAccountId: row.linkedAccountId,
      vendorScope: (row.vendorScope as string[]) ?? [],
      granularity: row.granularity as AddbackRecord["granularity"],
      values: (row.values as Record<string, number>) ?? {},
      recastNormalizedValue:
        row.recastNormalizedValue === null ? null : toNumber(row.recastNormalizedValue),
      groupId: row.groupId,
      groupLabel: row.groupLabel,
      explanation: row.explanation,
      commentary: row.commentary,
      createdBy: row.createdBy,
    };
  }

  async listAddbacks(versionId: string): Promise<AddbackRecord[]> {
    const rows = await this.db
      .select()
      .from(qoeAddbacks)
      .where(and(eq(qoeAddbacks.versionId, versionId), isNull(qoeAddbacks.deletedAt)));
    return rows.map(DrizzleQoeRepository.toRecord);
  }

  async getAddback(id: string): Promise<AddbackRecord | null> {
    const [row] = await this.db
      .select()
      .from(qoeAddbacks)
      .where(and(eq(qoeAddbacks.id, id), isNull(qoeAddbacks.deletedAt)))
      .limit(1);
    return row ? DrizzleQoeRepository.toRecord(row) : null;
  }

  async createAddback(input: CreateAddbackInput): Promise<AddbackRecord> {
    const [row] = await this.db
      .insert(qoeAddbacks)
      .values({
        companyId: input.companyId,
        versionId: input.versionId,
        kind: input.kind,
        dataSource: input.dataSource,
        typeKey: input.typeKey,
        name: input.name,
        linkedAccountId: input.linkedAccountId,
        vendorScope: input.vendorScope,
        granularity: input.granularity,
        values: input.values,
        recastNormalizedValue:
          input.recastNormalizedValue === null ? null : String(input.recastNormalizedValue),
        groupId: input.groupId,
        groupLabel: input.groupLabel,
        explanation: input.explanation,
        commentary: input.commentary,
        createdBy: input.createdBy,
      })
      .returning();
    return DrizzleQoeRepository.toRecord(row!);
  }

  /** Soft delete — an add-back is evidence, so the record is retained. */
  async deleteAddback(id: string): Promise<void> {
    await this.db
      .update(qoeAddbacks)
      .set({ deletedAt: new Date() })
      .where(eq(qoeAddbacks.id, id));
  }

  async updateCommentary(id: string, commentary: string): Promise<AddbackRecord | null> {
    const [row] = await this.db
      .update(qoeAddbacks)
      .set({ commentary, updatedAt: new Date() })
      .where(and(eq(qoeAddbacks.id, id), isNull(qoeAddbacks.deletedAt)))
      .returning();
    return row ? DrizzleQoeRepository.toRecord(row) : null;
  }

  async setAccountClassification(
    versionId: string,
    accountId: string,
    accountType: string,
  ): Promise<void> {
    // The statement follows from the type. Deriving it here means a
    // reclassification cannot leave the two contradicting each other.
    const statementType =
      accountType === "income" || accountType === "cogs" || accountType === "expense"
        ? "profit_loss"
        : "balance_sheet";
    await this.db
      .update(chartOfAccounts)
      .set({ accountType, statementType, updatedAt: new Date() })
      .where(and(eq(chartOfAccounts.versionId, versionId), eq(chartOfAccounts.id, accountId)));
  }

  async setAccountRole(
    versionId: string,
    accountId: string,
    role: EbitdaRole | null,
  ): Promise<void> {
    await this.db
      .update(chartOfAccounts)
      .set({ ebitdaRole: role, updatedAt: new Date() })
      .where(and(eq(chartOfAccounts.versionId, versionId), eq(chartOfAccounts.id, accountId)));
  }

  /** One transaction, so a classification run either lands whole or not at all. */
  async setAccountRoles(
    versionId: string,
    updates: Array<{ accountId: string; role: EbitdaRole | null }>,
  ): Promise<void> {
    if (updates.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const { accountId, role } of updates) {
        await tx
          .update(chartOfAccounts)
          .set({ ebitdaRole: role, updatedAt: new Date() })
          .where(and(eq(chartOfAccounts.versionId, versionId), eq(chartOfAccounts.id, accountId)));
      }
    });
  }
}

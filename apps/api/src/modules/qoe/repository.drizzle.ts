import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@datahub/db";
import { schema } from "@datahub/db";
import type { Account, GlEntry } from "@datahub/financial-engine";
import type { EbitdaRole } from "@datahub/contracts";
import type {
  AddbackRecord,
  CreateAddbackInput,
  EngagementData,
  QoeRepository,
} from "./ports.js";

const { chartOfAccounts, generalLedgerEntries, qoeAddbacks, companies, keyReportVersions } = schema;

/** P&L account types that behave as income. Everything else on the P&L is expense. */
const INCOME_TYPES = new Set(["income", "revenue", "other_income"]);

function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export class DrizzleQoeRepository implements QoeRepository {
  constructor(private readonly db: Db) {}

  async loadEngagement(versionId: string): Promise<EngagementData | null> {
    const [version] = await this.db
      .select({ id: keyReportVersions.id, companyId: keyReportVersions.companyId })
      .from(keyReportVersions)
      .where(eq(keyReportVersions.id, versionId))
      .limit(1);
    if (!version) return null;

    const [company] = await this.db
      .select({
        name: companies.name,
        profitMetric: companies.profitMetric,
        replacement: sql<string | null>`market_rate_replacement_salary`,
      })
      .from(companies)
      .where(eq(companies.id, version.companyId))
      .limit(1);

    const coaRows = await this.db
      .select()
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.versionId, versionId));

    const accounts: Account[] = coaRows.map((row) => {
      const statementType = row.statementType === "profit_loss" ? "profit_loss" : "balance_sheet";
      return {
        id: row.id,
        name: row.accountName,
        statementType,
        accountType:
          statementType === "profit_loss"
            ? INCOME_TYPES.has(String(row.accountType))
              ? "income"
              : "expense"
            : null,
        ebitdaRole: (row.ebitdaRole as EbitdaRole | null) ?? null,
      };
    });

    // Only posted transactions: header, beginning-balance and total rows would
    // double-count the very amounts they summarize.
    const glRows = await this.db
      .select({
        coaId: generalLedgerEntries.coaId,
        fiscalYear: generalLedgerEntries.fiscalYear,
        transactionDate: generalLedgerEntries.transactionDate,
        amount: generalLedgerEntries.amount,
        vendor: generalLedgerEntries.vendor,
      })
      .from(generalLedgerEntries)
      .where(
        and(
          eq(generalLedgerEntries.versionId, versionId),
          eq(generalLedgerEntries.rowType, "TRANSACTION"),
        ),
      );

    const entries: GlEntry[] = [];
    const years = new Set<number>();
    for (const row of glRows) {
      if (!row.coaId) continue;
      const date = row.transactionDate ? new Date(row.transactionDate) : null;
      const fiscalYear = row.fiscalYear ?? date?.getUTCFullYear() ?? null;
      if (!fiscalYear) continue;
      years.add(fiscalYear);
      entries.push({
        accountId: row.coaId,
        fiscalYear,
        month: date ? date.getUTCMonth() + 1 : 0,
        amount: toNumber(row.amount),
        vendor: row.vendor ?? null,
      });
    }

    return {
      companyId: version.companyId,
      companyName: company?.name ?? "",
      profitMetric: company?.profitMetric === "sde" ? "sde" : "adjusted_ebitda",
      marketRateReplacementSalary: company?.replacement ? toNumber(company.replacement) : null,
      fiscalYears: [...years].sort((a, b) => a - b),
      accounts,
      entries,
    };
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
}

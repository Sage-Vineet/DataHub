import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@datahub/db";
import { schema } from "@datahub/db";
import { isStatementCaption } from "@datahub/financial-engine";
import type { Account, BalanceSheetAnchor, GlEntry } from "@datahub/financial-engine";
import type { EbitdaRole } from "@datahub/contracts";
import type {
  AddbackRecord,
  CreateAddbackInput,
  EngagementData,
  QoeRepository,
} from "./ports.js";

const {
  chartOfAccounts,
  generalLedgerEntries,
  balanceSheetEntries,
  qoeAddbacks,
  companies,
  keyReportVersions,
} = schema;

/** P&L account types that behave as income. Everything else on the P&L is expense. */
const INCOME_TYPES = new Set(["income", "revenue", "other_income"]);

/** `balance_sheet_entries.section` uses plurals; the engine uses the singular. */
const SECTION_TO_TYPE: Record<string, "asset" | "liability" | "equity"> = {
  assets: "asset",
  asset: "asset",
  liabilities: "liability",
  liability: "liability",
  equity: "equity",
};

/** Fiscal year and month from an `as_of_date`. */
function periodOf(asOf: string): { fiscalYear: number; month: number } {
  const [year, month] = asOf.split("-");
  return { fiscalYear: Number(year), month: Number(month ?? "12") };
}

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
        // Balance-sheet accounts carry a real type too. Returning null here
        // made every liability and equity account fall back to "asset" in the
        // roll-forward's balance check, and put the debit/credit split in the
        // trial balance on the wrong side of the ledger.
        accountType:
          statementType === "profit_loss"
            ? INCOME_TYPES.has(String(row.accountType))
              ? "income"
              : "expense"
            : (SECTION_TO_TYPE[String(row.accountType ?? "").toLowerCase()] ?? null),
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

    const anchors = await this.loadAnchors(versionId);

    return {
      companyId: version.companyId,
      companyName: company?.name ?? "",
      profitMetric: company?.profitMetric === "sde" ? "sde" : "adjusted_ebitda",
      marketRateReplacementSalary: company?.replacement ? toNumber(company.replacement) : null,
      fiscalYears: [...years].sort((a, b) => a - b),
      accounts,
      entries,
      anchors,
    };
  }

  /**
   * Balance-sheet statements usable as roll-forward anchors.
   *
   * Subtotal rows (`is_total`) and rows this system previously generated
   * (`is_generated`) are excluded: feeding a derived figure back in as an
   * anchor would compound whatever produced it. Statements are returned
   * earliest-first, so the earliest is rolled from and any later one becomes a
   * tie-out.
   */
  private async loadAnchors(versionId: string): Promise<BalanceSheetAnchor[]> {
    const rows = await this.db
      .select({
        asOfDate: balanceSheetEntries.asOfDate,
        accountName: balanceSheetEntries.accountName,
        section: balanceSheetEntries.section,
        subSection: balanceSheetEntries.subSection,
        amount: balanceSheetEntries.amount,
        coaId: balanceSheetEntries.coaId,
        hierarchyLevel: balanceSheetEntries.hierarchyLevel,
        isTotal: balanceSheetEntries.isTotal,
      })
      .from(balanceSheetEntries)
      .where(
        and(
          eq(balanceSheetEntries.versionId, versionId),
          or(isNull(balanceSheetEntries.isTotal), ne(balanceSheetEntries.isTotal, true)),
          or(isNull(balanceSheetEntries.isGenerated), ne(balanceSheetEntries.isGenerated, true)),
        ),
      )
      .orderBy(asc(balanceSheetEntries.asOfDate), asc(balanceSheetEntries.sortOrder));

    // `hierarchy_level` only tells us anything when it actually varies — the
    // column defaults to 0, so a statement where nothing set it would otherwise
    // look like nothing but section headers.
    const levelsAreMeaningful = new Set(rows.map((r) => r.hierarchyLevel)).size > 1;

    const byDate = new Map<string, BalanceSheetAnchor>();
    for (const row of rows) {
      if (!row.asOfDate || !row.accountName) continue;
      const section = SECTION_TO_TYPE[String(row.section ?? "").toLowerCase()];
      if (!section) continue;
      // A parent caption is structure, not an account. Extraction filters
      // subtotals but not headings, so "Bank Accounts" arrives looking like a
      // balance and would be double-counted against the accounts beneath it
      // (UAT #4).
      if (
        isStatementCaption(
          {
            accountName: row.accountName,
            hierarchyLevel: row.hierarchyLevel,
            isTotal: row.isTotal,
          },
          { levelsAreMeaningful },
        )
      ) {
        continue;
      }

      let anchor = byDate.get(row.asOfDate);
      if (!anchor) {
        const { fiscalYear, month } = periodOf(row.asOfDate);
        anchor = { kind: "starting", fiscalYear, month, rows: [] };
        byDate.set(row.asOfDate, anchor);
      }
      anchor.rows.push({
        accountId: row.coaId ?? row.accountName,
        accountName: row.accountName,
        section,
        group: row.subSection ?? null,
        amount: toNumber(row.amount),
      });
    }

    const anchors = [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, anchor]) => anchor);

    // The earliest statement is the one rolled FROM; anything later states a
    // closing position and is only used to check against.
    return anchors.map((anchor, index) => ({
      ...anchor,
      kind: index === 0 ? "starting" : "ending",
    }));
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

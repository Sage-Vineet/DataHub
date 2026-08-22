import { desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { ProfitMetric } from "@datahub/contracts";
import type {
  CompaniesRepository,
  CompanyCreateInput,
  CompanyRecord,
  CompanyUpdatePatch,
} from "./ports.js";

const { activityLog, companies, userCompanies, users } = schema;
type Row = typeof companies.$inferSelect;

function toRecord(row: Row): CompanyRecord {
  return {
    id: row.id,
    name: row.name,
    projectName: row.projectName,
    industry: row.industry,
    status: row.status,
    since: row.since,
    logo: row.logo,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    profitMetric: row.profitMetric as ProfitMetric,
    dataSourceType: row.dataSourceType,
    quickbooksConnected: row.quickbooksConnected,
    manualUploadActive: row.manualUploadActive,
  };
}

/**
 * Tables with a direct `company_id` FK, deleted in safe dependency order
 * (parity with legacy `deleteCompany`). Nested tables (no `company_id`) are
 * handled first, keyed by their parent ids.
 */
const DIRECT_COMPANY_TABLES = [
  "documents",
  "requests",
  "folders",
  "reminders",
  "activity_log",
  "company_messages",
  "direct_messages",
  "buyer_groups",
  "manual_gl_staged_transactions",
  "manual_gl_balance_sheet_lines",
  "manual_gl_batches",
  "report_source_records",
  "user_companies",
] as const;

/** Drizzle-backed `CompaniesRepository` (single typed path — no Supabase fallback, D6). */
export class DrizzleCompaniesRepository implements CompaniesRepository {
  constructor(private readonly db: Db) {}

  /**
   * A deal's activity, newest first, with the actor's name joined in.
   *
   * Left join so an event whose actor has since been removed still appears —
   * losing the person must not lose the history.
   */
  async listActivity(companyId: string, limit: number) {
    const rows = await this.db
      .select({
        id: activityLog.id,
        companyId: activityLog.companyId,
        type: activityLog.type,
        message: activityLog.message,
        actorId: activityLog.createdBy,
        actorName: users.name,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .leftJoin(users, eq(users.id, activityLog.createdBy))
      .where(eq(activityLog.companyId, companyId))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      type: r.type as "upload" | "request" | "approved" | "reminder",
      message: r.message,
      actorId: r.actorId ?? null,
      actorName: r.actorName ?? null,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    }));
  }

  async getById(id: string): Promise<CompanyRecord | null> {
    const rows = await this.db.select().from(companies).where(eq(companies.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listAll(): Promise<CompanyRecord[]> {
    const rows = await this.db.select().from(companies).orderBy(companies.createdAt);
    return rows.map(toRecord);
  }

  async listByIds(ids: readonly string[]): Promise<CompanyRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.select().from(companies).where(inArray(companies.id, [...ids]));
    return rows.map(toRecord);
  }

  async create(input: CompanyCreateInput): Promise<CompanyRecord> {
    const rows = await this.db
      .insert(companies)
      .values({
        name: input.name,
        projectName: input.projectName,
        // `industry` is optional in the contract and NOT NULL with no default in
        // the deployed schema, so omitting it was a 500 rather than a 400. The
        // SPA has always sent "" for an unfilled field, so that is the value
        // that keeps existing and new rows the same shape.
        industry: input.industry ?? "",
        status: input.status,
        since: input.since,
        logo: input.logo,
        contactName: input.contactName,
        contactEmail: input.contactEmail,
        contactPhone: input.contactPhone,
        profitMetric: input.profitMetric,
      })
      .returning();
    return toRecord(rows[0]!);
  }

  async updateSafeFields(id: string, patch: CompanyUpdatePatch): Promise<CompanyRecord | null> {
    const rows = await this.db
      .update(companies)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(companies.id, id))
      .returning();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async linkUserCompany(userId: string, companyId: string): Promise<void> {
    await this.db.insert(userCompanies).values({ userId, companyId }).onConflictDoNothing();
  }

  /**
   * The 4-step cascade in a single transaction (design D4): nested tables →
   * direct company-keyed tables in FK order → null `users.company_id` → delete
   * the company. Atomic: any failure rolls the whole thing back.
   */
  async cascadeDelete(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Step 1 — nested tables (no company_id; delete before their parents).
      await tx.execute(sql`
        DELETE FROM folder_access
        WHERE folder_id IN (SELECT id FROM folders WHERE company_id = ${id})
      `);
      for (const child of ["request_documents", "request_narratives", "request_reminders"]) {
        await tx.execute(sql`
          DELETE FROM ${sql.identifier(child)}
          WHERE request_id IN (SELECT id FROM requests WHERE company_id = ${id})
        `);
      }
      await tx.execute(sql`
        DELETE FROM buyer_group_members
        WHERE group_id IN (SELECT id FROM buyer_groups WHERE company_id = ${id})
      `);

      // Step 2 — direct company_id tables, in safe order.
      for (const table of DIRECT_COMPANY_TABLES) {
        await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE company_id = ${id}`);
      }

      // Step 3 — unlink users whose primary company was this one (SET NULL).
      await tx.execute(sql`UPDATE users SET company_id = NULL WHERE company_id = ${id}`);

      // Step 4 — delete the company.
      await tx.execute(sql`DELETE FROM companies WHERE id = ${id}`);
    });
  }
}

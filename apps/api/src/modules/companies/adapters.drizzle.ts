import { sql } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type {
  CompanyStats,
  CompanyStatsPort,
  FolderProvisioningPort,
  UserProvisioningPort,
} from "./ports.js";

/**
 * Legacy-backed port adapters (design D3). Read/write the cross-domain tables
 * directly for now; swap to the real `users`/`folders`/`requests` module services
 * once those land — no contract change. Runtime adapters (not unit-tested).
 */

/** Request-count stats from the `requests` table (design D5). */
export class DrizzleCompanyStatsPort implements CompanyStatsPort {
  constructor(private readonly db: Db) {}

  async countsFor(companyIds: readonly string[]): Promise<Map<string, CompanyStats>> {
    const map = new Map<string, CompanyStats>();
    if (companyIds.length === 0) return map;
    for (const id of companyIds) map.set(id, { total: 0, pending: 0, completed: 0 });

    const idList = sql.join(
      companyIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const result = await this.db.execute(
      sql`SELECT company_id, status FROM requests WHERE company_id IN (${idList})`,
    );
    const rows = (result as unknown as { rows: Array<{ company_id: string; status: string | null }> })
      .rows;
    for (const row of rows) {
      const entry = map.get(String(row.company_id));
      if (!entry) continue;
      entry.total += 1;
      if (row.status === "pending") entry.pending += 1;
      else if (row.status === "completed") entry.completed += 1;
    }
    return map;
  }
}

/** Provision a company's default folders if it has none. */
export class DrizzleFolderProvisioningPort implements FolderProvisioningPort {
  private static readonly DEFAULTS = [
    "Finance",
    "Compliance",
    "HR",
    "Legal",
    "M&A",
    "Tax",
    "Other",
  ] as const;

  constructor(private readonly db: Db) {}

  async ensureDefaultFolders(companyId: string, createdBy: string): Promise<void> {
    const existing = await this.db
      .select({ id: schema.folders.id })
      .from(schema.folders)
      .where(sql`${schema.folders.companyId} = ${companyId}`)
      .limit(1);
    if (existing.length > 0) return;
    await this.db.insert(schema.folders).values(
      DrizzleFolderProvisioningPort.DEFAULTS.map((name) => ({ companyId, createdBy, name })),
    );
  }
}

/**
 * Client-representative sync: ensure a buyer user exists for the company's
 * contact email and is linked to it. A minimal, transitional implementation —
 * the full legacy behavior moves into the `users` module when it lands.
 */
export class DrizzleUserProvisioningPort implements UserProvisioningPort {
  constructor(private readonly db: Db) {}

  async syncClientRepresentative(company: {
    id: string;
    contactEmail: string | null;
    contactName: string | null;
  }): Promise<void> {
    if (!company.contactEmail || !company.contactName) return;
    const email = company.contactEmail.toLowerCase();
    const found = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`lower(${schema.users.email}) = ${email}`)
      .limit(1);

    let userId = found[0]?.id;
    if (!userId) {
      const inserted = await this.db
        .insert(schema.users)
        .values({
          name: company.contactName,
          email,
          // Placeholder hash — the user resets via the forgot-password flow.
          passwordHash: "!",
          role: "buyer",
          companyId: company.id,
        })
        .returning({ id: schema.users.id });
      userId = inserted[0]!.id;
    } else {
      await this.db
        .update(schema.users)
        .set({ companyId: company.id })
        .where(sql`${schema.users.id} = ${userId}`);
    }
    await this.db
      .insert(schema.userCompanies)
      .values({ userId, companyId: company.id })
      .onConflictDoNothing();
  }
}

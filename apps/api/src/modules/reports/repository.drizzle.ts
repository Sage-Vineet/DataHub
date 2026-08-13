import { asc, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { ReportVersionStatus } from "@datahub/contracts";
import type {
  CreateVersionInput,
  ReportsRepository,
  UpdateVersionPatch,
  VersionRecord,
} from "./ports.js";

const { keyReportVersions } = schema;
type Row = typeof keyReportVersions.$inferSelect;

function toRecord(r: Row): VersionRecord {
  return {
    id: r.id,
    companyId: r.companyId,
    versionNumber: r.versionNumber,
    versionName: r.versionName,
    status: r.status as ReportVersionStatus,
    isActive: r.isActive,
    resolvedBatchId: r.resolvedBatchId,
    lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    createdBy: r.createdBy,
  };
}

export class DrizzleReportsRepository implements ReportsRepository {
  constructor(private readonly db: Db) {}

  async listByCompany(companyId: string): Promise<VersionRecord[]> {
    const rows = await this.db.select().from(keyReportVersions).where(eq(keyReportVersions.companyId, companyId)).orderBy(asc(keyReportVersions.versionNumber));
    return rows.map(toRecord);
  }

  async getById(id: string): Promise<VersionRecord | null> {
    const rows = await this.db.select().from(keyReportVersions).where(eq(keyReportVersions.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  private async nextNumber(tx: Db, companyId: string): Promise<number> {
    const rows = await tx
      .select({ n: keyReportVersions.versionNumber })
      .from(keyReportVersions)
      .where(eq(keyReportVersions.companyId, companyId))
      .orderBy(desc(keyReportVersions.versionNumber))
      .limit(1);
    return (rows[0]?.n ?? 0) + 1;
  }

  async create(input: CreateVersionInput): Promise<VersionRecord> {
    return this.db.transaction(async (tx) => {
      const versionNumber = await this.nextNumber(tx as unknown as Db, input.companyId);
      const rows = await tx
        .insert(keyReportVersions)
        .values({
          companyId: input.companyId,
          versionNumber,
          versionName: input.versionName,
          status: "draft",
          isActive: false,
          metadata: input.metadata,
          createdBy: input.createdBy,
        })
        .returning();
      return toRecord(rows[0]!);
    });
  }

  async update(id: string, patch: UpdateVersionPatch): Promise<VersionRecord | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.versionName !== undefined) set.versionName = patch.versionName;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.metadata !== undefined) set.metadata = patch.metadata;
    const rows = await this.db.update(keyReportVersions).set(set).where(eq(keyReportVersions.id, id)).returning();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(keyReportVersions).where(eq(keyReportVersions.id, id));
  }

  async duplicate(id: string, createdBy: string): Promise<VersionRecord | null> {
    const source = await this.getById(id);
    if (!source) return null;
    return this.create({ companyId: source.companyId, versionName: source.versionName, metadata: source.metadata, createdBy });
  }

  async activate(id: string): Promise<VersionRecord | null> {
    return this.db.transaction(async (tx) => {
      const found = await tx.select().from(keyReportVersions).where(eq(keyReportVersions.id, id)).limit(1);
      const target = found[0];
      if (!target) return null;
      // Clear the company's active flag first, then set the target (partial unique invariant).
      await tx.update(keyReportVersions).set({ isActive: false }).where(eq(keyReportVersions.companyId, target.companyId));
      const rows = await tx
        .update(keyReportVersions)
        .set({ isActive: true, updatedAt: new Date() })
        .where(eq(keyReportVersions.id, id))
        .returning();
      return toRecord(rows[0]!);
    });
  }
}

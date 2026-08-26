import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type {
  CreateDatasetVersionInput,
  DatasetVersionRecord,
  DatasetsRepository,
  FinalizeInput,
} from "./ports.js";

const { datasetVersions } = schema;
type Row = typeof datasetVersions.$inferSelect;

function toRecord(row: Row): DatasetVersionRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    versionNumber: row.versionNumber,
    label: row.label ?? null,
    sourceKey: row.sourceKey,
    status: row.status,
    isActive: row.isActive,
    syncRunId: row.syncRunId ?? null,
    rowCount: row.rowCount,
    fiscalYears: (row.fiscalYears ?? []) as number[],
    finalizedAt: row.finalizedAt ? row.finalizedAt.toISOString() : null,
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
  };
}

export class DrizzleDatasetsRepository implements DatasetsRepository {
  constructor(private readonly db: Db) {}

  async list(
    companyId: string,
    filter: { sourceKey?: string; limit: number },
  ): Promise<DatasetVersionRecord[]> {
    const clauses = [eq(datasetVersions.companyId, companyId)];
    if (filter.sourceKey) clauses.push(eq(datasetVersions.sourceKey, filter.sourceKey));

    const rows = await this.db
      .select()
      .from(datasetVersions)
      .where(and(...clauses))
      .orderBy(desc(datasetVersions.versionNumber))
      .limit(filter.limit);
    return rows.map(toRecord);
  }

  async getById(companyId: string, id: string): Promise<DatasetVersionRecord | null> {
    const [row] = await this.db
      .select()
      .from(datasetVersions)
      .where(and(eq(datasetVersions.companyId, companyId), eq(datasetVersions.id, id)))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async active(companyId: string): Promise<DatasetVersionRecord | null> {
    const [row] = await this.db
      .select()
      .from(datasetVersions)
      .where(and(eq(datasetVersions.companyId, companyId), eq(datasetVersions.isActive, true)))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async create(input: CreateDatasetVersionInput): Promise<DatasetVersionRecord> {
    // The number is computed inside the insert rather than read first and
    // written second: two concurrent imports would otherwise both read `2` and
    // race, and the unique index would fail the loser with a message about an
    // index rather than about what happened.
    const [row] = await this.db
      .insert(datasetVersions)
      .values({
        companyId: input.companyId,
        sourceKey: input.sourceKey,
        label: input.label,
        syncRunId: input.syncRunId,
        createdBy: input.createdBy,
        versionNumber: sql<number>`(
          SELECT COALESCE(MAX(version_number), 0) + 1
            FROM dataset_versions
           WHERE company_id = ${input.companyId}
             AND source_key = ${input.sourceKey}
        )`,
      })
      .returning();
    return toRecord(row!);
  }

  async finalize(id: string, input: FinalizeInput): Promise<DatasetVersionRecord | null> {
    const [row] = await this.db
      .update(datasetVersions)
      .set({
        status: "finalized",
        rowCount: input.rowCount,
        fiscalYears: input.fiscalYears,
        finalizedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(datasetVersions.id, id))
      .returning();
    return row ? toRecord(row) : null;
  }

  async fail(id: string, reason: string): Promise<void> {
    await this.db
      .update(datasetVersions)
      .set({
        status: "failed",
        isActive: false,
        metadata: { failureReason: reason },
        updatedAt: new Date(),
      })
      .where(eq(datasetVersions.id, id));
  }

  async activate(
    companyId: string,
    id: string,
    supersede: boolean,
  ): Promise<DatasetVersionRecord | null> {
    return this.db.transaction(async (tx) => {
      const now = new Date();

      // Stand down whatever is current first. The partial unique index permits
      // one active row, so setting the new one before clearing the old would
      // fail on the index rather than succeed.
      await tx
        .update(datasetVersions)
        .set({
          isActive: false,
          // `rolled_back` says "this was current and was replaced", which is a
          // different fact from "this was never activated".
          ...(supersede ? { status: "rolled_back" as const } : {}),
          updatedAt: now,
        })
        .where(and(eq(datasetVersions.companyId, companyId), eq(datasetVersions.isActive, true)));

      const [row] = await tx
        .update(datasetVersions)
        .set({ isActive: true, activatedAt: now, updatedAt: now })
        .where(
          and(
            eq(datasetVersions.companyId, companyId),
            eq(datasetVersions.id, id),
            // The CHECK enforces this too; naming it here means a caller gets
            // "no such finalized version" rather than a constraint violation.
            eq(datasetVersions.status, "finalized"),
          ),
        )
        .returning();
      return row ? toRecord(row) : null;
    });
  }
}

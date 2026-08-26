import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type {
  FinishInput,
  ProgressPatch,
  StartRunInput,
  SyncRepository,
  SyncRunRecord,
} from "./ports.js";

const { syncRuns } = schema;
type Row = typeof syncRuns.$inferSelect;

/** Statuses that mean work is meant to be happening. */
const UNFINISHED = ["queued", "running"];

function toRecord(row: Row): SyncRunRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceKey: row.sourceKey,
    kind: row.kind,
    status: row.status,
    totalFiles: row.totalFiles,
    processedFiles: row.processedFiles,
    currentFile: row.currentFile ?? null,
    currentStep: row.currentStep ?? null,
    result: (row.result ?? {}) as Record<string, unknown>,
    errorMessage: row.errorMessage ?? null,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    heartbeatAt: row.heartbeatAt ? row.heartbeatAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

export class DrizzleSyncRepository implements SyncRepository {
  constructor(private readonly db: Db) {}

  async current(
    companyId: string,
    filter: { sourceKey?: string },
  ): Promise<SyncRunRecord | null> {
    const clauses = [eq(syncRuns.companyId, companyId)];
    if (filter.sourceKey) clauses.push(eq(syncRuns.sourceKey, filter.sourceKey));

    const [row] = await this.db
      .select()
      .from(syncRuns)
      .where(and(...clauses))
      .orderBy(desc(syncRuns.startedAt))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async history(companyId: string, limit: number): Promise<SyncRunRecord[]> {
    const rows = await this.db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.companyId, companyId))
      .orderBy(desc(syncRuns.startedAt))
      .limit(limit);
    return rows.map(toRecord);
  }

  async getById(companyId: string, runId: string): Promise<SyncRunRecord | null> {
    const [row] = await this.db
      .select()
      .from(syncRuns)
      .where(and(eq(syncRuns.companyId, companyId), eq(syncRuns.id, runId)))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async start(input: StartRunInput): Promise<SyncRunRecord> {
    // No `onConflict` clause on purpose: the partial unique index over
    // unfinished runs must REFUSE a second one rather than quietly merging it
    // into the first, and the service turns that refusal into a 409.
    const [row] = await this.db
      .insert(syncRuns)
      .values({
        companyId: input.companyId,
        sourceKey: input.sourceKey,
        kind: input.kind,
        status: "running",
        totalFiles: input.totalFiles,
        startedBy: input.startedBy,
      })
      .returning();
    return toRecord(row!);
  }

  async advance(runId: string, patch: ProgressPatch): Promise<void> {
    const now = new Date();
    await this.db
      .update(syncRuns)
      .set({
        ...(patch.processedFiles !== undefined ? { processedFiles: patch.processedFiles } : {}),
        ...(patch.totalFiles !== undefined ? { totalFiles: patch.totalFiles } : {}),
        ...(patch.currentFile !== undefined ? { currentFile: patch.currentFile } : {}),
        ...(patch.currentStep !== undefined ? { currentStep: patch.currentStep } : {}),
        // Every advance is also a heartbeat. A sync that is making progress is
        // by definition alive, and a separate beat would be one more thing to
        // forget to call.
        heartbeatAt: now,
        updatedAt: now,
      })
      .where(eq(syncRuns.id, runId));
  }

  async finish(runId: string, input: FinishInput): Promise<void> {
    const now = new Date();
    await this.db
      .update(syncRuns)
      .set({
        status: input.status,
        // The CHECK constraint requires this alongside a terminal status, so
        // the two cannot drift apart.
        finishedAt: now,
        heartbeatAt: now,
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
        updatedAt: now,
      })
      .where(eq(syncRuns.id, runId));
  }

  async reapStalled(companyId: string, staleBefore: Date): Promise<number> {
    const rows = await this.db
      .update(syncRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorMessage: "The sync stopped reporting and was closed out.",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(syncRuns.companyId, companyId),
          inArray(syncRuns.status, UNFINISHED),
          lt(syncRuns.heartbeatAt, staleBefore),
        ),
      )
      .returning({ id: syncRuns.id });
    return rows.length;
  }
}

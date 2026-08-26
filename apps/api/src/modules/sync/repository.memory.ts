import { randomUUID } from "node:crypto";
import type {
  FinishInput,
  ProgressPatch,
  StartRunInput,
  SyncRepository,
  SyncRunRecord,
} from "./ports.js";

const UNFINISHED = new Set(["queued", "running"]);

/**
 * The same store, in memory.
 *
 * The clock is injectable because every interesting behaviour here is about
 * time — staleness, ordering, whether a run is still going — and a test that
 * has to sleep to exercise those is a test that will flake on a loaded box.
 */
export class InMemorySyncRepository implements SyncRepository {
  private readonly runs: SyncRunRecord[] = [];
  now = new Date("2024-06-01T12:00:00.000Z");

  private stamp(): string {
    return this.now.toISOString();
  }

  current(companyId: string, filter: { sourceKey?: string }): Promise<SyncRunRecord | null> {
    const mine = this.runs
      .filter(
        (r) => r.companyId === companyId && (!filter.sourceKey || r.sourceKey === filter.sourceKey),
      )
      .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
    return Promise.resolve(mine[0] ?? null);
  }

  history(companyId: string, limit: number): Promise<SyncRunRecord[]> {
    return Promise.resolve(
      this.runs
        .filter((r) => r.companyId === companyId)
        .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
        .slice(0, limit),
    );
  }

  getById(companyId: string, runId: string): Promise<SyncRunRecord | null> {
    return Promise.resolve(
      this.runs.find((r) => r.companyId === companyId && r.id === runId) ?? null,
    );
  }

  start(input: StartRunInput): Promise<SyncRunRecord> {
    // The partial unique index the real table carries. A fake without it would
    // let a test prove that concurrent syncs are prevented when they are not.
    const clash = this.runs.find(
      (r) =>
        r.companyId === input.companyId &&
        r.sourceKey === input.sourceKey &&
        UNFINISHED.has(r.status),
    );
    if (clash) {
      return Promise.reject(
        new Error("duplicate key value violates unique constraint uq_sync_runs_one_active"),
      );
    }

    const record: SyncRunRecord = {
      id: randomUUID(),
      companyId: input.companyId,
      sourceKey: input.sourceKey,
      kind: input.kind,
      status: "running",
      totalFiles: input.totalFiles,
      processedFiles: 0,
      currentFile: null,
      currentStep: null,
      result: {},
      errorMessage: null,
      startedAt: this.stamp(),
      heartbeatAt: this.stamp(),
      finishedAt: null,
    };
    this.runs.push(record);
    return Promise.resolve(record);
  }

  advance(runId: string, patch: ProgressPatch): Promise<void> {
    const run = this.runs.find((r) => r.id === runId);
    if (run) {
      if (patch.processedFiles !== undefined) run.processedFiles = patch.processedFiles;
      if (patch.totalFiles !== undefined) run.totalFiles = patch.totalFiles;
      if (patch.currentFile !== undefined) run.currentFile = patch.currentFile;
      if (patch.currentStep !== undefined) run.currentStep = patch.currentStep;
      run.heartbeatAt = this.stamp();
    }
    return Promise.resolve();
  }

  finish(runId: string, input: FinishInput): Promise<void> {
    const run = this.runs.find((r) => r.id === runId);
    if (run) {
      run.status = input.status;
      run.finishedAt = this.stamp();
      run.heartbeatAt = this.stamp();
      if (input.result !== undefined) run.result = input.result;
      if (input.errorMessage !== undefined) run.errorMessage = input.errorMessage;
    }
    return Promise.resolve();
  }

  reapStalled(companyId: string, staleBefore: Date): Promise<number> {
    let closed = 0;
    for (const run of this.runs) {
      if (run.companyId !== companyId || !UNFINISHED.has(run.status)) continue;
      if (!run.heartbeatAt || new Date(run.heartbeatAt) >= staleBefore) continue;
      run.status = "failed";
      run.finishedAt = this.stamp();
      run.errorMessage = "The sync stopped reporting and was closed out.";
      closed++;
    }
    return Promise.resolve(closed);
  }
}

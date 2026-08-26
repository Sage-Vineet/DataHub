import type { SyncRunRecord } from "./progress.js";

export type { SyncRunRecord, SyncProgress, SyncStatus } from "./progress.js";

export interface StartRunInput {
  companyId: string;
  sourceKey: string;
  kind: string;
  totalFiles: number;
  startedBy: string | null;
}

export interface ProgressPatch {
  processedFiles?: number;
  totalFiles?: number;
  currentFile?: string | null;
  currentStep?: string | null;
}

export interface FinishInput {
  status: "completed" | "failed" | "cancelled";
  result?: Record<string, unknown>;
  errorMessage?: string | null;
}

export interface SyncRepository {
  /** The most recent run for a company, whatever its state. */
  current(companyId: string, filter: { sourceKey?: string }): Promise<SyncRunRecord | null>;
  /** Recent runs, newest first — the history the maps never had. */
  history(companyId: string, limit: number): Promise<SyncRunRecord[]>;
  getById(companyId: string, runId: string): Promise<SyncRunRecord | null>;
  /**
   * Begin one.
   *
   * Rejects when an unfinished run already exists for the same company and
   * source — the partial unique index enforces it, and two concurrent syncs of
   * one source race each other into the same tables.
   */
  start(input: StartRunInput): Promise<SyncRunRecord>;
  /** Advance it, and beat. */
  advance(runId: string, patch: ProgressPatch): Promise<void>;
  finish(runId: string, input: FinishInput): Promise<void>;
  /**
   * Close out runs that stopped reporting, so their company can start again.
   * Returns how many were closed.
   */
  reapStalled(companyId: string, staleBefore: Date): Promise<number>;
}

/**
 * How a caller reads a sync run.
 *
 * Pure, because the interesting decision here is a judgement rather than a
 * lookup: whether a run that SAYS it is running actually is.
 */

export type SyncStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface SyncRunRecord {
  id: string;
  companyId: string;
  sourceKey: string;
  kind: string;
  status: string;
  totalFiles: number;
  processedFiles: number;
  currentFile: string | null;
  currentStep: string | null;
  result: Record<string, unknown>;
  errorMessage: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
}

/** What the progress bar renders. */
export interface SyncProgress {
  active: boolean;
  status: string;
  runId: string | null;
  sourceKey: string | null;
  totalFiles: number;
  processedFiles: number;
  currentFile: string;
  currentStep: string;
  percentage: number;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  /** True when the run claims to be going but has not reported in. */
  stalled: boolean;
}

/**
 * How long a run may go without a heartbeat before a reader stops believing it.
 *
 * Generous on purpose. A sync parsing a large PDF can be genuinely silent for
 * a while, and calling a live run dead is worse than waiting: the user starts a
 * second one, and two syncs of the same source race each other into the same
 * tables.
 */
export const STALE_AFTER_MS = 5 * 60 * 1000;

/** Statuses that mean work is meant to be happening. */
const UNFINISHED = new Set(["queued", "running"]);

/**
 * Has this run gone quiet?
 *
 * A process that died holding a `running` row cannot write its own epitaph, so
 * this is the reader's judgement rather than anything stored.
 */
export function isStalled(run: SyncRunRecord, now: Date): boolean {
  if (!UNFINISHED.has(run.status)) return false;
  if (!run.heartbeatAt) return true;
  return now.getTime() - new Date(run.heartbeatAt).getTime() > STALE_AFTER_MS;
}

/** Progress as a whole percentage, 0–100. */
export function percentageOf(processed: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const raw = (Math.max(0, processed) / total) * 100;
  // Clamped, because a miscounted total would otherwise render a bar past its
  // own end — which reads as a bug in the page rather than in the count.
  return Math.min(100, Math.round(raw));
}

/** The idle answer, for a company with no run to report. */
export function idleProgress(): SyncProgress {
  return {
    active: false,
    status: "idle",
    runId: null,
    sourceKey: null,
    totalFiles: 0,
    processedFiles: 0,
    currentFile: "",
    currentStep: "idle",
    percentage: 0,
    startedAt: null,
    finishedAt: null,
    errorMessage: null,
    stalled: false,
  };
}

/**
 * Turn a run into what the page renders.
 *
 * A stalled run reports `active: false` — so the button comes back and the
 * user can start again — while keeping its status and its last known position,
 * so the page can say what happened rather than pretending nothing did.
 */
export function toProgress(run: SyncRunRecord | null, now: Date): SyncProgress {
  if (!run) return idleProgress();

  const stalled = isStalled(run, now);
  return {
    active: UNFINISHED.has(run.status) && !stalled,
    status: run.status,
    runId: run.id,
    sourceKey: run.sourceKey,
    totalFiles: run.totalFiles,
    processedFiles: run.processedFiles,
    currentFile: run.currentFile ?? "",
    currentStep: run.currentStep ?? run.status,
    percentage:
      // A finished run is finished, whatever the counters say. A sync that
      // skipped four unreadable files would otherwise sit at 60% forever.
      run.status === "completed" ? 100 : percentageOf(run.processedFiles, run.totalFiles),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    errorMessage: run.errorMessage,
    stalled,
  };
}

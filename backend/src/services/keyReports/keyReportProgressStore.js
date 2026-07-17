/**
 * KEY REPORTS GENERATION PROGRESS STORE (in-memory)
 *
 * The Key Reports "Generate" pipeline (keyReportSyncService.generateFinancialTables)
 * runs as a single synchronous request that can take several minutes. Before this
 * store, the frontend progress bar was a pure time-based guess that raced to 98%
 * and froze there — completely disconnected from what the backend was doing.
 *
 * This store lets the sync pipeline publish REAL, phase-by-phase progress as it
 * advances through its logged lifecycle — from "=== Sync started ===" to
 * "=== Sync complete ===" — so the frontend can poll and render the actual
 * position in the pipeline.
 *
 * State is intentionally ephemeral and in-memory: a process restart simply drops
 * it (the frontend then falls back to its own handling), and there is no value in
 * persisting transient sub-request progress to the database.
 *
 * Stage keys mirror the frontend's STAGES (GenerateProgressPanel.jsx) so the UI
 * can highlight the correct step directly from the backend's reported stage:
 *   preparing → reading_gl → ai_processing → coa → financial_reports →
 *   snapshots → validation → completed
 */

// versionId (string) -> {
//   status: 'generating' | 'done' | 'error',
//   stageKey, stageLabel, pct, message, startedAt, updatedAt, error
// }
const _progress = new Map();

// How long a terminal (done/error) entry is retained so a final poll can still
// read it, after which getProgress prunes it. The frontend stops polling as soon
// as the /generate request resolves, so this is just a safety-net for stragglers.
const TERMINAL_TTL_MS = 60 * 1000;

function key(versionId) {
  return String(versionId);
}

function nowIso() {
  return new Date().toISOString();
}

/** Begin tracking a generation run. Resets any prior state for this version. */
function startProgress(versionId) {
  if (!versionId) return;
  const ts = nowIso();
  _progress.set(key(versionId), {
    status: 'generating',
    stageKey: 'preparing',
    stageLabel: 'Preparing Data',
    pct: 0,
    message: 'Starting…',
    startedAt: ts,
    updatedAt: ts,
    error: null,
  });
}

/**
 * Advance progress. Percentage is monotonic — a late or out-of-order update can
 * never rewind the bar — and is capped below 100 while still generating (100 is
 * reserved for completeProgress).
 */
function updateProgress(versionId, { stageKey, stageLabel, pct, message } = {}) {
  if (!versionId) return;
  const k = key(versionId);
  const prev = _progress.get(k);
  // If startProgress was never called (e.g. process restarted mid-run), seed one.
  const base = prev || {
    status: 'generating',
    pct: 0,
    startedAt: nowIso(),
    error: null,
  };
  let nextPct = base.pct || 0;
  if (Number.isFinite(pct)) {
    nextPct = Math.max(base.pct || 0, Math.min(99, pct));
  }
  _progress.set(k, {
    ...base,
    status: 'generating',
    stageKey: stageKey || base.stageKey || 'preparing',
    stageLabel: stageLabel || base.stageLabel || 'Preparing Data',
    pct: nextPct,
    message: message != null ? message : base.message,
    updatedAt: nowIso(),
    error: null,
  });
}

/** Mark the run finished successfully at 100%. */
function completeProgress(versionId, message = 'All reports are ready.') {
  if (!versionId) return;
  const k = key(versionId);
  const prev = _progress.get(k) || { startedAt: nowIso() };
  _progress.set(k, {
    ...prev,
    status: 'done',
    stageKey: 'completed',
    stageLabel: 'Completed',
    pct: 100,
    message,
    updatedAt: nowIso(),
    error: null,
  });
}

/** Mark the run failed, preserving the stage it failed at (if known). */
function failProgress(versionId, errorMessage = 'Generation failed.', stageKey = null) {
  if (!versionId) return;
  const k = key(versionId);
  const prev = _progress.get(k) || { pct: 0, startedAt: nowIso() };
  _progress.set(k, {
    ...prev,
    status: 'error',
    stageKey: stageKey || prev.stageKey || 'preparing',
    stageLabel: prev.stageLabel || 'Generation stopped',
    pct: prev.pct || 0,
    message: errorMessage,
    updatedAt: nowIso(),
    error: errorMessage,
  });
}

/** Read current progress for a version (or null). Prunes stale terminal entries. */
function getProgress(versionId) {
  if (!versionId) return null;
  const k = key(versionId);
  const entry = _progress.get(k);
  if (!entry) return null;
  if (entry.status === 'done' || entry.status === 'error') {
    const age = Date.now() - new Date(entry.updatedAt).getTime();
    if (Number.isFinite(age) && age > TERMINAL_TTL_MS) {
      _progress.delete(k);
      return null;
    }
  }
  return entry;
}

/** Drop any tracked progress for a version. */
function clearProgress(versionId) {
  if (!versionId) return;
  _progress.delete(key(versionId));
}

module.exports = {
  startProgress,
  updateProgress,
  completeProgress,
  failProgress,
  getProgress,
  clearProgress,
};

// In-memory Key Reports generation progress tracker.
//
// The generate ("sync") pipeline runs as a single synchronous request that only
// resolves when the whole workflow finishes. The frontend progress bar used to
// fake its advance with a time-based ticker that always stalled at 98%. This
// module lets the bar reflect REAL progress instead: as the sync pipeline logs
// its phase markers (from "=== Sync started ===" to "=== Sync complete ==="),
// we map each marker to the matching UI stage and remember it here, keyed by
// versionId. A lightweight polling endpoint reads it.
//
// Deliberately in-memory only — no database table. Progress is transient
// per-run state, so a plain Map is enough; entries are pruned by TTL so the map
// never grows unbounded.

// Stage keys MUST match the STAGES defined in
// src/components/key-reports/GenerateProgressPanel.jsx.
//
// Each entry maps a distinctive substring of a real sync log line to the stage
// it represents. The pipeline logs these in order, so matching them as they are
// emitted walks the bar forward through the same steps shown in the UI.
const STAGE_MARKERS = [
  { includes: '=== Sync started ===', stage: 'preparing', start: true },
  { includes: 'Files discovered:', stage: 'reading_gl' },
  { includes: '--- Extraction:', stage: 'ai_processing' },
  { includes: '--- Step 6: Chart of Accounts', stage: 'coa' },
  { includes: '--- Phase 3: Trial Balance', stage: 'financial_reports' },
  { includes: '--- Phase 6: Materialize', stage: 'snapshots' },
  { includes: '--- Step 7: Validation Results', stage: 'validation' },
  { includes: '=== Sync complete ===', stage: 'completed', done: true },
];

// Ordered list of stage keys — used to enforce forward-only transitions so a
// stray/duplicate log line can never make the bar jump backwards.
const STAGE_ORDER = [
  'preparing',
  'reading_gl',
  'ai_processing',
  'coa',
  'financial_reports',
  'snapshots',
  'validation',
  'completed',
];

const TTL_MS = 30 * 60 * 1000; // drop finished/stale runs after 30 min

const progressByVersion = new Map(); // versionId -> { stage, done, updatedAt }

function prune() {
  const now = Date.now();
  for (const [versionId, entry] of progressByVersion) {
    if (now - entry.updatedAt > TTL_MS) progressByVersion.delete(versionId);
  }
}

function stageRank(stage) {
  const i = STAGE_ORDER.indexOf(stage);
  return i === -1 ? -1 : i;
}

/** Begin tracking a fresh run for this version at the first stage. */
function startProgress(versionId) {
  if (!versionId) return;
  prune();
  progressByVersion.set(versionId, {
    stage: 'preparing',
    done: false,
    updatedAt: Date.now(),
  });
}

/** Advance to a stage (forward-only). No-op if versionId is missing. */
function setStage(versionId, stage, { done = false } = {}) {
  if (!versionId || stageRank(stage) === -1) return;
  const current = progressByVersion.get(versionId);
  // Only ever move forward — ignore out-of-order or repeated earlier markers.
  if (current && stageRank(stage) < stageRank(current.stage)) return;
  progressByVersion.set(versionId, { stage, done, updatedAt: Date.now() });
}

/**
 * Feed a raw sync log line. If it matches a known phase marker, advance the
 * tracked stage. Called from the sync service's logger, so progress stays tied
 * to the exact log lines from "=== Sync started ===" to "=== Sync complete ===".
 * Fully defensive — logging must never break the sync itself.
 */
function onSyncLog(versionId, message) {
  if (!versionId || typeof message !== 'string') return;
  try {
    for (const marker of STAGE_MARKERS) {
      if (message.includes(marker.includes)) {
        if (marker.start) startProgress(versionId);
        else setStage(versionId, marker.stage, { done: !!marker.done });
        break;
      }
    }
  } catch {
    /* never let progress tracking interfere with the pipeline */
  }
}

/** Read the current progress snapshot for a version (or null if none). */
function getProgress(versionId) {
  if (!versionId) return null;
  const entry = progressByVersion.get(versionId);
  return entry ? { ...entry } : null;
}

/** Forget a version's progress (e.g. after the run is fully consumed). */
function clearProgress(versionId) {
  if (versionId) progressByVersion.delete(versionId);
}

module.exports = {
  startProgress,
  setStage,
  onSyncLog,
  getProgress,
  clearProgress,
};

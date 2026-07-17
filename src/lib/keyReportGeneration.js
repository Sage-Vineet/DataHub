// Module-level Key Reports generation manager.
//
// Generation ("syncing") runs for minutes on the backend. Keeping its state in
// React component state meant: navigating away unmounted the page, the in-flight
// request's result was dropped, the completion toast never fired, and returning
// showed an idle page. This manager owns generation OUTSIDE the component so it:
//   • survives client-side navigation (the request keeps running),
//   • persists per-version state to sessionStorage (visible on return),
//   • lets any mounted page subscribe for live progress + completion.
//
// State is keyed per (clientId, versionId) so each version's syncing status is
// independent and restored when the user comes back to that version.

import { generateKeyReportVersion, getKeyReportGenerateProgress } from "./api";
import { clearCachedFinancials } from "./keyReportFinancials";

// How often to poll the backend for live generation progress while a run is
// in-flight. The pipeline runs for minutes, so a modest cadence is plenty.
const PROGRESS_POLL_MS = 1500;

const STORAGE_PREFIX = "keyReports.generateState";

function storageKey(clientId, versionId) {
  return `${STORAGE_PREFIX}:${clientId || "default"}:${versionId}`;
}

function readState(clientId, versionId) {
  if (!versionId) return null;
  try {
    const raw = sessionStorage.getItem(storageKey(clientId, versionId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeState(clientId, versionId, state) {
  if (!versionId) return;
  try {
    if (!state) sessionStorage.removeItem(storageKey(clientId, versionId));
    else sessionStorage.setItem(storageKey(clientId, versionId), JSON.stringify(state));
  } catch {
    /* sessionStorage unavailable — non-fatal */
  }
}

// Map a backend error message to an approximate pipeline stage (for the progress panel).
function inferErrorStage(message = "") {
  const m = String(message).toLowerCase();
  if (m.includes("chart of accounts") || m.includes("coa")) return "coa";
  if (m.includes("financial report") || m.includes("profit") || m.includes("balance")) return "financial_reports";
  if (m.includes("snapshot")) return "snapshots";
  if (m.includes("validation")) return "validation";
  if (m.includes("general ledger") || m.includes("gl")) return "reading_gl";
  return "ai_processing";
}

// Live, in-memory registry of running generations for THIS JS session, so
// client-side navigation back to the page reflects the still-running request.
const inFlight = new Map(); // storageKey -> Promise
const listeners = new Set(); // () => void

function emit() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore listener errors */
    }
  });
}

/** Subscribe to any generation state change. Returns an unsubscribe fn. */
export function subscribeGeneration(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the persisted generation state for a version (or null). */
export function getGenerationState(clientId, versionId) {
  return readState(clientId, versionId);
}

/** True while a generation request for this version is running in this session. */
export function isGenerationInFlight(clientId, versionId) {
  return inFlight.has(storageKey(clientId, versionId));
}

/**
 * Start (or re-use) a generation for a version. Idempotent while in-flight:
 * calling again returns the existing promise instead of starting a second run.
 * Resolves to { ok, res } / { ok:false, error }. Persists state + emits on
 * start and completion regardless of whether any component is mounted.
 */
export function startGeneration(clientId, versionId, versionLabel = "") {
  if (!versionId) return Promise.resolve({ ok: false, error: "No version selected." });
  const key = storageKey(clientId, versionId);
  if (inFlight.has(key)) return inFlight.get(key);

  // Identity fields (clientId / versionId / versionLabel) are stored in the
  // state so a global toaster can announce completions on any page without
  // needing the version list.
  const identity = { clientId: clientId || null, versionId, versionLabel };
  const startedAt = new Date().toISOString();
  writeState(clientId, versionId, {
    ...identity,
    status: "generating",
    startedAt,
    finishedAt: null,
    summary: null,
    warnings: [],
    validationResults: [],
    error: null,
    errorStage: null,
    progress: null,
    notified: false,
  });
  emit();

  // Poll the backend for real, phase-by-phase progress while the run is
  // in-flight, merging it into the persisted state so the progress bar reflects
  // the actual pipeline position. Fully best-effort: any poll failure is ignored
  // (the panel falls back to its own animation), and the interval is always
  // cleared when the request settles.
  const pollTimer = setInterval(async () => {
    try {
      const res = await getKeyReportGenerateProgress(versionId);
      const progress = res?.progress || null;
      if (!progress) return;
      const current = readState(clientId, versionId);
      // Only apply while THIS run is still generating — never overwrite a
      // terminal state the request handler has already written.
      if (!current || current.status !== "generating" || current.startedAt !== startedAt) return;
      writeState(clientId, versionId, { ...current, progress });
      emit();
    } catch {
      /* progress polling is best-effort */
    }
  }, PROGRESS_POLL_MS);

  const promise = (async () => {
    try {
      const res = await generateKeyReportVersion(versionId);
      // Freshly synced data — drop any cached financial-statements response so
      // the Reports page refetches the new numbers instead of a stale copy.
      clearCachedFinancials(clientId, versionId);
      // The backend returns `success: true` even when the accounting workflow was
      // HALTED (e.g. no Opening Balance Sheet, or a required file failed to
      // extract). In that case NO Chart of Accounts or financial reports were
      // generated, so treating it as "done" wrongly shows "Generation Complete"
      // while every report stays empty. Surface the halt as an error with the
      // backend's explanation so the user knows what to fix.
      if (res?.halted) {
        const message =
          res?.message ||
          "Generation was halted: required accounting data (e.g. an Opening Balance Sheet) is missing or failed to extract. Fix the linked files and re-generate.";
        writeState(clientId, versionId, {
          ...identity,
          status: "error",
          startedAt,
          finishedAt: new Date().toISOString(),
          summary: res?.summary || null,
          warnings: Array.isArray(res?.warnings) ? res.warnings : [],
          validationResults: Array.isArray(res?.validationResults) ? res.validationResults : [],
          error: message,
          errorStage: "preparing",
          notified: false,
        });
        return { ok: false, error: message, halted: true };
      }
      writeState(clientId, versionId, {
        ...identity,
        status: "done",
        startedAt,
        finishedAt: new Date().toISOString(),
        summary: res?.result?.summary || null,
        warnings: Array.isArray(res?.warnings) ? res.warnings : [],
        validationResults: Array.isArray(res?.validationResults) ? res.validationResults : [],
        error: null,
        errorStage: null,
        warnCount: res?.warnings?.length || 0,
        notified: false,
      });
      return { ok: true, res };
    } catch (e) {
      const message = e?.message || "Generation failed.";
      writeState(clientId, versionId, {
        ...identity,
        status: "error",
        startedAt,
        finishedAt: new Date().toISOString(),
        summary: null,
        warnings: [],
        validationResults: [],
        error: message,
        errorStage: inferErrorStage(message),
        notified: false,
      });
      return { ok: false, error: message };
    } finally {
      clearInterval(pollTimer);
      inFlight.delete(key);
      emit();
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

/**
 * Scan every persisted generation and return those that finished (done/error)
 * but haven't been announced yet. Used by the app-level toaster so a completion
 * pops on whatever page the user is currently on.
 */
export function listUnnotifiedCompletions() {
  const out = [];
  try {
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const k = sessionStorage.key(i);
      if (!k || !k.startsWith(`${STORAGE_PREFIX}:`)) continue;
      let state;
      try {
        state = JSON.parse(sessionStorage.getItem(k));
      } catch {
        continue;
      }
      if (!state || state.notified) continue;
      if (state.status !== "done" && state.status !== "error") continue;
      out.push(state);
    }
  } catch {
    /* sessionStorage unavailable — non-fatal */
  }
  return out;
}

/** Mark a completed generation's toast as shown, so it isn't re-notified. */
export function markGenerationNotified(clientId, versionId) {
  const state = readState(clientId, versionId);
  if (state && !state.notified) {
    writeState(clientId, versionId, { ...state, notified: true });
  }
}

/** Clear persisted generation state for a version (e.g. after linked docs change). */
export function clearGeneration(clientId, versionId) {
  writeState(clientId, versionId, null);
  emit();
}

/**
 * Reconcile an orphaned "generating" state after a hard reload (the in-flight
 * request was lost when the page fully reloaded). If the server shows the
 * version was synced at/after this run started, promote to "done" using the
 * persisted validation results; if it clearly never finished, reset to idle so
 * the UI doesn't show a permanent spinner. No-op during normal SPA navigation
 * (the request is still tracked in memory).
 */
export function reconcileGeneration(clientId, versionId, { lastSyncedAt, validationResults } = {}) {
  const state = readState(clientId, versionId);
  if (!state || state.status !== "generating") return;
  if (isGenerationInFlight(clientId, versionId)) return; // still running in this session

  const syncedMs = lastSyncedAt ? new Date(lastSyncedAt).getTime() : 0;
  const startedMs = state.startedAt ? new Date(state.startedAt).getTime() : 0;

  if (syncedMs && syncedMs >= startedMs) {
    writeState(clientId, versionId, {
      ...state,
      status: "done",
      finishedAt: lastSyncedAt,
      validationResults: Array.isArray(validationResults) ? validationResults : [],
      notified: true, // completed while away/reloaded — don't pop a stale toast
    });
  } else {
    writeState(clientId, versionId, null); // lost run — return to idle
  }
  emit();
}

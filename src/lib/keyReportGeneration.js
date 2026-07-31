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

import { generateKeyReportVersion, saveChartOfAccounts } from "./api";
import { clearCachedFinancials } from "./keyReportFinancials";

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
 *
 * Phase machine (mirrors the backend's halt reasons — see
 * keyReportSyncService.generateFinancialTables's PROPOSE MODE branch):
 *   "extracting"           in flight (was "generating")
 *   "coa_review_required"  structural success — a Proposed COA came back and
 *                          is stashed here (proposedTree/matchSummary) so a
 *                          page reload doesn't lose it. Nothing persisted,
 *                          no reports generated yet.
 *   "coa_generation_failed" any OTHER halt reason (a document-gate failure
 *                          e.g. general_ledger_required, or the proposal
 *                          build itself throwing) — nothing to review.
 *   "error"                the request itself threw (network/exception).
 *
 * NOTE on response shape: POST /generate (and /sync) return
 * { success, version, warnings, validationResults, result }, where `result`
 * is keyReportSyncService.generateCoaProposal's own return value — the
 * halted/summary/proposedTree/matchSummary/message fields all live under
 * `res.result`, one level deeper than `res` itself.
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
    status: "extracting",
    startedAt,
    finishedAt: null,
    summary: null,
    warnings: [],
    validationResults: [],
    proposedTree: null,
    matchSummary: null,
    error: null,
    errorStage: null,
    violations: null,
    notified: false,
  });
  emit();

  const promise = (async () => {
    try {
      const res = await generateKeyReportVersion(versionId);
      // Freshly synced data — drop any cached financial-statements response so
      // the Reports page refetches the new numbers instead of a stale copy.
      clearCachedFinancials(clientId, versionId);

      const inner = res?.result || {};
      const haltReason = inner?.summary?.haltReason || null;

      if (inner.halted && haltReason === "coa_review_required") {
        // Structural success: a Proposed COA was built and is waiting on the
        // user's review/approve. Stash the proposal itself so a page reload
        // still has something to show the grid (see WorkspaceKeyReports).
        writeState(clientId, versionId, {
          ...identity,
          status: "coa_review_required",
          startedAt,
          finishedAt: new Date().toISOString(),
          summary: inner.summary || null,
          warnings: Array.isArray(res?.warnings) ? res.warnings : [],
          validationResults: Array.isArray(res?.validationResults) ? res.validationResults : [],
          proposedTree: inner.proposedTree || null,
          matchSummary: inner.matchSummary || null,
          error: null,
          errorStage: null,
          violations: null,
          notified: false,
        });
        return { ok: true, res, needsReview: true };
      }

      if (inner.halted) {
        // A document-gate failure (e.g. general_ledger_required) or a
        // genuine COA build failure (coa_generation_failed) — either way,
        // nothing was proposed and there is nothing to review.
        const message =
          inner.message || res?.message ||
          "Generation was halted: required accounting data is missing or failed to extract. Fix the linked files and re-generate.";
        writeState(clientId, versionId, {
          ...identity,
          status: "coa_generation_failed",
          startedAt,
          finishedAt: new Date().toISOString(),
          summary: inner.summary || null,
          warnings: Array.isArray(res?.warnings) ? res.warnings : [],
          validationResults: Array.isArray(res?.validationResults) ? res.validationResults : [],
          proposedTree: null,
          matchSummary: null,
          error: message,
          errorStage: inferErrorStage(message),
          violations: null,
          notified: false,
        });
        return { ok: false, error: message, halted: true };
      }

      // Defensive fallback: PROPOSE MODE always halts with coa_review_required
      // on structural success (see the backend doc comments) — reaching here
      // means an unexpected shape. Treat it as review-required with whatever
      // proposal (if any) came back rather than silently claiming reports
      // exist when they don't.
      writeState(clientId, versionId, {
        ...identity,
        status: "coa_review_required",
        startedAt,
        finishedAt: new Date().toISOString(),
        summary: inner.summary || null,
        warnings: Array.isArray(res?.warnings) ? res.warnings : [],
        validationResults: Array.isArray(res?.validationResults) ? res.validationResults : [],
        proposedTree: inner.proposedTree || null,
        matchSummary: inner.matchSummary || null,
        error: null,
        errorStage: null,
        violations: null,
        notified: false,
      });
      return { ok: true, res, needsReview: true };
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
        proposedTree: null,
        matchSummary: null,
        error: message,
        errorStage: inferErrorStage(message),
        violations: null,
        notified: false,
      });
      return { ok: false, error: message };
    } finally {
      inFlight.delete(key);
      emit();
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

/**
 * approveCoa — the Chart-of-Accounts Save/Approve action. Posts the user's
 * complete reviewed tree to POST .../chart-of-accounts/save; on success the
 * backend has already validated, persisted, AND generated every report
 * (Trial Balance/Reconciliation/Monthly Balance Sheets/snapshots) inside the
 * same call — so "reports_ready" here means exactly that, synchronously.
 * Shares the same in-flight/session-storage machinery as startGeneration
 * (keyed by clientId+versionId) so a double-click can't submit twice and a
 * page reload still reflects the outcome.
 *
 * Resolves to { ok:true, res } or { ok:false, error, violations }. On
 * failure nothing was persisted server-side (see keyReportSyncService's
 * APPROVE MODE) — state reverts to "coa_review_required" with the
 * violations attached so the grid can show them without losing the user's
 * edits (the caller — ChartOfAccountsGrid — keeps its own draft in memory
 * regardless of what this function persists to sessionStorage).
 */
export function approveCoa(clientId, versionId, treeNodes) {
  if (!versionId) return Promise.resolve({ ok: false, error: "No version selected." });
  const key = storageKey(clientId, versionId);
  if (inFlight.has(key)) return inFlight.get(key);

  const prior = readState(clientId, versionId) || {};
  const identity = { clientId: clientId || null, versionId, versionLabel: prior.versionLabel || "" };
  const startedAt = prior.startedAt || new Date().toISOString();

  writeState(clientId, versionId, {
    ...prior,
    ...identity,
    status: "coa_saving",
    error: null,
    errorStage: null,
    violations: null,
    notified: false,
  });
  emit();

  const promise = (async () => {
    try {
      const res = await saveChartOfAccounts(versionId, treeNodes);
      clearCachedFinancials(clientId, versionId);
      writeState(clientId, versionId, {
        ...identity,
        status: "reports_ready",
        startedAt,
        finishedAt: new Date().toISOString(),
        summary: res?.result?.summary || null,
        warnings: Array.isArray(res?.warnings) ? res.warnings : (prior.warnings || []),
        validationResults: Array.isArray(res?.validationResults) ? res.validationResults : [],
        proposedTree: null,
        matchSummary: null,
        error: null,
        errorStage: null,
        violations: null,
        notified: false,
      });
      return { ok: true, res };
    } catch (e) {
      const violations = Array.isArray(e?.payload?.violations) ? e.payload.violations : null;
      const message = e?.message || "Failed to save Chart of Accounts.";
      writeState(clientId, versionId, {
        ...prior,
        ...identity,
        status: "coa_review_required", // nothing persisted — back to review
        error: message,
        errorStage: "coa",
        violations,
        notified: false,
      });
      return { ok: false, error: message, violations };
    } finally {
      inFlight.delete(key);
      emit();
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

// Terminal states worth announcing via the app-level toaster — everything
// that is NOT still in flight ("extracting" / "coa_saving").
const FINISHED_STATUSES = new Set(["reports_ready", "coa_review_required", "coa_generation_failed", "error"]);

/**
 * Scan every persisted generation and return those that finished but
 * haven't been announced yet. Used by the app-level toaster so a completion
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
      if (!FINISHED_STATUSES.has(state.status)) continue;
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
 * Reconcile an orphaned "extracting" state after a hard reload (the in-flight
 * request was lost when the page fully reloaded). If the server shows the
 * version was synced at/after this run started, promote to either
 * "reports_ready" (an approval already landed after that sync — rare but
 * possible if the reload happened mid-approve) or "coa_review_required".
 * The Proposed COA itself lived only in the lost in-memory response and
 * cannot be recovered here — ChartOfAccountsGrid's own "no cached proposal"
 * empty state (with a Regenerate button) is the intended fallback. If the
 * sync clearly never finished, reset to idle so the UI doesn't show a
 * permanent spinner. No-op during normal SPA navigation (the request is
 * still tracked in memory).
 */
export function reconcileGeneration(clientId, versionId, { lastSyncedAt, validationResults, coaApprovedAt } = {}) {
  const state = readState(clientId, versionId);
  if (!state || state.status !== "extracting") return;
  if (isGenerationInFlight(clientId, versionId)) return; // still running in this session

  const syncedMs = lastSyncedAt ? new Date(lastSyncedAt).getTime() : 0;
  const startedMs = state.startedAt ? new Date(state.startedAt).getTime() : 0;
  const approvedMs = coaApprovedAt ? new Date(coaApprovedAt).getTime() : 0;

  if (syncedMs && syncedMs >= startedMs) {
    const reachedApproval = Boolean(approvedMs && approvedMs >= syncedMs);
    writeState(clientId, versionId, {
      ...state,
      status: reachedApproval ? "reports_ready" : "coa_review_required",
      finishedAt: lastSyncedAt,
      validationResults: Array.isArray(validationResults) ? validationResults : [],
      proposedTree: null,
      notified: true, // completed while away/reloaded — don't pop a stale toast
    });
  } else {
    writeState(clientId, versionId, null); // lost run — return to idle
  }
  emit();
}
